import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { findEarlyClosings, findForeignClosings, ownIssue } from "../pr-body-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../pr-body-guard.mjs", import.meta.url));
const REPO = "sssoto17/sunny-pastures";

// Real bodies that closed an issue early (#270). Each linked its issue on GitHub: read over GraphQL
// (`closingIssuesReferences`) on 16 Nov. Excerpts keep the original line numbers that matter.

// #131, lines 1-18: the keyword sits in a code span in a plan-table cell. It closed #99 on 9 Nov.
const PR_131 = `Part of #99

## What and why

Part 1 of 4 of #99 (split agreed with the admin on 9 Nov). It closes the Exceptions-row gaps the
#40 review found. Before this PR, a row could:
- waive any finding on its path;
- cover the whole repo with \`**\`;
- never expire if its date was unreadable;
- hide in a \`~~~\` fence, or behind an earlier empty \`## Exceptions\` heading.

| Part | Scope |
|---|---|
| **B1 (this PR)** | Exceptions rows: the Rule column, Path breadth, dates, \`FLOOR_GUARD_TODAY\` in CI, fences, repeated headings, hidden expiry |
| B2 | Missed patterns, numbers paired by context, Dependabot SHA-only bumps, the route message (it names the real route: \`main checks\` has no bypass) |
| B3, \`Closes #99\` | Coverage ratchet fails closed, \`check:task\` skips the project ratchet, typecheck reach, ADR-0004's patterns for the guard and the gate |
| B4 | The floor job's own setup (\`actions/setup-node\` directly). Main's guard fails any floor-job edit as \`check-removed\`, so the admin lifts \`main checks\` for that one merge |
`;

// #245, line 1: a negated phrase still links. #68 closed 2 s after the stack merged (13 Nov).
const PR_245 = `Part of #68 (step 4). **Part 3 of 3**, based on part 2, #244 (\`68-tests-a-f-2\`), which is based on part 1, #243. The test design per letter, the runbook, the verification and "For the admin" for the whole stack are in #243's body. This part doesn't close #68: running the tests, the required checks and auto-merge remain.

## Changes made
`;

// #279's first body (16 Nov, from its edit history): prose about the next part. #48 closed at 01:08.
const PR_279 = `Part of #48

Part 1 of 2. Part 2 (based on this branch) adds the two-process gate and \`ci / determinism\`, and closes #48.
`;

const lines = (findings) => findings.map((f) => f.line);

// #426 (merged 21 Nov from claude/lanes-push-admin-2pna8j), lines 1 and 60 of its body: it closed
// #385, as meant, and #386 too, through a code span in a bullet about a refused variable. #386 had
// work left and was reopened (#512).
const PR_426 = `Closes #385
${"\n".repeat(58)}  - A variable naming an issue the body doesn't link (\`38\` against \`Closes #386\`): refused.
`;

describe("findEarlyClosings", () => {
	it("finds #131's code-span keyword in a table cell, on line 16", () => {
		expect(findEarlyClosings(PR_131, REPO)).toEqual([{ line: 16, issue: 99, text: "Closes #99" }]);
	});

	it("finds #245's negated phrase on line 1", () => {
		expect(findEarlyClosings(PR_245, REPO)).toEqual([{ line: 1, issue: 68, text: "close #68" }]);
	});

	it("finds #279's mid-prose phrase about another part, on line 3", () => {
		expect(findEarlyClosings(PR_279, REPO)).toEqual([{ line: 3, issue: 48, text: "closes #48" }]);
	});

	it.each([
		"close",
		"closes",
		"closed",
		"fix",
		"fixes",
		"fixed",
		"resolve",
		"resolves",
		"resolved",
	])("finds each of GitHub's nine keywords: %s", (keyword) => {
		expect(lines(findEarlyClosings(`Part of #7\n\nThis ${keyword} #7.`, REPO))).toEqual([3]);
	});

	it.each(["CLOSES #7", "Closes: #7", "CLOSES: #7", "Fixes:#7", "closes\n#7"])(
		"finds uppercase, a colon and odd spacing: %j",
		(phrase) => {
			expect(findEarlyClosings(`Part of #7\n${phrase}`, REPO)).toHaveLength(1);
		},
	);

	it.each([
		["owner/repo#N", "Closes sssoto17/sunny-pastures#7"],
		["owner/repo#N in another case", "closes SSSOTO17/Sunny-Pastures#7"],
		["an issue URL", "fixes https://github.com/sssoto17/sunny-pastures/issues/7"],
		["an issue URL with www", "fixes https://www.github.com/sssoto17/sunny-pastures/issues/7"],
		["a keyword in an HTML comment", "<!-- resolves #7 -->"],
		["a keyword in a fenced code block", "```\ncloses #7\n```"],
	])("counts %s as a link to #N", (_, phrase) => {
		expect(findEarlyClosings(`Part of #7\n\n${phrase}`, REPO)).toHaveLength(1);
	});

	it.each([
		"  Part of #7",
		"**Part of #7**",
		"**Part of** #7",
		"> Part of #7",
		"- part of #7",
		"1. Part of #7",
		"Part of: #7",
		"| Part of #7 |",
	])("reads a link line with markdown before it: %j", (link) => {
		expect(findEarlyClosings(`${link}\ncloses #7`, REPO)).toHaveLength(1);
	});

	it("counts a Part of written as owner/repo#N", () => {
		expect(findEarlyClosings(`Part of sssoto17/sunny-pastures#7\ncloses #7`, REPO)).toHaveLength(1);
	});

	it("stays fast on a body built to make the patterns backtrack", () => {
		const start = performance.now();
		findEarlyClosings(`Part of #7\n${" \n".repeat(30_000)}close${" ".repeat(60_000)}x`, REPO);
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it("reports every early closing, each on its own line", () => {
		const body = "Part of #7\nPart of #8\nfixes #7\n\nresolves #8 and closes #7";
		expect(findEarlyClosings(body, REPO)).toEqual([
			{ line: 3, issue: 7, text: "fixes #7" },
			{ line: 5, issue: 8, text: "resolves #8" },
			{ line: 5, issue: 7, text: "closes #7" },
		]);
	});

	describe("passes", () => {
		it.each([
			[
				"a closing part (as #280 and #250 are written)",
				"Closes #48\n\nPart 2 of 2, based on #279.",
			],
			["a plain Part of body", "Part of #48\n\nPart 1 of 2, based on main."],
			[
				"the PR template's own comment",
				'Closes # <!-- or "Part of #N" for an earlier part of a split; the last part says Closes -->',
			],
			["a keyword for a different issue", "Part of #48\n\nAlso fixes #51, found on the way."],
			["a longer number", "Part of #48\n\ncloses #480"],
			["another repository's issue", "Part of #48\n\ncloses octo-org/octo-repo#48"],
			["another repository's issue URL", "Part of #48\n\ncloses https://github.com/o/r/issues/48"],
			["a keyword inside a word", "Part of #48\n\nunclosed #48, prefixes #48"],
			["a keyword with a word before the issue", "Part of #48\n\nIt closes the gap #48 found."],
			[
				"#176's owner/repo reference",
				"Part of #88 (part 3 of 4). The report is in sssoto17/sunny-pastures#177's body.",
			],
			[
				"a closing part that quotes the earlier parts' link mid-line (#189)",
				"Closes #85\n\nPart 3 of 3. This is the only part that closes #85; #187 and #188 say `Part of #85`.",
			],
			[
				"a closing part that calls itself the last part of #N (#149)",
				"Closes #125\n\nThe last part of #125.",
			],
			["an empty body", ""],
		])("%s", (_, body) => {
			expect(findEarlyClosings(body, REPO)).toEqual([]);
		});
	});
});

describe("ownIssue", () => {
	it.each([
		["512-merge-closes", 512],
		["claude/issue-512-merge-closes-195im7", 512],
		["claude/512-merge-closes", 512],
		["68-tests-a-f-2", 68],
	])("reads the issue from the branch %s", (branch, issue) => {
		expect(ownIssue(branch, "Closes #9", REPO)).toBe(issue);
	});

	it.each([
		["a Closes line", "Closes #385\n\nText.", 385],
		["a Part of line", "Part of #48\n\nText.", 48],
		["a link line after a quoted one", "> Closes #44 was the old plan\n\nCloses #5", 5],
		["a link line after a fenced one", "```\nCloses #44\n```\nCloses #5", 5],
		["a link line in bold under a heading", "## Link\n\n**Closes** #7", 7],
	])(
		"falls back to the body's first link line when the branch names no issue: %s",
		(_, body, issue) => {
			expect(ownIssue("claude/lanes-push-admin-2pna8j", body, REPO)).toBe(issue);
		},
	);

	it.each(["claude/lanes-push-admin", "dependabot/npm_and_yarn/vitest-4.1.0", "main"])(
		"is null when neither the branch %s nor the body names one",
		(branch) => {
			expect(ownIssue(branch, "Bumps vitest.\n\nIt closes #7 mid-line.", REPO)).toBeNull();
		},
	);
});

describe("findForeignClosings", () => {
	it("finds #426's code-span keyword for #386 on line 60", () => {
		expect(findForeignClosings(PR_426, REPO, 385)).toEqual([
			{ line: 60, issue: 386, text: "Closes #386" },
		]);
	});

	it.each([
		["a code span", "Closes #5\n\nSee `fixes #6`."],
		["a quote", "Closes #5\n\n> resolves #6"],
		["prose", "Closes #5\n\nThis also closed #6 on the way."],
		["a table cell", "Closes #5\n\n| a | fixes #6 |"],
		["an issue URL", "Closes #5\n\nfixes https://github.com/sssoto17/sunny-pastures/issues/6"],
		["an Also line in a quote", "Closes #5\n> Also closes #6"],
		["an Also line in a code span", "Closes #5\n`Also closes #6`"],
		["an Also line with another keyword", "Closes #5\nAlso fixes #6"],
		["an Also line in a fenced block", "Closes #5\n```\nAlso closes #6\n```"],
		["an Also line in an unclosed fence", "Closes #5\n~~~md\n\nAlso closes #6"],
		["a bold keyword", "Closes #5\n**Fixes** #6"],
		["a bold keyword with its colon", "Closes #5\n__Resolves:__ #6"],
	])("finds a keyword for another issue in %s", (_, body) => {
		expect(findForeignClosings(body, REPO, 5).map((f) => f.issue)).toEqual([6]);
	});

	it("stays fast on a body built to make the patterns backtrack", () => {
		const body = `${" \n".repeat(30_000)}${"also ".repeat(20_000)}close${" ".repeat(60_000)}x`;
		const start = performance.now();
		findForeignClosings(body, REPO, 5);
		ownIssue("claude/x", body, REPO);
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it("finds every keyword for an issue when the PR has none of its own", () => {
		expect(lines(findForeignClosings("Bumps x.\n\nfixes #6\ncloses #7", REPO, null))).toEqual([
			3, 4,
		]);
	});

	it("passes the PR template as it stands", () => {
		const template = readFileSync(
			fileURLToPath(new URL("../../pull_request_template.md", import.meta.url)),
			"utf8",
		);
		expect(findForeignClosings(template, REPO, null)).toEqual([]);
		expect(findEarlyClosings(template, REPO)).toEqual([]);
	});

	it("checks the rest of an Also closes line", () => {
		expect(findForeignClosings("Closes #5\nAlso closes #6, fixes #7", REPO, 5)).toEqual([
			{ line: 2, issue: 7, text: "fixes #7" },
		]);
	});

	describe("passes", () => {
		it.each([
			["the own issue, in any form", "Closes #5\n\nfixes sssoto17/sunny-pastures#5, `resolves #5`"],
			["an Also closes line", "Closes #5\nAlso closes #6"],
			["an Also closes line after a closed fence", "Closes #5\n```\nx\n```\nAlso closes #6"],
			["an Also closes line with markdown", "Closes #5\n\n- **Also closes** #6\n  also closes: #7"],
			["another repository's issue", "Closes #5\n\ncloses octo-org/octo-repo#6"],
			["a longer number with a word between", "Closes #5\n\nIt closes the gap #6 found."],
			[
				"the PR template's own comment",
				'Closes # <!-- or "Part of #N" for an earlier part of a split; the last part says Closes -->',
			],
			["an empty body", ""],
		])("%s", (_, body) => {
			expect(findForeignClosings(body, REPO, 5)).toEqual([]);
		});
	});
});

describe("pr-body-guard.mjs", () => {
	let dir;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const run = (event) => {
		dir = mkdtempSync(join(tmpdir(), "pr-body-"));
		const path = join(dir, "event.json");
		if (event !== undefined) writeFileSync(path, JSON.stringify(event));
		const r = spawnSync(process.execPath, [SCRIPT], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: path },
		});
		return { code: r.status, out: r.stdout + r.stderr };
	};
	const event = (body, ref = "48-gate") => ({
		pull_request: { body, head: { ref } },
		repository: { full_name: REPO },
	});

	it("fails #426's body on #386 and names the line", () => {
		const r = run(event(PR_426, "claude/lanes-push-admin-2pna8j"));
		expect(r.code).toBe(1);
		expect(r.out).toContain("line 60: `Closes #386` links #386, but this PR's issue is #385");
		expect(r.out).toContain("::error title=guard / pr-body::");
	});

	it("passes a body with an Also closes line", () => {
		const r = run(event("Closes #385\nAlso closes #386\n\nBoth done.", "385-lanes"));
		expect(r).toEqual({ code: 0, out: expect.stringContaining("pr-body: pass") });
	});

	it("fails a body that closes another issue than the branch's", () => {
		const r = run(event("Closes #513", "512-merge-closes"));
		expect(r.code).toBe(1);
		expect(r.out).toContain("line 1: `Closes #513` links #513, but this PR's issue is #512");
	});

	it("fails #279's first body and names the line and the issue", () => {
		const r = run(event(PR_279));
		expect(r.code).toBe(1);
		expect(r.out).toContain("line 3: `closes #48` links #48");
		expect(r.out).toContain("::error title=guard / pr-body::");
	});

	it("passes a plain Part of body", () => {
		const r = run(event("Part of #48\n\nPart 1 of 2."));
		expect(r).toEqual({ code: 0, out: expect.stringContaining("pr-body: pass") });
	});

	it("passes a PR with no body", () => {
		expect(run(event(null)).code).toBe(0);
	});

	it("can't run without the event file, and never reads that as a pass", () => {
		const r = run(undefined);
		expect(r.code).toBe(2);
		expect(r.out).toContain("cannot run");
	});

	it("prints only the matched keyword and reference, so the body can't run a workflow command", () => {
		const r = run(event("Part of #48\n::warning::closes #48 ::add-mask::x"));
		expect(r.code).toBe(1);
		expect(r.out).toContain("`closes #48`");
		expect(r.out).not.toContain("::warning::");
		expect(r.out).not.toContain("add-mask");
	});
});
