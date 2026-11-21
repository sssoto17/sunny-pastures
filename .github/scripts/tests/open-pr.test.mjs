import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../open-pr.sh", import.meta.url));

// A fake gh: logs each call on one line and answers from files in its folder. branches and
// labels list what exists, one per line; open.<branch> holds the number of that branch's open PR;
// stack.<n> the stack PR #n is in. POST pulls saves its stdin to pull.json and answers 41 with node
// id PR_41; POST stacks answers 50; POST graphql (the ready mark) logs its variables. FAIL_* refuse
// a call, as GitHub would with a 403 or 422.
const FAKE_GH = `#!/usr/bin/env bash
d=$(dirname "$0")
a="$*"; printf '%s\\n' "\${a//$'\\n'/\\\\n}" >>"$d/calls"
R=repos/o/r
case "$*" in
  "api $R/branches/"*" --jq .name") b=\${2#$R/branches/}; grep -qxF -- "$b" "$d/branches" && echo "$b" || { echo "gh: Branch not found (HTTP 404)" >&2; exit 1; } ;;
  "api $R/pulls?head=o:"*) b=\${2#$R/pulls?head=o:}; b=\${b%&state=open}; cat "$d/open.$b" 2>/dev/null; true ;;
  "api -X POST $R/pulls --input - --jq "*) [ -z "$FAIL_PULL" ] || { echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; }; cat >"$d/pull.json"; echo 41 PR_41 ;;
  "api $R/labels/"*" --jq .name") l=\${2#$R/labels/}; grep -qxF -- "$l" "$d/labels" && echo "$l" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  "api -X POST $R/issues/41/labels"*) [ -z "$FAIL_LABELS" ] || { echo "gh: Forbidden (HTTP 403)" >&2; exit 1; } ;;
  "api $R/pulls/"*" --jq "*) n=\${2#$R/pulls/}; cat "$d/stack.$n" 2>/dev/null; true ;;
  "api -X POST $R/stacks/"*"/add "*) [ -z "$FAIL_STACK" ] || { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; } ;;
  "api -X POST $R/stacks "*) [ -z "$FAIL_STACK" ] || { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; }; echo 50 ;;
  "api -X POST graphql "*) [ -z "$FAIL_READY" ] || { echo "gh: Resource not accessible by integration" >&2; exit 1; } ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
`;

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

function run(
	env = {},
	{ branches = ["336-open-pr", "main"], labels = [], open = {}, stacks = {} } = {},
) {
	dir = mkdtempSync(join(tmpdir(), "open-pr-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), FAKE_GH);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(join(bin, "branches"), `${branches.join("\n")}\n`);
	writeFileSync(join(bin, "labels"), `${labels.join("\n")}\n`);
	for (const [b, n] of Object.entries(open)) writeFileSync(join(bin, `open.${b}`), `${n}\n`);
	for (const [n, s] of Object.entries(stacks)) writeFileSync(join(bin, `stack.${n}`), `${s}\n`);
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "o/r",
			GITHUB_OUTPUT: join(dir, "output"),
			GITHUB_STEP_SUMMARY: join(dir, "summary"),
			BRANCH: "336-open-pr",
			BASE: "",
			TITLE: "feat(ci): open PRs as the App (#336)",
			BODY: "Closes #336.",
			LABELS: "",
			...env,
		},
	});
	return {
		code: res.status,
		out: res.stdout + res.stderr,
		calls: read(join(bin, "calls")),
		pull: existsSync(join(bin, "pull.json")) ? JSON.parse(read(join(bin, "pull.json"))) : null,
		output: read(join(dir, "output")),
		summary: read(join(dir, "summary")),
	};
}

describe("open-pr.sh (the workflow's step)", () => {
	it("opens the PR on main over REST, with the payload's title and body as data", () => {
		const r = run();
		expect(r.code).toBe(0);
		expect(r.pull).toEqual({
			title: "feat(ci): open PRs as the App (#336)",
			head: "336-open-pr",
			base: "main",
			body: "Closes #336.",
			draft: true,
		});
		expect(r.output).toContain("pr=41\n");
		expect(r.summary).toContain("#41");
	});

	// #358: opened as a draft, then marked ready by the App, so ready_for_review starts its CI.
	it("marks the draft ready with the App's token, the node id as a variable", () => {
		const r = run();
		expect(r.calls).toContain(
			"api -X POST graphql --silent -f id=PR_41 -f query=mutation($id: ID!)",
		);
		expect(r.calls).toContain("markPullRequestReadyForReview(input: {pullRequestId: $id})");
		expect(r.output).toContain("ready=yes\n");
		expect(r.summary).toContain("Marked it ready for review.");
	});

	it("leaves the PR a draft when READY is false (scripts/stack.sh marks it ready)", () => {
		const r = run({ READY: "false" });
		expect(r.code).toBe(0);
		expect(r.pull.draft).toBe(true);
		expect(r.calls).not.toContain("graphql");
		expect(r.output).toContain("ready=no\n");
	});

	it("fails, with the PR still open, when the ready mark is refused", () => {
		const r = run({ FAIL_READY: "1" });
		expect(r.code).toBe(1);
		expect(r.output).toContain("pr=41\n");
		expect(r.output).toContain("ready=failed\n");
		expect(r.out).toContain("::error title=open-pr::#41 is open but still a draft");
	});

	// The payload is untrusted: whatever it holds stays a value, never shell code.
	it("keeps shell syntax in the title and body as text", () => {
		const nasty = "$(touch pwned) `touch pwned2` ${HOME} '; exit 0; \"";
		const r = run({ TITLE: `fix: ${nasty}`, BODY: `${nasty}\n@file` });
		expect(r.code).toBe(0);
		expect(r.pull.title).toBe(`fix: ${nasty}`);
		expect(r.pull.body).toBe(`${nasty}\n@file`);
		expect(existsSync(join(dir, "pwned"))).toBe(false);
		expect(existsSync(join(dir, "pwned2"))).toBe(false);
	});

	// A refusal names the value, so a newline in it must not start a workflow command of its own.
	it("never lets payload text start a workflow command", () => {
		const r = run({
			BRANCH: "x\n::stop-commands::t0k\n::add-mask::%y",
			LABELS: "a\n::warning::fake",
		});
		expect(r.code).toBe(2);
		expect(r.out).not.toMatch(/^::(stop-commands|add-mask)/m);
		expect(r.out).toContain("x%0A::stop-commands::t0k%0A::add-mask::%25y");
		const l = run({ LABELS: "a\n::warning::fake" });
		expect(l.out).not.toMatch(/^::warning::fake/m);
	});

	it.each([
		["main", "never opens a PR from main"],
		["prototype/persistence", "isn't a lane branch"],
		["dependabot/npm/x", "isn't a lane branch"],
		["336_open", "isn't a lane branch"],
		["-336-x", "isn't a lane branch"],
		["", "isn't a lane branch"],
		// a name of dots only is a path step, not a name (the reviewer's finding on #343)
		["claude/..", "isn't a lane branch"],
		["claude/.", "isn't a lane branch"],
	])("refuses the branch %j", (branch, why) => {
		const r = run({ BRANCH: branch }, { branches: [branch, "main"] });
		expect(r.code).toBe(2);
		expect(r.out).toContain(why);
		expect(r.calls).not.toContain("POST");
	});

	it.each(["336-open-pr", "101-103-setup-wizards-2", "claude/lanes-pr-sunny-factory-mdcucg"])(
		"accepts the lane branch %j",
		(branch) => {
			const r = run({ BRANCH: branch }, { branches: [branch, "main"] });
			expect(r.code).toBe(0);
			expect(r.pull.head).toBe(branch);
		},
	);

	it("refuses a branch that isn't on origin", () => {
		const r = run({}, { branches: ["main"] });
		expect(r.code).toBe(2);
		expect(r.out).toContain("no branch 336-open-pr on origin");
		expect(r.calls).not.toContain("POST");
	});

	it("refuses a branch that already has an open PR", () => {
		const r = run({}, { open: { "336-open-pr": 40 } });
		expect(r.code).toBe(2);
		expect(r.out).toContain("already has PR #40");
		expect(r.calls).not.toContain("POST");
	});

	it.each([
		[{ TITLE: "  " }, "no title"],
		[{ TITLE: "x".repeat(257) }, "title is over 256"],
		[{ BODY: "x".repeat(65537) }, "body is over 65536"],
		[{ BASE: "prototype/persistence" }, "base prototype/persistence isn't main or a lane branch"],
		[{ BASE: "336-open-pr" }, "onto itself"],
		[{ READY: "yes" }, "READY is 'yes', not true or false"],
	])("refuses %j", (env, why) => {
		const r = run(env);
		expect(r.code).toBe(2);
		expect(r.out).toContain(why);
		expect(r.out).toContain("::error");
		expect(r.calls).not.toContain("POST");
	});

	it("adds only labels that exist, and warns about the rest", () => {
		const r = run(
			{ LABELS: "review:admin, area:ci-cd,nosuch,bad label" },
			{ labels: ["review:admin", "area:ci-cd"] },
		);
		expect(r.code).toBe(0);
		expect(r.calls).toContain(
			"api -X POST repos/o/r/issues/41/labels --silent -f labels[]=review:admin -f labels[]=area:ci-cd",
		);
		expect(r.out).toContain("::warning title=open-pr::label nosuch doesn't exist");
		expect(r.out).toContain("::warning title=open-pr::label bad label");
		expect(r.calls).not.toContain("labels/bad");
	});

	// GET labels/.. would resolve to the repo itself, and POST would then create a label "..".
	it("never treats a name of dots only as a label", () => {
		const r = run({ LABELS: "..,.,review:admin" }, { labels: ["..", ".", "review:admin"] });
		expect(r.code).toBe(0);
		expect(r.out).toContain("::warning title=open-pr::label ..: not a label name here");
		expect(r.calls).not.toMatch(/labels\/\.\.?( |$)/m);
		expect(r.calls).toContain("--silent -f labels[]=review:admin\n");
	});

	it("keeps the PR when labelling is refused, with a warning", () => {
		const r = run({ LABELS: "review:admin" }, { labels: ["review:admin"] });
		expect(r.code).toBe(0);
		const f = run({ LABELS: "review:admin", FAIL_LABELS: "1" }, { labels: ["review:admin"] });
		expect(f.code).toBe(0);
		expect(f.out).toContain("::warning title=open-pr::adding the labels to #41 failed");
		expect(f.output).toContain("pr=41\n");
	});

	describe("a stack part (base is the part below)", () => {
		const below = { branches: ["336-b", "336-a", "main"], open: { "336-a": 40 } };

		it("refuses a base with no open PR", () => {
			const r = run({ BRANCH: "336-b", BASE: "336-a" }, { branches: below.branches });
			expect(r.code).toBe(2);
			expect(r.out).toContain("336-a has no open PR");
			expect(r.calls).not.toContain("POST");
		});

		it("starts a stack with the part below when it has none, then marks the part ready", () => {
			const r = run({ BRANCH: "336-b", BASE: "336-a" }, below);
			expect(r.code).toBe(0);
			expect(r.pull.base).toBe("336-a");
			expect(r.calls).toContain(
				"api -X POST repos/o/r/stacks -F pull_requests[]=40 -F pull_requests[]=41 --jq .number",
			);
			expect(r.calls.indexOf("graphql")).toBeGreaterThan(r.calls.indexOf("/stacks"));
			expect(r.output).toContain("stack=50\n");
			expect(r.summary).toContain("stack #50");
		});

		it("adds the PR to the stack the part below is in", () => {
			const r = run({ BRANCH: "336-b", BASE: "336-a" }, { ...below, stacks: { 40: 50 } });
			expect(r.code).toBe(0);
			expect(r.calls).toContain("api -X POST repos/o/r/stacks/50/add -F pull_requests[]=41");
			expect(r.output).toContain("stack=50\n");
		});

		// Record whether /stacks accepts an App token; never fail the run over it (#336).
		it("keeps the PR when the App token can't link the stack", () => {
			const r = run({ BRANCH: "336-b", BASE: "336-a", FAIL_STACK: "1" }, below);
			expect(r.code).toBe(0);
			expect(r.output).toContain("pr=41\n");
			expect(r.output).toContain("stack=refused\n");
			expect(r.out).toContain("::warning title=open-pr::linking #41 into a stack failed");
			expect(r.out).toContain("HTTP 403");
			// unlinked, it stays a draft: its ready mark waits for scripts/stack.sh's link
			expect(r.calls).not.toContain("graphql");
			expect(r.output).toContain("ready=no\n");
		});
	});

	it("fails when GitHub refuses the PR", () => {
		const r = run({ FAIL_PULL: "1" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("::error title=open-pr::opening the PR failed");
	});
});
