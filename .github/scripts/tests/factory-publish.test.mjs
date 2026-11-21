import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../factory-publish.sh", import.meta.url));
const BOT = "sunny-factory[bot]";
const BOT_EMAIL = `123+${BOT}@users.noreply.github.com`;

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// Git with a fixed identity: the App's bot user, as the factory job's git config sets it.
const git = (cwd, args, { name = BOT, email = BOT_EMAIL } = {}) => {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: name,
			GIT_AUTHOR_EMAIL: email,
			GIT_COMMITTER_NAME: name,
			GIT_COMMITTER_EMAIL: email,
		},
	});
	if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout.trim();
};
const write = (root, files) => {
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), c);
	}
};

// A repo with main, and a hand-off as the factory job builds it: the branch's commits as a bundle
// from main, then the branch deleted, as on the fresh publish runner.
function handoff({
	branch = "42-add-a-line",
	baseFiles = {},
	change = (repo) => write(repo, { "docs/note.md": "hi\n" }),
	commits = 1,
	identity,
	body = "chore(docs): add a line (#42)\n\nCloses #42\n",
	labels = "area:docs\nreview:admin\n",
	bundleAs,
	extra,
	entries,
} = {}) {
	dir = mkdtempSync(join(tmpdir(), "factory-publish-"));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-q", "-b", "main"]);
	write(repo, { README: "base\n", ...baseFiles });
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "base"]);
	const base = git(repo, ["rev-parse", "HEAD"]);
	git(repo, ["switch", "-qc", "work"]);
	for (let i = 0; i < commits; i++) {
		if (i === 0) change(repo);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", `c${i}`, "--allow-empty"], identity);
	}
	// A name git refuses, or main itself, is bundled under another: the script refuses it first.
	const valid = spawnSync("git", ["check-ref-format", "--branch", branch]).status === 0;
	const ref = bundleAs ?? (valid && branch !== "main" ? branch : "safe");
	git(repo, ["branch", "-f", ref, "work"]);
	const h = join(dir, "h");
	mkdirSync(h);
	// No commits: a bundle of the whole branch, since git refuses an empty range.
	git(repo, [
		"bundle",
		"create",
		"-q",
		join(h, "commits.bundle"),
		commits ? `${base}..${ref}` : ref,
	]);
	git(repo, ["switch", "-q", "main"]);
	git(repo, ["branch", "-qD", "work", ref]);
	writeFileSync(join(h, "branch"), `${branch}\n`);
	writeFileSync(join(h, "pr-body.md"), body);
	writeFileSync(join(h, "labels"), labels);
	if (extra) extra(h, repo);
	const names = entries ?? ["branch", "commits.bundle", "labels", "pr-body.md"];
	spawnSync("tar", ["-czf", join(dir, "handoff.tgz"), ...names], { cwd: h });
	return { repo, base };
}

function run(repo, base) {
	const work = join(dir, `work-${Math.random().toString(36).slice(2)}`);
	mkdirSync(work);
	writeFileSync(join(dir, "out"), "");
	const res = spawnSync("bash", [SCRIPT], {
		cwd: repo,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1",
			ISSUE: "42",
			HANDOFF: join(dir, "handoff.tgz"),
			WORK: work,
			BASE: base,
			BOT,
			GITHUB_OUTPUT: join(dir, "out"),
		},
	});
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		out: readFileSync(join(dir, "out"), "utf8"),
		branches: git(repo, ["branch", "--format=%(refname:short)"]),
	};
}
const publish = (opts) => {
	const { repo, base } = handoff(opts);
	return run(repo, base);
};
// The log of a refusal (exit 1, no branch handed on), or a line that fails any toMatch.
const refusal = (p) =>
	p.code === 1 && !/^branch=/m.test(p.out) ? p.log : `NOT REFUSED (exit ${p.code}): ${p.log}`;

describe("factory-publish.sh", () => {
	it("passes a clean hand-off and fetches the branch", () => {
		const p = publish();
		expect(p.code).toBe(0);
		expect(p.log).toMatch(
			/^PUBLISH ok: 42-add-a-line, 1 commit\(s\), labels: area:docs review:admin/m,
		);
		expect(p.out).toMatch(/^branch=42-add-a-line$/m);
		expect(p.out).toMatch(/^labels=area:docs,review:admin$/m);
		expect(p.out).toMatch(/^body=.*pr-body\.md$/m);
		expect(p.branches).toContain("42-add-a-line");
	});

	it("passes a hand-off with no labels", () => {
		const p = publish({ labels: "" });
		expect(p.code).toBe(0);
		expect(p.out).toMatch(/^labels=$/m);
	});

	it("passes 100 commits, the most it takes", () => {
		expect(publish({ commits: 100 }).code).toBe(0);
	});

	describe("the branch", () => {
		it.each([
			["another issue's number", "43-add-a-line"],
			["no slug", "42-"],
			["capitals", "42-Add"],
			["main", "main"],
			["a path", "42-a/../../x"],
			["the claude/ prefix", "claude/42-x"],
		])("refuses a branch with %s", (_n, branch) => {
			expect(refusal(publish({ branch }))).toMatch(
				/^PUBLISH refused: the branch .* isn't 42-<slug>/m,
			);
		});

		it("refuses a branch name over 100 characters", () => {
			expect(refusal(publish({ branch: `42-${"a".repeat(98)}` }))).toMatch(
				/branch name is over 100 characters/,
			);
		});

		it("refuses a branch that already exists here", () => {
			const { repo, base } = handoff();
			git(repo, ["branch", "42-add-a-line"]);
			expect(refusal(run(repo, base))).toMatch(/the branch 42-add-a-line already exists here/);
		});

		it("refuses a bundle that doesn't hold the named branch", () => {
			expect(refusal(publish({ bundleAs: "42-something-else" }))).toMatch(
				/the bundle has no branch 42-add-a-line/,
			);
		});
	});

	describe("the commits", () => {
		it("refuses a branch with no commits past main", () => {
			expect(refusal(publish({ commits: 0 }))).toMatch(/has no commits past main/);
		});

		it("refuses more than 100 commits", () => {
			expect(refusal(publish({ commits: 101 }))).toMatch(/has 101 commits, over 100/);
		});

		it("refuses a corrupt bundle", () => {
			expect(
				refusal(
					publish({
						extra: (h) => writeFileSync(join(h, "commits.bundle"), "# v2 git bundle\nnot really\n"),
					}),
				),
			).toMatch(/git can't verify the bundle against main/);
		});

		it.each([
			["the author and committer", { name: "Someone", email: "s@example.invalid" }],
			["a lookalike name", { name: "sunny-factory", email: BOT_EMAIL }],
			["a lookalike email", { name: BOT, email: `x+${BOT}@example.invalid` }],
		])("refuses a commit with another identity: %s", (_n, identity) => {
			expect(refusal(publish({ identity }))).toMatch(
				/a commit isn't authored and committed by sunny-factory\[bot\]/,
			);
		});
	});

	describe("protected paths", () => {
		it.each([
			[".github/workflows/ci.yml", "a workflow"],
			["tests/acceptance/a.test.ts", "an acceptance test"],
			// git quotes these names in a listing, so a grep over the names would miss them.
			[".github/workflows/é.yml", "a workflow with a non-ASCII name"],
			["tests/acceptance/é.test.ts", "an acceptance test with a non-ASCII name"],
			['tests/acceptance/a"b\tc.test.ts', "an acceptance test with a quote and a tab"],
		])("refuses a diff that touches %s (%s)", (path) => {
			expect(refusal(publish({ change: (repo) => write(repo, { [path]: "x" }) }))).toMatch(
				/^PUBLISH refused: the diff touches \.github\/workflows\/ or tests\/acceptance\//m,
			);
		});

		it("refuses a rename out of tests/acceptance/", () => {
			const p = publish({
				baseFiles: { "tests/acceptance/a.test.ts": "test\n" },
				change: (repo) => git(repo, ["mv", "tests/acceptance/a.test.ts", "moved.test.ts"]),
			});
			expect(refusal(p)).toMatch(/^PUBLISH refused: the diff touches /m);
		});
	});

	describe("the body and labels", () => {
		it("refuses a body that doesn't close this issue", () => {
			expect(refusal(publish({ body: "chore: x\n\nCloses #420\n" }))).toMatch(
				/doesn't say Closes #42/,
			);
		});

		it("refuses a body with no title", () => {
			expect(refusal(publish({ body: "\nCloses #42\n" }))).toMatch(/no title on its first line/);
		});

		it("refuses a title over 256 characters", () => {
			expect(refusal(publish({ body: `${"t".repeat(257)}\n\nCloses #42\n` }))).toMatch(
				/title is over 256 characters/,
			);
		});

		it.each(["bug", "factory:ready", "area:Docs", "review:admin,area:x"])(
			"refuses the label %j",
			(label) => {
				expect(refusal(publish({ labels: `${label}\n` }))).toMatch(
					/^PUBLISH refused: the label .* isn't review:admin or area:\*/m,
				);
			},
		);
	});

	describe("the hand-off itself", () => {
		it("refuses an extra entry", () => {
			expect(
				refusal(
					publish({
						extra: (h) => writeFileSync(join(h, "evil.sh"), "x"),
						entries: ["branch", "commits.bundle", "labels", "pr-body.md", "evil.sh"],
					}),
				),
			).toMatch(/^PUBLISH refused: the hand-off holds /m);
		});

		it("refuses a symlink, before unpacking", () => {
			const p = publish({
				extra: (h) => {
					rmSync(join(h, "labels"));
					symlinkSync("/etc/passwd", join(h, "labels"));
				},
			});
			expect(refusal(p)).toMatch(/isn't a regular file/);
		});

		it("refuses a hand-off that isn't a tar.gz", () => {
			const { repo, base } = handoff();
			writeFileSync(join(dir, "handoff.tgz"), "not a tar");
			expect(refusal(run(repo, base))).toMatch(/isn't a readable tar\.gz/);
		});
	});
});
