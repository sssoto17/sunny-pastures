// Every tsconfig and jsconfig in the repo compiles strictly (CONSTRAINTS.md, Floor; #135). Each is
// read through the TypeScript API, as tsc reads it: `extends` resolved, comments ignored, options
// outside `compilerOptions` ignored. So a config that extends a loose or missing file, or keeps
// `strict` in a comment, at the top level or inside a block comment, fails here (#133's known
// limits; both comments on #135). The floor guard still reports a strict option relaxed in a diff.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ts from "@typescript/typescript6";
import { afterAll, describe, expect, it } from "vitest";

import { root } from "./lint-snippet.mjs";

// The options `strict` turns on; setting one to false loosens it again.
const STRICT_FAMILY = [
	"noImplicitAny",
	"noImplicitThis",
	"strictNullChecks",
	"strictFunctionTypes",
	"strictBindCallApply",
	"strictPropertyInitialization",
	"strictBuiltinIteratorReturn",
	"alwaysStrict",
	"useUnknownInCatchVariables",
];
// The base's other strictness options, which every config keeps at the base's value.
const STRICT_OPTION = /^(strict|no[A-Z]|exactOptional|allowUnreachable|allowUnused|useUnknown)/;

/** A config as tsc sees it, or a thrown error when tsc can't read it at all. */
const parse = (file) =>
	ts.getParsedCommandLineOfConfigFile(file, undefined, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (d) => {
			throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
		},
	});

const BASE = parse(join(root, "tsconfig.base.json")).options;

/** What makes `file` less strict than tsconfig.base.json: option names, or tsc's error codes. */
const strictGaps = (file, base = BASE) => {
	const parsed = parse(file);
	if (parsed.errors.length > 0) return parsed.errors.map((e) => `TS${e.code}`);
	// A solution file (`"files": []`, only references) compiles nothing, so it has no strictness.
	const raw = parsed.raw ?? {};
	if (Array.isArray(raw.files) && raw.files.length === 0 && !raw.include) return [];
	const { options } = parsed;
	return [
		...(options.strict === true ? [] : ["strict"]),
		...STRICT_FAMILY.filter((name) => options[name] === false),
		...Object.keys(base).filter((k) => STRICT_OPTION.test(k) && options[k] !== base[k]),
		...(options.allowUnusedLabels === true ? ["allowUnusedLabels"] : []),
	];
};

describe("the repo's tsconfigs", () => {
	const configs = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\0")
		.filter((f) => /^[tj]sconfig[^/]*\.json$/.test(basename(f)));

	it("include the base and the sim's", () => {
		expect(configs).toEqual(
			expect.arrayContaining(["tsconfig.base.json", "packages/sim/tsconfig.json"]),
		);
	});

	it("keep the base strict", () => {
		expect(BASE.strict).toBe(true);
	});

	it.each(configs)("%s is as strict as tsconfig.base.json", (file) => {
		expect(strictGaps(join(root, file))).toEqual([]);
	});
});

describe("a tsconfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "tsconfigs-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "a.js"), "export const b = 1;\n");
	writeFileSync(join(dir, "base.json"), readFileSync(join(root, "tsconfig.base.json"), "utf8"));
	writeFileSync(
		join(dir, "loose.json"),
		'{ "compilerOptions": { "strict": false, "noImplicitReturns": false } }\n',
	);
	const gaps = (text, name = "tsconfig.json") => {
		writeFileSync(join(dir, name), text);
		return strictGaps(join(dir, name));
	};

	it.each([
		["without extends or strict", '{ "compilerOptions": { "target": "ES2022" } }'],
		["extending a file that does not exist", '{ "extends": "./nope.json" }'],
		["extending a package that is not installed", '{ "extends": "@tsconfig/missing" }'],
		["extending nothing", '{ "extends": [] }'],
		["extending an empty string", '{ "extends": "" }'],
		["extending a real file that is not strict", '{ "extends": "./loose.json" }'],
		["with strict only in a comment", '{\n  // "strict": true\n  "compilerOptions": {}\n}'],
		["with strict moved out of compilerOptions", '{ "strict": true, "compilerOptions": {} }'],
		[
			"with strict wrapped in a block comment",
			'{\n  "compilerOptions": {\n    /*\n    "strict": true\n    */\n  }\n}',
		],
		[
			"turning one of strict's checks off",
			'{ "extends": "./base.json", "compilerOptions": { "strictNullChecks": false } }',
		],
		[
			"turning a base option off",
			'{ "extends": "./base.json", "compilerOptions": { "noUncheckedIndexedAccess": false } }',
		],
		[
			"allowing unreachable code",
			'{ "extends": "./base.json", "compilerOptions": { "allowUnreachableCode": true } }',
		],
		[
			"allowing unused labels",
			'{ "extends": "./base.json", "compilerOptions": { "allowUnusedLabels": true } }',
		],
		["extending the base, then a loose file", '{ "extends": ["./base.json", "./loose.json"] }'],
	])("fails %s", (_case, text) => {
		expect(gaps(text)).not.toEqual([]);
	});

	it.each([
		["extending the base", '{ "extends": "./base.json" }'],
		["extending a loose file, then the base", '{ "extends": ["./loose.json", "./base.json"] }'],
	])("passes %s", (_case, text) => {
		expect(gaps(text)).toEqual([]);
	});

	// #133's known limit: tsc reads a jsconfig.json too, and the guard never looked at one.
	it("fails a new jsconfig.json that is not strict, and passes one that extends the base", () => {
		expect(gaps('{ "compilerOptions": { "checkJs": true } }', "jsconfig.json")).toContain("strict");
		expect(gaps('{ "extends": "./base.json" }', "jsconfig.json")).toEqual([]);
	});
});
