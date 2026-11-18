import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../review-gate.sh", import.meta.url));

// A review as review.yml's gather step writes it to reviews.json.
const review = (
	state,
	{ body = "summary", commit = "abc", author = "sunny-reviewer[bot]" } = {},
) => ({
	id: 1,
	author,
	state,
	submitted_at: "2026-11-16T10:00:00Z",
	body,
	commit_id: commit,
});

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// ADMIN marks a PR that carries review:admin, as gather's pr.json lists its labels.
const ADMIN = { labels: ["review:admin"] };

function gate(action, reviews, { labels = [], files = {} } = {}) {
	dir = mkdtempSync(join(tmpdir(), "review-gate-"));
	writeFileSync(join(dir, "reviews.json"), JSON.stringify(reviews));
	writeFileSync(join(dir, "pr.json"), JSON.stringify({ head_sha: "abc", labels }));
	writeFileSync(join(dir, "out"), "");
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			ACTION: action,
			BOT: "sunny-reviewer",
			PR_JSON: join(dir, files.pr ?? "pr.json"),
			REVIEWS: join(dir, files.reviews ?? "reviews.json"),
			GITHUB_OUTPUT: join(dir, "out"),
		},
	});
	return {
		code: res.status,
		out: res.stdout + res.stderr,
		run: readFileSync(join(dir, "out"), "utf8").match(/^run=(.*)$/m)?.[1],
	};
}

describe("review-gate.sh", () => {
	it.each(["synchronize", "reopened", "ready_for_review", "opened"])(
		"skips a %s run on a head the App already reviewed",
		(action) => {
			const g = gate(action, [review("COMMENTED")]);
			expect(g.code).toBe(0);
			expect(g.run).toBe("false");
			expect(g.out).toContain("GATE skip");
		},
	);

	// Each line or file comment post-review.sh posts is its own COMMENTED review with an empty
	// body (PR #280: two reviews at 2a46ae8, 2 s apart). Only the summary review ends a run.
	it.each([
		["no review yet", []],
		[
			"only an empty-body comment review: the run died before its summary",
			[review("COMMENTED", { body: "" })],
		],
		["a review of an older head", [review("APPROVED", { commit: "old" })]],
		["someone else's review of this head", [review("APPROVED", { author: "sssoto17" })]],
		["another App's review of this head", [review("COMMENTED", { author: "sunny-factory[bot]" })]],
	])("reviews a head after %s", (_name, reviews) => {
		const g = gate("synchronize", reviews);
		expect(g.code).toBe(0);
		expect(g.run).toBe("true");
	});

	// ADR-0002 test (e): review:admin added after an approval re-runs the review, which dismisses
	// the approval and turns auto-merge off. The job's `if:` lets through only that label, added
	// by someone other than the App.
	it("reviews a reviewed head again when review:admin is added after its approval", () => {
		const g = gate("labeled", [review("COMMENTED", { body: "" }), review("APPROVED")], ADMIN);
		expect(g.run).toBe("true");
		expect(g.out).toContain("GATE run");
	});

	// cancel-in-progress: a reopened or ready_for_review at the same head cancels that labeled run
	// mid-way, so the run that replaces it must withdraw the approval in its place.
	it.each(["reopened", "ready_for_review", "synchronize"])(
		"still withdraws the approval on a %s run that cancelled the labeled one",
		(action) => {
			expect(gate(action, [review("APPROVED")], ADMIN).run).toBe("true");
		},
	);

	it("skips any other event after that approval while review:admin is off", () => {
		expect(gate("synchronize", [review("APPROVED")]).run).toBe("false");
		expect(gate("reopened", [review("APPROVED")]).run).toBe("false");
	});

	it.each([
		["a summary that already held the approval", [review("COMMENTED")]],
		["an approval already dismissed", [review("DISMISSED"), review("COMMENTED")]],
		["Request changes", [review("CHANGES_REQUESTED")]],
		["someone else's approval", [review("COMMENTED"), review("APPROVED", { author: "sssoto17" })]],
	])("skips review:admin added after %s: there is no approval to withdraw", (_name, reviews) => {
		expect(gate("labeled", reviews, ADMIN).run).toBe("false");
	});

	it("reviews an unreviewed head whatever the event", () => {
		expect(gate("labeled", [], ADMIN).run).toBe("true");
	});

	it.each(["reviews", "pr"])("fails, rather than guess, when %s can't be read", (which) => {
		const g = gate("synchronize", [], { files: { [which]: "missing.json" } });
		expect(g.code).not.toBe(0);
		expect(g.run).toBeUndefined();
	});
});
// The gate saves money only if review.yml asks it before Claude runs, from the reviews with their
// commit_id. The workflow runs from main on pull_request_target, so a PR can't prove this live.
describe("review.yml", () => {
	const yml = readFileSync(
		fileURLToPath(new URL("../../workflows/review.yml", import.meta.url)),
		"utf8",
	);
	const at = (s) => {
		const i = yml.indexOf(s);
		expect(i, s).toBeGreaterThan(-1);
		return i;
	};

	it("asks the gate in gather, before the diff, the threads and Claude", () => {
		const gate = at("REVIEWS=$CTX/reviews.json bash .github/scripts/review-gate.sh");
		expect(at('"$CTX/pr.json"')).toBeLessThan(gate);
		expect(at("submitted_at, body, commit_id}")).toBeLessThan(gate);
		expect(at("if grep -qx 'run=false' \"$GITHUB_OUTPUT\"; then exit 0; fi")).toBeGreaterThan(gate);
		expect(at("gh pr diff")).toBeGreaterThan(gate);
		expect(at("gh api graphql")).toBeGreaterThan(gate);
		expect(at("- id: claude\n        if: steps.gather.outputs.run == 'true'\n")).toBeGreaterThan(
			gate,
		);
	});

	it("keeps the allowed claude-code-action pin (#290)", () => {
		expect(yml).toContain("anthropics/claude-code-action@61a9c274fa7110a66dfafc1bbbced03833eb25fe");
	});

	// #68 (admin, 18 Nov 2026): the review runs the code-review-and-quality skill. A typed /skill
	// loads only a registered skill, and `--setting-sources user` registers ~/.claude/skills only,
	// so a step copies main's skill there before Claude runs. `project` stays out: it would load the
	// repo's .mcp.json (the action sets enableAllProjectMcpServers), hooks and allow rules.
	describe("the review skill", () => {
		const claudeArgs = yml.slice(at("claude_args: >-"), at("# Minted after Claude has finished"));

		it("copies main's skill into the user's skills before Claude runs", () => {
			const step = at("- name: Install the review skill (main's copy)\n");
			expect(at("uses: actions/checkout@")).toBeLessThan(step);
			expect(step).toBeLessThan(at("- id: claude\n"));
		});

		// .claude/skills/code-review-and-quality is a symlink into .agents/skills/ (mode 120000): a
		// plain `cp -R` copies the link, which dangles under $HOME, and the skill never registers.
		it("leaves a real SKILL.md under $HOME, not a link", () => {
			const lines = yml.slice(at("- name: Install the review skill (main's copy)\n")).split("\n");
			const from = lines.findIndex((l) => l.trim() === "run: |") + 1;
			const end = lines.findIndex((l, i) => i >= from && l.trim() === "");
			const script = lines
				.slice(from, end)
				.map((l) => l.trim())
				.join("\n");
			const home = mkdtempSync(join(tmpdir(), "review-skill-"));
			try {
				const root = fileURLToPath(new URL("../../..", import.meta.url));
				const r = spawnSync("bash", ["-c", script], {
					cwd: root,
					env: { ...process.env, HOME: home },
					encoding: "utf8",
				});
				expect(r.status, r.stderr).toBe(0);
				const dir = join(home, ".claude/skills/code-review-and-quality");
				expect(lstatSync(dir).isSymbolicLink()).toBe(false);
				expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toMatch(
					/^---\nname: code-review-and-quality\n/,
				);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		it("invokes the skill as the prompt's first word", () => {
			expect(yml).toMatch(
				/prompt: >-\n\s+\/code-review-and-quality Read \.github\/review-prompt\.md/,
			);
		});

		it("still loads user settings only, with no MCP servers", () => {
			expect(claudeArgs).toContain("--setting-sources user\n");
			expect(claudeArgs).not.toMatch(/project|local|--mcp-config/);
		});

		it("still gives Claude Read, Grep and Glob only, Skill denied", () => {
			expect(claudeArgs).toContain('--allowedTools "Read,Grep,Glob"');
			const denied = claudeArgs.match(/--disallowedTools "([^"]*)"/)?.[1].split(",");
			expect(denied).toEqual(
				expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task", "Skill"]),
			);
		});

		it("reports whether the skill was registered, from the init message", () => {
			expect(yml).toContain("RESULT skill=code-review-and-quality registered=");
		});
	});
});
