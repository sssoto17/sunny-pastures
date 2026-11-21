import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../factory-publish.sh", import.meta.url));

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const sh = (cwd, cmd, ...args) => {
	const res = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
		},
	});
	if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${res.stderr}`);
	return res.stdout.trim();
};

// A repo with main, and a hand-off as the factory job builds it: the branch's commits as a bundle
// from main, then the branch deleted, as on the fresh publish runner.
function handoff({
	branch = "42-add-a-line",
	files = { "docs/note.md": "hi\n" },
	body = "chore(docs): add a line (#42)\n\nCloses #42\n",
	labels = "area:docs\nreview:admin\n",
	commits = 1,
	entries,
	extra,
} = {}) {
	dir = mkdtempSync(join(tmpdir(), "factory-publish-"));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	sh(repo, "git", "init", "-q", "-b", "main");
	writeFileSync(join(repo, "README"), "base\n");
	sh(repo, "git", "add", ".");
	sh(repo, "git", "commit", "-qm", "base");
	const base = sh(repo, "git", "rev-parse", "HEAD");
	const h = join(dir, "h");
	mkdirSync(h);
	sh(repo, "git", "switch", "-qc", "work");
	for (let i = 0; i < commits; i++) {
		for (const [p, c] of Object.entries(files)) {
			mkdirSync(join(repo, p, ".."), { recursive: true });
			writeFileSync(join(repo, p), c + i);
		}
		sh(repo, "git", "add", "-A");
		sh(repo, "git", "commit", "-qm", `c${i}`, "--allow-empty");
	}
	sh(repo, "git", "branch", "-m", "work", "tmp");
	// A name git refuses, or main itself, is bundled under another: the script refuses it first.
	const valid = spawnSync("git", ["check-ref-format", "--branch", branch]).status === 0;
	const bundled = valid && branch !== "main" ? branch : "safe";
	sh(repo, "git", "branch", "-f", bundled, "tmp");
	sh(repo, "git", "bundle", "create", "-q", join(h, "commits.bundle"), `${base}..${bundled}`);
	sh(repo, "git", "switch", "-q", "main");
	sh(repo, "git", "branch", "-qD", "tmp", bundled);
	writeFileSync(join(h, "branch"), `${branch}\n`);
	writeFileSync(join(h, "pr-body.md"), body);
	writeFileSync(join(h, "labels"), labels);
	if (extra) extra(h);
	sh(
		h,
		"tar",
		"-czf",
		join(dir, "handoff.tgz"),
		...(entries ?? ["branch", "commits.bundle", "labels", "pr-body.md"]),
	);
	return { repo, base };
}

function publish(opts = {}, { issue = "42" } = {}) {
	const { repo, base } = handoff(opts);
	const work = join(dir, "work");
	mkdirSync(work);
	writeFileSync(join(dir, "out"), "");
	const res = spawnSync("bash", [SCRIPT], {
		cwd: repo,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1",
			ISSUE: issue,
			HANDOFF: join(dir, "handoff.tgz"),
			WORK: work,
			BASE: base,
			GITHUB_OUTPUT: join(dir, "out"),
		},
	});
	const out = readFileSync(join(dir, "out"), "utf8");
	const branches = sh(repo, "git", "branch", "--format=%(refname:short)");
	return { code: res.status, log: res.stdout + res.stderr, out, branches };
}

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

	it.each([
		["another issue's number", "43-add-a-line"],
		["no slug", "42-"],
		["capitals", "42-Add"],
		["main", "main"],
		["a path", "42-a/../../x"],
		["the claude/ prefix", "claude/42-x"],
	])("refuses a branch with %s", (_n, branch) => {
		const p = publish({ branch });
		expect(p.code).toBe(1);
		expect(p.log).toMatch(/^PUBLISH refused: the branch .* isn't 42-<slug>/m);
		expect(p.out).not.toMatch(/^branch=/m);
	});

	it.each([
		[".github/workflows/ci.yml", "a workflow"],
		["tests/acceptance/a.test.ts", "an acceptance test"],
	])("refuses a diff that touches %s (%s)", (path) => {
		const p = publish({ files: { [path]: "x" } });
		expect(p.code).toBe(1);
		expect(p.log).toMatch(/^PUBLISH refused: the diff touches /m);
	});

	it.each(["bug", "factory:ready", "area:Docs", "review:admin,area:x"])(
		"refuses the label %j",
		(label) => {
			const p = publish({ labels: `${label}\n` });
			expect(p.code).toBe(1);
			expect(p.log).toMatch(/^PUBLISH refused: the label .* isn't review:admin or area:\*/m);
		},
	);

	it("refuses a body that doesn't close this issue", () => {
		const p = publish({ body: "chore: x\n\nCloses #420\n" });
		expect(p.code).toBe(1);
		expect(p.log).toMatch(/doesn't say Closes #42/);
	});

	it("refuses a body with no title", () => {
		const p = publish({ body: "\nCloses #42\n" });
		expect(p.code).toBe(1);
		expect(p.log).toMatch(/no title on its first line/);
	});

	it("refuses an extra entry in the hand-off", () => {
		const p = publish({
			extra: (h) => writeFileSync(join(h, "evil.sh"), "x"),
			entries: ["branch", "commits.bundle", "labels", "pr-body.md", "evil.sh"],
		});
		expect(p.code).toBe(1);
		expect(p.log).toMatch(/^PUBLISH refused: the hand-off holds /m);
	});

	it("refuses a symlink in the hand-off, before unpacking", () => {
		const p = publish({
			extra: (h) => {
				rmSync(join(h, "labels"));
				symlinkSync("/etc/passwd", join(h, "labels"));
			},
		});
		expect(p.code).toBe(1);
		expect(p.log).toMatch(/isn't a regular file/);
	});

	it("refuses a hand-off that isn't a tar.gz", () => {
		const p = publish();
		writeFileSync(join(dir, "handoff.tgz"), "not a tar");
		const res = spawnSync("bash", [SCRIPT], {
			cwd: join(dir, "repo"),
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				ISSUE: "42",
				HANDOFF: join(dir, "handoff.tgz"),
				WORK: join(dir, "work"),
				BASE: "HEAD",
				GITHUB_OUTPUT: join(dir, "out"),
			},
		});
		expect(p.code).toBe(0);
		expect(res.status).toBe(1);
		expect(res.stdout).toMatch(/isn't a readable tar\.gz/);
	});
});
