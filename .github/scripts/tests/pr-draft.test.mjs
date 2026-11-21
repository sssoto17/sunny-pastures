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

const SCRIPT = fileURLToPath(new URL("../pr-draft.sh", import.meta.url));

// A fake gh: logs each call on one line and answers from files in its folder. pr.<n> holds PR #n's
// "<state>\t<draft>\t<repo>\t<head ref>\t<node id>" line, as the script's --jq @tsv reads it; a
// missing file is a 404. POST graphql logs its variables and, with FAIL_GRAPHQL, refuses.
const FAKE_GH = `#!/usr/bin/env bash
d=$(dirname "$0")
a="$*"; printf '%s\\n' "\${a//$'\\n'/\\\\n}" >>"$d/calls"
R=repos/o/r
case "$*" in
  "api $R/pulls/"*" --jq "*) n=\${2#$R/pulls/}; cat "$d/pr.$n" 2>/dev/null || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  "api -X POST graphql "*) [ -z "$FAIL_GRAPHQL" ] || { echo "gh: Resource not accessible by integration" >&2; exit 1; } ;;
  *) echo "fake: unexpected gh call: $*" >&2; exit 99 ;;
esac
`;

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const pr = (draft, { state = "open", repo = "o/r", head = "358-ci", id = "PR_x" } = {}) =>
	[state, String(draft), repo, head, id].join("\t");

function run(env, prs) {
	dir = mkdtempSync(join(tmpdir(), "pr-draft-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), FAKE_GH);
	chmodSync(join(bin, "gh"), 0o755);
	for (const [n, line] of Object.entries(prs)) writeFileSync(join(bin, `pr.${n}`), `${line}\n`);
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "o/r",
			GITHUB_OUTPUT: join(dir, "output"),
			GITHUB_STEP_SUMMARY: join(dir, "summary"),
			...env,
		},
	});
	const calls = read(join(bin, "calls"));
	return {
		code: res.status,
		out: res.stdout + res.stderr,
		calls,
		writes: calls.split("\n").filter((l) => l.includes("graphql")),
		output: read(join(dir, "output")),
		summary: read(join(dir, "summary")),
	};
}

describe("pr-draft.sh (the workflow's step)", () => {
	it("marks drafts ready with markPullRequestReadyForReview, the node id as a variable", () => {
		const r = run(
			{ STATE: "ready", PRS: "41,42" },
			{ 41: pr(true, { id: "PR_41" }), 42: pr(true, { head: "claude/x-1", id: "PR_42" }) },
		);
		expect(r.code).toBe(0);
		expect(r.writes).toHaveLength(2);
		expect(r.writes[0]).toContain("markPullRequestReadyForReview(input: {pullRequestId: $id})");
		expect(r.writes[0]).toContain("-f id=PR_41");
		expect(r.writes[1]).toContain("-f id=PR_42");
		expect(r.output).toContain("switched=41,42\n");
		expect(r.summary).toContain("#41 #42 ready as the App");
	});

	it("turns ready PRs into drafts with convertPullRequestToDraft", () => {
		const r = run({ STATE: "draft", PRS: "41" }, { 41: pr(false) });
		expect(r.code).toBe(0);
		expect(r.writes[0]).toContain("convertPullRequestToDraft(input: {pullRequestId: $id})");
	});

	// A PR in the asked state raises no event, and a number twice is switched once.
	it("leaves a PR already in the state alone, and switches a repeated number once", () => {
		const r = run({ STATE: "ready", PRS: "41,42,42" }, { 41: pr(false), 42: pr(true) });
		expect(r.code).toBe(0);
		expect(r.out).toContain("#41 is ready already");
		expect(r.writes).toHaveLength(1);
		expect(r.output).toContain("switched=42\n");
	});

	it.each([
		[{ STATE: "", PRS: "41" }, "the state '' isn't draft or ready"],
		[{ STATE: "closed", PRS: "41" }, "the state 'closed' isn't draft or ready"],
		[{ STATE: "ready", PRS: "" }, "aren't PR numbers"],
		[{ STATE: "ready", PRS: "41;rm -rf /" }, "aren't PR numbers"],
		[{ STATE: "ready", PRS: "41,,42" }, "aren't PR numbers"],
		[{ STATE: "ready", PRS: "041" }, "aren't PR numbers"],
		[{ STATE: "ready", PRS: "../41" }, "aren't PR numbers"],
		[
			{ STATE: "ready", PRS: Array.from({ length: 21 }, (_, i) => i + 1).join(",") },
			"more than 20",
		],
	])("refuses the payload %j before any call", (env, why) => {
		const r = run(env, { 41: pr(true) });
		expect(r.code).toBe(2);
		expect(r.out).toContain("::error title=pr-draft::");
		expect(r.out).toContain(why);
		expect(r.calls).toBe("");
	});

	// Every PR is checked first: one refusal means nothing is written, even for the PRs before it.
	it.each([
		[{ 42: pr(true, { state: "closed" }) }, "#42 isn't open"],
		[{ 42: pr(true, { repo: "fork/r" }) }, "#42 comes from another repository"],
		[{ 42: pr(true, { repo: "" }) }, "#42 comes from another repository"],
		[{ 42: pr(true, { head: "main" }) }, "#42's head main isn't a lane branch"],
		[{ 42: pr(true, { head: "claude/.." }) }, "#42's head claude/.. isn't a lane branch"],
		[{}, "can't read PR #42"],
	])("refuses every write when a PR fails its check (%j)", (more, why) => {
		const r = run({ STATE: "ready", PRS: "41,42" }, { 41: pr(true), ...more });
		expect(r.code).toBe(2);
		expect(r.out).toContain(why);
		expect(r.writes).toHaveLength(0);
	});

	it("never lets payload text start a workflow command", () => {
		const r = run({ STATE: "x\n::add-mask::%y", PRS: "41" }, {});
		expect(r.code).toBe(2);
		expect(r.out).not.toMatch(/^::add-mask/m);
		expect(r.out).toContain("x%0A::add-mask::%25y");
	});

	it("fails when GitHub refuses a switch, and names the PR", () => {
		const r = run({ STATE: "ready", PRS: "41", FAIL_GRAPHQL: "1" }, { 41: pr(true) });
		expect(r.code).toBe(1);
		expect(r.out).toContain("::error title=pr-draft::GitHub refused to mark #41 ready");
		expect(r.output).toContain("switched=\n");
	});
});
