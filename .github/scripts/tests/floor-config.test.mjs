// The floor's lint rules are on for every file ESLint reads (#135, second comment: read configs
// with ESLint's own config loader). A config block added later can replace a rule's options for
// some files, and code can empty the selector lists; neither removes a line, so the floor guard
// can't see them. So every tracked file ESLint lints is checked twice:
// - with the loaded config (`calculateConfigForFile`), the three rules are at "error";
// - a probe linted as that file reports each floor selector, one probe per line.
// The probes check behaviour, not the config's own lists, so emptying a list can't also empty the
// expectation. `<>` breaks a stub for main's guard (see floor-lint.test.mjs).
import { execFileSync } from "node:child_process";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

import config from "../../../eslint.config.mjs";
import { root } from "./lint-snippet.mjs";

const SYNTAX = "no-restricted-syntax";
// Each probe line, and the rule that must report it.
const PROBES = [
	["import fc from 'fast-check';", SYNTAX], // a file that runs fc.assert without inject
	["throw new <>Error('not implemented');", SYNTAX],
	["try { f(); } catch { /* x */<> }", SYNTAX],
	["try { f(); } catch {<>}", "no-empty"],
	["p.catch(() => <>null);", SYNTAX],
	["const noop = () => undefined;", SYNTAX],
	["function e() {}", "@typescript-eslint/no-empty-function"],
	["fc.assert(p);", SYNTAX],
	["fc.assert(p, {});", SYNTAX],
	["const s = { path: 'x' };", SYNTAX],
	["const check = fc.assert;", SYNTAX],
	["const q = { numRuns: 1 };", SYNTAX],
];
const PROBE = PROBES.map(([line]) => line.replaceAll("<>", "")).join("\n");
// Where the run count is read, and requireProvided's own test (eslint.config.mjs): the one probe
// those files may pass.
const RUN_COUNT_FILES = new Set([
	"vitest.config.mts",
	"packages/sim/src/state/tests/provided.test.ts",
]);
const RUN_COUNT_PROBE = PROBES.length;

const OFF_TYPED = [
	tseslint.configs.disableTypeChecked,
	{ languageOptions: { parserOptions: { projectService: false } } },
];
const loader = (overrides = []) =>
	new ESLint({ cwd: root, overrideConfig: [...OFF_TYPED, ...overrides] });

/** The floor rules `file` doesn't get, as "rule" or "line rule"; empty when it gets them all. */
const floorGaps = async (eslint, file) => {
	const { rules } = await eslint.calculateConfigForFile(file);
	const gaps = [
		...(JSON.stringify(rules["no-empty"]) === '[2,{"allowEmptyCatch":false}]' ? [] : ["no-empty"]),
		...["@typescript-eslint/no-empty-function", SYNTAX].filter((r) => rules[r]?.[0] !== 2),
	];
	const [result] = await eslint.lintText(PROBE, { filePath: file });
	const fatal = result.messages.find((m) => m.fatal);
	if (fatal) throw new Error(`ESLint could not lint the probe as ${file}: ${fatal.message}`);
	const found = new Set(result.messages.map((m) => `${m.line} ${m.ruleId}`));
	PROBES.forEach(([, rule], i) => {
		const exempt = i + 1 === RUN_COUNT_PROBE && RUN_COUNT_FILES.has(file);
		if (!exempt && !found.has(`${i + 1} ${rule}`)) gaps.push(`${i + 1} ${rule}`);
	});
	return gaps;
};

const eslint = loader();
const tracked = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
	{
		cwd: root,
		encoding: "utf8",
	},
)
	.split("\0")
	.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
const linted = [];
for (const file of tracked) if (!(await eslint.isPathIgnored(file))) linted.push(file);

describe("the floor's lint rules", () => {
	it("cover the sim, its tests and the CI scripts", () => {
		expect(linted).toEqual(
			expect.arrayContaining([
				"packages/sim/src/hash/index.ts",
				"packages/sim/src/sim/tests/properties.test.ts",
				".github/scripts/floor-guard.mjs",
				"eslint.config.mjs",
			]),
		);
	});

	it.each(linted)("are all on for %s", async (file) => {
		expect(await floorGaps(eslint, file)).toEqual([]);
	});

	// Review of the #135 stack: both were clean for the floor guard and for `eslint .`.
	it("fail when a later block replaces the selectors for a folder", async () => {
		const override = {
			files: ["packages/sim/src/hash/**"],
			rules: { [SYNTAX]: ["error", "WithStatement"] },
		};
		expect(await floorGaps(loader([override]), "packages/sim/src/hash/index.ts")).toContain(
			`2 ${SYNTAX}`,
		);
	});

	it("fail when the selector lists are emptied", async () => {
		// What `UNFINISHED_SYNTAX.length = 0` and its siblings leave: each block's rule with no
		// selectors. A later block with only a severity would keep the earlier options instead.
		const emptied = config.map((block) =>
			block.rules?.[SYNTAX] ? { ...block, rules: { ...block.rules, [SYNTAX]: ["error"] } } : block,
		);
		const eslint = new ESLint({
			cwd: root,
			overrideConfigFile: true,
			overrideConfig: [...emptied, ...OFF_TYPED],
		});
		for (const file of ["packages/sim/src/hash/index.ts", ".github/scripts/floor-guard.mjs"])
			expect(await floorGaps(eslint, file)).toContain(`3 ${SYNTAX}`);
	});
});
