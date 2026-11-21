#!/usr/bin/env node
// acceptance-guard.mjs: `guard / acceptance` (#384, MUST-15.2). A bot-authored PR that touches
// tests/acceptance/** fails; every other PR passes, the admin's included. The detector is the PR's
// author, which the App's token sets, so an agent can't fake it (ADR-0007, section 6). A bot is a
// `[bot]` login or GitHub's `Bot` user type. "Touches" is any file the PR lists there, added,
// changed, deleted or renamed into or out of it; paths compare without case, as a case-blind
// filesystem would merge them.
//
// Usage: node .github/scripts/acceptance-guard.mjs   ($GITHUB_EVENT_PATH; REST with $GITHUB_TOKEN)
// Exit codes: 0 pass, 1 a bot PR touches tests/acceptance, 2 could not run (never reads as a pass).
// Paths print JSON-quoted, so a file name can't start a workflow command.
import { CannotRun, isMain, readEvent } from "./diff.mjs";

const FOLDER = "tests/acceptance";

/** Whether a PR author is a bot: a `[bot]` login, or GitHub's `Bot` type. */
export const isBot = (user) => /\[bot\]$/i.test(user?.login ?? "") || user?.type === "Bot";

/** Whether a repo-relative path is tests/acceptance or under it, in any case. */
export const inAcceptance = (path) => {
	const p = path?.toLowerCase();
	return p === FOLDER || p?.startsWith(`${FOLDER}/`) === true;
};

// The verdict, `{ ok, touched, message }`; a non-bot author passes without a request. `getPull` and
// `listFiles` (every page) answer as REST does. Throws CannotRun when it can't judge.
export const checkAcceptance = async (event, { getPull, listFiles }) => {
	const pr = event?.pull_request;
	if (!pr?.number || !pr.user?.login) throw new CannotRun("the event has no pull_request author");
	const author = pr.user.login;
	if (!isBot(pr.user))
		return { ok: true, touched: [], message: `${author} isn't a bot (MUST-15.2)` };

	const [pull, files] = await Promise.all([getPull(), listFiles()]);
	// REST lists at most 3000 files; a shorter list than the PR's count could hide a touched path.
	if (files.length < pull.changed_files)
		throw new CannotRun(`GitHub listed ${files.length} of the PR's ${pull.changed_files} files`);

	// A rename lists the old path as `previous_filename`, so a move out of the folder counts too.
	const paths = files.flatMap((f) => [f.filename, f.previous_filename]);
	const touched = [...new Set(paths.filter(inAcceptance))];
	if (touched.length === 0)
		return { ok: true, touched, message: `${author}'s PR leaves ${FOLDER}/ alone` };
	return {
		ok: false,
		touched,
		message:
			`${author} is a bot, and this PR touches ${touched.length} path(s) under ${FOLDER}/. ` +
			"Agents can't change the acceptance tests (MUST-15.2): drop those changes, " +
			"or the admin makes them in a PR of their own (ADR-0007, section 6).",
	};
};

const api = (repo, token) => {
	const base = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}/`;
	const get = async (path) => {
		const res = await globalThis.fetch(base + path, {
			headers: {
				accept: "application/vnd.github+json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
		});
		if (!res.ok) throw new CannotRun(`GET ${path} answered ${res.status}`);
		return res.json();
	};
	const all = async (path) => {
		const items = [];
		for (let page = 1; ; page++) {
			const batch = await get(`${path}?per_page=100&page=${page}`);
			items.push(...batch);
			if (batch.length < 100) return items;
		}
	};
	return { get, all };
};

const main = async () => {
	const event = readEvent();
	const number = event?.pull_request?.number;
	const { get, all } = api(
		event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY,
		process.env.GITHUB_TOKEN,
	);
	const r = await checkAcceptance(event, {
		getPull: () => get(`pulls/${number}`),
		listFiles: () => all(`pulls/${number}/files`),
	});
	for (const p of r.touched) console.log(`acceptance: ${JSON.stringify(p)}`);
	if (r.ok) {
		console.log(`acceptance: pass (${r.message})`);
		return 0;
	}
	console.log(`::error title=guard / acceptance::${r.message}`);
	console.error(`acceptance: fail: ${r.message}`);
	return 1;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (e) {
		console.error(
			`acceptance: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`,
		);
		process.exitCode = 2;
	}
}
