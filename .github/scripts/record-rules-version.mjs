#!/usr/bin/env node
// record-rules-version.mjs: records a released rules version's logs for the rules-version check
// (ADR-0006, section 10; #154). Run it once, when version N first reaches an environment whose farms
// persist, after its `contentHash` is set in the registry (packages/sim/src/versions/index.ts):
//
//   node .github/scripts/record-rules-version.mjs <N>
//
// It plays the property harness's generator at the root config's fixed seed under version N
// (versions/tests/record.ts), writes versions/tests/rulesVersion<N>.ts and lists it in
// versions/tests/recordings.ts. A recording is never rewritten: the script refuses a version that
// already has one, and one whose content doesn't hash to its recorded hash.
//
// Node 24 runs the sim's TypeScript as it stands (type stripping); a resolve hook maps the sim's
// `.js` import paths to their `.ts` files. Exit codes: 0 recorded, 1 refused, 2 could not run.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VERSIONS = join(ROOT, "packages/sim/src/versions");
const TESTS = join(VERSIONS, "tests");
// The root vitest.config.mts's fast-check seed (D10), so a recording is the harness's own sample.
const SETTINGS = { seed: 0x5eed };

const fail = (code, message) => {
	console.error(`record-rules-version: ${message}`);
	process.exit(code);
};

const version = Number(process.argv[2]);
if (process.argv.length !== 3 || !Number.isSafeInteger(version) || version < 1) {
	fail(2, "usage: node .github/scripts/record-rules-version.mjs <rules version>");
}

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			const isSimPath = specifier.startsWith(".") && specifier.endsWith(".js");
			if (!isSimPath || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
			return next(`${specifier.slice(0, -3)}.ts`, context);
		}
	},
});
const { registry } = await import(join(VERSIONS, "index.ts"));
const { stateHash } = await import(join(ROOT, "packages/sim/src/index.ts"));
const { recordLogs } = await import(join(TESTS, "record.ts"));

const entry = version === 1 ? registry.first : registry.later[version - 2];
if (entry === undefined) fail(1, `the registry has no rules version ${version}`);
const hash = stateHash(entry.content);
if (entry.contentHash !== hash) {
	fail(
		1,
		`version ${version} isn't released: its content hashes to ${hash}, and its contentHash in ` +
			"the registry is " +
			(entry.contentHash === null ? "null" : "another") +
			". Record the hash there first, then run this again.",
	);
}
const file = join(TESTS, `rulesVersion${version}.ts`);
if (existsSync(file))
	fail(1, `version ${version} is recorded already; a recording is never rewritten`);

const recording = recordLogs(registry, version, SETTINGS);
const source = [
	`// Rules version ${version}'s recorded logs (ADR-0006, section 10), written by`,
	"// .github/scripts/record-rules-version.mjs when it was released. Never edit by hand.",
	'import type { Recording } from "./record.js";',
	"",
	`export const rulesVersion${version}: Recording = ${JSON.stringify(recording)};`,
	"",
].join("\n");
writeFormatted(file, source);

const recorded = readdirSync(TESTS)
	.flatMap((name) => /^rulesVersion(\d+)\.ts$/.exec(name)?.slice(1) ?? [])
	.map(Number)
	.sort((a, b) => a - b);
writeFormatted(
	join(TESTS, "recordings.ts"),
	[
		"// The recorded logs of every released rules version (ADR-0006, section 10), one file per version",
		"// beside this one. Written by `node .github/scripts/record-rules-version.mjs <version>` when the version is",
		"// released, never edited by hand: the rules-version check replays each one on today's code.",
		'import type { Recording } from "./record.js";',
		...recorded.map((n) => `import { rulesVersion${n} } from "./rulesVersion${n}.js";`),
		"",
		`export const recordings: readonly Recording[] = [${recorded.map((n) => `rulesVersion${n}`).join(", ")}];`,
		"",
	].join("\n"),
);
const rows = recording.logs.reduce((total, log) => total + log.rows.length, 0);
console.log(
	`record-rules-version: recorded ${recording.logs.length} logs (${rows} rows) for version ${version}`,
);

// Writes `source` to `path` as Prettier lays out the repo's TypeScript (`pnpm format:check`).
function writeFormatted(path, source) {
	const prettier = join(ROOT, "node_modules/prettier/bin/prettier.cjs");
	const result = spawnSync(process.execPath, [prettier, "--stdin-filepath", path], {
		cwd: ROOT,
		encoding: "utf8",
		input: source,
	});
	if (result.status !== 0) fail(2, `prettier failed:\n${result.stderr}`);
	writeFileSync(path, result.stdout);
}
