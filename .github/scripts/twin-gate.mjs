#!/usr/bin/env node
// twin-gate.mjs: the `<workflow> / twin` job of ci.yml, security.yml and pr-body.yml (#358).
// A push to a stacked part fires `synchronize` twice on one head, a second or so apart: once for
// the part's own push and once because the part below changed, and both runs test the same merge
// commit (the #346 stack: part 4's twin `ci` runs both checked out 21fd683). The first run tests;
// the later one waits for it and repeats what its jobs concluded, so a twin never reports a result
// the first run didn't and a flaky job gets one draw, not two. Nothing is cancelled, so no
// cancelled twin is left on the head (throwaway stack #315; ADR-0002, area 2, "Stacks").
//
// Twins are told apart by the run's name: each workflow's `run-name:` ends in
// ` · <action> <merge commit>` (`github.sha` on a pull_request event). A run that isn't the later
// of two `synchronize` runs on the same merge commit runs for real, and so does one where another
// run on the head started after the first (a body edit, say: new input), or where the first run
// is still going after the wait. Every doubt runs the jobs: the gate never skips a check that
// would otherwise have run, and it never fails.
//
// Usage: node .github/scripts/twin-gate.mjs   (reads $GITHUB_EVENT_PATH, $GITHUB_RUN_ID, $GITHUB_SHA)
// Writes `mirror=<json>` (job id -> the first run's conclusion; {} to run for real) and
// `source=<url>` to $GITHUB_OUTPUT. A job's id is its check name after ` / `. Always exits 0.
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

const POLL_MS = 15_000;
// The longest job these workflows run is `ci / test` at 15 minutes; past this the twin runs.
const MAX_WAIT_MS = 20 * 60_000;

const real = (message) => ({ mirror: {}, source: "", message });

/** Job id -> conclusion, from the first run's jobs. The gate's own job isn't repeated. */
const mirrorOf = (jobs) =>
	Object.fromEntries(
		jobs
			.map((j) => [j.name.split(" / ")[1], j.conclusion ?? "failure"])
			.filter(([id]) => id && id !== "twin"),
	);

/**
 * Whether this run repeats an earlier twin: `{ mirror, source, message }`, where an empty
 * `mirror` means run for real. `deps` answer from REST: `getRun(id)`, `listRuns(workflowId,
 * headSha)` (this workflow's runs on the head), `getJobs(runId)` (the latest attempt's), `sleep`.
 */
export const twinGate = async (
	event,
	{ runId, sha },
	deps,
	{ pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS, now = Date.now } = {},
) => {
	if (event?.action !== "synchronize" || !event.pull_request)
		return real(`a ${event?.action ?? "non-PR"} event has no twin`);
	const self = await deps.getRun(runId);
	const key = ` · synchronize ${sha}`;
	if (!self.display_title.endsWith(key))
		return real(`this run's name doesn't end in "${key}", so twins can't be told apart`);

	const start = now();
	for (;;) {
		const runs = await deps.listRuns(self.workflow_id, event.pull_request.head.sha);
		const first = [self, ...runs]
			.filter((r) => r.display_title.endsWith(key))
			.reduce((a, b) => (b.id < a.id ? b : a));
		if (first.id === self.id) return real("the first run on this merge commit");
		const later = runs.find((r) => r.id > first.id && !r.display_title.endsWith(key));
		if (later) return real(`run ${later.id} started after run ${first.id} with other input`);
		if (first.status === "completed") {
			const mirror = mirrorOf(await deps.getJobs(first.id));
			return { mirror, source: first.html_url, message: `repeats run ${first.id}` };
		}
		if (now() - start >= maxWaitMs) return real(`run ${first.id} is still running`);
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
	let r;
	try {
		r = await twinGate(
			event,
			{ runId: Number(process.env.GITHUB_RUN_ID), sha: process.env.GITHUB_SHA },
			deps,
		);
	} catch (e) {
		// Fail open: an unreadable answer runs every job, as if there were no twin.
		console.log(
			`::warning title=twin::${e instanceof CannotRun ? e.message : e}; running for real`,
		);
		r = real("could not ask GitHub");
	}
	const out = `mirror=${JSON.stringify(r.mirror)}\nsource=${r.source}\n`;
	appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/stdout", out);
	console.log(`twin: ${r.message}${r.source ? ` (${r.source})` : ""}`);
	for (const [id, c] of Object.entries(r.mirror)) console.log(`twin: ${id}: ${c}`);
};

if (isMain(import.meta.url)) await main();
