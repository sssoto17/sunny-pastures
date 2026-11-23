#!/usr/bin/env node
// code-owned-guard.mjs: `guard / code-owned` (#337, #565). A held PR fails until the admin signs
// off by removing `review:admin` on its current head; a PR that isn't held passes. ADR-0002, area 2,
// "Solo-admin approvals: removing `review:admin` is the sign-off" (#495) is the design.
//
// Held: the PR's diff touches a path in `main`'s .github/CODEOWNERS, or it has ever carried
// `review:admin` (its events). On a code-owned PR that has never carried it, the guard adds the
// label and its one-line comment (CONSTRAINTS.md, "Escalation criteria", Code-owned path); from
// then on the verdict reads the label, not the reason it was added.
//
// The sign-off: `sssoto17`, a `User` account, removes `review:admin`, read from the PR's events, not
// through a GitHub App. The run that the `unlabeled` event fires checks that the event's head is
// still the PR's head, then writes a record on that commit: a check run named
// `code-owned / sign-off`, conclusion success, its summary naming the removal's event id and actor.
// Only an App can write a check run, but a workflow on a PR's own branch holds an Actions token too,
// so a record counts only when its check suite's workflow run is `main`'s code-owned.yml on
// `pull_request_target` (that event always runs the default branch's copy of a workflow; ADR-0002,
// area 2, "Stacks", #404).
//
// The verdict: a held PR passes only when the label is off and such a record exists for the current
// head. A held PR with the label off and no record (a push after the sign-off, a removal by anyone
// else, a removal on an older head) gets the label back and fails. #494's Comment-review rule is
// gone: reviews play no part.
//
// One writer per head: the job is `code-owned (run)`, and this script creates or updates one
// `guard / code-owned` check run on the PR's live head through the Checks API, re-reading the live
// state (label, events, records, diff) on every run. It never checks out or runs the PR's code.
//
// Usage: node .github/scripts/code-owned-guard.mjs [--codeowners <file>]
//   (reads the PR from $GITHUB_EVENT_PATH; REST through $GITHUB_API_URL with $GITHUB_TOKEN)
// Exit codes: 0 the verdict, pass or held, is written to `guard / code-owned`; 2 could not run (the
// check run is then written as a failure when the head is known, so it never reads as a pass). A
// held PR leaves the job green: the required check carries the verdict, and a red job beside it
// would keep the board from reading the PR as green (scripts/board-status.sh leaves out only
// `guard / code-owned`). It prints paths JSON-quoted, so a file name can't start a workflow command.
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

export const LABEL = "review:admin";
export const ADMIN = "sssoto17";
export const CHECK = "guard / code-owned";
export const SIGN_OFF = "code-owned / sign-off";
export const WORKFLOW = ".github/workflows/code-owned.yml";
// GitHub Actions' App id: the integration the ruleset's required checks name.
export const ACTIONS_APP = 15368;
// The REST events list can lag the webhook: how often a removal run re-reads it, and how far apart.
const TRIES = 5;
const WAIT_MS = 2000;

const ESCALATED =
	"escalated: Code-owned path\n\n`guard / code-owned` added `review:admin`: the diff touches a path " +
	"in `main`'s .github/CODEOWNERS, so the check holds the PR until the admin removes the label on " +
	'its head (CONSTRAINTS.md, "Escalation criteria"; ADR-0002, area 2, "Solo-admin approvals").';

/**
 * CODEOWNERS as rules, in file order: `{ pattern, rx, owners }`. GitHub's syntax is gitignore's
 * without `!` or `[ ]`: a leading or inner `/` anchors to the root, a trailing `/` means a folder,
 * `*` stays inside one segment and `**` crosses them. `owners` keeps every owner token, so a line
 * owned by a team or an email still owns its paths.
 */
export const parseCodeOwners = (text) =>
	text
		.split("\n")
		.map((line) => line.replace(/#.*/, "").trim())
		.filter(Boolean)
		.map((line) => {
			const [pattern, ...owners] = line.split(/\s+/);
			return { pattern, rx: toRegExp(pattern), owners };
		});

/** Whether `path` is code-owned: the last matching rule decides, as on GitHub, and needs owners. */
export const isOwned = (rules, path) =>
	(rules.findLast((r) => r.rx.test(path))?.owners.length ?? 0) > 0;

/**
 * Whether a check run is a record from `main`'s code-owned.yml: written by GitHub Actions, and its
 * check suite's one workflow run (`run`, as `GET actions/runs?check_suite_id=` lists it) is
 * code-owned.yml on `pull_request_target`, which always runs the default branch's copy. Anything it
 * can't show, it doesn't count.
 */
export const fromMain = (checkRun, run) =>
	checkRun?.app?.id === ACTIONS_APP &&
	run?.event === "pull_request_target" &&
	run.path === WORKFLOW &&
	run.check_suite_id === checkRun.check_suite?.id;

/** Whether an issue event is the admin's sign-off: `sssoto17`, a User, removing the label itself. */
export const isAdminRemoval = (e) =>
	e?.event === "unlabeled" &&
	e.label?.name === LABEL &&
	e.actor?.login?.toLowerCase() === ADMIN &&
	e.actor.type === "User" &&
	!e.performed_via_github_app;

/**
 * The verdict on the PR an event names: `{ ok, owned, head, message }`. On the way it adds the label
 * to a code-owned PR that never carried it (`escalate`), writes the sign-off record on the run an
 * admin removal fired (`writeRecord`), and puts the label back on a held PR with neither the label
 * nor a record (`rearm`). `getPull`, `listFiles` and `listEvents` (every page) answer as REST does;
 * `listRecords(sha)` lists the `code-owned / sign-off` check runs on a commit and `runOfSuite(id)`
 * the workflow run of a check suite (null when there isn't exactly one). Throws CannotRun when it
 * can't judge.
 */
export const checkCodeOwned = async (event, deps) => {
	const { rules, getPull, listFiles, listEvents, escalate, rearm } = deps;
	if (!event?.pull_request?.head?.sha || !event.pull_request.number)
		throw new CannotRun("the event has no pull_request head");
	if (!rules.some((r) => r.owners.length)) throw new CannotRun("CODEOWNERS lists no owned path");

	const [pull, files, events] = await Promise.all([getPull(), listFiles(), listEvents()]);
	// REST lists at most 3000 files; a shorter list than the PR's count could hide an owned path.
	if (files.length < pull.changed_files)
		throw new CannotRun(`GitHub listed ${files.length} of the PR's ${pull.changed_files} files`);

	const head = pull.head.sha;
	const short = head.slice(0, 7);
	const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename ?? []].flat()))];
	const owned = paths.filter((p) => isOwned(rules, p));
	const labelled = pull.labels.some((l) => l.name === LABEL);
	const carried = labelled || events.some((e) => e.event === "labeled" && e.label?.name === LABEL);
	const verdict = (ok, message) => ({ ok, owned, head, message });

	if (!carried) {
		if (owned.length === 0) return verdict(true, "not held: no code-owned path, never escalated");
		await escalate();
		return verdict(
			false,
			`held: code-owned, so review:admin was added; the admin removes it on ${short}`,
		);
	}
	if (labelled)
		return verdict(
			false,
			`held: review:admin is on; the admin signs off by removing it on ${short}`,
		);

	const signed = await signOff(event, pull, events, deps);
	const records = await recordsFromMain(head, deps);
	if (records.length > 0)
		return verdict(
			true,
			`signed off: ${SIGN_OFF} ${records.at(-1).id} from main's code-owned.yml on ${short}`,
		);

	const removal = signed ?? latestLabelEvent(events);
	const why = isAdminRemoval(removal)
		? `no ${SIGN_OFF} record from main's code-owned.yml on ${short}, the head (pushed after the sign-off, or removed on an older head)`
		: `review:admin was removed by ${who(removal)}, which isn't the admin's sign-off`;
	await rearm(why);
	return verdict(false, `held: ${why}; review:admin is back`);
};

/**
 * Writes `guard / code-owned` on `verdict.head`: updates the newest such check run from `main`'s
 * code-owned.yml there, or creates one, so each head has one writer. `listChecks(sha)` lists the
 * `guard / code-owned` check runs on a commit; `createCheck(body)` and `updateCheck(id, body)`
 * answer as REST does.
 */
export const writeVerdict = async (verdict, deps) => {
	const ours = await fromMainOnly(await deps.listChecks(verdict.head), deps);
	const body = {
		status: "completed",
		conclusion: verdict.ok ? "success" : "failure",
		output: { title: verdict.message.slice(0, 255), summary: summaryOf(verdict) },
	};
	const latest = ours.at(-1);
	if (latest) return deps.updateCheck(latest.id, body);
	return deps.createCheck({ name: CHECK, head_sha: verdict.head, ...body });
};

// On the run an `unlabeled` event of `review:admin` fired: the removal it reports, read from the
// PR's events (re-read while the list lags the webhook), and the record written when it is the
// admin's on the event's head, which is still the PR's head and has the label off. Returns the
// removal, or null when the run isn't one.
async function signOff(event, pull, events, { listEvents, writeRecord, sleep = delay }) {
	if (event.action !== "unlabeled" || event.label?.name !== LABEL) return null;

	const sender = event.sender?.login?.toLowerCase();
	let removal = latestLabelEvent(events);
	for (let i = 1; i < TRIES && !reports(removal, sender); i++) {
		await sleep(WAIT_MS);
		removal = latestLabelEvent(await listEvents());
	}
	if (!reports(removal, sender) || !isAdminRemoval(removal)) return removal;
	if (event.pull_request.head.sha !== pull.head.sha) return removal;

	const at = pull.head.sha.slice(0, 7);
	await writeRecord(pull.head.sha, {
		title: `${removal.actor.login} removed review:admin on ${at}`,
		summary:
			`Sign-off: \`${removal.actor.login}\` (${removal.actor.type}) removed \`review:admin\` on ` +
			`${pull.head.sha}, the PR's head, in event ${removal.id} (${removal.created_at}).`,
	});
	return removal;
}

// The PR's last event that added or removed `review:admin`; events come oldest first.
function latestLabelEvent(events) {
	return events.findLast(
		(e) => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === LABEL,
	);
}

function reports(removal, sender) {
	return removal?.event === "unlabeled" && removal.actor?.login?.toLowerCase() === sender;
}

async function recordsFromMain(head, deps) {
	return fromMainOnly(await deps.listRecords(head), deps);
}

// The check runs among `runs` that `fromMain` counts, oldest first.
async function fromMainOnly(runs, { runOfSuite }) {
	const kept = [];
	for (const r of [...runs].sort((a, b) => a.id - b.id)) {
		if (r.app?.id !== ACTIONS_APP || !r.check_suite?.id) continue;

		if (fromMain(r, await runOfSuite(r.check_suite.id))) kept.push(r);
	}
	return kept;
}

function who(e) {
	if (!e?.actor?.login) return "someone the events don't name";
	const app = e.performed_via_github_app
		? `, through the App ${e.performed_via_github_app.slug}`
		: "";
	return `${e.actor.login} (${e.actor.type}${app})`;
}

function summaryOf({ message, owned }) {
	const list = owned.slice(0, 50).map((p) => `- ${JSON.stringify(p)}`);
	const more = owned.length > 50 ? [`- and ${owned.length - 50} more`] : [];
	const paths = owned.length ? ["", "Code-owned paths in the diff:", ...list, ...more] : [];
	return [
		message,
		"",
		"The admin signs off by removing `review:admin` on the PR's head; a push re-arms it " +
			'(ADR-0002, area 2, "Solo-admin approvals").',
		...paths,
	].join("\n");
}

// A pattern as a RegExp over a repo-relative path. Unanchored names match in any folder; a match
// also covers everything under it (a folder named like a file pattern), except after a final
// single `*`, which GitHub keeps to one level (`/docs/*` owns docs/a.md, not docs/a/b.md).
function toRegExp(pattern) {
	const dir = pattern.endsWith("/");
	const body = pattern.replace(/^\/|\/$/g, "");
	const anchored = pattern.startsWith("/") || body.includes("/");
	const glob = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };
	const src = body
		.split(/(\*\*\/|\*\*|\*|\?)/)
		.map((t) => glob[t] ?? t.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
		.join("");
	const end = dir ? "/" : /(?:^|[^*])\*$/.test(body) ? "$" : "(?:/|$)";
	return new RegExp(`${anchored ? "^" : "(?:^|/)"}${src}${end}`);
}

const api = (repo, token) => {
	const base = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}/`;
	const call = async (method, path, body) => {
		const res = await globalThis.fetch(base + path, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!res.ok)
			throw new CannotRun(`${method} ${path.replace(/\?.*/, "")} answered ${res.status}`);
		return res.json();
	};
	// Every page of a list; `key` names the array in an object answer (check-runs, workflow_runs).
	const all = async (path, key) => {
		const items = [];
		const sep = path.includes("?") ? "&" : "?";
		for (let page = 1; ; page++) {
			const answer = await call("GET", `${path}${sep}per_page=100&page=${page}`);
			const batch = key ? answer[key] : answer;
			items.push(...batch);
			if (batch.length < 100) return items;
		}
	};
	return { call, all };
};

const main = async () => {
	const event = readEvent();
	const flag = process.argv.indexOf("--codeowners");
	const file = flag > -1 ? process.argv[flag + 1] : ".github/CODEOWNERS";
	const number = event?.pull_request?.number;
	const { call, all } = api(
		event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY,
		process.env.GITHUB_TOKEN,
	);
	const checksNamed = (name) => (sha) =>
		all(
			`commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all`,
			"check_runs",
		);
	const comment = (body) => call("POST", `issues/${number}/comments`, { body });
	const addLabel = () => call("POST", `issues/${number}/labels`, { labels: [LABEL] });
	const deps = {
		getPull: () => call("GET", `pulls/${number}`),
		listFiles: () => all(`pulls/${number}/files`),
		listEvents: () => all(`issues/${number}/events`),
		listRecords: checksNamed(SIGN_OFF),
		listChecks: checksNamed(CHECK),
		runOfSuite: async (id) => {
			const runs = (await call("GET", `actions/runs?check_suite_id=${id}`)).workflow_runs ?? [];
			return runs.length === 1 ? runs[0] : null;
		},
		escalate: async () => {
			await addLabel();
			await comment(ESCALATED);
		},
		rearm: async (why) => {
			await addLabel();
			await comment(`\`guard / code-owned\` put \`review:admin\` back: ${why}.`);
		},
		writeRecord: (sha, output) =>
			call("POST", "check-runs", {
				name: SIGN_OFF,
				head_sha: sha,
				status: "completed",
				conclusion: "success",
				output,
			}),
		createCheck: (body) => call("POST", "check-runs", body),
		updateCheck: (id, body) => call("PATCH", `check-runs/${id}`, body),
	};

	let verdict;
	try {
		let rules;
		try {
			rules = parseCodeOwners(readFileSync(file, "utf8"));
		} catch {
			throw new CannotRun(`can't read CODEOWNERS at ${file}`);
		}
		verdict = await checkCodeOwned(event, { rules, ...deps });
	} catch (e) {
		const head = event?.pull_request?.head?.sha;
		if (head && number && e instanceof CannotRun) {
			const failed = { ok: false, owned: [], head, message: `cannot run: ${e.message}` };
			// A failure to write it too is reported, and the exit code is still 2.
			await writeVerdict(failed, deps).catch((w) =>
				console.error(`code-owned: couldn't write the failure: ${w?.message ?? w}`),
			);
		}
		throw e;
	}
	await writeVerdict(verdict, deps);
	for (const p of verdict.owned) console.log(`code-owned: ${JSON.stringify(p)}`);
	console.log(`code-owned: ${verdict.ok ? "pass" : "held"} (${verdict.message})`);
	return 0;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (e) {
		console.error(
			`code-owned: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`,
		);
		process.exitCode = 2;
	}
}
