#!/usr/bin/env node
// stack-base-guard.mjs: `guard / stack-base` (#264). Related PRs are always a native stack, never
// hand-chained bases (admin, 16 Nov 2026; CONSTRAINTS.md, "Split size"). So a PR whose base isn't
// the default branch fails unless GitHub has it in a stack (`pull_request.stack` is set).
//
// scripts/stack.sh opens the PRs first and links them as a stack after, so the run for `opened`
// can start before the stack exists. When the event has no stack, it asks GitHub again
// (GET pulls/<n>, the job's read-only token), every 10 s for up to 6 tries, before it fails.
//
// Usage: node .github/scripts/stack-base-guard.mjs   (reads the PR from $GITHUB_EVENT_PATH)
// Exit codes: 0 pass, 1 a base that isn't the default branch outside a stack, 2 could not run.
// It logs the event's stack object and base, the evidence #264 asked for on stacked CI runs.
import { setTimeout as delay } from "node:timers/promises";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

const WAIT_MS = 10_000;

/**
 * The verdict for a PR event: `{ ok, message }`. `getPull(number)` returns the PR as REST does;
 * it's called only when the base isn't the default branch and the event has no stack.
 */
export const checkStackBase = async (event, { getPull, sleep, tries = 6 }) => {
	const pr = event?.pull_request;
	const main = event?.repository?.default_branch;
	if (!pr?.base?.ref || !main)
		throw new CannotRun("the event has no pull_request base or default branch");
	const base = pr.base.ref;
	if (base === main) return { ok: true, message: `base is ${main}` };

	let stack = pr.stack ?? null;
	for (let i = 0; !stack && i < tries; i++) {
		if (i > 0) await sleep(WAIT_MS);
		stack = (await getPull(pr.number))?.stack ?? null;
	}
	if (stack) {
		return {
			ok: true,
			message: `base ${base} is the part below: part ${stack.position} of ${stack.size} of stack #${stack.number}`,
		};
	}
	return {
		ok: false,
		message:
			`#${pr.number} is based on ${base}, not ${main}, and isn't in a native stack: a hand-chained PR. ` +
			'Open related PRs with scripts/stack.sh, which links them as a stack (CONSTRAINTS.md, "Split size"), ' +
			`or retarget this PR to ${main}.`,
	};
};

const getPullFromApi = (repo, token) => async (number) => {
	const res = await globalThis.fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
		headers: {
			accept: "application/vnd.github+json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!res.ok) throw new CannotRun(`GET pulls/${number} answered ${res.status}`);
	return res.json();
};

const main = async () => {
	const event = readEvent();
	const pr = event?.pull_request ?? {};
	// Evidence for #264: what a stacked part's run sees. Numbers and branch names only.
	console.log(
		`stack-base: event base ${JSON.stringify(pr.base?.ref ?? null)}, stack ${JSON.stringify(pr.stack ?? null)}`,
	);
	const repo = event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
	const r = await checkStackBase(event, {
		getPull: getPullFromApi(repo, process.env.GITHUB_TOKEN),
		sleep: (ms) => delay(ms),
	});
	if (r.ok) {
		console.log(`stack-base: pass (${r.message})`);
		return 0;
	}
	console.log(`::error title=guard / stack-base::${r.message}`);
	console.error(`stack-base: ${r.message}`);
	return 1;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (e) {
		console.error(
			`stack-base: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`,
		);
		process.exitCode = 2;
	}
}
