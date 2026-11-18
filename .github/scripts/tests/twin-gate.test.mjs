import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { twinGate } from "../twin-gate.mjs";

const MERGE = "21fd683abdea7facf40785254a8d1bb68dd8d102";
const KEY = ` · synchronize ${MERGE}`;

const event = (action = "synchronize") => ({
	action,
	pull_request: { number: 365, head: { sha: "ccd1b0f" } },
});

// A run as GET actions/runs lists it. `title` is the run's display_title, from `run-name:`.
const run = (id, title = `part 4${KEY}`, status = "completed") => ({
	id,
	workflow_id: 7,
	display_title: title,
	status,
	html_url: `https://github.com/o/r/actions/runs/${id}`,
});

// GitHub as the gate sees it: `self` is this run, `lists` answers each listing in turn (the last
// one repeats), `jobs` is the original's jobs. It records every call.
const github = ({ self, lists, jobs = [] }) => {
	const calls = [];
	let n = 0;
	return {
		calls,
		getRun: async (id) => {
			calls.push(`run ${id}`);
			return self;
		},
		listRuns: async (workflowId, headSha) => {
			calls.push(`list ${workflowId} ${headSha}`);
			return lists[Math.min(n++, lists.length - 1)];
		},
		getJobs: async (id) => {
			calls.push(`jobs ${id}`);
			return jobs;
		},
		sleep: async () => {
			calls.push("sleep");
		},
	};
};

const job = (name, conclusion) => ({ name, conclusion });

describe("twinGate", () => {
	it.each(["opened", "reopened", "edited"])(
		"runs a %s event for real without asking GitHub",
		async (action) => {
			const gh = github({ self: run(2), lists: [[]] });
			const r = await twinGate(event(action), { runId: 2, sha: MERGE }, gh);
			expect(r.mirror).toEqual({});
			expect(gh.calls).toEqual([]);
		},
	);

	it("runs the first run of a merge commit for real", async () => {
		const gh = github({ self: run(1), lists: [[run(2, `part 4${KEY}`, "queued"), run(1)]] });
		const r = await twinGate(event(), { runId: 1, sha: MERGE }, gh);
		expect(r.mirror).toEqual({});
		expect(gh.calls).toEqual(["run 1", "list 7 ccd1b0f"]);
	});

	it("makes a later twin repeat what the first run's jobs concluded, keyed by job id", async () => {
		const gh = github({
			self: run(2, `part 4${KEY}`, "in_progress"),
			lists: [[run(2, `part 4${KEY}`, "in_progress"), run(1)]],
			jobs: [
				job("ci / twin", "skipped"),
				job("ci / test", "failure"),
				job("ci / lint", "success"),
				job("guard / floor", "success"),
				job("ci / typecheck", "skipped"),
			],
		});
		const r = await twinGate(event(), { runId: 2, sha: MERGE }, gh);
		expect(r.mirror).toEqual({
			test: "failure",
			lint: "success",
			floor: "success",
			typecheck: "skipped",
		});
		expect(r.source).toBe("https://github.com/o/r/actions/runs/1");
		expect(gh.calls).toContain("jobs 1");
	});

	it("waits for the first run to finish before it reads its jobs", async () => {
		const twin = run(2, `part 4${KEY}`, "in_progress");
		const gh = github({
			self: twin,
			lists: [
				[twin, run(1, `part 4${KEY}`, "queued")],
				[twin, run(1, `part 4${KEY}`, "in_progress")],
				[twin, run(1)],
			],
			jobs: [job("ci / test", "success")],
		});
		const r = await twinGate(event(), { runId: 2, sha: MERGE }, gh, { pollMs: 1 });
		expect(r.mirror).toEqual({ test: "success" });
		expect(gh.calls.filter((c) => c === "sleep")).toHaveLength(2);
		expect(gh.calls.at(-1)).toBe("jobs 1");
	});

	it("runs for real when the first run tested another merge commit", async () => {
		const other = ` · synchronize ${"f".repeat(40)}`;
		const gh = github({ self: run(2), lists: [[run(2), run(1, `part 4${other}`)]] });
		const r = await twinGate(event(), { runId: 2, sha: MERGE }, gh);
		expect(r.mirror).toEqual({});
		expect(gh.calls).not.toContain("jobs 1");
	});

	// A body edit between the twins (pr-body's `edited`) is new input: repeating the first run's
	// result after it would report on the old body last.
	it.each([
		["before the wait", [[run(3), run(2, "part 4 · edited abc"), run(1)]]],
		[
			"during the wait",
			[
				[run(3), run(1, `part 4${KEY}`, "in_progress")],
				[run(3), run(2, "part 4 · edited abc"), run(1)],
			],
		],
	])("runs for real when another run started after the first one, %s", async (_, lists) => {
		const gh = github({ self: run(3), lists });
		const r = await twinGate(event(), { runId: 3, sha: MERGE }, gh, { pollMs: 1 });
		expect(r.mirror).toEqual({});
		expect(gh.calls).not.toContain("jobs 1");
	});

	it("runs for real when the first run outlasts the wait", async () => {
		const gh = github({ self: run(2), lists: [[run(2), run(1, `part 4${KEY}`, "in_progress")]] });
		let t = 0;
		const r = await twinGate(event(), { runId: 2, sha: MERGE }, gh, {
			pollMs: 60_000,
			maxWaitMs: 180_000,
			now: () => (t += 60_000),
		});
		expect(r.mirror).toEqual({});
		expect(r.message).toMatch(/still running/);
	});

	it("runs for real when this run's name doesn't carry the merge commit", async () => {
		const gh = github({ self: run(2, "part 4"), lists: [[run(2, "part 4"), run(1, "part 4")]] });
		const r = await twinGate(event(), { runId: 2, sha: MERGE }, gh);
		expect(r.mirror).toEqual({});
		expect(gh.calls).toEqual(["run 2"]);
	});
});

// The gate only helps if every job of the three workflows asks it; a job that forgets is a second
// draw again. A job without `!cancelled()` would skip whenever the gate is skipped (every run but a
// stacked part's synchronize), and a skipped required job reads as passing.
describe.each(["ci", "security", "pr-body"])("%s.yml", (workflow) => {
	const yml = readFileSync(
		fileURLToPath(new URL(`../../workflows/${workflow}.yml`, import.meta.url)),
		"utf8",
	);
	const jobs = Object.fromEntries(
		yml
			.slice(yml.indexOf("\njobs:\n"))
			.split(/^ {2}(?=[a-z-]+:\n)/m)
			.slice(1)
			.map((body) => [body.slice(0, body.indexOf(":")), body]),
	);
	const mirror = "fromJSON(needs.twin.outputs.mirror || '{}')";

	it("names each run after its action and merge commit, the key the gate matches", () => {
		expect(yml).toMatch(/^run-name: .*'\{0\} · \{1\} \{2\}'.*github\.event\.action, github\.sha/m);
	});

	it("asks the gate only on a stacked part's synchronize, with a read-only actions token", () => {
		expect(jobs.twin).toContain(
			"    if: github.event.action == 'synchronize' && github.event.pull_request.stack\n",
		);
		expect(jobs.twin).toMatch(/^ {6}actions: read\b/m);
		expect(jobs.twin).toContain("uses: ./.github/actions/twin\n");
	});

	it.each(Object.keys(jobs).filter((id) => id !== "twin"))(
		"makes %s skip a twin of a pass and repeat any other result first",
		(id) => {
			const body = jobs[id];
			expect(body).toMatch(new RegExp(`^ {4}name: [a-z]+ / ${id}\\n`, "m"));
			expect(body).toMatch(/^ {4}needs: \[(stack, )?twin\]\n/m);
			const cond = body.match(/^ {4}if: \$\{\{ (.*) \}\}\n/m)?.[1] ?? "";
			expect(cond.startsWith("!cancelled() && ")).toBe(true);
			expect(cond).toContain(`!contains(fromJSON('["success","skipped"]'), ${mirror}['${id}'])`);
			const first = body.slice(body.indexOf("    steps:\n")).split("\n").slice(1, 3);
			expect(first).toEqual([
				"      - name: Repeat the first run's result (#358)",
				`        if: ${mirror}[github.job]`,
			]);
		},
	);
});
