#!/usr/bin/env node
// factory-fix-gate.mjs: the factory's gate in fix mode (#588; ADR-0002, area 2, "Fix rounds
// (#588)"), run by factory-gather.sh when factory.yml gets a `pr` input. A fix round is worked only
// when the PR is open, opened by sunny-factory[bot] from a `<n>-<slug>` branch of this repo, every
// commit on it is authored and committed by that bot user (the factory made it: lanes open PRs as
// the App too, #336, but commit as themselves), its head
// is still the commit the dispatch named (`head`), and sunny-reviewer[bot]'s newest verdict
// (factory-review.mjs) is on that head, sends it back for fixes and lists at least one Required
// finding. Writes run=true, pr=, issue= (the branch's number), branch=, head= and turns= only when
// all of that holds, and the Required findings to FINDINGS; every refusal is one `GATE refused:`
// line, a warning annotation and a line in the step summary, and exits 0, as factory-gate.sh does.
//
// Env: PR, HEAD, ISSUE (must be empty: a run is an issue or a fix, never both) and MAX_TURNS (the
// dispatch inputs, through env:), PR_JSON (GET /repos/{o}/{r}/pulls/{n}, or {} when that read
// failed), REVIEWS_JSON and COMMITS_JSON (its reviews and its commits, each one array), BOT_EMAIL
// (the bot user's commit email, from factory.yml's FACTORY_BOT_ID), GITHUB_REPOSITORY, FINDINGS, GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY (optional). Exit codes: 0 decided, 2 could not run (a file unreadable).
// Tests: .github/scripts/tests/factory-review.test.mjs ("factory-fix-gate.mjs")
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { isMain } from "./diff.mjs";
import { newestVerdict, requiredFindings, wantsFixes } from "./factory-review.mjs";

const BOT = "sunny-factory[bot]";
const CAP = 100; // --max-turns, as factory-gate.sh: the input may only lower it

/**
 * `{ refusal }`, or the checked values `{ pr, issue, branch, head, turns, findings }`. The inputs
 * are the raw dispatch inputs; `pull` and `reviews` the gathered files.
 */
export const checkFix = ({ pr, head, issue, maxTurns, repo, pull, reviews, commits, botEmail }) => {
	const input = checkInputs({ pr, head, issue, maxTurns });
	if (typeof input === "string") return { refusal: input };
	const why = refusePull(pull, input, repo);
	if (why) return { refusal: why };
	const byBot = (c) =>
		c.commit?.author?.email === botEmail && c.commit?.committer?.email === botEmail;
	if (commits.length === 0 || !commits.every(byBot)) {
		return { refusal: `PR #${pr} has commits that aren't ${BOT}'s: the factory didn't make it` };
	}
	const review = newestVerdict(reviews);
	if (!review) return { refusal: `PR #${pr} has no verdict from sunny-reviewer[bot]` };
	if (review.commit_id !== head) {
		return { refusal: `the reviewer's newest verdict on PR #${pr} isn't on ${head.slice(0, 7)}` };
	}
	if (!wantsFixes(review))
		return { refusal: `the reviewer's newest verdict doesn't ask for fixes` };
	const findings = requiredFindings(review.body);
	if (findings.length === 0) return { refusal: `the reviewer's verdict lists no Required finding` };
	const branch = pull.head.ref;
	return { ...input, issue: Number(branch.split("-")[0]), branch, findings };
};

// The checked inputs, or why they're refused.
function checkInputs({ pr, head, issue, maxTurns }) {
	if (issue) return "a run takes an issue or a pr, not both";
	if (!/^[1-9]\d{0,6}$/.test(pr ?? "")) return `the pr input ${JSON.stringify(pr)} isn't a number`;
	if (!/^[0-9a-f]{40}$/.test(head ?? "")) return "the head input isn't a full commit SHA";
	const turns = maxTurns || String(CAP);
	if (!/^[1-9]\d{0,2}$/.test(turns) || Number(turns) > CAP) {
		return `max_turns ${JSON.stringify(turns)} must be a whole number from 1 to ${CAP}`;
	}
	return { pr: Number(pr), head, turns: Number(turns) };
}

// Why the PR can't take a fix round, or null.
function refusePull(pull, { pr, head }, repo) {
	if (pull.number !== pr) return `PR #${pr} doesn't exist or can't be read`;
	if (pull.state !== "open") return `PR #${pr} is ${pull.state}`;
	if (pull.user?.login !== BOT) return `PR #${pr} wasn't opened by ${BOT}`;
	return refuseHead(pull.head ?? {}, { pr, head }, repo);
}

// Why the PR's branch can't take a fix round, or null.
function refuseHead(branch, { pr, head }, repo) {
	if (branch.repo?.full_name !== repo) return `PR #${pr}'s branch isn't in ${repo}`;
	if (!/^[1-9]\d{0,6}-[a-z0-9-]{1,90}$/.test(branch.ref ?? "")) {
		return `PR #${pr}'s branch isn't <n>-<slug>`;
	}
	if (branch.sha !== head) return `PR #${pr} moved: its head isn't ${head.slice(0, 7)}`;
	return null;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const main = () => {
	const env = process.env;
	const reviews = readJson(env.REVIEWS_JSON);
	const commits = readJson(env.COMMITS_JSON);
	if (!Array.isArray(reviews) || !Array.isArray(commits)) {
		throw new Error("REVIEWS_JSON or COMMITS_JSON isn't an array");
	}
	if (!env.BOT_EMAIL) throw new Error("BOT_EMAIL is not set");
	const out = (line) => appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
	const c = checkFix({
		pr: env.PR,
		head: env.HEAD,
		issue: env.ISSUE,
		maxTurns: env.MAX_TURNS,
		repo: env.GITHUB_REPOSITORY,
		pull: readJson(env.PR_JSON),
		reviews,
		commits,
		botEmail: env.BOT_EMAIL,
	});
	if (c.refusal) {
		// Escaped as workflow commands require, as factory-gate.sh's esc().
		const m = c.refusal.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
		console.log(`GATE refused: ${m}`);
		console.log(`::warning title=factory refused::${m}`);
		if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Refused: ${m}\n`);
		out("run=false");
		return;
	}
	writeFileSync(env.FINDINGS, `${c.findings.join("\n\n")}\n`);
	for (const k of ["pr", "issue", "branch", "head", "turns"]) out(`${k}=${c[k]}`);
	console.log(
		`GATE run: fix PR #${c.pr} (${c.branch} at ${c.head.slice(0, 7)}), ` +
			`${c.findings.length} Required finding(s) (max-turns ${c.turns})`,
	);
	out("run=true");
};

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (e) {
		console.error(`factory-fix-gate: cannot run: ${e?.message ?? e}`);
		process.exitCode = 2;
	}
}
