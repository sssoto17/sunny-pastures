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
// the test asks it to (FAIL_LINE: every line comment; FAIL_FILE: file comments on that path;
// FAIL_LABEL: adding a label; FAIL_COMMENT: a plain PR comment; FAIL_STACK: reading the stack).
// Labels reads one line of `labels` per call. FAKE_STACK is the number GET pulls/7 gives for its
// stack ("none" outside one), and GET stacks/<n> answers with `stack.json`.
const FAKE_GH = `#!/usr/bin/env bash
d=$(dirname "$0")
a="$*"; printf '%s\\n' "\${a//$'\\n'/\\\\n}" >>"$d/calls"
case "$*" in
  "api repos/o/r/pulls/7 --jq"*) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${FAKE_HEAD:-$FAKE_HEAD_DEFAULT}" "\${FAKE_AUTHOR:-sssoto17}" PR_node "\${FAKE_AUTO:-false}" "\${FAKE_BASE:-main}" "\${FAKE_STACK:-none}" ;;
  "api repos/o/r/stacks/"*) [ -z "$FAIL_STACK" ] && cat "$d/stack.json" ;;
  "api -X POST repos/o/r/issues/7/labels"*) [ -z "$FAIL_LABEL" ] ;;
  "api -X POST repos/o/r/issues/7/comments"*) [ -z "$FAIL_COMMENT" ] ;;
  *"enablePullRequestAutoMerge"*) [ -z "$FAIL_AUTO" ] ;;
  *"disablePullRequestAutoMerge"*) [ -z "$FAIL_DISABLE" ] ;;
  "api repos/o/r/issues/7/labels --jq"*) head -n1 "$d/labels"; tail -n +2 "$d/labels" >"$d/l2"; [ -s "$d/l2" ] && mv "$d/l2" "$d/labels"; true ;;
  "api graphql -F owner"*) cat "$d/threads.json" ;;
  "api --paginate repos/o/r/pulls/7/reviews"*) cat "$d/reviews.json" ;;
  *"-F line="*) [ -z "$FAIL_LINE" ] ;;
  *"subject_type=file"*) [[ " $* " != *" path=$FAIL_FILE "* ]] ;;
esac
`;

// A fake git that only logs: since #454 the script runs on a runner that never ran the action, so
// it must read the restored base from RESTORED, the hand-off, and never from git.
const FAKE_GIT = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >>"$(dirname "$0")/calls"
`;
const SHA = "b".repeat(40);
const HEAD = "a".repeat(40); // the reviewed head, as review.yml's hand-off carries it
// A stacked part whose base the action restored at the commit the gate read.
const STACKED = { FAKE_BASE: "lane-part1", BASE: "lane-part1", BASE_SHA: SHA, RESTORED: SHA };

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

function run(
	v,
	{ threads = [], labels = ["false"], reviews = [], files = FILES, stack = [], env = {} } = {},
) {
	dir = mkdtempSync(join(tmpdir(), "post-review-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin/gh"), FAKE_GH);
	chmodSync(join(dir, "bin/gh"), 0o755);
	writeFileSync(join(dir, "bin/git"), FAKE_GIT);
	chmodSync(join(dir, "bin/git"), 0o755);
	writeFileSync(join(dir, "bin/labels"), `${labels.join("\n")}\n`);
	writeFileSync(join(dir, "bin/threads.json"), JSON.stringify(threads));
	writeFileSync(join(dir, "bin/reviews.json"), JSON.stringify(reviews));
	writeFileSync(join(dir, "bin/stack.json"), JSON.stringify({ number: 693, pull_requests: stack }));
	writeFileSync(join(dir, "files.json"), JSON.stringify(files));
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "o/r",
			PR: "7",
			HEAD,
			FAKE_HEAD_DEFAULT: HEAD,
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

	// #566 (admin, 26 Nov 2026): escalation is a label plus a plain comment, never a review thread,
	// a finding or a withheld approval. The bot reviews and approves on the code alone; the label
	// and `guard / code-owned` hold the PR for the admin (ADR-0002 area 2, "Solo-admin approvals").
	describe("escalation is a label (#566)", () => {
		const escRows = { escalation_rows: ["Feature slice"], escalation_path: "a.ts" };
		const ownChangesRequested = [
			{ id: 55, user: { login: "sunny-reviewer[bot]" }, state: "CHANGES_REQUESTED" },
		];

		it.each([
			["an App opened (#336)", { FAKE_AUTHOR: "sunny-factory[bot]" }],
			["the admin's account opened", { FAKE_AUTHOR: "o" }],
			["another account opened", { FAKE_AUTHOR: "sssoto17" }],
		])("approves a clean escalated PR %s", (_name, env) => {
			const r = run(verdict(escRows), { env });
			expect(r.code).toBe(0);
			expect(r.calls).toContain("-f event=APPROVE");
			expect(r.calls).not.toContain("event=COMMENT");
			expect(r.out).toContain("escalated=true");
		});

		it("approves a clean labelled PR, and adds no second label or comment", () => {
			for (const v of [verdict(), verdict(escRows)]) {
				const r = run(v, { labels: ["true"], env: { FAKE_AUTO: "true" } });
				expect(r.calls).toContain("-f event=APPROVE");
				expect(r.calls).not.toContain("labels[]=review:admin");
				expect(r.calls).not.toContain("issues/7/comments");
				// The guard already holds it, so auto-merge stays on for the admin's sign-off.
				expect(r.calls).not.toContain("disablePullRequestAutoMerge");
				expect(r.calls).not.toContain("dismissals");
				expect(r.out).toContain("auto_merge=on");
			}
		});

		it("adds review:admin and one plain comment for a missed row, before it approves", () => {
			const r = run(verdict(escRows), { env: { FAKE_AUTHOR: "sunny-factory[bot]" } });
			expect(r.code).toBe(0);
			expect(r.calls).toMatch(
				/issues\/7\/labels --silent -f labels\[\]=review:admin\n[\s\S]*issues\/7\/comments --silent -f body=escalated: Feature slice\\n[\s\S]*-f event=APPROVE/,
			);
			expect(r.calls.match(/issues\/7\/comments/g)).toHaveLength(1);
			// A plain comment: no review thread, and no mention of the admin.
			expect(r.calls).not.toContain("pulls/7/comments");
			expect(r.calls).not.toContain("graphql -F id=");
			expect(r.calls).not.toContain("@o");
			// It says what holds the PR now, and that the review is on the code alone.
			expect(r.calls).toContain("`guard / code-owned` holds it until the admin removes the label");
			expect(r.out).toContain("label_added=true");
			// The script, not the model's summary, names the rows in the review's body.
			expect(r.calls).toMatch(
				/event=APPROVE -f body=merge\\n\\nEscalation rows \(CONSTRAINTS.md\): Feature slice\./,
			);
			// The admin's queue on a factory PR (#37) stays; no request on anyone else's PR.
			expect(r.calls).toContain("reviewers[]=o");
			expect(run(verdict(escRows)).calls).not.toContain("requested_reviewers");
		});

		it("never requests changes, nor withholds, for a missed row alone", () => {
			const r = run(verdict(escRows), { reviews: ownChangesRequested });
			expect(r.calls).not.toContain("REQUEST_CHANGES");
			expect(r.calls).not.toContain("event=COMMENT");
			// Its Approve replaces its own earlier Request changes, so nothing is dismissed.
			expect(r.calls).toContain("-f event=APPROVE");
			expect(r.calls).not.toContain("dismissals");
		});

		it("posts no approval when the label can't be added", () => {
			const r = run(verdict(escRows), { env: { FAIL_LABEL: "1" } });
			expect(r.code).not.toBe(0);
			expect(r.calls).not.toContain("event=");
			expect(r.calls).not.toContain("AutoMerge");
			expect(r.calls).not.toContain("issues/7/comments");
		});

		it("still approves when only the explanation comment fails", () => {
			const r = run(verdict(escRows), { env: { FAIL_COMMENT: "1" } });
			expect(r.code).toBe(0);
			expect(r.out).toContain("::warning::review:admin added, but the escalation comment");
			expect(r.calls).toMatch(/labels\[\]=review:admin[\s\S]*-f event=APPROVE/);
		});

		// The label it just added fires `guard / code-owned`, which may still read green from its
		// last run: auto-merge turned on now could merge before the guard turns red.
		it("doesn't turn on auto-merge on the run that added the label, and turns off one on", () => {
			const r = run(verdict(escRows));
			expect(r.calls).toContain("-f event=APPROVE");
			expect(r.calls).not.toContain("enablePullRequestAutoMerge");
			expect(r.out).toContain("auto_merge=escalated");
			const on = run(verdict(escRows), { env: { FAKE_AUTO: "true" } });
			expect(on.calls).toMatch(/event=APPROVE[\s\S]*disablePullRequestAutoMerge/);
			expect(on.out).toContain("auto_merge=escalated");
			// A stacked part it escalates gets neither.
			const part = run(verdict(escRows), { env: STACKED });
			expect(part.calls).not.toContain("AutoMerge");
			expect(part.out).toContain("auto_merge=escalated");
		});

		it("requests changes on an escalated PR with a Required finding, after labelling it", () => {
			const findings = [{ path: "a.ts", line: 3, body: "bug" }];
			const r = run(verdict({ ...escRows, findings }));
			expect(r.calls).toMatch(/labels\[\]=review:admin[\s\S]*event=REQUEST_CHANGES/);
			expect(r.calls).toContain("body=escalated: Feature slice");
			// The finding is the only thread it posts.
			expect(r.calls.match(/pulls\/7\/comments/g)).toHaveLength(1);
		});

		it("withholds the approval while a finding thread of its own is open", () => {
			const r = run(verdict(escRows), {
				threads: [thread("T1", "a finding")],
				reviews: ownChangesRequested,
			});
			expect(r.calls).toContain("labels[]=review:admin");
			expect(r.calls).toContain("-f event=COMMENT");
			expect(r.calls).not.toContain("event=APPROVE");
			// Its Request changes stays: the finding isn't fixed.
			expect(r.calls).not.toContain("dismissals");
		});

		// Threads stop being memory: an escalation thread from before #566, open or resolved by
		// anyone, neither escalates the PR, nor holds the approval, nor is touched.
		it("reopens no thread and reads no escalation thread as memory", () => {
			const r = run(verdict({ resolve_threads: ["E2"] }), {
				threads: [
					thread("E1", "escalated: Code-owned path", { resolved: true, by: "sunny-factory" }),
					thread("E2", "escalated: Feature slice"),
					thread("E3", "escalated: Feature slice", { resolved: true, by: "o" }),
					thread("X", "a deleted user's note", { author: null }),
				],
			});
			expect(r.code).toBe(0);
			expect(r.calls).not.toContain("unresolveReviewThread");
			expect(r.calls).not.toContain("resolveReviewThread");
			expect(r.calls).not.toContain("labels[]=review:admin");
			expect(r.calls).toContain("-f event=APPROVE");
			expect(r.out).toContain("escalated=false");
		});

		it("never lets a finding pass for an escalation thread", () => {
			const findings = [{ path: "a.ts", line: 3, body: "escalated: not really" }];
			const r = run(verdict({ findings }));
			expect(r.calls).toContain("-F line=3 -f side=RIGHT -f body=Finding: escalated: not really");
			const padded = run(verdict({ findings: [{ ...findings[0], body: "  escalated: x" }] }));
			expect(padded.calls).toContain("-f body=Finding:   escalated: x");
		});
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
		expect(r.calls).toContain(`issues/7/comments --silent -f body=escalated: ${row}\\n`);
		expect(r.calls).toContain("labels[]=review:admin");
		expect(r.calls).toContain("-f event=APPROVE");
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

	it("keeps its earlier approval once review:admin is on the PR: the guard holds it", () => {
		const reviews = [{ id: 60, user: { login: "sunny-reviewer[bot]" }, state: "APPROVED" }];
		const r = run(verdict(), { labels: ["true"], reviews });
		expect(r.calls).not.toContain("dismissals");
		expect(r.calls).toContain("-f event=APPROVE");
	});

	// #274: once per head, except ADR-0002 test (e). review-gate.sh runs first in review.yml.
	it("on a head it approved, runs again only for review:admin, and then approves again", () => {
		const approval = { id: 60, user: { login: "sunny-reviewer[bot]" }, state: "APPROVED" };
		const asGathered = [
			{ author: "sunny-reviewer[bot]", state: "APPROVED", body: "merge", commit_id: HEAD },
		];
		const gate = (action, labels = []) => {
			const d = mkdtempSync(join(tmpdir(), "gate-"));
			writeFileSync(join(d, "reviews.json"), JSON.stringify(asGathered));
			writeFileSync(
				join(d, "pr.json"),
				JSON.stringify({ head_sha: HEAD, base: "main", stack: null, labels }),
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

		// Since #566 the label no longer holds the approval: `guard / code-owned` holds the PR, so
		// the re-run approves again and leaves its approval and auto-merge alone.
		const r = run(verdict(), { labels: ["true"], reviews: [approval], env: { FAKE_AUTO: "true" } });
		expect(r.calls).not.toContain("dismissals");
		expect(r.calls).not.toContain("AutoMerge");
		expect(r.calls).toContain("-f event=APPROVE");
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
		expect(r.calls).toContain(`-f id=PR_node -f head=${HEAD}`);
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

	// #695: part 1 of a native stack is based on main, so the base alone doesn't show it's a part.
	// Its typecheck, lint and test skip (only the top part runs them), so auto-merge would merge it
	// alone, untested, without the stack's one merge. The live GET pulls/<n> names its stack, and
	// GET stacks/<n> whether an open part sits above it (ADR-0002 area 2, "Auto-merge").
	describe("part 1 of a native stack, on main (#695)", () => {
		const part = (number, state = "open") => ({ number, state });
		const inStack = { FAKE_STACK: "693" };

		it("approves part 1 but never turns its auto-merge on while a part above is open", () => {
			const r = run(verdict(), { stack: [part(7), part(8)], env: inStack });
			expect(r.code).toBe(0);
			expect(r.calls).toContain("-f event=APPROVE");
			expect(r.calls).toContain("api repos/o/r/stacks/693");
			expect(r.calls).not.toContain("AutoMerge");
			expect(r.out).toContain("auto_merge=stacked");
			expect(r.out).toContain("stack=693");
		});

		it("turns off auto-merge someone turned on, after the approval", () => {
			const r = run(verdict(), {
				stack: [part(7), part(8)],
				env: { ...inStack, FAKE_AUTO: "true" },
			});
			expect(r.calls).toMatch(/event=APPROVE[\s\S]*disablePullRequestAutoMerge/);
			expect(r.calls).not.toContain("enablePullRequestAutoMerge");
			expect(r.out).toContain("auto_merge=stacked");
		});

		it("holds a part on main whose stack it can't read, or that the stack doesn't list", () => {
			for (const opts of [
				{ stack: [part(7), part(8)], env: { ...inStack, FAIL_STACK: "1" } },
				{ stack: [part(5), part(8)], env: inStack },
				{ stack: [part(7), part(8)], env: { FAKE_STACK: "unknown" } },
			]) {
				const r = run(verdict(), opts);
				expect(r.code).toBe(0);
				expect(r.calls).toContain("-f event=APPROVE");
				expect(r.calls).not.toContain("enablePullRequestAutoMerge");
				expect(r.out).toContain("auto_merge=stacked");
			}
		});

		it("treats the last open part on main as a single PR: the parts above were closed", () => {
			const top = run(verdict(), {
				stack: [part(6, "closed"), part(7), part(8, "closed")],
				env: inStack,
			});
			expect(top.calls).toContain("enablePullRequestAutoMerge");
			expect(top.out).toContain("auto_merge=on");
			expect(top.out).toContain("stack=693");
		});

		it("leaves a single PR on main outside any stack as it was: on, or refused", () => {
			const on = run(verdict());
			expect(on.calls).not.toContain("stacks/");
			expect(on.calls).toContain("enablePullRequestAutoMerge");
			expect(on.out).toContain("auto_merge=on");
			expect(on.out).toContain("stack=none");
			const refused = run(verdict(), { env: { FAIL_AUTO: "1" } });
			expect(refused.out).toContain("auto_merge=refused");
		});

		it("never reads the stack without an approval, and still turns auto-merge off", () => {
			const findings = [{ path: "a.ts", line: 3, body: "bug" }];
			const r = run(verdict({ findings }), {
				stack: [part(7), part(8)],
				env: { ...inStack, FAKE_AUTO: "true" },
			});
			expect(r.calls).toContain("disablePullRequestAutoMerge");
			expect(r.calls).not.toContain("enablePullRequestAutoMerge");
			expect(r.out).toContain("auto_merge=off");
		});
	});

	// #404 (admin, 21 Nov 2026): the gate read the base's files at BASE_SHA, and the action fetched
	// origin/<base> 20-60 s later to restore config from it. A part below that moved in between
	// means the review ran with config the gate never saw. Since #454 the model's job records that
	// commit as RESTORED ("none" when the action fetched no base) and hands it to the post job.
	it.each([
		["the part below moved", { RESTORED: "c".repeat(40) }],
		["the action fetched no base", { RESTORED: "none" }],
		["the hand-off carries no restored commit", { RESTORED: undefined }],
		["gather recorded no base commit", { BASE_SHA: "" }],
		["neither commit was recorded", { BASE_SHA: "", RESTORED: "" }],
		["both are the same thing but no SHA", { BASE_SHA: "main", RESTORED: "main" }],
		["the base isn't a plain branch name", { BASE: "lane part1", FAKE_BASE: "lane part1" }],
	])("posts nothing on a stacked part when %s", (_name, env) => {
		const r = run(verdict(), { env: { ...STACKED, ...env } });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("nothing posted");
		expect(r.calls).not.toMatch(/^api /m);
	});

	it("takes the restored base from the hand-off, never from git, and ignores it on main", () => {
		const stacked = run(verdict(), { env: STACKED });
		expect(stacked.code).toBe(0);
		expect(stacked.calls).toContain("-f event=APPROVE");
		expect(stacked.calls).not.toContain("git ");
		const onMain = run(verdict(), { env: { RESTORED: "none" } });
		expect(onMain.code).toBe(0);
		expect(onMain.calls).not.toContain("git ");
	});

	// #454: HEAD comes from the model's job, so it must be a commit SHA before anything is read.
	it.each([["abc"], [""], [`${"a".repeat(40)}\n`], ["A".repeat(40)]])(
		"posts nothing when the hand-off's head is %j",
		(head) => {
			const r = run(verdict(), { env: { HEAD: head } });
			expect(r.code).not.toBe(0);
			expect(r.out).toContain("the reviewed head isn't a commit SHA: nothing posted");
			expect(r.calls).toBe("");
		},
	);

	// #454: the post job runs --check before it mints the App's token. It needs no token: it calls
	// nothing, and stops after the hand-off's checks with what the full run would have refused.
	describe("--check", () => {
		const check = (v, env = {}) => {
			dir = mkdtempSync(join(tmpdir(), "post-review-check-"));
			mkdirSync(join(dir, "bin"));
			writeFileSync(join(dir, "bin/gh"), FAKE_GH);
			chmodSync(join(dir, "bin/gh"), 0o755);
			writeFileSync(join(dir, "bin/git"), FAKE_GIT);
			chmodSync(join(dir, "bin/git"), 0o755);
			const res = spawnSync("bash", [SCRIPT, "--check"], {
				cwd: dir,
				encoding: "utf8",
				env: {
					PATH: `${join(dir, "bin")}:${process.env.PATH}`,
					RUNNER_TEMP: dir,
					DEFAULT_BRANCH: "main",
					BASE: "main",
					HEAD,
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
		};

		it("passes a well-formed hand-off without a token or a call", () => {
			const r = check(verdict());
			expect(r.code).toBe(0);
			expect(r.out).toContain("CHECK ok");
			expect(r.calls).toBe("");
			const stacked = check(verdict(), { BASE: "lane-part1", BASE_SHA: SHA, RESTORED: SHA });
			expect(stacked.code).toBe(0);
			expect(stacked.calls).toBe("");
		});

		it.each([
			["a verdict of the wrong shape", verdict({ findings: null }), {}],
			["a verdict holding a credential", verdict({ summary: "sk-ant-oat01-xyz" }), {}],
			["no verdict", "", {}],
			["a head that isn't a SHA", verdict(), { HEAD: "abc" }],
			[
				"a stacked part whose base moved",
				verdict(),
				{ BASE: "p1", BASE_SHA: SHA, RESTORED: "none" },
			],
		])("refuses %s", (_name, v, env) => {
			const r = check(v, env);
			expect(r.code).not.toBe(0);
			expect(r.out).toContain("nothing posted");
			expect(r.out).not.toContain("CHECK ok");
			expect(r.calls).toBe("");
		});
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
		const open = [thread("T1", "a finding")];
		const held = run(verdict(), { threads: open, env: { FAKE_AUTO: "true" } });
		expect(held.calls).toContain("-f event=COMMENT");
		expect(held.calls).not.toContain("enablePullRequestAutoMerge");
		expect(held.calls).toMatch(/disablePullRequestAutoMerge[\s\S]*event=COMMENT/);

		// A refused disable still posts the review that withholds the approval.
		const stuck = run(verdict(), {
			threads: open,
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
