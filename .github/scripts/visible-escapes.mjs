#!/usr/bin/env node
// visible-escapes.mjs: makes the control characters in a PR's diff visible before the reviewer
// reads it (#648). review.yml's gather step pipes the diff through it into diff.patch.
//
// Why: an escape sequence in a PR can hide text in a terminal, so the reviewer must see that one
// is there (admin, 26 Nov 2026), and `gh pr diff` refuses outright to print a diff that holds one,
// which stopped the review before Claude ran (#645, run 45871690829). So nothing is dropped: each
// ESC byte becomes the text `<ESC>`, and every other control character, C0 (except tab, line feed
// and carriage return, which diffs hold as text), DEL and C1 (U+0080-U+009F as UTF-8, where
// U+009B is a one-byte CSI), becomes `<U+XXXX>`. The rest of the diff passes byte for byte, so a
// file that isn't UTF-8 is never re-encoded.
//
// Usage: node .github/scripts/visible-escapes.mjs <out-file> <diff
// Writes the visible diff to <out-file> and prints one line saying what it replaced, which the
// workflow keeps as diff-escapes.txt in the review context. Exit codes: 0 written; 2 could not run.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";

import { isMain } from "./diff.mjs";

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;
const DEL = 0x7f;

const marker = (codePoint) =>
	codePoint === ESC ? "<ESC>" : `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;

/**
 * `bytes` with each control character replaced by its marker, and how many of each kind it held.
 * A C1 character counts only as its UTF-8 form (0xC2 then 0x80-0x9F): 0xC2 never continues a
 * sequence, so that pair is always the character.
 */
export function showEscapes(bytes) {
	const parts = [];
	let esc = 0;
	let other = 0;
	let from = 0;
	const replace = (at, length, codePoint) => {
		parts.push(bytes.subarray(from, at), Buffer.from(marker(codePoint)));
		from = at + length;
		if (codePoint === ESC) esc++;
		else other++;
	};
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if ((b < 0x20 && b !== TAB && b !== LF && b !== CR) || b === DEL) replace(i, 1, b);
		else if (b === 0xc2 && bytes[i + 1] >= 0x80 && bytes[i + 1] <= 0x9f) {
			replace(i, 2, bytes[i + 1]);
			i++;
		}
	}
	parts.push(bytes.subarray(from));
	return { bytes: Buffer.concat(parts), esc, other };
}

/** The line the workflow logs and keeps in the review context. */
export function describeEscapes({ esc, other }) {
	if (esc + other === 0)
		return "diff.patch: no control characters; the workflow changed nothing in the PR's diff.";
	const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
	return (
		`diff.patch: the workflow replaced ${count(esc, "ESC byte")} with <ESC> and ` +
		`${count(other, "other control character")} with <U+XXXX>; each marker stands for the ` +
		"control character the PR's diff holds there."
	);
}

if (isMain(import.meta.url)) {
	const out = process.argv[2];
	if (!out || process.argv.length > 3) {
		console.error("visible-escapes: usage: node visible-escapes.mjs <out-file> <diff");
		process.exitCode = 2;
	} else {
		try {
			const shown = showEscapes(readFileSync(0));
			writeFileSync(out, shown.bytes);
			console.log(describeEscapes(shown));
		} catch (e) {
			console.error(`visible-escapes: cannot run: ${e?.message ?? e}`);
			process.exitCode = 2;
		}
	}
}
