import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkFix } from "../factory-fix-gate.mjs";
import { newestVerdict, requiredFindings, wantsFixes } from "../factory-review.mjs";

const GATE = fileURLToPath(new URL("../factory-fix-gate.mjs", import.meta.url));
const HEAD = "f6cd23e7243ac2e33c0f65a4024a352086d1a6aa";
const OLD = "0123456789abcdef0123456789abcdef01234567";
const BOT_EMAIL = "355564973+sunny-factory[bot]@users.noreply.github.com";
const REPO = "sssoto17/sunny-pastures";

// PR #586's review body (sunny-reviewer[bot], 22 Nov 2026), shortened.
const BODY_586 = `merge after fixes: PR #586 at f6cd23e, full

Findings
1. [Required, confirmed] \`review:admin\` is missing, and the body says there is no admin review.
Fix: add \`review:admin\`, correct the two Review lines, and post the comment.
2. [Optional] Name the helper for its concept.

Escalation rows: Code-owned path (\`docs/adr/0003-simulation-design.md\`).
- [Required] not a finding: this list isn't under Findings.
`;

// A review as `GET …/pulls/{n}/reviews` returns it, trimmed.
const review = ({
	state = "CHANGES_REQUESTED",
	body = BODY_586,
	commit = HEAD,
	at = "2026-11-22T22:47:40Z",
	login = "sunny-reviewer[bot]",
} = {}) => ({ user: { login }, state, body, commit_id: commit, submitted_at: at });

describe("newestVerdict", () => {
	it("takes the reviewer's newest review, skipping empty line-comment reviews, dismissed ones and other authors", () => {
		const verdict = review({ at: "2026-11-22T22:47:40Z" });
		const reviews = [
			review({ state: "COMMENTED", body: "", at: "2026-11-22T22:47:36Z" }),
			verdict,
			review({ state: "COMMENTED", body: "", at: "2026-11-22T22:48:00Z" }),
			review({ state: "DISMISSED", body: "merge", at: "2026-11-22T22:49:00Z" }),
			review({ state: "APPROVED", body: "merge", at: "2026-11-22T22:50:00Z", login: "sssoto17" }),
		];
		expect(newestVerdict(reviews)).toBe(verdict);
		expect(newestVerdict([review({ body: " " })])).toBeNull();
	});
});

describe("wantsFixes", () => {
	it("reads Request changes, or a first line that starts 'merge after fixes'", () => {
		expect(wantsFixes(review())).toBe(true);
		expect(wantsFixes(review({ state: "COMMENTED", body: "merge after fixes: PR #1" }))).toBe(true);
		expect(wantsFixes(review({ state: "COMMENTED", body: "merge after admin review: x" }))).toBe(
			false,
		);
		expect(wantsFixes(review({ state: "APPROVED", body: "merge: PR #1" }))).toBe(false);
	});
});

describe("requiredFindings", () => {
	it("keeps the Required items under Findings, with their continuation lines", () => {
		expect(requiredFindings(BODY_586)).toEqual([
			"1. [Required, confirmed] `review:admin` is missing, and the body says there is no admin review.\n" +
				"Fix: add `review:admin`, correct the two Review lines, and post the comment.",
		]);
	});

	it("finds none without a Findings list", () => {
		expect(requiredFindings("merge after fixes\n\n1. [Required] x")).toEqual([]);
	});
});

const pull = (over = {}) => ({
	number: 586,
	state: "open",
	user: { login: "sunny-factory[bot]" },
	head: { ref: "541-owned-entry-list", sha: HEAD, repo: { full_name: REPO } },
	...over,
});
const commit = (email = BOT_EMAIL) => ({ commit: { author: { email }, committer: { email } } });
const check = (over = {}) =>
	checkFix({
		pr: "586",
		head: HEAD,
		issue: "",
		maxTurns: "",
		repo: REPO,
		pull: pull(),
		reviews: [review()],
		commits: [commit()],
		botEmail: BOT_EMAIL,
		...over,
	});

describe("checkFix", () => {
	it("passes a factory PR the reviewer sent back on its head, with the issue from the branch", () => {
		expect(check()).toMatchObject({
			pr: 586,
			issue: 541,
			branch: "541-owned-entry-list",
			head: HEAD,
			turns: 100,
		});
		expect(check().findings).toHaveLength(1);
	});

	it.each([
		["an issue as well", { issue: "541" }, /issue or a pr, not both/],
		["a pr that isn't a number", { pr: "586; x" }, /isn't a number/],
		["a short head", { head: "f6cd23e" }, /full commit SHA/],
		["max_turns over the cap", { maxTurns: "101" }, /from 1 to 100/],
		["a closed PR", { pull: pull({ state: "closed" }) }, /is closed/],
		[
			"a PR another author opened",
			{ pull: pull({ user: { login: "sssoto17" } }) },
			/wasn't opened/,
		],
		[
			"a lane PR (commits not the bot's)",
			{ commits: [commit(), commit("noreply@anthropic.com")] },
			/the factory didn't make it/,
		],
		[
			"a fork's branch",
			{ pull: pull({ head: { ...pull().head, repo: { full_name: "x/y" } } }) },
			/isn't in/,
		],
		["a PR that moved", { head: OLD }, /moved/],
		["a verdict on an older head", { reviews: [review({ commit: OLD })] }, /isn't on f6cd23e/],
		[
			"a verdict that doesn't ask for fixes",
			{ reviews: [review({ state: "APPROVED", body: "merge: PR #586" })] },
			/doesn't ask for fixes/,
		],
		[
			"no Required finding",
			{ reviews: [review({ body: "merge after fixes\n\nFindings\n1. [Optional] x\n" })] },
			/no Required finding/,
		],
	])("refuses %s", (_n, over, why) => {
		expect(check(over).refusal).toMatch(why);
	});
});

describe("factory-fix-gate.mjs", () => {
	let dir;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	const gate = (env, files = {}) => {
		dir = mkdtempSync(join(tmpdir(), "factory-fix-gate-"));
		const put = (name, value) => writeFileSync(join(dir, name), value);
		put("pr.json", JSON.stringify(pull()));
		put("commits.json", JSON.stringify([commit()]));
		put("reviews.json", JSON.stringify(files.reviews ?? [review()]));
		put("out", "");
		const res = spawnSync("node", [GATE], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				PR: "586",
				HEAD,
				PR_JSON: join(dir, "pr.json"),
				REVIEWS_JSON: join(dir, "reviews.json"),
				COMMITS_JSON: join(dir, "commits.json"),
				BOT_EMAIL,
				GITHUB_REPOSITORY: REPO,
				FINDINGS: join(dir, "findings.md"),
				GITHUB_OUTPUT: join(dir, "out"),
				...env,
			},
		});
		return {
			code: res.status,
			log: res.stdout + res.stderr,
			out: readFileSync(join(dir, "out"), "utf8"),
		};
	};

	it("writes the checked values and the Required findings", () => {
		const g = gate({});
		expect(g.code).toBe(0);
		expect(g.out).toBe(
			`pr=586\nissue=541\nbranch=541-owned-entry-list\nhead=${HEAD}\nturns=100\nrun=true\n`,
		);
		expect(readFileSync(join(dir, "findings.md"), "utf8")).toMatch(/^1\. \[Required, confirmed\]/);
	});

	it("refuses with run=false, one GATE line and an escaped annotation", () => {
		const g = gate({ HEAD: OLD });
		expect(g.code).toBe(0);
		expect(g.out).toBe("run=false\n");
		expect(g.log).toMatch(/^GATE refused: PR #586 moved/m);
	});

	it("fails rather than guess on a file that isn't an array", () => {
		expect(gate({}, { reviews: { message: "Not Found" } }).code).toBe(2);
	});
});
