#!/usr/bin/env node
// pr-body-guard.mjs: `guard / pr-body` (#270, #512). Two checks on the PR body's closing keywords.
//
// A merge closes its own issue and only that one (#512): five issues closed with work left in one
// week (#386 through a code span in #426's body, #107, #358, #404, #417). So every closing keyword
// must name the PR's own issue, the `<N>` of its branch (`<N>-<slug>`, optionally after one
// `<prefix>/` and `issue-`, as scripts/board-status.sh reads it), or failing that the issue on the
// body's first link line. The one way to close a second issue is a line of its own that starts
// `Also closes #M` (docs/agents/issue-tracker.md, "Closing issues").
//
// An earlier part of a split says `Part of #N` and must not link #N with a closing keyword, or #N
// closes when that part merges, before its work is done: #131 closed #99 through a code span in a
// plan table, #245 closed #68 through "doesn't close #68", and #279's first body linked #48
// through prose about the next part (retro 2026-11-15).
//
// GitHub's grammar ("Linking a pull request to an issue", docs.github.com, read through Context7
// on 16 Nov 2026): the nine keywords close, closes, closed, fix, fixes, fixed, resolve, resolves,
// resolved; in any case; optionally followed by a colon; then `#N` or `OWNER/REPO#N`. The docs say
// nothing about code spans, HTML comments, fenced code, emphasis or full issue URLs. #131 shows a
// code span links, so this guard reads the raw body and counts all of them, bold keywords
// (`**Fixes** #N`) included: a false alarm costs an edit, a miss closes an issue early.
//
// Usage: node .github/scripts/pr-body-guard.mjs   (reads the PR from $GITHUB_EVENT_PATH)
// Exit codes: 0 pass, 1 an early or a foreign closing link, 2 could not run (never reads as a pass).
// It prints only what the patterns matched (a keyword and an issue reference), never a whole line
// of the body, so no text the PR wrote can run as a workflow command.
import { CannotRun, isMain, readEvent } from "./diff.mjs";

// No letter or digit before it; an underscore may be, for `__Fixes__`.
const KEYWORD = String.raw`(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
// Between a keyword and its issue: bold around the keyword or its colon, a colon, spaces.
const KEYWORD_GAP = String.raw`(?:\*\*|__)?(?:\s*:)?(?:\*\*|__)?\s*`;
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

	return closings(body, ref)
		.filter((f) => parts.has(f.issue))
		.map(finding);
};

// The branch grammar scripts/board-status.sh reads (`decide branch`): one optional `<prefix>/`, an
// optional `issue-`, then `<N>-<slug>`.
const BRANCH = /^(?:[A-Za-z0-9._-]+\/)?(?:issue-)?([1-9]\d{0,6})-[A-Za-z0-9._-]+$/;

// The start of a line that opens with a link or `Also closes`: indent, a list marker, bold. No
// quote, table pipe or code span: a line there is about something else.
const PLAIN_LINE = String.raw`^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?`;

/**
 * The issue this PR is for: the `<N>` its branch names, else the issue on the body's first link
 * line outside a fence (a plain line that starts with a closing keyword or `Part of`, as the PR
 * template's first line does), else null.
 * @param {string} branch the PR's head ref
 * @param {string} body
 * @param {string | null} repo
 * @returns {number | null}
 */
export const ownIssue = (branch, body, repo) => {
	const named = BRANCH.exec(branch ?? "");
	if (named) return Number(named[1]);
	const fenced = fencedLines(body);
	const links = body.matchAll(
		new RegExp(
			String.raw`${PLAIN_LINE}(?:${KEYWORD}|part of)${KEYWORD_GAP}${issueRef(repo)}(?!\d)`,
			"gim",
		),
	);
	for (const m of links) if (!fenced.has(lineOf(body, m.index))) return issueOf(m);
	return null;
};

/**
 * Every closing keyword in `body` that links an issue other than `own`, in order, apart from the
 * `closes` that opens an `Also closes #M` line. That line starts with only indent, a list marker or
 * bold before `Also`, outside a fence: one in a quote, a table, a code span or a fenced block is
 * reported like any other keyword. With `own` null, every closing keyword is foreign.
 * @param {string} body
 * @param {string | null} repo
 * @param {number | null} own
 * @returns {{ line: number, issue: number, text: string }[]}
 */
export const findForeignClosings = (body, repo, own) => {
	const fenced = fencedLines(body);
	const also = new Set(
		[...body.matchAll(new RegExp(String.raw`${PLAIN_LINE}also[ \t]+(?=closes\b)`, "gim"))]
			.filter((m) => !fenced.has(lineOf(body, m.index)))
			.map((m) => m.index + m[0].length),
	);
	return closings(body, issueRef(repo))
		.filter((f) => f.issue !== own && !also.has(f.index))
		.map(finding);
};

// Every closing keyword followed by an issue `ref`, in order: its line, issue, offset and the
// matched text with its whitespace collapsed (the only body text the guard ever prints).
function closings(body, ref) {
	return [...body.matchAll(new RegExp(String.raw`${KEYWORD}${KEYWORD_GAP}${ref}(?!\d)`, "gi"))].map(
		(m) => ({
			line: lineOf(body, m.index),
			issue: issueOf(m),
			index: m.index,
			text: m[0].replace(/\s+/g, " "),
		}),
	);
}

// A closing as the guard reports it, without its offset.
function finding({ line, issue, text }) {
	return { line, issue, text };
}

// The 1-based numbers of the lines inside a ``` or ~~~ fence, the fence lines included. An
// unclosed fence runs to the end of the body, as CommonMark reads it.
function fencedLines(body) {
	const fenced = new Set();
	let fence = null;
	body.split("\n").forEach((text, i) => {
		const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
		if (fence === null) {
			if (!mark) return;
			fence = mark[1];
		} else if (mark && closesFence(fence, mark[1], mark[2])) fence = null;
		fenced.add(i + 1);
	});
	return fenced;
}

// A closing fence: the opening's character, at least as long, nothing after it but spaces.
function closesFence(open, mark, rest) {
	return mark[0] === open[0] && mark.length >= open.length && !/\S/.test(rest);
}

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

function lineOf(body, index) {
	return body.slice(0, index).split("\n").length;
}

function issueOf(match) {
	return Number(match.slice(1).find((g) => g !== undefined));
}

const EARLY_HINT = `An earlier part of a split says \`Part of #N\` and describes the later parts without a closing
keyword. GitHub links a keyword followed by #N anywhere in the body (a code span, a table, a
negated phrase, prose about another PR) and closes #N when this part merges. Reword the line,
for example "the last part carries the link", or, if this PR completes the issue, replace
\`Part of #N\` with the closing link (CONSTRAINTS.md, "Split size").`;

const FOREIGN_HINT = `A merge closes its own issue and only that one (#512). GitHub links a keyword followed by #N
anywhere in the body (a code span, a quote, a table, prose about another PR) and closes #N on
merge. Reword the line without the keyword ("the gap #N found", "see #N"). If this PR really
completes a second issue too, give it a line of its own: \`Also closes #M\`
(docs/agents/issue-tracker.md, "Closing issues").`;

const main = () => {
	const event = readEvent();
	const body = event?.pull_request?.body ?? "";
	const repo = event?.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? null;
	const own = ownIssue(event?.pull_request?.head?.ref ?? "", body, repo);
	const early = findEarlyClosings(body, repo);
	const foreign = findForeignClosings(body, repo, own);
	if (early.length === 0 && foreign.length === 0) {
		console.log(
			`pr-body: pass (closing keywords name only ${own ? `#${own}` : "no issue"} or an Also closes line; no \`Part of\` issue is linked)`,
		);
		return 0;
	}

	for (const f of early) {
		console.error(
			`pr-body: line ${f.line}: \`${f.text}\` links #${f.issue}, which this body calls \`Part of #${f.issue}\``,
		);
		console.log(
			`::error title=guard / pr-body::Line ${f.line} of the PR body links #${f.issue} with a closing keyword, but the body says Part of #${f.issue}`,
		);
	}
	const mine = own ? `this PR's issue is #${own}` : "this PR names no issue of its own";
	for (const f of foreign) {
		console.error(`pr-body: line ${f.line}: \`${f.text}\` links #${f.issue}, but ${mine}`);
		console.log(
			`::error title=guard / pr-body::Line ${f.line} of the PR body closes #${f.issue} on merge, but ${mine}`,
		);
	}
	if (early.length) console.error(`\n${EARLY_HINT}`);
	if (foreign.length) console.error(`\n${FOREIGN_HINT}`);
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
