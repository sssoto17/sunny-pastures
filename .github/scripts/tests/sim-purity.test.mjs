// The sim purity rules in eslint.config.mjs (#81, MUST-10.1): each banned construct is reported
// in a file inside packages/sim and none of the rules fire outside it. It lives here because the
// root Vitest include already runs .github/scripts tests, and it can't sit inside packages/sim:
// it imports eslint and node:*.
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { lintSnippet, root } from "./lint-snippet.mjs";

const eslint = new ESLint({ cwd: root });
const PURITY_RULES = new Set([
	"no-eval",
	"no-new-func",
	"no-restricted-globals",
	"no-restricted-imports",
	"no-restricted-properties",
	"no-restricted-syntax",
]);

/** The purity findings for `code` linted as if it were the file at `filePath`, as "line rule". */
const purityFindings = (code, filePath) => lintSnippet(code, filePath, PURITY_RULES);

// One banned construct per line, so each finding names its line.
const BANNED = [
	"import { readFileSync } from 'node:fs';",
	"import { thing } from 'some-package';",
	"export { other } from '@scope/pkg';",
	"export const a = Date.now();",
	"export const b = Math.random();",
	"export const c = new Date();",
	"export const d = new Date;",
	"export const e = Date();",
	"export const f = import('./lazy.js');",
	"export class Farm {}",
	"export const g = class {};",
].join("\n");

const BANNED_FINDINGS = [
	"1 no-restricted-imports",
	"2 no-restricted-imports",
	"3 no-restricted-imports",
	"4 no-restricted-properties",
	"5 no-restricted-properties",
	"6 no-restricted-syntax",
	"7 no-restricted-syntax",
	"8 no-restricted-syntax",
	"9 no-restricted-syntax",
	"10 no-restricted-syntax",
	"11 no-restricted-syntax",
];

// Ways around the rules above, each reaching the clock or randomness another way (review of #121).
// Like every snippet here, these are text for ESLint to parse; nothing ever runs them.
const EVASIONS = [
	"export const a = eval('Date.now()');",
	"export const b = new Function('return Date.now()')();",
	"export const c = globalThis.Math.random();",
	"export const d = new globalThis.Date();",
	"export const e = Reflect.get(Math, 'random')();",
	"const D = Date; export const f = D.now();",
	"export const g = (Date as DateConstructor).now();",
	"export const h = new Date(...[]);",
	"export const i = Date.prototype.constructor();",
	"export const j = new Intl.DateTimeFormat().format();",
	"export const k = Intl.DateTimeFormat().format();",
].join("\n");

const EVASION_FINDINGS = [
	"1 no-restricted-globals",
	"1 no-eval",
	"2 no-new-func",
	"2 no-restricted-globals",
	"3 no-restricted-globals",
	"4 no-restricted-globals",
	"5 no-restricted-globals",
	"6 no-restricted-syntax",
	"7 no-restricted-syntax",
	"8 no-restricted-syntax",
	"9 no-restricted-syntax",
	"10 no-restricted-syntax",
	"11 no-restricted-syntax",
];

// D16: 32-bit operators truncate times above 2^31 ms. Lint sees a time by its name only, anywhere
// inside the operand. `| 0` and `|= 0` truncate whatever they touch, so they are banned outright.
const TIME_BITWISE = [
	"export const g = (s) => s.time | 1;",
	"export const h = (at) => at >>> 0;",
	"export const i = (startTime) => startTime << 1;",
	"export const j = (s) => s.readyAt & 0xff;",
	"export const k = (to) => ~to;",
	"export const l = (x, s) => { x ^= s.time; return x; };",
	"export const m = (to) => 7 ^ to;",
	"export const n = (to, at) => (to - at) | 0;",
	"export const o = (time, growMs) => (time + growMs) >>> 0;",
	"export const p = (time) => Math.trunc(time) | 0;",
	"export const q = (state) => state['time'] & 1;",
	"export const r = (t) => { t |= 0; return t; };",
	"export const s = (now, elapsed) => (now >> 1) ^ elapsed;",
	"export const t = (duration, waitMs) => duration << waitMs;",
].join("\n");

const TIME_BITWISE_FINDINGS = [
	...[1, 2, 3, 4, 5, 6, 7].map((line) => `${line} no-restricted-syntax`),
	"8 no-restricted-syntax", // a time inside the operand
	"8 no-restricted-syntax", // and `| 0`
	"9 no-restricted-syntax",
	"10 no-restricted-syntax",
	"10 no-restricted-syntax",
	"11 no-restricted-syntax",
	"12 no-restricted-syntax",
	"13 no-restricted-syntax", // `now >> 1`
	"13 no-restricted-syntax", // `… ^ elapsed`
	"14 no-restricted-syntax",
];

// Code the sim needs and the rules must leave alone: relative imports, a date from a value, and
// mulberry32's 32-bit maths on a stream state (ADR-0003, sections 7 and 10).
const ALLOWED = [
	"import { stateHash } from './hash.js';",
	"import { other } from '../other.js';",
	"export const n = new Date(0);",
	"export const o = (state) => (state + 0x6d2b79f5) >>> 0;",
	"export const p = (t) => Math.imul(t ^ (t >>> 15), t | 1);",
	"export const q = (s) => s.time + 1;",
	"export const r = (atlas, timer) => atlas | timer;",
	"export const s = Date.UTC(2026, 10, 9) + Date.parse('2026-11-09');",
	"export const t = (x) => ({ Date: x.Date, time: Math.trunc(x.time / 1000) });",
	"export const u = new Intl.DateTimeFormat('en-GB');",
].join("\n");

describe("sim purity rules", () => {
	it("report every banned construct in a packages/sim source file", async () => {
		expect(await purityFindings(BANNED, "packages/sim/src/snippet.ts")).toEqual(BANNED_FINDINGS);
	});

	it("report the ways around them: eval, globals, aliases of Date, Intl", async () => {
		expect(await purityFindings(EVASIONS, "packages/sim/src/snippet.ts")).toEqual(EVASION_FINDINGS);
	});

	it("report 32-bit operators on time values in packages/sim", async () => {
		expect(await purityFindings(TIME_BITWISE, "packages/sim/src/snippet.ts")).toEqual(
			TIME_BITWISE_FINDINGS,
		);
	});

	it("leave relative imports, dates from a value and stream maths alone", async () => {
		expect(await purityFindings(ALLOWED, "packages/sim/src/snippet.ts")).toEqual([]);
	});

	it("leave the sim's own 32-bit maths alone (mulberry32, SHA-256)", async () => {
		const results = await eslint.lintFiles([
			"packages/sim/src/random/index.ts",
			"packages/sim/src/hash/sha256.ts",
		]);
		expect(results.flatMap((r) => r.messages)).toEqual([]);
	});

	it("do not fire outside packages/sim", async () => {
		const all = `${BANNED}\n${EVASIONS}\n${TIME_BITWISE}`;
		expect(await purityFindings(all, "scripts/snippet.ts")).toEqual([]);
		expect(await purityFindings(all, "packages/other/src/snippet.ts")).toEqual([]);
	});

	it("let sim tests import vitest and fast-check, and nothing else", async () => {
		const code = [
			"import { test } from 'vitest';",
			"import fc from 'fast-check';",
			"import { stateHash } from './hash.js';",
			"import { readFileSync } from 'node:fs';",
			"import { thing } from 'some-package';",
			"import { x } from 'vitest/node';",
			"export const a = Date.now();",
			"export const b = Math.random();",
			"export const c = new Date();",
		].join("\n");
		expect(await purityFindings(code, "packages/sim/src/hash.test.ts")).toEqual([
			"4 no-restricted-imports",
			"5 no-restricted-imports",
			"6 no-restricted-imports",
			"7 no-restricted-properties",
			"8 no-restricted-properties",
			"9 no-restricted-syntax",
		]);
	});

	it("make sim property tests pass the shared fast-check settings (D10)", async () => {
		const code = [
			"import fc from 'fast-check';",
			"import { inject, vi } from 'vitest';",
			"const params = requireProvided('fastCheck', inject('fastCheck'));",
			"const p = fc.property(fc.nat(), () => true);",
			"fc.assert(p);",
			"fc.check(p);",
			"fc.assert(p, params);",
			"fc.check(p, requireProvided('fastCheck', inject('fastCheck')));",
			"export const a = Date.now();",
			"export const b = new Date();",
			"vi.setConfig({ testTimeout: inject('propertyTimeout') });",
		].join("\n");
		expect(await purityFindings(code, "packages/sim/src/hash.test.ts")).toEqual([
			"5 no-restricted-syntax",
			"6 no-restricted-syntax",
			"9 no-restricted-properties",
			"10 no-restricted-syntax",
		]);
	});

	// #208: a property file that leaves out the timeout gets Vitest's 5 s default, which only
	// fails at CI's 1,000 runs. Lint reports the file instead, on its first line.
	it.each([
		[
			"the fast-check settings without the property timeout",
			["requireProvided('fastCheck', inject('fastCheck'));"],
			["1"],
		],
		[
			"both, in either quote style",
			[
				'requireProvided("fastCheck", inject("fastCheck"));',
				'vi.setConfig({ testTimeout: inject("propertyTimeout") });',
			],
			[],
		],
		[
			"the property timeout outside vi.setConfig",
			["requireProvided('fastCheck', inject('fastCheck'));", "inject('propertyTimeout');"],
			["1"],
		],
		["neither", ["inject('other');"], []],
	])("report a sim test file that uses %s", async (_case, lines, findingLines) => {
		const code = ["import { inject, vi } from 'vitest';", ...lines].join("\n");
		expect(await purityFindings(code, "packages/sim/src/sim/tests/x.test.ts")).toEqual(
			findingLines.map((line) => `${line} no-restricted-syntax`),
		);
	});

	// #213: run without the root config, inject('fastCheck') gives undefined and fast-check picks a
	// random seed. Lint reports a read that requireProvided doesn't check, on its line.
	it.each([
		["read straight into the settings", ["const params = inject('fastCheck');"], ["3"]],
		["passed straight to fc.assert", ["fc.assert(p, inject('fastCheck'));"], ["3"]],
		["checked by requireProvided", ["requireProvided('fastCheck', inject('fastCheck'));"], []],
		[
			"checked by another function",
			["const params = check('fastCheck', inject('fastCheck'));"],
			["3"],
		],
	])("report the fast-check settings %s", async (_case, lines, findingLines) => {
		const code = [
			"import { inject, vi } from 'vitest';",
			"vi.setConfig({ testTimeout: inject('propertyTimeout') });",
			...lines,
		].join("\n");
		expect(await purityFindings(code, "packages/sim/src/sim/tests/x.test.ts")).toEqual(
			findingLines.map((line) => `${line} no-restricted-syntax`),
		);
	});
});

// The other half of the guard: the sim's tsconfigs keep timers, fetch, crypto, performance and
// node:* types out by compiling against ES2022 only, with no ambient types (#81). The floor guard
// watches strict options, not `lib` or `types`, so adding "DOM" or "node" would otherwise pass.
describe("sim tsconfigs", () => {
	/** The compiler options after `extends` is resolved, as tsc sees them. */
	const resolvedOptions = (file) => {
		const host = {
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (d) => {
				throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
			},
		};
		return ts.getParsedCommandLineOfConfigFile(join(root, file), {}, host).options;
	};

	it.each(["packages/sim/tsconfig.json", "packages/sim/tsconfig.test.json"])(
		"%s compiles against ES2022 only, with no ambient types",
		(file) => {
			const options = resolvedOptions(file);
			expect(options.lib).toEqual(["lib.es2022.d.ts"]);
			expect(options.types).toEqual([]);
			expect(options.noLib).toBeUndefined();
		},
	);
});
