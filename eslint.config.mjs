// The project's lint standard (CONSTRAINTS.md, "Lint"): 0 errors. Turning a rule off, or adding
// a path to `ignores`, is a moved threshold that the floor guard reports.
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import checkFile from "eslint-plugin-check-file";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const nodeGlobals = {
	console: "readonly",
	process: "readonly",
	URL: "readonly",
};

// Sim purity (MUST-10.1, CONSTRAINTS.md purity row, #81). The sim's tsconfig already rejects
// fetch, timers, performance, crypto and node:* types; these rules catch what tsc can't. Fallow
// boundaries (#41, M3) add the import-escape and call checks.
const SIM_FILES = ["packages/sim/**"];
const SIM_TEST_FILES = ["packages/sim/**/*.test.ts", "packages/sim/**/tests/**"];

// Every import that isn't relative: bare packages, scoped packages and node:*.
const nonRelativeImport = (allowed, message) => ({
	regex: `^(?!\\.\\.?(/|$)${allowed.map((name) => `|${name}$`).join("")})`,
	message,
});

// Module privacy (ADR-0005, sections 1 and 4): a module is a folder, and code outside it imports
// only its index.js. The patterns read the import string, so they see the folders an import walks
// into: after `./` or `../`, entering a folder and naming anything but its index.js reaches past
// the entry (`../hash/sha256.js`), or into a child module (`../facilities/addOns/index.js`).
// Test code may also enter another module's tests/ folder; source never enters any tests/.
const RELATIVE_START = "^(\\./|(\\.\\./)+)";
const MODULE_PRIVACY = [
	{
		// `./a/../b.js` and `../hash/../hash/sha256.js` would walk around the patterns below.
		regex: "^(?!(\\./|(\\.\\./)+)([^./][^/]*/)*[^./][^/]*$)\\.",
		message:
			"Write the relative path in its shortest form: ./ or ../ first, then folder names (ADR-0005, section 1).",
	},
	{
		regex: `${RELATIVE_START}[^./][^/]*/(?!index\\.js$|tests/)`,
		message:
			"Import another module only through its index.js, never a file or child module inside it (ADR-0005, section 1).",
	},
];
const SOURCE_PRIVACY = [
	...MODULE_PRIVACY,
	{
		regex: "(^|/)tests(/|$)",
		message: "Source never imports a tests/ folder (ADR-0005, section 4).",
	},
];
// Test code: MODULE_PRIVACY already lets it into another module's tests/ (`../../state/tests/x.js`).
const TEST_PRIVACY = MODULE_PRIVACY;
const SOURCE_FILES = ["{apps,packages}/**/*.{ts,tsx}"];
const TEST_FILES = ["{apps,packages}/**/*.test.{ts,tsx}", "{apps,packages}/**/tests/**"];

// Names in code (ADR-0005, section 6, C9): camelCase, PascalCase for types, no UPPER_SNAKE
// constants, and booleans start with is, has or can. Names that mirror an outside spec keep its
// spelling (SHA-256's K and H0). Properties may be snake_case where data mirrors an outside shape
// (a DB column, an API field); the sim mirrors none, so it passes camelCase only. The rule's
// options are one list, so the sim block repeats it with its own property formats.
const BOOLEAN = { types: ["boolean"], format: ["PascalCase"], prefix: ["is", "has", "can"] };
const naming = (propertyFormats) => [
	"error",
	{ selector: "default", format: ["camelCase"] },
	{ selector: "typeLike", format: ["PascalCase"] },
	{ selector: "import", format: ["camelCase", "PascalCase"] },
	{ selector: "variable", filter: { regex: "^(K|H0)$", match: true }, format: null },
	{ selector: "variable", format: ["camelCase"] },
	{ selector: "variable", ...BOOLEAN },
	// An unused leading parameter is named `_name`, so the used ones after it keep their place.
	{ selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
	{ selector: "parameter", ...BOOLEAN, leadingUnderscore: "allow" },
	{ selector: ["objectLiteralProperty", "typeProperty"], format: propertyFormats },
	{
		selector: ["objectLiteralProperty", "typeProperty"],
		modifiers: ["requiresQuotes"],
		format: null,
	},
];

// D16 (ADR-0003, section 10): 32-bit operators truncate times above 2^31 ms (about 24.9 days).
// Lint sees a time only by its name, anywhere inside the operand (`(to - at) | 0` included):
// `time`, `at`, `to`, `now`, `elapsed`, `duration`, or a name ending in `Time`, `At` or `Ms`.
const TIME_NAME = "/^(time|at|to|now|elapsed|duration)$|(Time|At|Ms)$/";
const BITWISE = `:matches(BinaryExpression[operator=/^(\\||&|\\^|<<|>>>?)$/], AssignmentExpression[operator=/^(\\||&|\\^|<<|>>>?)=$/], UnaryExpression[operator='~'])`;

// `Date` itself is banned, so an alias, a cast or `Date.prototype.constructor` can't reach the
// clock. Allowed: `new Date(value)` without a spread, `Date.UTC`, `Date.parse`, and `Date.now`,
// which no-restricted-properties reports. A property or key named Date is not the global.
const DATE_ALLOWED = [
	"NewExpression[arguments.length>0][arguments.0.type!='SpreadElement'] > Identifier.callee",
	"MemberExpression[computed=false][property.name=/^(UTC|parse|now)$/] > Identifier.object",
	"MemberExpression[computed=false] > Identifier.property",
	"Property[computed=false] > Identifier.key",
].join(", ");

const SIM_SYNTAX = [
	{
		selector: `Identifier[name='Date']:not(${DATE_ALLOWED})`,
		message:
			"Date reads the clock; time arrives as an argument. Allowed: new Date(value), Date.UTC, Date.parse (MUST-10.1).",
	},
	{
		selector:
			":matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name='DateTimeFormat'][arguments.length=0]",
		message:
			"Intl.DateTimeFormat() with no locale formats the current time by default; time arrives as an argument (MUST-10.1).",
	},
	{
		selector: "ImportExpression",
		message: "No dynamic import: the sim imports only its own files, statically (MUST-10.1).",
	},
	{
		// State is plain JSON data and rules are functions over it (ADR-0003, section 5; ADR-0005, C2).
		selector: ":matches(ClassDeclaration, ClassExpression)",
		message:
			"No classes in the sim: state is plain data, and rules are functions (ADR-0003, section 5).",
	},
	{
		selector: `${BITWISE}:has(Identifier[name=${TIME_NAME}], Literal[value=${TIME_NAME}])`,
		message: "No 32-bit operators on times: they truncate above 2^31 ms (ADR-0003, section 10).",
	},
	{
		selector:
			":matches(BinaryExpression[operator='|'], AssignmentExpression[operator='|='])[right.type='Literal'][right.value=0]",
		message: "| 0 truncates to 32 bits; use Math.trunc (ADR-0003, section 10).",
	},
];

export default defineConfig(
	{
		ignores: ["**/node_modules/", "**/coverage/", "**/dist/", "**/.next/", ".claude/", ".agents/"],
	},
	js.configs.recommended,
	// Typed linting (ADR-0005, section 6): strictTypeChecked includes strict. The project service
	// finds each file's tsconfig, the way an editor does.
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
	{
		// JS and config files are in no type-checked program (vitest.config.mts is, but only for
		// tsc), so the type-aware rules can't run on them.
		files: ["**/*.mjs", "**/*.js", "vitest.config.mts"],
		extends: [tseslint.configs.disableTypeChecked],
	},
	{
		files: ["**/*.mjs", "**/*.js"],
		languageOptions: { globals: nodeGlobals },
	},
	{
		// The code conventions (ADR-0005, section 6) for apps/ and packages/; .github/scripts is CI
		// tooling and keeps its own style. What a config can't check is in docs/agents/code-style.md.
		files: ["{apps,packages}/**/*.{ts,tsx}"],
		rules: {
			"@typescript-eslint/switch-exhaustiveness-check": "error", // in neither preset (ADR-0005)
			// No `import('…')` in a type: no-restricted-imports can't see it, so it would pass module
			// privacy (review of #140). Types come in through `import type` statements instead.
			"@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: true }],
			"@typescript-eslint/consistent-type-definitions": ["error", "interface"],
			"@typescript-eslint/consistent-type-assertions": [
				"error",
				{ assertionStyle: "as", objectLiteralTypeAssertions: "never" },
			],
			"@typescript-eslint/return-await": ["error", "always"],
			"@typescript-eslint/naming-convention": naming(["camelCase", "snake_case"]),
			"func-style": [
				"error",
				"declaration",
				{ allowArrowFunctions: true, overrides: { namedExports: "declaration" } },
			],
			eqeqeq: ["error", "always"],
			"no-warning-comments": ["error", { terms: ["todo", "fixme"] }],
			curly: ["error", "multi-line"],
			"no-else-return": "error",
			"prefer-destructuring": ["error", { object: true, array: false }],
			"no-nested-ternary": "error",
			"prefer-template": "error",
			"prefer-spread": "error",
			"prefer-object-spread": "error",
		},
	},
	{
		// Named exports only; a default export where React or Next needs one (ADR-0005, C6).
		files: ["{apps,packages}/**/*.ts"],
		ignores: ["apps/web/src/app/**"],
		rules: {
			"no-restricted-exports": [
				"error",
				{
					restrictDefaultExports: {
						direct: true,
						named: true,
						defaultFrom: true,
						namedFrom: true,
						namespaceFrom: true,
					},
				},
			],
		},
	},
	{
		// File and folder names (ADR-0005, section 5): one lowercase word where possible, camelCase
		// when a name needs more; `.test.ts` is the only suffix. Folders whose names a framework
		// dictates (Next's app/) and React component names (PascalCase) are settled with apps/web, M3.
		files: ["{apps,packages}/**/*.ts"],
		ignores: ["apps/web/src/app/**"],
		plugins: { "check-file": checkFile },
		rules: {
			"check-file/filename-naming-convention": [
				"error",
				{ "**/*.ts": "CAMEL_CASE" },
				{ ignoreMiddleExtensions: true },
			],
			"check-file/filename-blocklist": [
				"error",
				{ "**/*.spec.ts": "*.test.ts", "**/*.types.ts": "*.ts" },
				{
					errorMessage:
						"{{ target }}: .test.ts is the only suffix; types live in the index.ts or a types.ts sibling (ADR-0005, section 5).",
				},
			],
			"check-file/folder-naming-convention": [
				"error",
				{ "{apps,packages}/*/src/**/": "CAMEL_CASE" },
			],
		},
	},
	{
		// An expected failure is returned, not logged and dropped (ADR-0005, C10).
		files: ["packages/**"],
		rules: { "no-console": "error" },
	},
	{
		// Back up the Floor's ban on focused and skipped tests, and catch a test that asserts nothing.
		files: ["**/*.test.{ts,tsx,mjs}", "**/tests/**"],
		plugins: { vitest },
		rules: {
			// fc.assert throws on a counterexample, so a property with no expect inside still asserts.
			"vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "fc.assert"] }],
			"vitest/no-focused-tests": "error",
			"vitest/no-disabled-tests": "error",
			// describe names the unit, and each it reads as a sentence (ADR-0005, C18).
			"vitest/consistent-test-it": ["error", { fn: "it", withinDescribe: "it" }],
		},
	},
	{
		files: SOURCE_FILES,
		rules: { "no-restricted-imports": ["error", { patterns: SOURCE_PRIVACY }] },
	},
	{
		files: TEST_FILES,
		rules: { "no-restricted-imports": ["error", { patterns: TEST_PRIVACY }] },
	},
	{
		files: SIM_FILES,
		rules: {
			"@typescript-eslint/naming-convention": naming(["camelCase"]),
			"no-eval": "error",
			"no-new-func": "error",
			// Each reaches a banned call without naming it: globalThis.Math.random(), Reflect.get(…).
			"no-restricted-globals": [
				"error",
				{
					name: "globalThis",
					message: "Reach globals by name, so the purity rules see them (MUST-10.1).",
				},
				{
					name: "Reflect",
					message: "Reflect can reach banned calls without naming them (MUST-10.1).",
				},
				{
					name: "Function",
					message: "Function builds code the purity rules cannot see (MUST-10.1).",
				},
				{ name: "eval", message: "eval runs code the purity rules cannot see (MUST-10.1)." },
			],
			// A later block's options replace an earlier block's, so module privacy is merged in here.
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						nonRelativeImport(
							[],
							"The sim imports only its own files (MUST-10.1): no packages, no node:*.",
						),
						...SOURCE_PRIVACY,
					],
				},
			],
			"no-restricted-properties": [
				"error",
				{ object: "Date", property: "now", message: "Time arrives as an argument (MUST-10.1)." },
				{
					object: "Math",
					property: "random",
					message: "Randomness comes from a stream in the state (ADR-0003, section 7).",
				},
			],
			"no-restricted-syntax": ["error", ...SIM_SYNTAX],
		},
	},
	{
		// Sim tests may import their test tools and nothing else outside the sim (admin, 9 Nov, #81).
		// Every other purity rule above still applies to them.
		files: SIM_TEST_FILES,
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						nonRelativeImport(
							["vitest", "fast-check"],
							"Sim tests import only vitest, fast-check and sim files (#81).",
						),
						...TEST_PRIVACY,
					],
				},
			],
			// A later block's options replace an earlier block's, so the sim selectors are repeated here.
			"no-restricted-syntax": [
				"error",
				...SIM_SYNTAX,
				{
					// Without the settings, fast-check picks a random seed and its own run count (D10).
					selector:
						"CallExpression[callee.object.name='fc'][callee.property.name=/^(assert|check)$/][arguments.length<2]",
					message:
						"Pass the shared settings: fc.assert(property, inject('fastCheck')) (D10, ADR-0003 section 9).",
				},
			],
		},
	},
);
