#!/usr/bin/env node
// twin-gate.mjs: the `<workflow> / twin` job of ci.yml, security.yml and pr-body.yml (#358).
// A push to a stacked part fires `synchronize` twice on one head, a second or so apart: once for
// the part's own push and once because the part below changed, and both runs test the same merge
// commit (the #346 stack: part 4's twin `ci` runs both checked out 21fd683). The first run tests;
// the later one waits for it and repeats what its jobs concluded, so a twin never reports a result
// the first run didn't and a flaky job gets one draw, not two. Nothing is cancelled, so no
// cancelled twin is left on the head (throwaway stack #315; ADR-0002, area 2, "Stacks").
//
// Twins are told apart by the run's name: each workflow's `run-name:` starts with
// `<action> <merge commit> · ` (`github.sha` on a pull_request event), before the title, so a
// long title can't cut the key off. A run that isn't the later of two `synchronize` runs on one
// merge commit runs for real, and so does one where another run on the head started after the
// first (a body edit, say: new input), or where the first run is still going after the wait.
// Every doubt runs the jobs: the gate never skips a check that would otherwise have run.
//
// Usage: node .github/scripts/twin-gate.mjs   (reads $GITHUB_EVENT_PATH, $GITHUB_RUN_ID, $GITHUB_SHA)
// Writes to $GITHUB_OUTPUT: `pass=<json>`, the ids of the jobs whose first-run twin passed or
// skipped; `fail=<json>`, job id -> the first run's other conclusions; `source=<url>`, the first
// run. Empty lists run every job for real. A job's id is its check name after ` / `. Exits 0.
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

const POLL_MS = 15_000;
// A first run whose `ci / test` times out lasts its 15 minutes plus `ci / stack`, setup and the
// queue; past this the twin runs for real, and a flaky job gets its second draw back.
const MAX_WAIT_MS = 30 * 60_000;
// The conclusions a skipped job reports as well: a skipped required job reads as passing.
const PASSING = new Set(["success", "skipped"]);

const runForReal = (message) => ({ pass: [], fail: {}, source: "", message });

/** What a twin repeats of the first run's jobs. The gate's own job isn't repeated. */
const repeatOf = (jobs, source, message) => {
	const pass = [];
	const fail = {};
	for (const { name, conclusion } of jobs) {
		const id = name.split(" / ")[1];
		if (!id || id === "twin") continue;
		if (PASSING.has(conclusion)) pass.push(id);
		else fail[id] = conclusion ?? "failure";
	}
	return { pass, fail, source, message };
};

/**
 * Whether this run repeats an earlier twin: `{ pass, fail, source, message }`, where empty `pass`
 * and `fail` mean run every job for real. `deps` answer from REST: `getRun(id)`,
 * `listRuns(workflowId, headSha)` (this workflow's runs on the head), `getJobs(runId)` (the latest
 * attempt's), `sleep(ms)`.
 */
export const twinGate = async (
	event,
	{ runId, sha },
	deps,
	{ pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS, now = Date.now } = {},
) => {
	if (event?.action !== "synchronize" || !event.pull_request)
		return runForReal(`a ${event?.action ?? "non-PR"} event has no twin`);
	const self = await deps.getRun(runId);
	const key = `synchronize ${sha} · `;
	const twins = (r) => r.display_title.startsWith(key);
	if (!twins(self))
		return runForReal(`this run's name doesn't start with "${key}", so twins can't be told apart`);

	const start = now();
	for (;;) {
		const runs = await deps.listRuns(self.workflow_id, event.pull_request.head.sha);
		const first = [self, ...runs].filter(twins).reduce((a, b) => (b.id < a.id ? b : a));
		if (first.id === self.id) return runForReal("the first run on this merge commit");
		const later = runs.find((r) => r.id > first.id && !twins(r));
		if (later) return runForReal(`run ${later.id} started after run ${first.id} with other input`);
		if (first.status === "completed")
			return repeatOf(await deps.getJobs(first.id), first.html_url, `repeats run ${first.id}`);
		if (now() - start >= maxWaitMs) return runForReal(`run ${first.id} is still running`);
		await deps.sleep(pollMs);
	}
};

const apiGet = (repo, token) => async (path) => {
	const res = await globalThis.fetch(`https://api.github.com/repos/${repo}/${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!res.ok) throw new CannotRun(`GET ${path} answered ${res.status}`);
	return res.json();
};

const main = async () => {
	const event = readEvent();
	const get = apiGet(
		event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY,
		process.env.GITHUB_TOKEN,
	);
	const deps = {
		getRun: (id) => get(`actions/runs/${id}`),
		listRuns: async (wf, head) =>
			(await get(`actions/workflows/${wf}/runs?head_sha=${head}&per_page=100`)).workflow_runs,
		getJobs: async (id) => (await get(`actions/runs/${id}/jobs?per_page=100`)).jobs,
		sleep: (ms) => delay(ms),
	};
	let gate;
	try {
		gate = await twinGate(
			event,
			{ runId: Number(process.env.GITHUB_RUN_ID), sha: process.env.GITHUB_SHA },
			deps,
		);
	} catch (e) {
		// Fail open: an unreadable answer runs every job, as if there were no twin.
		console.log(
			`::warning title=twin::${e instanceof CannotRun ? e.message : e}; running for real`,
		);
		gate = runForReal("could not ask GitHub");
	}
	const { pass, fail, source, message } = gate;
	const out = `pass=${JSON.stringify(pass)}\nfail=${JSON.stringify(fail)}\nsource=${source}\n`;
	appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/stdout", out);
	console.log(`twin: ${message}${source ? ` (${source})` : ""}`);
	for (const id of pass) console.log(`twin: ${id}: passed or skipped there, so skipped here`);
	for (const [id, c] of Object.entries(fail))
		console.log(`twin: ${id}: ${c} there, so failed here`);
};

if (isMain(import.meta.url)) await main();
