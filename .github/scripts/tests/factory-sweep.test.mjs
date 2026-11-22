import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { decideSweep } from "../factory-sweep.mjs";

const SCRIPT = fileURLToPath(new URL("../factory-sweep.mjs", import.meta.url));
const GATHER = fileURLToPath(new URL("../factory-sweep-gather.sh", import.meta.url));
const REPO = "https://api.github.com/repos/sssoto17/sunny-pastures";
const BOT = "sunny-factory[bot]";

// A factory run as factory-sweep-gather.sh trims `GET …/actions/workflows/factory.yml/runs`, with
// `claude_ran` from its jobs (#582).
const run = (
	issue,
	started,
	{ status = "completed", conclusion = "failure", id = 1, claudeRan = true } = {},
) => ({
	id,
	claude_ran: claudeRan,
	display_title: `factory #${issue}`,
	status,
	conclusion,
	run_started_at: started,
	created_at: started,
	updated_at: started.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, "0")}`),
});
// A board item as the gather step shapes it from the REST Projects API.
const item = (
	number,
	{ status = "Ready", mode = "Factory", priority = "P2", repo = REPO } = {},
) => ({
	number,
	repository_url: repo,
	status,
	mode,
	priority,
});
// An open issue as `GET …/issues?labels=factory:ready` returns it, trimmed.
const issue = (
	number,
	{
		author = "OWNER",
		labels = ["factory:ready"],
		pr = false,
		updated = "2026-11-22T10:00:00Z",
	} = {},
) => ({
	number,
	author_association: author,
	labels: labels.map((name) => ({ name })),
	updated_at: updated,
	...(pr ? { pull_request: { url: "x" } } : {}),
});
// An open PR, trimmed.
const pull = (number, ref, login = "sssoto17") => ({ number, head: { ref }, user: { login } });

const decide = (over = {}) =>
	decideSweep({
		enabled: "true",
		maxOpenPrs: "",
		runs: [],
		items: [item(10), item(11)],
		issues: [issue(10), issue(11)],
		pulls: [],
		refs: [],
		comments: [],
		...over,
	});

describe("decideSweep", () => {
	it.each(["", "false", "TRUE", "true\n"])(
		"dispatches nothing while FACTORY_ENABLED is %j, before it reads anything",
		(enabled) => {
			const d = decide({ enabled, runs: null, items: null, pulls: null });
			expect(d.dispatch).toBeNull();
			expect(d.reason).toMatch(/^switch off: FACTORY_ENABLED is /);
		},
	);

	it.each(["queued", "waiting", "in_progress", "pending", "requested"])(
		"dispatches nothing while a factory run is %s",
		(status) => {
			const d = decide({
				runs: [run(9, "2026-11-22T21:00:00Z", { status, conclusion: null, id: 77 })],
			});
			expect(d.dispatch).toBeNull();
			expect(d.reason).toBe(`factory run 77 (factory #9) is ${status}`);
		},
	);

	it("dispatches nothing once the factory's open PRs, drafts included, reach the default cap of 4", () => {
		const mine = [1, 2, 3].map((n) => pull(100 + n, `${200 + n}-x`, BOT));
		const theirs = [pull(110, "110-y"), pull(111, "111-z")];
		expect(decide({ pulls: [...mine, ...theirs] })).toMatchObject({
			dispatch: 10,
			open: 3,
			cap: 4,
		});
		const d = decide({ pulls: [...mine, pull(104, "204-x", BOT), ...theirs] });
		expect(d).toMatchObject({ dispatch: null, open: 4, cap: 4 });
		expect(d.reason).toBe("open-PR cap reached: 4 open PRs by sunny-factory[bot], cap 4");
	});

	it("reads FACTORY_MAX_OPEN_PRS, and dispatches nothing on a value that isn't a whole number", () => {
		expect(decide({ maxOpenPrs: "0" })).toMatchObject({ dispatch: null, open: 0, cap: 0 });
		expect(decide({ maxOpenPrs: "3" })).toMatchObject({ dispatch: 10, cap: 3 });
		for (const maxOpenPrs of ["-1", "four", "1.5", " 4"]) {
			const d = decide({ maxOpenPrs });
			expect(d.dispatch).toBeNull();
			expect(d.reason).toMatch(/^FACTORY_MAX_OPEN_PRS .* isn't a whole number/);
		}
	});

	it("orders the eligible issues by Priority, P0 first, then board order", () => {
		const items = [
			item(20, { priority: "P2" }),
			item(21, { priority: null }),
			item(22, { priority: "P1" }),
			item(23, { priority: "P0" }),
			item(24, { priority: "P1" }),
		];
		const d = decide({ items, issues: [20, 21, 22, 23, 24].map((n) => issue(n)) });
		expect(d.eligible.map((e) => e.number)).toEqual([23, 22, 24, 20, 21]);
		expect(d.dispatch).toBe(23);
		expect(d.reason).toBe("dispatch #23 (P0)");
	});

	it("takes an issue whose Mode isn't set, and skips one whose Mode is Manual", () => {
		const items = [item(30, { mode: "Manual" }), item(31, { mode: null })];
		const d = decide({ items, issues: [issue(30), issue(31)] });
		expect(d.dispatch).toBe(31);
		expect(d.skipped).toContainEqual({ number: 30, why: "Mode is Manual" });
	});

	it("skips what the gate would refuse, and says why", () => {
		const items = [40, 41, 42, 43, 44, 45, 47].map((n) => item(n));
		items.push(item(48, { status: "In progress" }), item(49, { repo: `${REPO}-other` }));
		const issues = [
			issue(41, { labels: ["chore"] }),
			issue(42, { author: "CONTRIBUTOR" }),
			issue(43, { pr: true }),
			issue(44),
			issue(45),
			issue(47),
			issue(48),
			issue(49),
		];
		const d = decide({
			items,
			issues,
			pulls: [pull(500, "44-thing")],
			refs: [{ ref: "refs/heads/45-thing" }, { ref: "refs/heads/470-other" }],
		});
		expect(d.skipped).toEqual([
			{ number: 40, why: "not an open issue carrying factory:ready" },
			{ number: 41, why: "not an open issue carrying factory:ready" },
			{ number: 42, why: "opened by a CONTRIBUTOR, not the owner or a collaborator" },
			{ number: 43, why: "a pull request" },
			{ number: 44, why: "has PR #500 from a 44- branch" },
			{ number: 45, why: "has the branch 45-thing" },
		]);
		expect(d.eligible.map((e) => e.number)).toEqual([47]);
		expect(d.dispatch).toBe(47);
	});

	// Each fixture run finishes an hour after it starts.
	it("skips an issue whose last factory run opened no PR, until the issue is updated after it finished", () => {
		const runs = [
			run(60, "2026-11-22T06:00:00Z", { id: 1, conclusion: "success" }),
			run(60, "2026-11-22T09:00:00Z", { id: 2 }),
			run(61, "2026-11-22T09:00:00Z", { id: 3 }),
			run(62, "2026-11-22T09:00:00Z", { id: 4, conclusion: "cancelled" }),
		];
		const issues = [
			issue(60, { updated: "2026-11-22T08:00:00Z" }), // before its last run: skipped
			issue(61, { updated: "2026-11-22T09:30:00Z" }), // during the run: skipped
			issue(62, { updated: "2026-11-22T10:30:00Z" }), // after it finished: retried
		];
		const items = [item(60, { priority: "P0" }), item(61, { priority: "P0" }), item(62)];
		const d = decide({ items, issues, runs });
		expect(d.skipped).toEqual([
			{ number: 60, why: "last run failed: run 2 (failure) opened no PR; edit the issue to retry" },
			{ number: 61, why: "last run failed: run 3 (failure) opened no PR; edit the issue to retry" },
		]);
		expect(d.dispatch).toBe(62);
	});

	it("doesn't retry an issue when the update after its run is a stranger's comment", () => {
		const runs = [run(63, "2026-11-22T09:00:00Z", { id: 5 })];
		const issues = [issue(63, { updated: "2026-11-22T11:00:00Z" })];
		const comment = (author_association) => ({
			issue: 63,
			author_association,
			updated_at: "2026-11-22T11:00:00Z",
		});
		const stranger = decide({ items: [item(63)], issues, runs, comments: [comment("NONE")] });
		expect(stranger.dispatch).toBeNull();
		expect(stranger.skipped[0].why).toMatch(/^last run failed: run 5/);
		const owner = decide({ items: [item(63)], issues, runs, comments: [comment("OWNER")] });
		expect(owner.dispatch).toBe(63);
	});

	// #582: run 45075597193 failed at claude-code-action's actor check, before Claude started.
	it("doesn't skip an issue whose last run failed before Claude ran (no claude_ran)", () => {
		const issues = [issue(64, { updated: "2026-11-22T08:00:00Z" })];
		const last = (claudeRan) => [run(64, "2026-11-22T09:00:00Z", { id: 6, claudeRan })];
		const unread = last(true);
		delete unread[0].claude_ran;
		for (const runs of [last(false), unread]) {
			expect(decide({ items: [item(64)], issues, runs }).dispatch).toBe(64);
		}
		const ran = decide({ items: [item(64)], issues, runs: last(true) });
		expect(ran.dispatch).toBeNull();
		expect(ran.skipped[0].why).toMatch(/^last run failed: run 6/);
	});

	it("dispatches nothing when no issue is eligible", () => {
		const d = decide({ items: [item(50, { status: "Backlog" })], issues: [issue(50)] });
		expect(d).toMatchObject({ dispatch: null, eligible: [], reason: "no eligible issue" });
	});
});

describe("factory-sweep.mjs", () => {
	let dir;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	const cli = (env, files = {}) => {
		dir = mkdtempSync(join(tmpdir(), "factory-sweep-"));
		const data = {
			runs: [],
			items: [item(60)],
			issues: [issue(60)],
			pulls: [],
			refs: [],
			comments: [],
			...files,
		};
		for (const [k, v] of Object.entries(data))
			writeFileSync(join(dir, `${k}.json`), JSON.stringify(v));
		writeFileSync(join(dir, "out"), "");
		writeFileSync(join(dir, "summary"), "");
		const res = spawnSync("node", [SCRIPT], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				SWEEP_DIR: dir,
				GITHUB_OUTPUT: join(dir, "out"),
				GITHUB_STEP_SUMMARY: join(dir, "summary"),
				...env,
			},
		});
		return {
			code: res.status,
			log: res.stdout + res.stderr,
			out: readFileSync(join(dir, "out"), "utf8"),
			summary: readFileSync(join(dir, "summary"), "utf8"),
		};
	};

	it("writes the issue to dispatch, a SWEEP line and the job summary", () => {
		const r = cli({ FACTORY_ENABLED: "true" }, { pulls: [pull(7, "7-x", BOT)] });
		expect(r.code).toBe(0);
		expect(r.out).toBe("issue=60\n");
		expect(r.log).toMatch(/^SWEEP dispatch #60 \(P2\) open=1 cap=4$/m);
		expect(r.summary).toContain("- Switch: on");
		expect(r.summary).toContain("- Open factory PRs: 1 of 4");
		expect(r.summary).toContain("1. #60 (P2)");
		expect(r.summary).toContain("Chosen: #60 (the dispatch job sends it)");
	});

	it("writes an empty issue and says why when the switch is off, without reading the files", () => {
		const r = cli({ FACTORY_ENABLED: "false", SWEEP_DIR: "/nonexistent" });
		expect(r.code).toBe(0);
		expect(r.out).toBe("issue=\n");
		expect(r.log).toMatch(/^SWEEP none: switch off: FACTORY_ENABLED is "false"$/m);
		expect(r.summary).toContain("- Switch: off");
	});

	it("fails rather than guess on a file that isn't the JSON array it expects", () => {
		const r = cli({ FACTORY_ENABLED: "true" }, { runs: { message: "Bad credentials" } });
		expect(r.code).toBe(2);
		expect(r.out).toBe("");
	});
});

describe("factory-sweep-gather.sh", () => {
	let dir;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	// A fake gh on PATH that logs each call's path and token: the fields give three ids, the runs
	// FAKE_RUNS (default []), the factory:ready issues FAKE_ISSUES, a run's jobs read `true` for run 5
	// alone, and each other paginated `--jq '.[] | …'` read prints nothing, as gh does for an empty page.
	const gather = (env) => {
		dir = mkdtempSync(join(tmpdir(), "factory-sweep-gather-"));
		mkdirSync(join(dir, "bin"));
		const gh = join(dir, "bin", "gh");
		writeFileSync(
			gh,
			`#!/usr/bin/env bash
for a; do case $a in repos/* | users/*) url=$a ;; esac; done
echo "$url token=\${GH_TOKEN}" >>"${join(dir, "calls")}"
case "$*" in
  *"/fields?"*) echo "1,2,3" ;;
  *"/runs?"*) echo "\${FAKE_RUNS:-[]}" ;;
  *"labels=factory:ready"*) echo "\${FAKE_ISSUES-}" ;;
  *"/runs/5/jobs"*) echo true ;;
  *"/jobs"*) echo false ;;
esac
`,
		);
		chmodSync(gh, 0o755);
		writeFileSync(join(dir, "calls"), "");
		const res = spawnSync("bash", [GATHER], {
			encoding: "utf8",
			env: {
				PATH: `${join(dir, "bin")}:${process.env.PATH}`,
				GITHUB_REPOSITORY: "sssoto17/sunny-pastures",
				SWEEP_DIR: join(dir, "sweep"),
				GH_TOKEN: "repo-token",
				PROJECT_GH_TOKEN: "board-token",
				...env,
			},
		});
		return {
			code: res.status,
			log: res.stdout + res.stderr,
			calls: readFileSync(join(dir, "calls"), "utf8"),
		};
	};

	it("reads nothing with the switch off", () => {
		const g = gather({ FACTORY_ENABLED: "false" });
		expect(g.code).toBe(0);
		expect(g.calls).toBe("");
		expect(g.log).toContain("SWEEP gather: switch off, nothing read");
	});

	it("reads over REST, with the board token on the Project's calls only, and never prints a token", () => {
		const g = gather({ FACTORY_ENABLED: "true" });
		expect(g.code).toBe(0);
		expect(g.calls).toContain(
			"repos/sssoto17/sunny-pastures/actions/workflows/factory.yml/runs?per_page=100",
		);
		expect(g.calls).toContain("users/sssoto17/projectsV2/3/items?per_page=100&fields=1,2,3");
		expect(g.log).toMatch(/^SWEEP gather: runs=0 issues=0 pulls=0 branches=0 comments=0 items=0$/m);
		const calls = g.calls.trim().split("\n");
		expect(calls).toHaveLength(6);
		for (const c of calls) {
			expect(c).toMatch(c.includes("projectsV2") ? /token=board-token$/ : /token=repo-token$/);
		}
		expect(g.log).not.toMatch(/repo-token|board-token/);
	});

	// #582: the sweep counts a run against its issue only when the factory job's "Claude ran" step
	// succeeded, so the gather reads the jobs of the open factory:ready issues' completed runs.
	it("marks each completed run of an open factory:ready issue with claude_ran, from its jobs", () => {
		const r = (id, title, status = "completed") => ({
			id,
			display_title: title,
			status,
			created_at: "2026-11-22T09:00:00Z",
		});
		const runs = [
			r(5, "factory #70"),
			r(6, "factory #70"),
			r(7, "factory #71", "in_progress"),
			r(8, "factory #99"),
		];
		const g = gather({
			FACTORY_ENABLED: "true",
			FAKE_RUNS: JSON.stringify(runs),
			FAKE_ISSUES: JSON.stringify({ number: 70 }) + "\n" + JSON.stringify({ number: 71 }),
		});
		expect(g.code).toBe(0);
		const jobs = g.calls.split("\n").filter((c) => c.includes("/jobs"));
		expect(jobs).toEqual([
			"repos/sssoto17/sunny-pastures/actions/runs/5/jobs?per_page=100 token=repo-token",
			"repos/sssoto17/sunny-pastures/actions/runs/6/jobs?per_page=100 token=repo-token",
		]);
		const out = JSON.parse(readFileSync(join(dir, "sweep", "runs.json"), "utf8"));
		expect(out.map((x) => [x.id, x.claude_ran])).toEqual([
			[5, true],
			[6, false],
			[7, false],
			[8, false],
		]);
	});
});
