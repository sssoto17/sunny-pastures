#!/usr/bin/env node
// pr-body-guard.mjs: `guard / pr-body` (#270). An earlier part of a split says `Part of #N` and
// must not link #N with a closing keyword, or #N closes when that part merges, before its work is
// done: #131 closed #99 through a code span in a plan table, #245 closed #68 through "doesn't close
// #68", and #279's first body linked #48 through prose about the next part (retro 2026-11-15).
//
// GitHub's grammar ("Linking a pull request to an issue", docs.github.com, read through Context7
// on 16 Nov 2026): the nine keywords close, closes, closed, fix, fixes, fixed, resolve, resolves,
// resolved; in any case; optionally followed by a colon; then `#N` or `OWNER/REPO#N`. The docs say
// nothing about code spans, HTML comments, fenced code or full issue URLs. #131 shows a code span
// links, so this guard reads the raw body and counts all of them: a false alarm costs an edit, a
// miss closes an issue early.
//
// Usage: node .github/scripts/pr-body-guard.mjs   (reads the PR from $GITHUB_EVENT_PATH)
// Exit codes: 0 pass, 1 an early closing link, 2 could not run (never reads as a pass).
// It prints only what the patterns matched (a keyword and an issue reference), never a whole line
// of the body, so no text the PR wrote can run as a workflow command.
import { CannotRun, isMain, readEvent } from "./diff.mjs";

const KEYWORD = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
// What may come before `Part of` at the start of its line: indent, a quote, a list marker, a table
// pipe, emphasis. Spaces and tabs only, never a newline: that keeps each line's scan linear on a
// body of blank lines, and the optional colon is grouped with its spaces for the same reason.
const LINK_LINE = String.raw`^[ \t>*_|-]*(?:\d+[.)][ \t]*)?(?:\*\*|__)?`;

/**
 * Every closing keyword in `body` that links an issue the same body calls `Part of #N`, in order.
 * A body calls an issue `Part of #N` on a line that starts with it, as the PR template's link line
 * does: a closing part that mentions the earlier parts' `Part of #N` mid-line (#189, #202) or "the
 * last part of #N" (#149) is not an earlier part.
 * `repo` is the PR's `owner/name`, for the `owner/name#N` and issue-URL forms; null skips them.
 * @param {string} body
 * @param {string | null} repo
 * @returns {{ line: number, issue: number, text: string }[]}
 */
export const findEarlyClosings = (body, repo) => {
	const ref = issueRef(repo);
	const parts = new Set(
		[
			...body.matchAll(
				new RegExp(String.raw`${LINK_LINE}part of(?:\*\*|__)?[ \t]*:?[ \t]*${ref}(?!\d)`, "gim"),
			),
		].map(issueOf),
	);
	if (parts.size === 0) return [];

	const findings = [];
	for (const m of body.matchAll(new RegExp(String.raw`${KEYWORD}(?:\s*:)?\s*${ref}(?!\d)`, "gi"))) {
		const issue = issueOf(m);
		if (!parts.has(issue)) continue;

		findings.push({
			line: body.slice(0, m.index).split("\n").length,
			issue,
			text: m[0].replace(/\s+/g, " "),
		});
	}
	return findings;
};

// `#N`, and for this repository `owner/name#N` and its issue URL. Each form captures N.
function issueRef(repo) {
	const forms = [String.raw`#(\d+)`];
	if (repo) {
		const name = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		forms.push(
			String.raw`${name}#(\d+)`,
			String.raw`https?://(?:www\.)?github\.com/${name}/issues/(\d+)`,
		);
	}
	return `(?:${forms.join("|")})`;
}

function issueOf(match) {
	return Number(match.slice(1).find((g) => g !== undefined));
}

const HINT = `An earlier part of a split says \`Part of #N\` and describes the later parts without a closing
keyword. GitHub links a keyword followed by #N anywhere in the body (a code span, a table, a
negated phrase, prose about another PR) and closes #N when this part merges. Reword the line,
for example "the last part carries the link", or, if this PR completes the issue, replace
\`Part of #N\` with the closing link (CONSTRAINTS.md, "Split size").`;

const main = () => {
	const event = readEvent();
	const body = event?.pull_request?.body ?? "";
	const repo = event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? null;
	const findings = findEarlyClosings(body, repo);
	if (findings.length === 0) {
		console.log("pr-body: pass (no `Part of` issue is linked by a closing keyword)");
		return 0;
	}

	for (const f of findings) {
		console.error(
			`pr-body: line ${f.line}: \`${f.text}\` links #${f.issue}, which this body calls \`Part of #${f.issue}\``,
		);
		console.log(
			`::error title=guard / pr-body::Line ${f.line} of the PR body links #${f.issue} with a closing keyword, but the body says Part of #${f.issue}`,
		);
	}
	console.error(`\n${HINT}`);
	return 1;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (e) {
		console.error(`pr-body: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`);
		process.exitCode = 2;
	}
}
