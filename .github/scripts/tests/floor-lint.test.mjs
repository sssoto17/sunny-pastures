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

const LINT_RULES = new Set([
	"no-empty",
	"@typescript-eslint/no-empty-function",
	"no-restricted-syntax",
]);

const snippet = (lines) => lines.join("\n").replaceAll("<>", "");

/** The floor findings for `lines`, linted as the file at `filePath`, as "line rule". */
const floorFindings = (lines, filePath) => lintSnippet(snippet(lines), filePath, LINT_RULES);

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
		// Review of #135: an empty statement, `void` on a name, a cast of undefined.
		["a .catch holding only an empty statement", ["p.catch(() => {;});"]],
		["a catch holding only an empty statement", ["try { f(); } catch { ; }"]],
		// Review of the #135 stack: the statement forms of a handler that does nothing.
		["a catch that only voids its error", ["try { f(); } catch (e) { void e; }"]],
		[
			"a catch that only returns",
			["export const g = () => {", "\ttry { f(); } catch { return; }", "};"],
		],
		["a .catch block that only voids its error", ["p.catch((e) => { void e; });"]],
		["a .catch returning void of its error", ["p.catch((e) => void e);"]],
		["a .catch returning undefined cast", ["p.catch(() => <>undefined as never);"]],
		["a .catch returning undefined asserted", ["p.catch(() => <>undefined!);"]],
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

// Property-run counts (#135, ADR-0003 section 9): a property gets its settings from
// inject('fastCheck') and nothing else, so no test file can lower the run count the root config
// reads from SIM_PROPERTY_RUNS. #133's known limits: counts set another way, under other names.
describe("property run counts", () => {
	const SIM_TEST = "packages/sim/src/sim/tests/x.test.ts";
	const HEAD = [
		"import fc from 'fast-check';",
		"import { inject, vi } from 'vitest';",
		"import { requireProvided } from '../../state/tests/provided.js';",
		"vi.setConfig({ testTimeout: inject('propertyTimeout') });",
		"const params = requireProvided('fastCheck', inject('fastCheck'));",
		"const p = fc.property(fc.nat(), () => true);",
	];
	// The finding lines count from the case's own first line.
	const findings = async (lines, file = SIM_TEST) =>
		(await floorFindings([...HEAD, ...lines], file)).map((f) => {
			const [line, rule] = f.split(" ");
			return `${Number(line) - HEAD.length} ${rule}`;
		});

	it.each([
		["settings written inline", ["fc.assert(p, { seed: 1, numRuns: 1 });"]],
		[
			"the shared settings with a count spread over them",
			["fc.assert(p, { ...params, numRuns: 1 });"],
		],
		[
			"settings built in a variable",
			["const quick = { ...params, numRuns: 1 };", "fc.assert(p, quick);"],
		],
		["a computed count", ["const quick = { ...params, numRuns: params.numRuns * 0 };"]],
		["a count assigned", ["params.numRuns = 1;"]],
		["a count assigned by computed key", ["params['numRuns'] = 1;"]],
		[
			"a count by template key",
			["const quick = { ...params, [`numRuns`]: 1 };", "fc.assert(p, quick);"],
		],
		["a count assigned by template key", ["params[`numRuns`] = 1;"]],
		["a count counted down", ["params.numRuns--;"]],
		["a count deleted", ["delete params.numRuns;"]],
		["a count merged in", ["Object.assign(params, { numRuns: 1 });"]],
		["a count defined by name", ["Object.defineProperty(params, 'numRuns', { value: 1 });"]],
		["fc.configureGlobal", ["fc.configureGlobal({ numRuns: 1 });"]],
		["a run cut short by time", ["fc.assert(p, { ...params, interruptAfterTimeLimit: 1 });"]],
		["a run that stops early", ["const quick = { ...params, skipAllAfterTimeLimit: 1 };"]],
		["a run replaying one path", ["const quick = { ...params, path: '0' };"]],
		["a reporter that hides failures", ["const quick = { ...params, reporter: () => 0 };"]],
		["fc.assert taken as a value", ["const check = fc.assert;", "check(p, params);"]],
		["fc.assert reached by computed key", ["fc['assert'](p, params);"]],
		["fc passed on", ["run(fc);"]],
	])("reports %s", async (_case, lines) => {
		expect((await findings(lines)).length).toBeGreaterThan(0);
	});

	it.each([
		["imported under another name", "import * as F from 'fast-check';"],
		["imported by name", "import { assert } from 'fast-check';"],
		["configured by name", "import { configureGlobal } from 'fast-check';"],
	])("reports fast-check %s", async (_case, line) => {
		expect(await floorFindings([line], SIM_TEST)).toContain("1 no-restricted-syntax");
	});

	// A settings object in a helper that doesn't import fast-check still can't hold a count.
	it("reports a count in a test helper", async () => {
		const file = "packages/sim/src/state/tests/quick.ts";
		expect(await floorFindings(["export const quick = { numRuns: 1 };"], file)).toEqual([
			"1 no-restricted-syntax",
		]);
	});

	// Outside the sim the property rules apply too; there is no requireProvided there yet.
	it.each([
		["without settings", ["import fc from 'fast-check';", "fc.assert(p);"]],
		[
			"without reading inject('fastCheck')",
			["import fc from 'fast-check';", "fc.assert(p, settings);"],
		],
	])("reports an app property test %s", async (_case, lines) => {
		expect(await floorFindings(lines, "apps/web/src/x.test.ts")).not.toEqual([]);
	});

	it.each([
		["the shared settings", ["fc.assert(p, params);"]],
		[
			"the shared settings, checked inline",
			["fc.check(p, requireProvided('fastCheck', inject('fastCheck')));"],
		],
		["the run count read", ["expect(counts.size).toBeLessThan(params.numRuns);"]],
		[
			"an async property",
			["await fc.assert(fc.asyncProperty(fc.nat(), async () => true), params);"],
		],
	])("does not report %s", async (_case, lines) => {
		expect(await findings(lines)).toEqual([]);
	});

	it.each([
		[
			"the root config, where the count is read",
			"vitest.config.mts",
			[
				"const runs = 100;",
				"export default { test: { provide: { fastCheck: { seed: 1, numRuns: runs } } } };",
			],
		],
		[
			"a path key in a file without fast-check",
			".github/scripts/tests/x.test.mjs",
			["const f = { path: 'a.ts', seed: 1 };"],
		],
	])("does not report %s", async (_case, file, lines) => {
		expect(await floorFindings(lines, file)).toEqual([]);
	});
});
