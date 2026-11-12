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

const SCRIPT = fileURLToPath(new URL("../post-review.sh", import.meta.url));

// A fake gh: logs each call on one line, answers reads from fixtures, and refuses the comments
// the test asks it to (FAIL_LINE: every line comment; FAIL_FILE: file comments on that path).
const FAKE_GH = `#!/usr/bin/env bash
d=$(dirname "$0")
a="$*"; printf '%s\\n' "\${a//$'\\n'/\\\\n}" >>"$d/calls"
case "$*" in
  "api repos/o/r/pulls/7 --jq"*) printf '%s\\t%s\\n' "\${FAKE_HEAD:-abc}" "\${FAKE_AUTHOR:-sssoto17}" ;;
  "api repos/o/r/issues/7/labels --jq"*) head -n1 "$d/labels"; tail -n +2 "$d/labels" >"$d/l2"; [ -s "$d/l2" ] && mv "$d/l2" "$d/labels"; true ;;
  "api graphql -F owner"*) cat "$d/threads.json" ;;
  "api --paginate repos/o/r/pulls/7/reviews"*) cat "$d/reviews.json" ;;
  *"-F line="*) [ -z "$FAIL_LINE" ] ;;
  *"subject_type=file"*) [[ " $* " != *" path=$FAIL_FILE "* ]] ;;
esac
`;

const thread = (id, body, { author = "sunny-reviewer", resolved = false, by = null } = {}) => ({
	id,
	isResolved: resolved,
	resolvedBy: by && { login: by },
	comments: { nodes: [{ author: author && { login: author }, body }] },
});
const verdict = (v = {}) =>
	JSON.stringify({
		summary: "merge",
		findings: [],
		escalation_rows: [],
		escalation_path: "",
		resolve_threads: [],
		...v,
	});

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function run(v, { threads = [], labels = ["false"], reviews = [], env = {} } = {}) {
	dir = mkdtempSync(join(tmpdir(), "post-review-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin/gh"), FAKE_GH);
	chmodSync(join(dir, "bin/gh"), 0o755);
	writeFileSync(join(dir, "bin/labels"), `${labels.join("\n")}\n`);
	writeFileSync(join(dir, "bin/threads.json"), JSON.stringify(threads));
	writeFileSync(join(dir, "bin/reviews.json"), JSON.stringify(reviews));
	const files = [
		{ filename: "a.ts", status: "modified" },
		{ filename: "gone.yml", status: "removed" },
		{ filename: "CONSTRAINTS.md", status: "modified" },
	];
	writeFileSync(join(dir, "files.json"), JSON.stringify(files));
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "o/r",
			PR: "7",
			HEAD: "abc",
			BOT: "sunny-reviewer",
			ADMIN: "o",
			FACTORY_APP: "sunny-factory",
			CTX: dir,
			RUNNER_TEMP: dir,
			THREADS_QUERY: "q",
			VERDICT: v,
			...env,
		},
	});
	const log = join(dir, "bin/calls");
	return {
		code: res.status,
		out: res.stdout + res.stderr,
		calls: existsSync(log) ? readFileSync(log, "utf8") : "",
	};
}

describe("post-review.sh", () => {
	it("approves a clean PR and resolves only its own fixed findings", () => {
		const r = run(verdict({ resolve_threads: ["T1", "T4"] }), {
			threads: [thread("T1", "a finding"), thread("T4", "a person's note", { author: "someone" })],
		});
		expect(r.code).toBe(0);
		expect(r.calls).toContain("-f event=APPROVE");
		expect(r.calls).toContain("-F id=T1 -f query=mutation($id: ID!) { resolveReviewThread");
		expect(r.calls).not.toContain("-F id=T4");
		expect(r.calls).not.toContain("labels[]=review:admin");
	});

	it("never approves over its own finding that is still open", () => {
		const r = run(verdict(), { threads: [thread("T1", "a finding")] });
		expect(r.calls).toContain("-f event=COMMENT");
		expect(r.calls).not.toContain("event=APPROVE");
	});

	it("treats its escalation thread as memory, and reopens one only the admin may resolve", () => {
		const r = run(verdict(), {
			threads: [
				thread("E1", "escalated: Code-owned path", { resolved: true, by: "sunny-factory" }),
				thread("E2", "escalated: Feature slice", { resolved: true, by: "o" }),
				thread("X", "a deleted user's note", { author: null }),
			],
		});
		expect(r.code).toBe(0);
		expect(r.calls).toContain("-F id=E1 -f query=mutation($id: ID!) { unresolveReviewThread");
		expect(r.calls).not.toContain("-F id=E2");
		expect(r.calls).toContain("-f event=COMMENT");
		expect(r.calls).not.toContain("subject_type=file");
	});

	it("escalates once: thread, label, the admin's review on a factory PR, own Request changes dismissed", () => {
		const reviews = [
			{ id: 55, user: { login: "sunny-reviewer[bot]" }, state: "CHANGES_REQUESTED" },
			{ id: 56, user: { login: "someone" }, state: "CHANGES_REQUESTED" },
		];
		const rows = {
			escalation_rows: ["Code-owned path", "Interface change"],
			escalation_path: "gone.yml",
		};
		const r = run(verdict(rows), { reviews, env: { FAKE_AUTHOR: "sunny-factory[bot]" } });
		expect(r.calls).toContain(
			"-f path=a.ts -f subject_type=file -f body=escalated: Code-owned path, Interface change\\n\\n@o:",
		);
		expect(r.calls).toContain("labels[]=review:admin");
		expect(r.calls).toContain("reviewers[]=o");
		expect(r.calls).toContain("pulls/7/reviews/55/dismissals");
		expect(r.calls).not.toContain("reviews/56/dismissals");
		expect(r.calls).toContain("-f event=COMMENT");

		const again = run(verdict({ escalation_rows: ["Interface change (sim)"] }), {
			threads: [thread("E1", "escalated: Code-owned path, Interface change")],
		});
		expect(again.calls).not.toContain("body=escalated");
	});

	it("holds the approval when review:admin is added during the run", () => {
		const r = run(verdict(), { labels: ["false", "true"] });
		expect(r.calls).toContain("-f event=COMMENT");
	});

	it("dismisses its own earlier approval once review:admin is on the PR", () => {
		const reviews = [
			{ id: 60, user: { login: "sunny-reviewer[bot]" }, state: "APPROVED" },
			{ id: 61, user: { login: "sssoto17" }, state: "APPROVED" },
		];
		const r = run(verdict(), { labels: ["true"], reviews });
		expect(r.calls).toContain("pulls/7/reviews/60/dismissals");
		expect(r.calls).not.toContain("reviews/61/dismissals");
		expect(r.calls).toContain("-f event=COMMENT");

		const clean = run(verdict(), { reviews });
		expect(clean.calls).not.toContain("dismissals");
		expect(clean.calls).toContain("-f event=APPROVE");
	});

	it("requests changes, placing each finding as well as the diff allows", () => {
		const findings = [
			{ path: "a.ts", line: 3, body: "bug" },
			{ path: "", line: 0, body: "split" },
		];
		const r = run(verdict({ findings }));
		expect(r.calls).toContain("-f path=a.ts -F line=3 -f side=RIGHT -f body=bug");
		expect(r.calls).toMatch(/event=REQUEST_CHANGES -f body=merge.*\(no file\):0 split/);

		// A line that isn't a number is refused before anything runs it as arithmetic.
		const odd = run(
			verdict({ findings: [{ path: "a.ts", line: "x[$(touch pwned)]", body: "odd" }] }),
		);
		expect(odd.code).not.toBe(0);
		expect(existsSync(join(dir, "pwned"))).toBe(false);

		const fallback = run(verdict({ findings: [findings[0]] }), { env: { FAIL_LINE: "1" } });
		expect(fallback.calls).toContain("-f path=a.ts -f subject_type=file -f body=Line 3: bug");
	});

	// A verdict missing a field, or with a field of the wrong type, posts nothing and fails the
	// job: a missing or null escalation_rows must never read as "no rows" (#240 review, 12 Nov).
	const without = (key) => JSON.stringify({ ...JSON.parse(verdict()), [key]: undefined });
	it.each([
		["escalation_rows missing", without("escalation_rows")],
		["escalation_rows null", verdict({ escalation_rows: null })],
		["an empty row", verdict({ escalation_rows: [""] })],
		["a blank row", verdict({ escalation_rows: [" "] })],
		["a newline row", verdict({ escalation_rows: ["\n"] })],
		["a row that isn't a string", verdict({ escalation_rows: [1] })],
		["resolve_threads missing", without("resolve_threads")],
		["a finding without a body", verdict({ findings: [{ path: "a.ts", line: 1 }] })],
		["a string", JSON.stringify("approve")],
		["not JSON", "approve this PR"],
		["empty", ""],
	])("posts nothing for a malformed verdict: %s", (_name, v) => {
		const r = run(v);
		expect(r.code).not.toBe(0);
		expect(r.calls).not.toContain("event=");
		expect(r.calls).not.toContain("/comments");
	});

	it("posts nothing for a verdict holding a credential, or after the head moved", () => {
		const secret = run(verdict({ summary: "sk-ant-oat01-xyz" }));
		expect(secret.code).toBe(1);
		expect(secret.calls).not.toContain("event=");

		const moved = run(verdict(), { env: { FAKE_HEAD: "def" } });
		expect(moved.code).toBe(0);
		expect(moved.calls).not.toContain("event=");
	});
});
