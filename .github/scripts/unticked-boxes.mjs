#!/usr/bin/env node
// unticked-boxes.mjs: the `issues: closed` job (#270). An issue closed with acceptance criteria
// still unticked was closed before its work was done (#99 on 9 Nov, #68 on 13 Nov; retro
// 2026-11-15). Boxes in an issue body are only for items to tick (#214), so an unticked box at
// close is worth a comment. The job only comments: it never reopens, labels or edits the issue.
//
// Usage: node .github/scripts/unticked-boxes.mjs --out <file>   (reads the issue from
// $GITHUB_EVENT_PATH). It writes the comment to <file> only when there are unticked boxes; the
// workflow posts the file. Exit codes: 0 done, 2 could not run.
import { readFileSync, writeFileSync } from "node:fs";

import { CannotRun, isMain } from "./diff.mjs";

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The text of each unticked task-list box in `body`, its wrapped lines joined with a space. Boxes
 * in HTML comments and fenced code are skipped: they don't render as boxes.
 * @param {string} body
 * @returns {string[]}
 */
export const findUnticked = (body) => {
	const items = [];
	let open = null; // the item being read: { ticked, text }, or null between items
	let fence = null; // the open fence's marker, or null outside fenced code
	const lines = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n");
	for (const line of lines) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			open = null;
			continue;
		}

		const item = ITEM.exec(line);
		if (item) {
			open = { ticked: item[1] !== " ", text: item[2].trim() };
			if (!open.ticked) items.push(open);
		} else if (open && /^\s+\S/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
			open.text += ` ${line.trim()}`;
		} else {
			open = null;
		}
	}
	return items.map((i) => i.text);
};

/**
 * The comment for an issue closed with `items` unticked. The boxes go in a code block, so a
 * mention or an issue reference in them doesn't notify or cross-link again.
 * @param {string[]} items
 */
export const commentFor = (items) => {
	const longest = Math.max(
		0,
		...items.map((t) => Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length))),
	);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const count = items.length === 1 ? "1 unticked box" : `${items.length} unticked boxes`;
	return [
		`This issue was closed with ${count} in its body:`,
		"",
		fence,
		...items.map((t) => `- [ ] ${t}`),
		fence,
		"",
		'If the work is done, tick them. If it isn\'t, reopen the issue: a closing keyword in an earlier part of a split closes it early (CONSTRAINTS.md, "Split size").',
		"",
		// No issue reference here: one would cross-link that issue from every closed issue.
		"<sub>Posted by `.github/workflows/issue-closed.yml`. It only comments: nothing on the issue was changed.</sub>",
		"",
	].join("\n");
};

const main = () => {
	const i = process.argv.indexOf("--out");
	const out = i === -1 ? null : process.argv[i + 1];
	if (!out) throw new CannotRun("usage: unticked-boxes.mjs --out <file>");

	let event;
	try {
		event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
	} catch {
		throw new CannotRun("no readable issues event at $GITHUB_EVENT_PATH");
	}
	const number = event?.issue?.number;
	const items = findUnticked(event?.issue?.body ?? "");
	if (items.length === 0) {
		console.log(`unticked-boxes: #${number} closed with no unticked boxes`);
		return 0;
	}

	writeFileSync(out, commentFor(items));
	console.log(
		`unticked-boxes: #${number} closed with ${items.length} unticked box${items.length === 1 ? "" : "es"}`,
	);
	return 0;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (e) {
		console.error(
			`unticked-boxes: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`,
		);
		process.exitCode = 2;
	}
}
