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
//    current head and is Request changes or starts "merge after fixes". A fix round takes only a PR
//    sunny-factory[bot] opened whose every commit is that bot user's (`factory`, read by the
//    gather): lanes open their PRs as sunny-factory[bot] too (#336) but commit as themselves, so a
//    lane PR is never picked, nor one a lane or the admin pushed a fix to. The loop guard,
//    stateless like the rest: the fix runs are the factory runs titled "factory fix #<pr> at <head
//    SHA>" (factory.yml's run-name), so a PR with a run at its current head, or with 2 fix runs
//    already (whatever they did, pushed nothing included), is skipped, and the SWEEP line says why.
//    Only the newest 100 factory runs are read;
// 5. backpressure on the review queue: as many open PRs (drafts included) the factory made as the
//    cap, or more, dispatches no new issue. A PR that merges or closes lowers the count, and the
//    next sweep goes on. The same signal as 4, widened to mixed commits (#657): opened by
//    sunny-factory[bot] with any commit its bot user authored (`factory_authored`, read by the
//    gather), so a factory PR a lane or the admin pushed a fix to still counts, since a factory run
//    made it. Lane PRs, opened as sunny-factory[bot] with none of its commits, aren't counted: the
//    SWEEP line and the summary show both numbers;
// 6. the eligible issues (admin, 23 Nov 2026, #619): `factory:ready` is the only gate. An open
//    issue (not a PR) whose one factory:* label, after the reconcile, is factory:ready, opened by
//    the owner or a collaborator, with no `blocked:*` label, no open native blocker
//    (`blocked_by`, read by the gather), no open PR from a `<n>-` branch and no `<n>-` branch (the
//    gate's rules). Status, Mode and Track aren't read: any column qualifies. A run that opens no
//    PR moves its issue to factory:failed (factory.yml's `labels` job), so it isn't picked again
//    until the admin relabels it factory:ready. Ordered by Priority (P0 first, unset last), then
//    board order (the order the REST items list returns them; an issue not on the board last, by
//    number). The first is dispatched; the factory's gate checks it again.
//
// Before any of 2 to 6, the reconcile (#619): every issue carrying a factory:* label (ready,
// working, review, failed; at most one at a time) is checked against the runs and PRs, and the
// drift is fixed: a closed issue loses every factory:* label; several factory:* labels keep the
// most advanced (failed > review > working > ready); factory:working with no live factory run
// (`factory #<n>`, or a fix round on its `<n>-` PR) goes to factory:review when the issue has an
// open PR from a `<n>-` branch, else to factory:failed ("run vanished"); factory:review with no
// open `<n>-` PR goes to factory:failed when its newest closed one (of the newest 100 the gather
// reads) closed unmerged. The choice reads the
// labels as reconciled. Each move, and factory:working on what is dispatched (a fix round's issue
// is its PR branch's number), is one `LABELS` line and one entry of the `labels` output, which
// sweep.yml's `labels` job writes through factory-label.sh before the dispatch.
//
// Env: FACTORY_ENABLED, FACTORY_MAX_OPEN_PRS (vars, through env:), SWEEP_DIR holding runs, items,
// issues, pulls, closed, refs and reviews .json (each an array), GITHUB_OUTPUT (gets `issue=<n>`,
// `pr=<n>` and `head=<sha>`, each empty unless it is the one dispatched, and `labels=<JSON>`, the
// label moves as `[{issue, to, why}]`, `to` null for none), GITHUB_STEP_SUMMARY (optional).
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
const FILES = ["runs", "items", "issues", "pulls", "closed", "refs", "reviews"];
// The factory:* states, least advanced first (#619).
const STATES = ["ready", "working", "review", "failed"];

/**
 * The sweep's decision:
 * `{ dispatch, fix, reason, open, lanes, cap, eligible, skipped, fixSkipped, moves }`.
 * `dispatch` is an issue number or null; `fix` a fix round `{ pr, head, round }` or null (at most
 * one of the two is set); `open` the factory's open PRs, counted against the cap; `lanes` the other
 * open PRs opened as sunny-factory[bot], not counted (#657); `moves` the label moves to write,
 * `{ issue, from, to, why }` with `to` a state or null (no factory:* label). `enabled` and
 * `maxOpenPrs` are the raw variables; the arrays are the gathered files (only read once the switch
 * is on).
 */
export const decideSweep = ({ enabled, maxOpenPrs, ...data }) => {
	const none = {
		dispatch: null,
		fix: null,
		open: null,
		lanes: null,
		cap: null,
		eligible: [],
		skipped: [],
		fixSkipped: [],
		moves: [],
	};
	if (enabled !== "true") {
		return { ...none, reason: `switch off: FACTORY_ENABLED is ${JSON.stringify(enabled ?? "")}` };
	}
	const { moves, states } = reconcile(data);
	const base = { ...none, moves };
	const cap = readCap(maxOpenPrs);
	if (cap === null) {
		const shown = JSON.stringify(maxOpenPrs);
		return {
			...base,
			reason: `FACTORY_MAX_OPEN_PRS ${shown} isn't a whole number: nothing dispatched`,
		};
	}
	const { open, lanes } = countOpen(data.pulls);
	const active = data.runs.find((r) => r.status !== "completed");
	if (active) {
		const reason = `factory run ${active.id} (${active.display_title}) is ${active.status}`;
		return { ...base, open, lanes, cap, reason };
	}
	const { fix, fixSkipped } = selectFix(data);
	const counted = { ...base, open, lanes, cap, fixSkipped };
	if (fix) {
		const reason = `fix round ${fix.round} of ${MAX_FIX_ROUNDS} on PR #${fix.pr} at ${short(fix.head)}`;
		// Only an open issue that already carries a factory:* label is claimed for a fix round.
		const n = branchIssue(data.pulls.find((p) => p.number === fix.pr)?.head?.ref);
		const claimable = n && states.get(n)?.to;
		const working = claimable && claim(moves, states, n, `fix round on PR #${fix.pr}`);
		return { ...counted, fix, reason, moves: working || moves };
	}
	if (open >= cap) {
		return { ...counted, reason: `open-PR cap reached: ${open} open factory PRs, cap ${cap}` };
	}
	const { eligible, skipped } = selectIssues(data, states);
	const first = eligible[0];
	if (!first) return { ...counted, skipped, reason: "no eligible issue" };
	const reason = `dispatch #${first.number} (${first.priority ?? "no Priority"})`;
	const working = claim(moves, states, first.number, "dispatched");
	return { ...counted, eligible, skipped, dispatch: first.number, reason, moves: working };
};

// The App's open PRs a factory run made (`open`, counted against the cap) and the lanes' (`lanes`):
// a PR with any commit its bot user authored is the factory's, a mixed one included (#657).
function countOpen(pulls) {
	const app = pulls.filter((p) => p.user?.login === BOT);
	const open = app.filter((p) => p.factory_authored === true).length;
	return { open, lanes: app.length - open };
}

// The moves with the dispatched issue set to factory:working, replacing any reconcile move of its.
function claim(moves, states, issue, why) {
	const from = states.get(issue)?.from ?? [];
	const rest = moves.filter((m) => m.issue !== issue);
	return [...rest, { issue, from, to: "working", why }];
}

// The `<n>` of a `<n>-<slug>` branch, or null.
function branchIssue(ref) {
	const m = /^([1-9][0-9]*)-/.exec(ref ?? "");
	return m ? Number(m[1]) : null;
}

/**
 * The reconcile (#619): the label moves that fix drift, and each labelled issue's state after them,
 * `states`: number → `{ from, to }` (`from` the factory:* states it carries, least advanced first;
 * `to` the one it keeps, or null).
 */
export function reconcile({ issues, runs, pulls, closed }) {
	const observed = { live: liveIssues(runs, pulls), pulls, closed };
	const moves = [];
	const states = new Map();
	for (const issue of issues.filter((i) => !i.pull_request)) {
		const from = STATES.filter((s) => issue.labels?.some((l) => l.name === `factory:${s}`));
		if (from.length === 0) continue;
		const kept = from.at(-1);
		const several = from.length > 1 ? [`several factory:* labels: kept factory:${kept}`] : [];
		const { to, why } = settle(issue, kept, observed);
		states.set(issue.number, { from, to });
		if (from.length !== 1 || from[0] !== to) {
			moves.push({ issue: issue.number, from, to, why: [...several, ...why].join("; ") });
		}
	}
	return { moves, states };
}

// Where one issue's kept factory:* state should be, and why it moves: `{ to, why: [] }`.
function settle(issue, kept, { live, pulls, closed }) {
	const n = issue.number;
	if (issue.state !== "open") return { to: null, why: [`the issue is ${issue.state}`] };
	if (kept === "working" && !live.has(n)) {
		const pr = openPull(pulls, n);
		if (pr) return { to: "review", why: [`run vanished; PR #${pr.number} is open`] };
		return { to: "failed", why: ["run vanished"] };
	}
	if (kept !== "review" || openPull(pulls, n)) return { to: kept, why: [] };
	// Only a closed PR it can see moves it: one past the newest 100 closed isn't read, so a merged
	// one there mustn't read as a failure.
	const last = newestClosed(closed, n);
	if (!last || last.merged_at) return { to: kept, why: [] };
	return { to: "failed", why: [`PR #${last.number} closed unmerged`] };
}

// The issues a factory run is working on now: `factory #<n>`, or a fix round on a `<n>-` PR.
function liveIssues(runs, pulls) {
	const live = new Set();
	for (const r of runs.filter((x) => x.status !== "completed")) {
		const title = r.display_title ?? "";
		const issue = /^factory #([1-9][0-9]*)$/.exec(title);
		if (issue) live.add(Number(issue[1]));
		const fix = /^factory fix #([1-9][0-9]*) at /.exec(title);
		const pr = fix && pulls.find((p) => p.number === Number(fix[1]));
		const n = branchIssue(pr?.head?.ref);
		if (n) live.add(n);
	}
	return live;
}

function openPull(pulls, n) {
	return pulls.find((p) => p.head?.ref?.startsWith(`${n}-`)) ?? null;
}

// The newest (highest-numbered) closed PR from a `<n>-` branch, or null.
function newestClosed(closed, n) {
	const mine = closed.filter((p) => p.head?.ref?.startsWith(`${n}-`));
	return mine.reduce((a, b) => (a && a.number > b.number ? a : b), null);
}

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
		const why = loopGuard(rounds, pr.number, head);
		if (why) fixSkipped.push({ pr: pr.number, why });
		else return { fix: { pr: pr.number, head, round: rounds.length + 1 }, fixSkipped };
	}
	return { fix: null, fixSkipped };
}

// Why a PR's fix rounds so far rule out another, or null: one already ran at this head, or the limit.
function loopGuard(rounds, pr, head) {
	if (rounds.some((r) => r.display_title === fixTitle(pr, head))) {
		return `a fix round already ran at ${short(head)}`;
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

function selectIssues(data, states) {
	const board = data.items.filter((i) => i.repository_url === REPO_URL);
	const place = new Map(board.map((it, i) => [it.number, { i, priority: it.priority ?? null }]));
	const ready = data.issues.filter(
		(i) => i.state === "open" && !i.pull_request && states.get(i.number)?.to === "ready",
	);
	const eligible = [];
	const skipped = [];
	for (const issue of ready) {
		const why = refusal(issue, data);
		const priority = place.get(issue.number)?.priority ?? null;
		if (why) skipped.push({ number: issue.number, why });
		else eligible.push({ number: issue.number, priority });
	}
	const order = (e) => place.get(e.number)?.i ?? Infinity;
	eligible.sort(
		(a, b) => rank(a.priority) - rank(b.priority) || order(a) - order(b) || a.number - b.number,
	);
	skipped.sort((a, b) => a.number - b.number);
	return { eligible, skipped };
}

// Why the sweep skips a factory:ready issue, or null when it is eligible: the gate's rules.
function refusal(issue, { pulls, refs }) {
	const n = issue.number;
	if (!TRUSTED.has(issue.author_association)) {
		return `opened by a ${issue.author_association}, not the owner or a collaborator`;
	}
	const blockedLabel = issue.labels?.find((l) => l.name.startsWith("blocked:"));
	if (blockedLabel) return `carries ${blockedLabel.name}`;
	const blockers = issue.blocked_by;
	if (!Array.isArray(blockers)) return "its blockers weren't read";
	if (blockers.length) return `blocked by ${blockers.map((b) => `#${b}`).join(", ")}`;
	const pr = openPull(pulls, n);
	if (pr) return `has PR #${pr.number} from a ${n}- branch`;
	const ref = refs.find((r) => r.ref?.startsWith(`refs/heads/${n}-`));
	if (ref) return `has the branch ${ref.ref.slice("refs/heads/".length)}`;
	return null;
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
	if (d.cap !== null) {
		lines.push(`- Open factory PRs: ${d.open} of ${d.cap}`);
		lines.push(`- Open lane PRs, not counted against the cap: ${d.lanes}`);
	}
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
	if (d.moves.length) lines.push("", "Labels:", "", ...d.moves.map((m) => `- ${labelLine(m)}`));
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
	const counts =
		d.cap === null ? "" : ` factory=${d.open} cap=${d.cap} lanes=${d.lanes} (not counted)`;
	const fixSkipped = d.fixSkipped.map((s) => `; skipped PR #${s.pr}: ${s.why}`).join("");
	const chosen = d.dispatch || d.fix ? d.reason : `none: ${d.reason}`;
	return `SWEEP ${chosen}${counts}${fixSkipped}`;
}

// One label move as the log and the summary show it: `#<n> <from> -> <to> (<why>)`.
function labelLine({ issue, from, to, why }) {
	const was = from.length ? from.map((s) => `factory:${s}`).join(", ") : "none";
	return `#${issue} ${was} -> ${to ? `factory:${to}` : "none"} (${why})`;
}

const main = () => {
	const env = process.env;
	const enabled = env.FACTORY_ENABLED ?? "";
	const dir = env.SWEEP_DIR ?? "";
	const read = (name) => (enabled === "true" ? readArray(dir, name) : null);
	const files = Object.fromEntries(FILES.map((name) => [name, read(name)]));
	const d = decideSweep({ enabled, maxOpenPrs: env.FACTORY_MAX_OPEN_PRS, ...files });
	for (const m of d.moves) console.log(`LABELS ${labelLine(m)}`);
	console.log(sweepLine(d));
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summarise(d, enabled));
	appendFileSync(env.GITHUB_OUTPUT ?? "/dev/stdout", outputs(d));
};

// What the labels and dispatch jobs read: at most one of the issue and the fix round is set, and
// the label moves as one line of JSON.
function outputs({ dispatch, fix, moves }) {
	const labels = JSON.stringify(
		moves.map(({ issue, from, to, why }) => ({ issue, from: from.join(" "), to, why })),
	);
	return `issue=${dispatch ?? ""}\npr=${fix?.pr ?? ""}\nhead=${fix?.head ?? ""}\nlabels=${labels}\n`;
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (e) {
		console.error(`factory-sweep: cannot run: ${e?.message ?? e}`);
		process.exitCode = 2;
	}
}
