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
const GATE = fileURLToPath(new URL("../review-gate.sh", import.meta.url));
const CODEOWNERS = fileURLToPath(new URL("../../CODEOWNERS", import.meta.url)); // the real file

// A fake gh: logs each call on one line, answers reads from fixtures, and refuses the comments
// the test asks it to (FAIL_LINE: every line comment; FAIL_FILE: file comments on that path).
// A label it adds shows on later reads, unless FAKE_NO_LABEL (as once #104 retires review:admin).
const FAKE_GH = `#!/usr/bin/env bash
d=$(dirname "$0")
a="$*"; printf '%s\\n' "\${a//$'\\n'/\\\\n}" >>"$d/calls"
case "$*" in
  "api repos/o/r/pulls/7 --jq"*) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${FAKE_HEAD:-abc}" "\${FAKE_AUTHOR:-sssoto17}" PR_node "\${FAKE_AUTO:-false}" "\${FAKE_AUTHOR_TYPE:-User}" "\${FAKE_BASE:-main}" ;;
  "api -X POST repos/o/r/issues/7/labels"*) [ -n "$FAKE_NO_LABEL" ] || echo true >"$d/labels" ;;
  *"enablePullRequestAutoMerge"*) [ -z "$FAIL_AUTO" ] ;;
  *"disablePullRequestAutoMerge"*) [ -z "$FAIL_DISABLE" ] ;;
  "api repos/o/r/issues/7/labels --jq"*) head -n1 "$d/labels"; tail -n +2 "$d/labels" >"$d/l2"; [ -s "$d/l2" ] && mv "$d/l2" "$d/labels"; true ;;
  "api graphql -F owner"*) cat "$d/threads.json" ;;
  "api --paginate repos/o/r/pulls/7/reviews"*) cat "$d/reviews.json" ;;
  *"-F line="*) [ -z "$FAIL_LINE" ] ;;
  *"subject_type=file"*) [[ " $* " != *" path=$FAIL_FILE "* ]] ;;
esac
`;

// A fake git for post-review.sh's base check (#404): `rev-parse` answers FAKE_ORIGIN, the commit
// origin/<base> points at after the action's fetch, or fails as for a ref it never fetched.
const FAKE_GIT = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >>"$(dirname "$0")/calls"
[[ $1 == rev-parse && -n $FAKE_ORIGIN ]] && echo "$FAKE_ORIGIN"
`;
const SHA = "b".repeat(40);
// A stacked part whose base the action restored at the commit the gate read.
const STACKED = { FAKE_BASE: "lane-part1", BASE: "lane-part1", BASE_SHA: SHA, FAKE_ORIGIN: SHA };

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

// None of the default files is code-owned or content, so only the verdict decides.
const FILES = [
	{ filename: "a.ts", status: "modified" },
	{ filename: "gone.yml", status: "removed" },
	{ filename: "notes.md", status: "modified" },
];

function run(v, { threads = [], labels = ["false"], reviews = [], files = FILES, env = {} } = {}) {
	dir = mkdtempSync(join(tmpdir(), "post-review-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin/gh"), FAKE_GH);
	chmodSync(join(dir, "bin/gh"), 0o755);
	writeFileSync(join(dir, "bin/git"), FAKE_GIT);
	chmodSync(join(dir, "bin/git"), 0o755);
	writeFileSync(join(dir, "bin/labels"), `${labels.join("\n")}\n`);
	writeFileSync(join(dir, "bin/threads.json"), JSON.stringify(threads));
	writeFileSync(join(dir, "bin/reviews.json"), JSON.stringify(reviews));
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
			DEFAULT_BRANCH: "main",
			BASE: "main",
			CODEOWNERS,
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

	// #322: the escalation thread alone holds the merge, so the bot approves a clean escalated PR,
	// but only one the admin's account opened: the author's login and type come from REST, never
	// from text the PR wrote. On an App-opened PR (#336) it withholds (ADR-0002 area 2, #264).
	const ADMIN_PR = { FAKE_AUTHOR: "o", FAKE_AUTHOR_TYPE: "User" };
	const escRows = { escalation_rows: ["Feature slice"], escalation_path: "a.ts" };
	const changesRequested = [
		{ id: 55, user: { login: "sunny-reviewer[bot]" }, state: "CHANGES_REQUESTED" },
	];

	it("approves a clean escalated PR the admin's account opened, posting the thread that holds it", () => {
		const r = run(verdict(escRows), { env: { ...ADMIN_PR, FAKE_NO_LABEL: "1" } });
		expect(r.code).toBe(0);
		expect(r.calls).toContain("-f path=a.ts -f subject_type=file -f body=escalated: Feature slice");
		expect(r.calls).toMatch(
			/body=escalated[\s\S]*-f event=APPROVE[\s\S]*enablePullRequestAutoMerge/,
		);
		expect(r.calls).not.toContain("reviewers[]=o");
		expect(r.out).toContain("escalated=true");

		// On a later run its open thread is the memory, and still the gate: approve, never resolve.
		const again = run(verdict(), {
			threads: [thread("E1", "escalated: Feature slice")],
			env: ADMIN_PR,
		});
		expect(again.calls).toContain("-f event=APPROVE");
		expect(again.calls).not.toContain("-F id=E1");
		expect(again.calls).not.toContain("body=escalated");

		// A thread someone else resolved is reopened first, so it holds the approval again.
		const reopened = run(verdict(), {
			threads: [thread("E1", "escalated: Feature slice", { resolved: true, by: "sunny-factory" })],
			env: ADMIN_PR,
		});
		expect(reopened.calls).toMatch(/-F id=E1 [^\n]*unresolveReviewThread[\s\S]*-f event=APPROVE/);
	});

	it.each([
		["an App opened (#336)", { FAKE_AUTHOR: "sunny-factory[bot]", FAKE_AUTHOR_TYPE: "Bot" }],
		["another account opened", { FAKE_AUTHOR: "sssoto17", FAKE_AUTHOR_TYPE: "User" }],
		["a Bot with the admin's login opened", { FAKE_AUTHOR: "o", FAKE_AUTHOR_TYPE: "Bot" }],
	])("withholds its approval on a clean escalated PR %s", (_name, env) => {
		const first = run(verdict(escRows), {
			reviews: changesRequested,
			env: { ...env, FAKE_NO_LABEL: "1" },
		});
		expect(first.calls).toContain("-f subject_type=file -f body=escalated: Feature slice");
		expect(first.calls).toContain("-f event=COMMENT");
		expect(first.calls).not.toContain("event=APPROVE");
		expect(first.calls).not.toContain("enablePullRequestAutoMerge");
		// Withheld for good, so its own fixed Request changes mustn't block the admin's approval.
		expect(first.calls).toContain("pulls/7/reviews/55/dismissals");

		const later = run(verdict(), { threads: [thread("E1", "escalated: Feature slice")], env });
		expect(later.calls).toContain("-f event=COMMENT");
		expect(later.calls).not.toContain("event=APPROVE");
	});

	it("after the admin resolved its thread, approves no later head: nothing would hold it", () => {
		const done = thread("E1", "escalated: Feature slice", { resolved: true, by: "o" });
		for (const v of [verdict(), verdict({ escalation_rows: ["Interface change"] })]) {
			const r = run(v, { threads: [done], env: { ...ADMIN_PR, FAKE_NO_LABEL: "1" } });
			expect(r.calls).toContain("-f event=COMMENT");
			expect(r.calls).not.toContain("event=APPROVE");
			expect(r.calls).not.toContain("-F id=E1");
		}
	});

	it("never lets a finding pass for an escalation thread", () => {
		const findings = [{ path: "a.ts", line: 3, body: "escalated: not really" }];
		const r = run(verdict({ findings }));
		expect(r.calls).toContain("-F line=3 -f side=RIGHT -f body=Finding: escalated: not really");
		const padded = run(verdict({ findings: [{ ...findings[0], body: "  escalated: x" }] }));
		expect(padded.calls).toContain("-f body=Finding:   escalated: x");
	});

	it("approves an escalated PR only while its escalation thread is on the PR", () => {
		// No file took the thread: nothing would hold the merge, so it withholds.
		const files = [{ filename: "gone.yml", status: "removed" }];
		const r = run(verdict(escRows), { files, env: { ...ADMIN_PR, FAKE_NO_LABEL: "1" } });
		expect(r.calls).toContain("Escalation thread not posted");
		expect(r.calls).toContain("-f event=COMMENT");
		expect(r.calls).not.toContain("event=APPROVE");
	});

	it("until #104, the review:admin it adds on escalating holds the approval", () => {
		const r = run(verdict(escRows), { env: ADMIN_PR });
		expect(r.calls).toContain("-f subject_type=file -f body=escalated: Feature slice");
		expect(r.calls).toContain("labels[]=review:admin");
		expect(r.calls).toContain("-f event=COMMENT");
		expect(r.calls).not.toContain("event=APPROVE");
	});

	it("requests changes on an escalated PR with a Required finding, and still posts the thread", () => {
		const findings = [{ path: "a.ts", line: 3, body: "bug" }];
		const r = run(verdict({ ...escRows, findings }), {
			reviews: changesRequested,
			env: { ...ADMIN_PR, FAKE_NO_LABEL: "1" },
		});
		expect(r.calls).toContain("-f subject_type=file -f body=escalated: Feature slice");
		expect(r.calls).toContain("-f event=REQUEST_CHANGES");
		expect(r.calls).not.toContain("dismissals");

		// An open earlier finding of its own holds the approval too, and its Request changes stays.
		const open = run(verdict(), {
			threads: [thread("E1", "escalated: Feature slice"), thread("T1", "a finding")],
			reviews: changesRequested,
			env: ADMIN_PR,
		});
		expect(open.calls).toContain("-f event=COMMENT");
		expect(open.calls).not.toContain("dismissals");
	});

	it("on an escalated PR it approves, its Approve replaces its own Request changes", () => {
		const r = run(verdict(), {
			threads: [thread("E1", "escalated: Feature slice")],
			reviews: changesRequested,
			env: ADMIN_PR,
		});
		expect(r.calls).toContain("-f event=APPROVE");
		expect(r.calls).not.toContain("dismissals");
	});

	// A verdict with no rows still escalates on the rows a path decides (#240 review, 12 Nov).
	it.each([
		[
			"a code-owned path",
			[{ filename: ".github/workflows/x.yml", status: "added" }],
			"Code-owned path",
		],
		[
			"a nested package.json",
			[{ filename: "packages/sim/package.json", status: "modified" }],
			"Code-owned path",
		],
		[
			"a rename out of a code-owned path",
			[{ filename: "notes/x.md", status: "renamed", previous_filename: "docs/adr/x.md" }],
			"Code-owned path",
		],
		[
			"a content file",
			[{ filename: "packages/sim/src/content/numbers.ts", status: "modified" }],
			"Content change",
		],
	])("escalates on %s whatever the verdict says", (_name, files, row) => {
		const r = run(verdict(), { files });
		expect(r.calls).toContain(`-f subject_type=file -f body=escalated: ${row}`);
		expect(r.calls).toContain("labels[]=review:admin");
		expect(r.calls).toContain("-f event=COMMENT");
		expect(r.calls).not.toContain("event=APPROVE");
	});

	it("merges the verdict's rows with the path rows, once each", () => {
		const files = [{ filename: "AGENTS.md", status: "modified" }];
		const r = run(verdict({ escalation_rows: ["Interface change", "Code-owned path"] }), { files });
		expect(r.calls).toContain("body=escalated: Interface change, Code-owned path\\n");
	});

	it("leaves a content test and an unowned docs file to the verdict", () => {
		const files = [
			{ filename: "packages/sim/src/content/tests/a.test.ts", status: "modified" },
			{ filename: "docs/diagrams/other.md", status: "modified" },
		];
		expect(run(verdict(), { files }).calls).toContain("-f event=APPROVE");
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

	// #274: once per head, except ADR-0002 test (e). review-gate.sh runs first in review.yml.
	it("on a head it approved, runs again only for review:admin, and then holds the approval", () => {
		const approval = { id: 60, user: { login: "sunny-reviewer[bot]" }, state: "APPROVED" };
		const asGathered = [
			{ author: "sunny-reviewer[bot]", state: "APPROVED", body: "merge", commit_id: "abc" },
		];
		const gate = (action, labels = []) => {
			const d = mkdtempSync(join(tmpdir(), "gate-"));
			writeFileSync(join(d, "reviews.json"), JSON.stringify(asGathered));
			writeFileSync(
				join(d, "pr.json"),
				JSON.stringify({ head_sha: "abc", base: "main", stack: null, labels }),
			);
			writeFileSync(join(d, "out"), "");
			spawnSync("bash", [GATE], {
				env: {
					PATH: process.env.PATH,
					ACTION: action,
					BOT: "sunny-reviewer",
					ADMIN: "sssoto17",
					DEFAULT_BRANCH: "main",
					PR_JSON: join(d, "pr.json"),
					REVIEWS: join(d, "reviews.json"),
					GITHUB_OUTPUT: join(d, "out"),
				},
			});
			const out = readFileSync(join(d, "out"), "utf8");
			rmSync(d, { recursive: true, force: true });
			return out.trim();
		};
		for (const action of ["synchronize", "reopened", "ready_for_review"])
			expect(gate(action), action).toBe("run=false");
		expect(gate("labeled", ["review:admin"])).toBe("run=true");

		const r = run(verdict(), { labels: ["true"], reviews: [approval], env: { FAKE_AUTO: "true" } });
		expect(r.calls).toContain("pulls/7/reviews/60/dismissals");
		expect(r.calls).toContain("disablePullRequestAutoMerge");
		expect(r.calls).toContain("-f event=COMMENT");
		expect(r.calls).not.toContain("event=APPROVE");
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

	// ADR-0002 area 2, flow step 3: approve, then turn on auto-merge for the reviewed head. Never
	// a merge: with the repo's allow_auto_merge off, GitHub refuses and nothing merges (Q16).
	it("turns on auto-merge after an approval, for the reviewed head only", () => {
		const r = run(verdict());
		expect(r.code).toBe(0);
		expect(r.calls).toMatch(/event=APPROVE[\s\S]*enablePullRequestAutoMerge/);
		expect(r.calls).toContain("-f id=PR_node -f head=abc");
		expect(r.calls).toContain("mergeMethod: SQUASH");
		expect(r.calls).not.toContain("pr merge");
		expect(r.out).toContain("auto_merge=on");

		const off = run(verdict(), { env: { FAIL_AUTO: "1" } });
		expect(off.code).toBe(0);
		expect(off.calls).toContain("-f event=APPROVE");
		expect(off.out).toContain("auto_merge=refused");

		// Test (d): after a push, the fresh approval finds auto-merge still on and leaves it.
		const still = run(verdict(), { env: { FAKE_AUTO: "true" } });
		expect(still.calls).not.toContain("AutoMerge");
		expect(still.out).toContain("auto_merge=on");
	});

	// #404: the reviewer now approves stacked parts. Auto-merge on a part based on the part below
	// would merge it into that branch on its own, and a stack merges whole (CONSTRAINTS.md).
	it("approves a stacked part but never leaves its auto-merge on", () => {
		const r = run(verdict(), { env: STACKED });
		expect(r.code).toBe(0);
		expect(r.calls).toContain("-f event=APPROVE");
		expect(r.calls).not.toContain("AutoMerge");
		expect(r.out).toContain("auto_merge=stacked");

		// Someone turned it on before: the approval turns it off rather than let the part merge.
		const on = run(verdict(), { env: { ...STACKED, FAKE_AUTO: "true" } });
		expect(on.calls).toMatch(/event=APPROVE[\s\S]*disablePullRequestAutoMerge/);
		expect(on.calls).not.toContain("enablePullRequestAutoMerge");
		expect(on.out).toContain("auto_merge=stacked");

		const findings = [{ path: "a.ts", line: 3, body: "bug" }];
		const held = run(verdict({ findings }), {
			env: { ...STACKED, FAKE_AUTO: "true" },
		});
		expect(held.calls).toContain("disablePullRequestAutoMerge");
	});

	// #404 (admin, 21 Nov 2026): the gate read the base's files at BASE_SHA, and the action fetched
	// origin/<base> 20-60 s later to restore config from it. A part below that moved in between
	// means the review ran with config the gate never saw.
	it.each([
		["the part below moved", { FAKE_ORIGIN: "c".repeat(40) }],
		["the action fetched no base", { FAKE_ORIGIN: "" }],
		["gather recorded no base commit", { BASE_SHA: "" }],
	])("posts nothing on a stacked part when %s", (_name, env) => {
		const r = run(verdict(), { env: { ...STACKED, ...env } });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("nothing posted");
		expect(r.calls).not.toMatch(/^api /m);
	});

	it("reads origin/<base> by its full ref, and never on a PR on main", () => {
		expect(run(verdict(), { env: STACKED }).calls).toContain(
			`git rev-parse --verify --quiet refs/remotes/origin/lane-part1^{commit}`,
		);
		const onMain = run(verdict());
		expect(onMain.code).toBe(0);
		expect(onMain.calls).not.toContain("git ");
	});

	// `set -u` alone would let an empty one through, and an empty DEFAULT_BRANCH reads every PR
	// as a stacked part.
	it.each([
		["DEFAULT_BRANCH", undefined],
		["DEFAULT_BRANCH", ""],
		["BASE", undefined],
		["BASE", ""],
	])("posts nothing when %s is %j", (name, value) => {
		const r = run(verdict(), { env: { [name]: value } });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain(`${name}: parameter null or not set`);
		expect(r.calls).toBe("");
	});

	it("never turns on auto-merge without an approval, and turns off one that is on", () => {
		const held = run(verdict(), { labels: ["true"], env: { FAKE_AUTO: "true" } });
		expect(held.calls).toContain("-f event=COMMENT");
		expect(held.calls).not.toContain("enablePullRequestAutoMerge");
		expect(held.calls).toMatch(/disablePullRequestAutoMerge[\s\S]*event=COMMENT/);

		// A refused disable still posts the review that withholds the approval.
		const stuck = run(verdict(), {
			labels: ["true"],
			env: { FAKE_AUTO: "true", FAIL_DISABLE: "1" },
		});
		expect(stuck.code).toBe(0);
		expect(stuck.calls).toContain("-f event=COMMENT");

		const findings = [{ path: "a.ts", line: 3, body: "bug" }];
		const changes = run(verdict({ findings }));
		expect(changes.calls).not.toContain("AutoMerge");
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
