#!/usr/bin/env node
// stack-base-guard.mjs: `guard / stack-base` (#264). Related PRs are always a native stack, never
// hand-chained bases (admin, 16 Nov 2026; CONSTRAINTS.md, "Split size"). So a PR whose base isn't
// the default branch fails unless GitHub has it in a stack (`pull_request.stack` is set).
//
// scripts/stack.sh opens the PRs first and links them as a stack after, so the run for `opened`
// can start before the stack exists. When the event has no stack, it asks GitHub again
// (GET pulls/<n>, the job's read-only token), every 10 s for up to 6 tries, before it fails.
//
// With --top it is ci.yml's `ci / stack` job instead: it writes `top=true|false` to $GITHUB_OUTPUT,
// false only for a lower part of a stack, so typecheck, lint and test run once per stack (#264).
// The event's stack can't say that on `opened`, for the reason above, so it asks GitHub the same way.
//
// Usage: node .github/scripts/stack-base-guard.mjs [--top]   (reads $GITHUB_EVENT_PATH)
// Exit codes: 0 pass (always, with --top), 1 a base that isn't the default branch outside a
// stack, 2 could not run. It logs the event's stack object and base: what a stacked run sees.
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

const WAIT_MS = 10_000;

/**
 * The PR's stack, `{ number, position, size, base }`, or null. From the event when it has one;
 * otherwise from `getPull`: up to `tries` times, 10 s apart, for a PR based on another branch
 * (it can only be a stacked part, or a hand-chained PR), and once for a PR on the default branch.
 */
const findStack = async (event, { getPull, sleep, tries = 6 }) => {
	const pr = event.pull_request;
	if (pr.stack) return pr.stack;
	const attempts = pr.base.ref === event.repository.default_branch ? 1 : tries;
	let failure = null;
	for (let i = 0; i < attempts; i++) {
		if (i > 0) await sleep(WAIT_MS);
		try {
			const stack = (await getPull(pr.number))?.stack;
			if (stack) return stack;
			failure = null;
		} catch (e) {
			failure = e; // asked again next round; thrown only if the last round failed too
		}
	}
	if (failure) throw failure;
	return null;
};

const requirePr = (event) => {
	if (!event?.pull_request?.base?.ref || !event?.repository?.default_branch)
		throw new CannotRun("the event has no pull_request base or default branch");
};

/**
 * Whether typecheck, lint and test should run. False only for a stack's lower part whose head the
 * top open part's head already contains, so the top part's run covers it. A push to a lower part
 * without `scripts/stack.sh update`, or a top part that left the stack, runs the suite here, or a
 * stack merge could land code no test ran on. `getStack(n)` and `compare(base, head)` (the
 * compare endpoint's status) come from REST.
 */
export const isTopPart = async (event, deps) => {
	if (!event?.pull_request) return true; // a push to main: run on what landed
	requirePr(event);
	const stack = await findStack(event, deps);
	if (!stack || stack.position === stack.size) return true;
	const pr = event.pull_request;
	const open = ((await deps.getStack(stack.number))?.pull_requests ?? []).filter(
		(p) => p.state === "open",
	);
	const top = open.at(-1);
	if (!top || top.number === pr.number) return true;
	const status = await deps.compare(pr.head.sha, top.head.sha);
	return !(status === "ahead" || status === "identical");
};

/**
 * The verdict for a PR event: `{ ok, message }`. `getPull(number)` returns the PR as REST does;
 * it's called only when the base isn't the default branch and the event has no stack.
 */
export const checkStackBase = async (event, { getPull, sleep, tries = 6 }) => {
	requirePr(event);
	const pr = event.pull_request;
	const main = event.repository.default_branch;
	const base = pr.base.ref;
	if (base === main) return { ok: true, message: `base is ${main}` };

	const stack = await findStack(event, { getPull, sleep, tries });
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
		getPull: (n) => get(`pulls/${n}`),
		getStack: (n) => get(`stacks/${n}`),
		compare: async (base, head) => (await get(`compare/${base}...${head}`)).status,
		sleep: (ms) => delay(ms),
	};
	const pr = event?.pull_request ?? {};
	// Evidence for #264: what a stacked part's run sees. Numbers and branch names only.
	console.log(
		`stack-base: event base ${JSON.stringify(pr.base?.ref ?? null)}, stack ${JSON.stringify(pr.stack ?? null)}`,
	);
	if (process.argv.includes("--top")) {
		const top = await isTopPart(event, deps);
		appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/stdout", `top=${top}\n`);
		console.log(`stack-base: top=${top}`);
		return 0;
	}
	const r = await checkStackBase(event, deps);
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
