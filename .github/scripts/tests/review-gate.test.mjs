import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function gate(action, reviews) {
	dir = mkdtempSync(join(tmpdir(), "review-gate-"));
	writeFileSync(join(dir, "reviews.json"), JSON.stringify(reviews));
	writeFileSync(join(dir, "out"), "");
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			ACTION: action,
			HEAD: "abc",
			BOT: "sunny-reviewer",
			REVIEWS: join(dir, "reviews.json"),
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
		const g = gate("labeled", [review("COMMENTED", { body: "" }), review("APPROVED")]);
		expect(g.run).toBe("true");
		expect(g.out).toContain("GATE run");
	});

	it("skips any other event after that approval", () => {
		expect(gate("synchronize", [review("APPROVED")]).run).toBe("false");
		expect(gate("reopened", [review("APPROVED")]).run).toBe("false");
	});

	it.each([
		["a summary that already held the approval", [review("COMMENTED")]],
		["an approval already dismissed", [review("DISMISSED"), review("COMMENTED")]],
		["Request changes", [review("CHANGES_REQUESTED")]],
	])("skips review:admin added after %s: there is no approval to withdraw", (_name, reviews) => {
		expect(gate("labeled", reviews).run).toBe("false");
	});

	it("reviews an unreviewed head whatever the event", () => {
		expect(gate("labeled", []).run).toBe("true");
	});

	it("fails, rather than guess, on reviews it can't read", () => {
		dir = mkdtempSync(join(tmpdir(), "review-gate-"));
		const res = spawnSync("bash", [SCRIPT], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				ACTION: "synchronize",
				HEAD: "abc",
				BOT: "sunny-reviewer",
				REVIEWS: join(dir, "missing.json"),
				GITHUB_OUTPUT: join(dir, "out"),
			},
		});
		expect(res.status).not.toBe(0);
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
		const gate = at("bash .github/scripts/review-gate.sh");
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
});
