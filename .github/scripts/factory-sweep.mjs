#!/usr/bin/env node
// factory-sweep.mjs: the sweep's choice (#108; ADR-0002, area 2, "The factory sweep, built (#108)"
// and "Fix rounds (#588)"). Which one factory run, if any, the sweep dispatches: a fix round on a
// factory PR, or a new issue. sweep.yml's `select` job runs it after
// .github/scripts/factory-sweep-gather.sh has written what it reads; it never calls GitHub.
//
// In order, the first that holds decides, and each says why in one `SWEEP` line:
// 1. the kill switch (#106): FACTORY_ENABLED anything but `true` dispatches nothing, before a file
//    is read;
// 2. the open-PR cap (admin, 22 Nov 2026): FACTORY_MAX_OPEN_PRS, default 4 when unset or empty. A
//    value that isn't a whole number dispatches nothing;
// 3. strictly serial: a factory run that is queued, waiting, pending, requested or in progress
//    dispatches nothing (factory.yml's concurrency group would make a new run wait, and a third
//    would cancel the waiting one);
// 4. a fix round (#588), before any new issue and whatever the cap, since it adds no PR: the open
//    PR the factory made with the lowest number whose newest verdict from sunny-reviewer[bot]
//    (factory-review.mjs: not dismissed, not an empty-bodied line-comment review) is on the PR's
//    current head and is Request changes or starts "merge after fixes". The factory made a PR when
//    sunny-factory[bot] opened it and every commit on it is that bot user's (`factory`, read by the
//    gather): lanes open their PRs as sunny-factory[bot] too (#336) but commit as themselves, so a
//    lane PR is never picked. The loop guard, stateless like the rest: the fix runs are the factory runs
//    titled "factory fix #<pr> at <head SHA>" (factory.yml's run-name), so a PR with a run at its
//    current head, or with 2 fix runs already (whatever they did, pushed nothing included), is
//    skipped, and the SWEEP line says why. Only the newest 100 factory runs are read;
// 5. backpressure on the review queue: as many open PRs (drafts included) opened by
//    sunny-factory[bot] as the cap, or more, dispatches no new issue. A PR that merges or closes
//    lowers the count, and the next sweep goes on;
// 6. the eligible issues: on the board in this repo, Status Ready, Mode Factory or not set, an
//    open issue (not a PR) carrying factory:ready and opened by the owner or a collaborator, with
//    no open PR from a `<n>-` branch and no `<n>-` branch (the gate's rules), and no factory run
//    for it ("factory #<n>") that ran Claude and ended without a PR since the issue was last
//    updated (`claude_ran`, read by the gather; a run that failed before Claude ran doesn't count,
//    #582): a run that opens no PR doesn't raise the count, so without this the loop could
//    re-dispatch one issue for ever. Updating the issue after that run finished makes it
//    eligible again, unless the update is a comment by someone other than the owner or a
//    collaborator. Ordered by Priority (P0 first, unset last), then board order (the order the
//    REST items list returns them). The first is dispatched; the factory's gate checks it again.
//
// Env: FACTORY_ENABLED, FACTORY_MAX_OPEN_PRS (vars, through env:), SWEEP_DIR holding runs, items,
// issues, pulls, refs, comments and reviews .json (each an array), GITHUB_OUTPUT (gets `issue=<n>`,
// `pr=<n>` and `head=<sha>`, each empty unless it is the one dispatched), GITHUB_STEP_SUMMARY
// (optional).
// Exit codes: 0 decided (dispatch or not), 2 could not run (a file missing or not an array): the
// step fails rather than guess, and nothing is written to GITHUB_OUTPUT.
// Tests: .github/scripts/tests/factory-sweep.test.mjs
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMain } from "./diff.mjs";
import { newestVerdict, wantsFixes } from "./factory-review.mjs";

const DEFAULT_CAP = 4;
const BOT = "sunny-factory[bot]";
const REPO_URL = "https://api.github.com/repos/sssoto17/sunny-pastures";
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const MAX_FIX_ROUNDS = 2;
// The gathered files, SWEEP_DIR/<name>.json.
const FILES = ["runs", "items", "issues", "pulls", "refs", "comments", "reviews"];

/**
 * The sweep's decision: `{ dispatch, fix, reason, open, cap, eligible, skipped, fixSkipped }`.
 * `dispatch` is an issue number or null; `fix` a fix round `{ pr, head, round }` or null (at most
 * one of the two is set); `open` the factory's open PRs. `enabled` and `maxOpenPrs` are the raw
 * variables; the arrays are the gathered files (only read once the switch is on).
 */
export const decideSweep = ({ enabled, maxOpenPrs, ...data }) => {
	const none = {
		dispatch: null,
		fix: null,
		open: null,
		cap: null,
		eligible: [],
		skipped: [],
		fixSkipped: [],
	};
	if (enabled !== "true") {
		return { ...none, reason: `switch off: FACTORY_ENABLED is ${JSON.stringify(enabled ?? "")}` };
	}
	const cap = readCap(maxOpenPrs);
	if (cap === null) {
		const shown = JSON.stringify(maxOpenPrs);
		return {
			...none,
			reason: `FACTORY_MAX_OPEN_PRS ${shown} isn't a whole number: nothing dispatched`,
		};
	}
	const open = data.pulls.filter((p) => p.user?.login === BOT).length;
	const active = data.runs.find((r) => r.status !== "completed");
	if (active) {
		const reason = `factory run ${active.id} (${active.display_title}) is ${active.status}`;
		return { ...none, open, cap, reason };
	}
	const { fix, fixSkipped } = selectFix(data);
	const counted = { ...none, open, cap, fixSkipped };
	if (fix) {
		const reason = `fix round ${fix.round} of ${MAX_FIX_ROUNDS} on PR #${fix.pr} at ${short(fix.head)}`;
		return { ...counted, fix, reason };
	}
	if (open >= cap) {
		return { ...counted, reason: `open-PR cap reached: ${open} open PRs by ${BOT}, cap ${cap}` };
	}
	const { eligible, skipped } = selectIssues(data);
	const first = eligible[0];
	if (!first) return { ...counted, skipped, reason: "no eligible issue" };
	const reason = `dispatch #${first.number} (${first.priority ?? "no Priority"})`;
	return { ...counted, eligible, skipped, dispatch: first.number, reason };
};

// The first factory PR the reviewer sent back on its current head, with the PRs the loop guard
// skipped on the way and why.
function selectFix({ pulls, reviews, runs }) {
	const fixSkipped = [];
	// `factory`: every commit is the App's bot user's (the gather). Lanes open PRs as the App too.
	const made = pulls.filter((p) => p.user?.login === BOT && p.factory === true);
	for (const pr of made.sort((a, b) => a.number - b.number)) {
		const head = pr.head?.sha;
		const review = newestVerdict(reviews.filter((r) => r.pr === pr.number));
		if (!head || review?.commit_id !== head || !wantsFixes(review)) continue;
		const rounds = runs.filter((r) => r.display_title?.startsWith(`factory fix #${pr.number} at `));
		const why = loopGuard(rounds, fixTitle(pr.number, head));
		if (why) fixSkipped.push({ pr: pr.number, why });
		else return { fix: { pr: pr.number, head, round: rounds.length + 1 }, fixSkipped };
	}
	return { fix: null, fixSkipped };
}

// Why a PR's fix rounds so far rule out another, or null: one already ran at this head, or the limit.
function loopGuard(rounds, title) {
	if (rounds.some((r) => r.display_title === title)) {
		return `a fix round already ran at ${short(title.slice(-40))}`;
	}
	if (rounds.length >= MAX_FIX_ROUNDS) {
		return `${rounds.length} fix rounds already, the limit is ${MAX_FIX_ROUNDS}`;
	}
	return null;
}

// factory.yml's run-name for a fix round: the sweep's whole record of the rounds it ran.
function fixTitle(pr, head) {
	return `factory fix #${pr} at ${head}`;
}

function short(sha) {
	return sha.slice(0, 7);
}

// null when the value isn't a whole number; unset or empty is the default.
function readCap(value) {
	if (value === undefined || value === null || value === "") return DEFAULT_CAP;
	return /^\d{1,4}$/.test(value) ? Number(value) : null;
}

function selectIssues(data) {
	const open = new Map(data.issues.map((i) => [i.number, i]));
	const ready = data.items.filter((i) => i.repository_url === REPO_URL && i.status === "Ready");
	const eligible = [];
	const skipped = [];
	for (const it of ready) {
		const why = refusal(it, open.get(it.number), data);
		if (why) skipped.push({ number: it.number, why });
		else eligible.push({ number: it.number, priority: it.priority ?? null });
	}
	// Array.prototype.sort is stable, so board order holds within a Priority.
	eligible.sort((a, b) => rank(a.priority) - rank(b.priority));
	return { eligible, skipped };
}

// Why the sweep skips a Ready item, or null when it is eligible: Mode, the gate's rules, then the
// last run.
function refusal(item, issue, { pulls, refs, runs, comments }) {
	const n = item.number;
	if (item.mode != null && item.mode !== "Factory") return `Mode is ${item.mode}`;
	if (!issue?.labels?.some((l) => l.name === "factory:ready"))
		return "not an open issue carrying factory:ready";
	if (issue.pull_request) return "a pull request";
	if (!TRUSTED.has(issue.author_association)) {
		return `opened by a ${issue.author_association}, not the owner or a collaborator`;
	}
	const pr = pulls.find((p) => p.head?.ref?.startsWith(`${n}-`));
	if (pr) return `has PR #${pr.number} from a ${n}- branch`;
	const ref = refs.find((r) => r.ref?.startsWith(`refs/heads/${n}-`));
	if (ref) return `has the branch ${ref.ref.slice("refs/heads/".length)}`;
	return lastRunRefusal(n, issue, runs, comments);
}

// The issue has no PR and no branch here, so its newest run opened none (or its PR closed unmerged
// and the branch went). Skipped unless the issue was updated after that run finished, and not by a
// comment from outside the owner and collaborators: the repo is public, and anyone's comment moves
// updated_at, which must not buy a factory run.
function lastRunRefusal(n, issue, runs, comments) {
	const mine = runs.filter((r) => r.display_title === `factory #${n}`);
	if (mine.length === 0) return null;
	const last = mine.reduce((a, b) => (started(b) > started(a) ? b : a));
	// A run that failed before Claude ran (#582: the action's actor check, a runner or install
	// failure) did no work, so it doesn't count: only the factory job's "Claude ran" step does.
	if (last.claude_ran !== true) return null;
	const updated = Date.parse(issue.updated_at);
	const byStranger = comments.some(
		(c) =>
			c.issue === n && !TRUSTED.has(c.author_association) && Date.parse(c.updated_at) >= updated,
	);
	if (Date.parse(last.updated_at ?? last.created_at) < updated && !byStranger) return null;
	return `last run failed: run ${last.id} (${last.conclusion}) opened no PR; edit the issue to retry`;
}

function started(run) {
	return Date.parse(run.run_started_at ?? run.created_at);
}

function rank(priority) {
	const i = PRIORITIES.indexOf(priority);
	return i === -1 ? PRIORITIES.length : i;
}

function readArray(dir, name) {
	const value = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
	if (!Array.isArray(value)) throw new Error(`${name}.json isn't an array`);
	return value;
}

function summarise(d, enabled) {
	const lines = ["### Factory sweep", "", `- Switch: ${enabled === "true" ? "on" : "off"}`];
	if (d.cap !== null) lines.push(`- Open factory PRs: ${d.open} of ${d.cap}`);
	lines.push("", "Eligible, in order:", "");
	if (d.eligible.length === 0) lines.push("- none (or not read)");
	d.eligible.forEach((e, i) =>
		lines.push(`${i + 1}. #${e.number} (${e.priority ?? "no Priority"})`),
	);
	if (d.skipped.length)
		lines.push("", "Skipped:", "", ...d.skipped.map((s) => `- #${s.number}: ${s.why}`));
	if (d.fixSkipped.length) {
		lines.push(
			"",
			"Fix rounds skipped:",
			"",
			...d.fixSkipped.map((s) => `- PR #${s.pr}: ${s.why}`),
		);
	}
	const chosen = d.fix ? `a ${d.reason}` : d.dispatch ? `#${d.dispatch}` : null;
	lines.push(
		"",
		chosen ? `Chosen: ${chosen} (the dispatch job sends it)` : `Dispatched: none (${d.reason})`,
		"",
	);
	return lines.join("\n");
}

// The one log line: what was chosen or why nothing, the counts, and the fix rounds skipped.
function sweepLine(d) {
	const counts = d.cap === null ? "" : ` open=${d.open} cap=${d.cap}`;
	const fixSkipped = d.fixSkipped.map((s) => `; skipped PR #${s.pr}: ${s.why}`).join("");
	const chosen = d.dispatch || d.fix ? d.reason : `none: ${d.reason}`;
	return `SWEEP ${chosen}${counts}${fixSkipped}`;
}

const main = () => {
	const env = process.env;
	const enabled = env.FACTORY_ENABLED ?? "";
	const dir = env.SWEEP_DIR ?? "";
	const read = (name) => (enabled === "true" ? readArray(dir, name) : null);
	const files = Object.fromEntries(FILES.map((name) => [name, read(name)]));
	const d = decideSweep({ enabled, maxOpenPrs: env.FACTORY_MAX_OPEN_PRS, ...files });
	console.log(sweepLine(d));
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summarise(d, enabled));
	appendFileSync(env.GITHUB_OUTPUT ?? "/dev/stdout", outputs(d));
};

// What the dispatch job reads: at most one of the issue and the fix round is set.
function outputs({ dispatch, fix }) {
	return `issue=${dispatch ?? ""}\npr=${fix?.pr ?? ""}\nhead=${fix?.head ?? ""}\n`;
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (e) {
		console.error(`factory-sweep: cannot run: ${e?.message ?? e}`);
		process.exitCode = 2;
	}
}
