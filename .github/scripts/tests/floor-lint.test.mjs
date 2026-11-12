// The Floor's unfinished-work checks as ESLint rules (#135, CONSTRAINTS.md, Floor): a stub that
// throws, an empty or comment-only `catch`, and a rejection handler that does nothing. ESLint reads
// the syntax tree, so the spellings the floor guard's line patterns missed (#133's known limits and
// #135's list) are caught too. The guard checks that these rules stay on and unsuppressed.
//
// The snippets are text for ESLint to parse; nothing runs them. Until #135's guard change is on
// main, main's guard reads this file's lines too, so `<>` breaks each stub where its line patterns
// would match; `snippet` removes it.
import { describe, expect, it } from "vitest";

import { lintSnippet } from "./lint-snippet.mjs";

const FLOOR_RULES = new Set([
	"no-empty",
	"@typescript-eslint/no-empty-function",
	"no-restricted-syntax",
]);

const snippet = (lines) => lines.join("\n").replaceAll("<>", "");

/** The floor findings for `lines`, linted as the file at `filePath`, as "line rule". */
const floorFindings = (lines, filePath) => lintSnippet(snippet(lines), filePath, FLOOR_RULES);

// One file of each kind ESLint reads: sim source, sim test, app source, CI script.
const FILES = [
	"packages/sim/src/hash/index.ts",
	"packages/sim/src/hash/tests/index.test.ts",
	"apps/web/src/server/x.ts",
	".github/scripts/x.mjs",
];

describe("unfinished work", () => {
	// Each case is one statement; the finding lines are its own, counted from 1.
	it.each([
		["a not-implemented stub", ["throw new <>Error('Not implemented');"]],
		["a stub without new", ["throw <>Error('not implemented');"]],
		["an upper-case stub", ["throw new <>Error('NOT IMPLEMENTED');"]],
		["a hyphenated stub", ["throw new <>Error('not-implemented');"]],
		['a "not yet implemented" stub', ["throw new <>Error('Not yet implemented');"]],
		['an "unimplemented" stub in a template', ["throw new <>TypeError(`unimplemented: ${x}`);"]],
		// #133's known limit: the message on the line after `throw new Error(`.
		[
			"a stub whose message is on the next line",
			["throw new <>Error(", "\t'Not implemented',", ");"],
		],
		["a stub thrown as a plain string", ["throw '<>not implemented';"]],
		[
			"a stub rejected instead of thrown",
			["export const r = () => Promise.reject(new <>Error('unimplemented'));"],
		],
		["a NotImplementedError", ["throw new <>NotImplementedError();"]],
		["a notImplemented helper", ["export const run = () => <>notImplemented();"]],
	])("reports %s", async (_case, lines) => {
		for (const file of FILES) {
			const findings = await floorFindings(lines, file);
			expect(findings.length, file).toBeGreaterThan(0);
		}
	});

	// Unfinished work can never be waived, so a false positive blocks for good (review of #133).
	it.each([
		[
			"a message that mentions unimplemented",
			["throw new Error('Feature flag unimplemented-x is off');"],
		],
		["a message about something else", ["throw new Error(`Unknown crop: ${id}`);"]],
		[
			"a catch with a comment and a call",
			["try { f(); } catch (e) {", "\t/* log it */ report(e);", "}"],
		],
		["a catch with code between comments", ["try { f(); } catch { /* a */ g(); /* b */ }"]],
		["a .catch that handles the error", ["p.catch((e) => { report(e); });"]],
		["a .catch that rethrows", ["p.catch((e) => { throw wrap(e); });"]],
		["a .then with a real rejection handler", ["p.then(f, (e) => report(e));"]],
		["a callback that returns a value", ["xs.map(() => null);"]],
	])("does not report %s", async (_case, lines) => {
		for (const file of FILES) expect(await floorFindings(lines, file), file).toEqual([]);
	});
});

describe("swallowed errors", () => {
	it.each([
		["an empty catch", ["try { f(); } catch {<>}"]],
		["an empty multi-line catch", ["try {", "\tf();", "} catch (e) {", "<>}"]],
		["a catch holding only a comment", ["try { f(); } catch { /* fine */<> }"]],
		["a catch holding only a // comment", ["try {", "\tf();", "} catch (e) { // ignore", "<>}"]],
		[
			"a catch holding only a multi-line block comment",
			["try {", "\tf();", "} catch (e) {", "\t/* ignored,", "\t   on purpose */", "<>}"],
		],
		["an empty .catch callback", ["p.catch(() => {<>});"]],
		["an empty .catch callback written across lines", ["p.catch((e) => {", "<>});"]],
		["an empty .catch function", ["p.catch(function () {<>});"]],
		["an async empty .catch", ["p.catch(async () => {<>});"]],
		["a .catch holding only a comment", ["p.catch(() => {", "\t// ignore", "<>});"]],
		["a .catch returning undefined", ["p.catch(() => <>undefined);"]],
		["a .catch returning null", ["p.catch(() => <>null);"]],
		["a .catch returning void 0", ["p.catch(() => <>void 0);"]],
		["a .catch with a bare return", ["p.catch(() => {", "\treturn;", "});"]],
		["a computed .catch", ["p['catch'](() => <>undefined);"]],
		["an empty rejection handler in .then", ["p.then(f, () => {<>});"]],
		["a .then rejection handler returning null", ["p.then(f, () => <>null);"]],
		// #133's known limit: a named no-op. ESLint can't follow the name to its definition, so the
		// no-op is reported where it's defined.
		["a no-op function passed by name", ["const noop = () => <>undefined;", "p.catch(noop);"]],
		[
			"a no-op declaration passed by name",
			["function noop() {", "\t// nothing", "}", "p.catch(noop);"],
		],
	])("reports %s", async (_case, lines) => {
		for (const file of FILES) {
			const findings = await floorFindings(lines, file);
			expect(findings.length, file).toBeGreaterThan(0);
		}
	});
});
