#!/usr/bin/env node
// code-owned-guard.mjs: `guard / code-owned` (#337). A PR whose diff touches a path in
// .github/CODEOWNERS fails until a code owner, the admin, approves its current head (on a PR the
// admin opened, reviews it: below); a PR that
// touches none passes. On a code-owned PR it adds `review:admin`, so the label comes from the diff,
// not from the reviewer bot's judgement (CONSTRAINTS.md, "Escalation criteria", Code-owned path).
// ADR-0002 (area 2, "Code-owner review on stacks") hands #68 turning GitHub's code-owner review off
// once this check is required; until then both hold.
//
// It runs on reviews only (#379): each submitted or dismissed review runs it once, on the PR's
// reviews as REST lists them, so the review that fired the run is one input among the others and a
// COMMENTED one fails a code-owned PR the admin hasn't approved rather than skipping the check.
//
// Which review counts: per reviewer, the latest review that isn't a comment, as GitHub reads it.
// It must be APPROVED, on the head this run reports on (`commit_id`), by a user CODEOWNERS lists
// as an owner of each code-owned path. So a dismissed or stale approval, a later Request changes,
// the bot's approval or anyone else's never counts. The list is the default branch's CODEOWNERS
// (the workflow copies it), so a PR can't drop a path from the list that judges it.
//
// A PR a code owner opened (#494; admin, 22 Nov: option A): GitHub refuses a self-approval, so a PR
// the admin's account opened (an `--as-admin` lane, #385) could never pass. When the PR's author, as
// the REST PR names it, is a User that CODEOWNERS lists as an owner of every code-owned path in the
// diff, the author's own latest review that isn't dismissed counts as the sign-off if it is on the
// head and APPROVED or COMMENTED. Any other PR keeps the rule above: on a PR the factory App opened,
// the admin's COMMENTED review still fails it. The admin's steps on such a PR, or each part of such
// a stack: resolve the escalation thread, leave a Comment review on the part's head (which runs this
// check), then bypass-merge part by part (ADR-0002, area 2, "Stacks"). A push needs a new review.
//
// Usage: node .github/scripts/code-owned-guard.mjs [--codeowners <file>]
//   (reads the PR from $GITHUB_EVENT_PATH; REST through $GITHUB_API_URL with $GITHUB_TOKEN)
// Exit codes: 0 pass, 1 held for the admin, 2 could not run (never reads as a pass). It prints
// paths JSON-quoted, so a file name can't start a workflow command.
import { readFileSync } from "node:fs";

import { CannotRun, isMain, readEvent } from "./diff.mjs";

export const LABEL = "review:admin";
const ESCALATED =
	"escalated: Code-owned path\n\n`guard / code-owned` added `review:admin`: the diff touches a path " +
	"in `main`'s .github/CODEOWNERS, so the check holds the PR until the admin approves its head, or, " +
	'on a PR the admin opened, reviews it (CONSTRAINTS.md, "Escalation criteria"; #494).';

/**
 * CODEOWNERS as rules, in file order: `{ pattern, rx, owners }`. GitHub's syntax is gitignore's
 * without `!` or `[ ]`: a leading or inner `/` anchors to the root, a trailing `/` means a folder,
 * `*` stays inside one segment and `**` crosses them. `owners` keeps every owner token, so a line
 * owned by a team or an email still owns its paths; `users` holds the logins that can approve
 * here: a team can't be read, and a bot is never a code owner (CODEOWNERS header).
 */
export const parseCodeOwners = (text) =>
	text
		.split("\n")
		.map((line) => line.replace(/#.*/, "").trim())
		.filter(Boolean)
		.map((line) => {
			const [pattern, ...owners] = line.split(/\s+/);
			return {
				pattern,
				rx: toRegExp(pattern),
				owners,
				users: owners.filter((o) => /^@[\w-]+$/.test(o)).map((o) => o.slice(1).toLowerCase()),
			};
		});

/** Whether `path` is code-owned: the last matching rule decides, as on GitHub, and needs owners. */
export const isOwned = (rules, path) => (lastMatch(rules, path)?.owners.length ?? 0) > 0;

/** The users who can approve `path` for its code owners; [] when it's unowned or owned by a team. */
export const ownersOf = (rules, path) => lastMatch(rules, path)?.users ?? [];

/**
 * The verdict for a review event on a PR: `{ ok, owned, message }`, after calling `escalate()` on a
 * code-owned PR that lacks `review:admin` (CONSTRAINTS.md, "Escalation criteria": the label and its
 * one-line comment). `getPull`, `listFiles` (every page) and `listReviews` (every page) answer as
 * REST does. Throws CannotRun when it can't judge.
 */
export const checkCodeOwned = async (
	event,
	{ rules, getPull, listFiles, listReviews, escalate },
) => {
	const head = event?.pull_request?.head?.sha;
	if (!head || !event.pull_request.number)
		throw new CannotRun("the event has no pull_request head");
	if (!rules.some((r) => r.owners.length)) throw new CannotRun("CODEOWNERS lists no owned path");

	const [pull, files] = await Promise.all([getPull(), listFiles()]);
	if (pull.head.sha !== head)
		return {
			ok: false,
			owned: [],
			message: `the head moved to ${pull.head.sha.slice(0, 7)}: a review of it runs this check`,
		};

	// REST lists at most 3000 files; a shorter list than the PR's count could hide an owned path.
	if (files.length < pull.changed_files)
		throw new CannotRun(`GitHub listed ${files.length} of the PR's ${pull.changed_files} files`);

	const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename ?? []].flat()))];
	const owned = paths.filter((p) => isOwned(rules, p));
	if (owned.length === 0) return { ok: true, owned, message: "no code-owned path in the diff" };

	if (!pull.labels.some((l) => l.name === LABEL)) await escalate();
	const reviews = await listReviews();
	const short = head.slice(0, 7);
	const author = ownerAuthorOf(pull, rules, owned);
	if (author && authorReviewed(reviews, author, head))
		return { ok: true, owned, message: `the author, a code owner, reviewed ${short}, the head` };

	const approvers = approversOf(reviews, head);
	const waiting = owned.filter((p) => !ownersOf(rules, p).some((o) => approvers.has(o)));
	if (waiting.length === 0)
		return { ok: true, owned, message: `a code owner approved ${short}, the head` };

	const who = author ? "the author, a code owner, to review" : "a code owner to approve";
	return {
		ok: false,
		owned,
		message: `${waiting.length} code-owned path(s) wait for ${who} ${short}, the head (CODEOWNERS)`,
	};
};

// The PR's author, lowercased, when it is a User account that CODEOWNERS lists as an owner of every
// code-owned path in the diff (#494); otherwise null, and the rule in the header alone decides. Read from the
// REST PR this run already fetched, the same read that pins the head, never from the event.
function ownerAuthorOf(pull, rules, owned) {
	const login = pull.user?.type === "User" ? (pull.user.login?.toLowerCase() ?? null) : null;
	if (!login) return null;

	return owned.every((p) => ownersOf(rules, p).includes(login)) ? login : null;
}

// Whether the author's latest review that isn't dismissed is APPROVED or COMMENTED, on `head`
// (#494). GitHub refuses a self-approval, so a comment is the author's sign-off; a review of an
// older head, or a later Request changes, never counts. A PENDING review isn't submitted, and REST
// shows it only to its own author, so it is skipped as `approversOf` skips it. Latest means last
// submitted: a review's id likely dates from when its draft started (inferred, not checked), so a
// draft begun on an older head and submitted after a comment on the head could have the lower id.
function authorReviewed(reviews, author, head) {
	const latest = [...reviews]
		.sort((a, b) => bySubmitted(a, b) || a.id - b.id)
		.findLast(
			(r) =>
				r.user?.login?.toLowerCase() === author && r.state !== "DISMISSED" && r.state !== "PENDING",
		);
	return (
		latest?.commit_id === head && (latest.state === "APPROVED" || latest.state === "COMMENTED")
	);
}

// The users whose latest review that isn't a comment approves `head`. Reviews sorted by id, the
// order GitHub made them in.
function approversOf(reviews, head) {
	const latest = new Map();
	for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
		if (!r.user?.login || r.state === "COMMENTED" || r.state === "PENDING") continue;

		latest.set(r.user.login.toLowerCase(), r);
	}
	return new Set(
		[...latest].filter(([, r]) => r.state === "APPROVED" && r.commit_id === head).map(([u]) => u),
	);
}

// ISO 8601 timestamps in UTC, as REST gives them, sort as strings.
function bySubmitted(a, b) {
	return (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "");
}

function lastMatch(rules, path) {
	return rules.findLast((r) => r.rx.test(path));
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
		if (!res.ok) throw new CannotRun(`${method} ${path} answered ${res.status}`);
		return res.json();
	};
	const all = async (path) => {
		const items = [];
		for (let page = 1; ; page++) {
			const batch = await call("GET", `${path}?per_page=100&page=${page}`);
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
	let rules;
	try {
		rules = parseCodeOwners(readFileSync(file, "utf8"));
	} catch {
		throw new CannotRun(`can't read CODEOWNERS at ${file}`);
	}
	const number = event?.pull_request?.number;
	const { call, all } = api(
		event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY,
		process.env.GITHUB_TOKEN,
	);
	const r = await checkCodeOwned(event, {
		rules,
		getPull: () => call("GET", `pulls/${number}`),
		listFiles: () => all(`pulls/${number}/files`),
		listReviews: () => all(`pulls/${number}/reviews`),
		escalate: async () => {
			await call("POST", `issues/${number}/labels`, { labels: [LABEL] });
			await call("POST", `issues/${number}/comments`, { body: ESCALATED });
		},
	});
	for (const p of r.owned) console.log(`code-owned: ${JSON.stringify(p)}`);
	if (r.ok) {
		console.log(`code-owned: pass (${r.message})`);
		return 0;
	}
	console.log(`::error title=guard / code-owned::${r.message}`);
	console.error(`code-owned: held: ${r.message}`);
	return 1;
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
