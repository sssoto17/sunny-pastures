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
//
// Which records count (#565's throwaway PRs #629 and #630): a check run written through the Checks
// API with an Actions token lands in the commit's oldest GitHub Actions check suite, whichever
// workflow that suite belongs to, so its suite and workflow run say nothing about who wrote it. A
// workflow on the PR's own branch holds an Actions token too. So the record carries proof: an OIDC
// token GitHub signed for the run that wrote it, whose audience names the repo, the PR and the head,
// and whose claims say the workflow was `main`'s code-owned.yml on `pull_request_target`. A record
// counts only when that token verifies against GitHub's published keys and its claims match; a
// branch's workflow can only get a token naming its own workflow and ref. The token's expiry isn't
// checked: the audience binds it to one head, so a copy proves nothing new.
//
// The verdict: a held PR passes only when the label is off and a counted record exists for the
// current head. A held PR with the label off and no counted record (a push after the sign-off, a
// removal by anyone else, a removal on an older head) gets the label back and fails. #494's
// Comment-review rule is gone: reviews play no part.
//
// One writer per head: the job is `code-owned (run)`, and this script updates the head's newest
// `guard / code-owned` check run through the Checks API, or creates one, re-reading the live state
// (label, events, records, diff) on every run. It also sets a commit status of the same name with
// the same verdict: on a head whose oldest Actions check suite is a `create` run (a branch pushed
// with its first commit, board-branch.yml), the check run never reaches the PR's merge box, and the
// status does (#630). It never checks out or runs the PR's code.
//
// Usage: node .github/scripts/code-owned-guard.mjs [--codeowners <file>]
//   (reads the PR from $GITHUB_EVENT_PATH; REST through $GITHUB_API_URL with $GITHUB_TOKEN; the
//   sign-off's OIDC token from $ACTIONS_ID_TOKEN_REQUEST_URL, which `id-token: write` sets)
// Exit codes: 0 the verdict, pass or held, is written to `guard / code-owned`; 2 could not run (the
// verdict is then written as a failure when the head is known, so it never reads as a pass). A
// held PR leaves the job green: the required check carries the verdict, and a red job beside it
// would keep the board from reading the PR as green (scripts/board-status.sh leaves out only
// `guard / code-owned`). It prints paths JSON-quoted, so a file name can't start a workflow command.
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

export const LABEL = "review:admin";
export const ADMIN = "sssoto17";
export const CHECK = "guard / code-owned";
export const SIGN_OFF = "code-owned / sign-off";
export const WORKFLOW = ".github/workflows/code-owned.yml";
export const ISSUER = "https://token.actions.githubusercontent.com";
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

/** The OIDC audience a sign-off record's token carries: one repo, one PR, one head. */
export const audienceOf = (repo, number, head) => `code-owned-sign-off:${repo}#${number}@${head}`;

/**
 * Whether a `code-owned / sign-off` check run counts for PR `number` of `repo` at `head`: written by
 * GitHub Actions on that head, and its summary's `token:` line an OIDC token that verifies against
 * GitHub's `keys` (JWKS), for `audienceOf(repo, number, head)`, from `main`'s code-owned.yml on
 * `pull_request_target` in `repo`.
 */
export const fromMain = (record, { repo, number, head, keys }) => {
	if (record?.app?.id !== ACTIONS_APP || record.head_sha !== head) return false;

	const claims = verifyJwt(record.output?.summary?.match(/^token: (\S+)$/m)?.[1], keys);
	const aud = [claims?.aud].flat();
	return (
		claims?.iss === ISSUER &&
		aud.length === 1 &&
		aud[0] === audienceOf(repo, number, head) &&
		claims.repository === repo &&
		claims.workflow_ref === `${repo}/${WORKFLOW}@refs/heads/main` &&
		claims.event_name === "pull_request_target"
	);
};

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
 * admin removal fired (`writeRecord(sha, output, audience)`), and puts the label back on a held PR
 * with neither the label nor a counted record (`rearm`). `getPull`, `listFiles` and `listEvents`
 * (every page) answer as REST does; `listRecords(sha)` lists the `code-owned / sign-off` check runs
 * on a commit, and `getKeys()` GitHub's OIDC signing keys. Throws CannotRun when it can't judge.
 */
export const checkCodeOwned = async (event, deps) => {
	const { rules, getPull, listFiles, listEvents, escalate, rearm } = deps;
	const number = event?.pull_request?.number;
	const repo = event?.repository?.full_name;
	if (!event?.pull_request?.head?.sha || !number || !repo)
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

	const signed = await signOff(event, pull, events, audienceOf(repo, number, head), deps);
	const keys = await deps.getKeys();
	const records = (await deps.listRecords(head))
		.filter((r) => fromMain(r, { repo, number, head, keys }))
		.sort((a, b) => a.id - b.id);
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
 * Writes the verdict on `verdict.head`: updates the newest `guard / code-owned` check run GitHub
 * Actions wrote there, or creates one (`listChecks(sha)`, `createCheck(body)`, `updateCheck(id,
 * body)` answer as REST does), then sets the commit status of the same name (`setStatus(sha,
 * body)`), which reaches the merge box when the check run can't.
 */
export const writeVerdict = async (verdict, deps) => {
	const body = {
		status: "completed",
		conclusion: verdict.ok ? "success" : "failure",
		output: { title: verdict.message.slice(0, 255), summary: summaryOf(verdict) },
	};
	const latest = (await deps.listChecks(verdict.head))
		.filter((r) => r.app?.id === ACTIONS_APP)
		.sort((a, b) => a.id - b.id)
		.at(-1);
	// A check run this token can't update (another workflow's job) still leaves room for a new one.
	const updated = latest
		? await deps.updateCheck(latest.id, body).then(
				() => true,
				(e) => {
					console.error(`code-owned: couldn't update check run ${latest.id}: ${e?.message ?? e}`);
					return false;
				},
			)
		: false;
	if (!updated) await deps.createCheck({ name: CHECK, head_sha: verdict.head, ...body });
	await deps.setStatus(verdict.head, {
		state: verdict.ok ? "success" : "failure",
		context: CHECK,
		description: verdict.message.slice(0, 140),
	});
};

// On the run an `unlabeled` event of `review:admin` fired: the removal it reports, read from the
// PR's events (re-read while the list lags the webhook), and the record written when it is the
// admin's on the event's head, which is still the PR's head and has the label off. Returns the
// removal, or null when the run isn't one.
async function signOff(event, pull, events, audience, { listEvents, writeRecord, sleep = delay }) {
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
	const output = {
		title: `${removal.actor.login} removed review:admin on ${at}`,
		summary:
			`Sign-off: \`${removal.actor.login}\` (${removal.actor.type}) removed \`review:admin\` on ` +
			`${pull.head.sha}, the PR's head, in event ${removal.id} (${removal.created_at}).`,
	};
	await writeRecord(pull.head.sha, output, audience);
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

// A JWT's claims when its RS256 signature verifies against the key its header names; else null.
function verifyJwt(jwt, keys) {
	try {
		const [h, p, s, ...rest] = jwt.split(".");
		if (rest.length > 0) return null;
		const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
		const jwk = keys.find((k) => k.kid === header.kid);
		if (header.alg !== "RS256" || !jwk) return null;
		const key = createPublicKey({ key: jwk, format: "jwk" });
		const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
		return ok ? JSON.parse(Buffer.from(p, "base64url").toString("utf8")) : null;
	} catch {
		return null;
	}
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
	// Every page of a list; `key` names the array in an object answer (check-runs).
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

// GitHub's OIDC signing keys, and a token for `audience` from this run (`id-token: write`).
const oidc = {
	keys: async () => {
		const res = await globalThis.fetch(
			process.env.CODE_OWNED_JWKS_URL ?? `${ISSUER}/.well-known/jwks`,
		);
		if (!res.ok) throw new CannotRun(`GitHub's OIDC keys answered ${res.status}`);
		return (await res.json()).keys ?? [];
	},
	token: async (audience) => {
		const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
		if (!url) throw new CannotRun("no OIDC token: the job needs `id-token: write`");
		const res = await globalThis.fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
			headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
		});
		if (!res.ok) throw new CannotRun(`the OIDC token request answered ${res.status}`);
		return (await res.json()).value;
	},
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
	let keys;
	const deps = {
		getPull: () => call("GET", `pulls/${number}`),
		listFiles: () => all(`pulls/${number}/files`),
		listEvents: () => all(`issues/${number}/events`),
		listRecords: checksNamed(SIGN_OFF),
		listChecks: checksNamed(CHECK),
		getKeys: async () => (keys ??= await oidc.keys()),
		escalate: async () => {
			await addLabel();
			await comment(ESCALATED);
		},
		rearm: async (why) => {
			await addLabel();
			await comment(`\`guard / code-owned\` put \`review:admin\` back: ${why}.`);
		},
		writeRecord: async (sha, output, audience) =>
			call("POST", "check-runs", {
				name: SIGN_OFF,
				head_sha: sha,
				status: "completed",
				conclusion: "success",
				output: { ...output, summary: `${output.summary}\n\ntoken: ${await oidc.token(audience)}` },
			}),
		createCheck: (body) => call("POST", "check-runs", body),
		updateCheck: (id, body) => call("PATCH", `check-runs/${id}`, body),
		setStatus: (sha, body) => call("POST", `statuses/${sha}`, body),
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
