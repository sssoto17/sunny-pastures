#!/usr/bin/env node
// md-tables.mjs: the table check in `format:md` (#344; ADR-0005, section 6, Prettier). Prettier
// wraps the repo's Markdown, but it pads every row of a table to the table's widest row (#231,
// section 2), so every top-level table keeps `<!-- prettier-ignore -->` on the line before it and
// stays as written. A table without it would be padded silently by the next `prettier --write`;
// this check fails it first.
//
// Usage: node .github/scripts/md-tables.mjs [file...]
//   With no files: every tracked *.md in Prettier's scope (what `prettier --check "**/*.md"`
//   reads), run from the top of the work tree.
// Exit codes: 0 every table keeps its comment; 1 a table doesn't (each one listed as file:line);
// 2 the files can't be read.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { getFileInfo } from "prettier";

import { CannotRun, git, isMain } from "./diff.mjs";

const IGNORE = "<!-- prettier-ignore -->";

// The first line (1-based) of each top-level table in `text` whose line before isn't the ignore
// comment. The file is read with micromark and its GFM extension, as the floor guard reads
// CONSTRAINTS.md (#132), so a table-looking line in a fence or an indented block isn't a table.
// Only top-level tables count, as #344 asks: the repo has no nested table today (#231, section 4).
export const bareTables = (text) => {
	const lines = text.split(/\r?\n/);
	const events = postprocess(
		parse({ extensions: [gfm()] })
			.document()
			.write(preprocess()(text, undefined, true)),
	);
	const bare = [];
	let depth = 0;
	for (const [kind, token] of events) {
		if (kind === "exit") {
			depth--;
			continue;
		}

		if (depth === 0 && token.type === "table") {
			const before = lines[token.start.line - 2] ?? "";
			if (before.trim() !== IGNORE) bare.push(token.start.line);
		}
		depth++;
	}
	return bare;
};

// file:line for each bare table in the files. CannotRun when one can't be read.
const check = (files) =>
	files.flatMap((file) => {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			throw new CannotRun(`can't read ${file}`);
		}
		return bareTables(text).map((line) => `${file}:${line}`);
	});

// The tracked Markdown that `prettier --check "**/*.md"` reads, from the top of the work tree:
// Prettier skips what .gitignore and .prettierignore list (its CLI's default ignore files).
// Symlinks are skipped: CLAUDE.md links to AGENTS.md, which is checked under its own name.
const markdownInScope = async () => {
	const top = git(["rev-parse", "--show-toplevel"])?.trim();
	if (!top) throw new CannotRun("not in a git work tree");

	process.chdir(top);
	const listed = git(["ls-files", "-z", "--", "*.md"]);
	if (listed === null) throw new CannotRun("git ls-files failed");

	const ignorePath = [join(top, ".gitignore"), join(top, ".prettierignore")];
	const inScope = [];
	for (const file of listed.split("\0")) {
		if (!file || lstatSync(file).isSymbolicLink()) continue;

		if (!(await getFileInfo(join(top, file), { ignorePath })).ignored) inScope.push(file);
	}
	return inScope;
};

const main = async (files) => {
	let found;
	try {
		found = check(files.length > 0 ? files : await markdownInScope());
	} catch (e) {
		if (!(e instanceof CannotRun)) throw e;

		console.error(`md-tables: ${e.message}`);
		return 2;
	}
	for (const at of found)
		console.error(`${at}: a table without ${IGNORE} on the line before it (ADR-0005, section 6)`);
	return found.length > 0 ? 1 : 0;
};

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
