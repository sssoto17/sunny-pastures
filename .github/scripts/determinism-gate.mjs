#!/usr/bin/env node
// determinism-gate.mjs: the determinism gate, `ci / determinism` (#48; CONSTRAINTS.md, Determinism
// row; MUST-17.1, MUST-10.2, MUST-14.3). ADR-0001's step 0: the recorded 500-step script plays
// through packages/sim in two separate Node processes, and fails unless both end on the same farm
// (state hash and plain JSON) with the recorded state hash.
//
// The sim's source imports `.js` paths that are `.ts` files, so Node can't run it as it stands.
// The gate compiles it once with the repo's own tsc, under the sim's own compiler options, into a
// temp folder, and each process imports that JavaScript (no runner package; admin, 16 Nov). The
// processes run with different time zones and locales, and each also plays the script twice and
// replays it from JSON snapshots (packages/sim/src/sim/tests/playScript.ts).
//
// Usage: node .github/scripts/determinism-gate.mjs [--update | --record]
//   --update  writes the hash both processes agree on to determinismScript.hash
//   --record  records the script again (recordScript.ts) to a temp file beside the recorded one,
//             checks it as --update does, and moves it into place with the hash only on a pass
// A released rules version's hash never changes; a new version adds its own (ADR-0006; #154).
// Exit codes: 0 pass, 1 the gate failed, 2 could not run. A 2 never reads as a pass.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CannotRun, isMain } from "./diff.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SIM_TESTS = "packages/sim/src/sim/tests";
const SCRIPT = `${SIM_TESTS}/determinismScript.json`;
const HASH = `${SIM_TESTS}/determinismScript.hash`;
const STEPS = 500;
const GAP_MS = 8 * 3_600_000;
// Floors on what the script reaches, kept here in the code-owned runner (#48's review): a script
// recorded long ago, and replayed on rules that refuse most of it, no longer tests much.
const MIN_REFUSED = 10;
const MIN_ACCEPTED = 400;
const FLAGS = ["--update", "--record"];
// The two processes differ in everything the sim must not read (MUST-10.1).
const PROCESSES = [
	{ label: "process 1", env: { TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } },
	{
		label: "process 2",
		env: { TZ: "Pacific/Chatham", LANG: "da_DK.UTF-8", LC_ALL: "da_DK.UTF-8" },
	},
];

// The runs' agreement, the recorded hash, and whether the script reaches what the gate is for: the
// 8-hour gap (offline progress), refused actions and both random streams (ADR-0001, ADR-0003 s. 7).
export const evaluate = ({ script, runs, expected }) => {
	const report = runs.map(
		(r) => `${r.label}: ${r.accepted} accepted, ${r.refused} refused, state hash ${r.hash}`,
	);
	const failures = runs.flatMap((r) => r.problems.map((p) => `${r.label}: ${p}`));
	const [first] = runs;
	if (runs.some((r) => r.hash !== first.hash || r.jsonHash !== first.jsonHash)) {
		failures.push(
			"the two processes ended on different farms (state hash or plain JSON): the sim is not deterministic",
		);
	} else if (expected === null) {
		failures.push(`${HASH} holds no expected state hash; run this script with --update`);
	} else if (first.hash !== expected) {
		failures.push(
			`both processes ended on ${first.hash}, but ${HASH} records ${expected}. If this PR changes ` +
				"rules or content on purpose, run `node .github/scripts/determinism-gate.mjs --update` and " +
				"commit the hash (a code-owned file). Otherwise a change moved an outcome it shouldn't.",
		);
	}

	const { steps } = script;
	if (steps.length !== STEPS) failures.push(`the script has ${steps.length} steps, not ${STEPS}`);
	if (!steps.some((s, i) => i > 0 && s.at - steps[i - 1].at >= GAP_MS)) {
		failures.push("the script has no gap of 8 hours between two steps");
	}
	if (!first.isGapBusy) {
		failures.push("no work is in progress when the script's 8-hour gap begins");
	}
	if (first.refused < MIN_REFUSED) {
		failures.push(
			`the rules refuse ${first.refused} of the script's steps, fewer than ${MIN_REFUSED}`,
		);
	}
	if (first.accepted < MIN_ACCEPTED) {
		failures.push(
			`the rules accept ${first.accepted} of the script's steps, fewer than ${MIN_ACCEPTED}: ` +
				"record it again with --record",
		);
	}
	for (const stream of ["yields", "orders"]) {
		if (!first.streamsMoved[stream])
			failures.push(`the script never draws from the ${stream} stream`);
	}
	return { failures, report };
};

// The sim, compiled with its own tsconfig's options into `dir`, as ES modules.
const compile = (dir) => {
	const config = join(dir, "tsconfig.json");
	const out = join(dir, "out");
	const files = ["playScript.ts", "recordScript.ts"].map((f) => join(ROOT, SIM_TESTS, f));
	writeFileSync(
		config,
		JSON.stringify({
			extends: join(ROOT, "packages/sim/tsconfig.json"),
			compilerOptions: {
				outDir: out,
				emitDeclarationOnly: false,
				declaration: false,
				composite: false,
				incremental: false,
				noEmitOnError: true,
			},
			include: [],
			files,
		}),
	);
	const tsc = spawnSync(
		process.execPath,
		[join(ROOT, "node_modules/typescript/bin/tsc"), "-p", config],
		{ encoding: "utf8" },
	);
	if (tsc.status !== 0) throw new CannotRun(`tsc failed:\n${tsc.stdout}${tsc.stderr}`);
	writeFileSync(join(out, "package.json"), '{ "type": "module" }\n');
	return (file) => pathToFileURL(join(out, SIM_TESTS.replace("packages/sim/src/", ""), file)).href;
};

// One process: plays the script at `scriptPath` and prints what it saw as JSON on stdout.
const play = async (moduleUrl, scriptPath) => {
	const { playScript } = await import(moduleUrl);
	const { final, ...run } = playScript(JSON.parse(readFileSync(scriptPath, "utf8")));
	// The final farm's plain JSON, hashed here rather than by the sim's own stateHash.
	const jsonHash = createHash("sha256").update(JSON.stringify(final)).digest("hex");
	// What this process resolved, not what the parent asked for.
	const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
	console.log(JSON.stringify({ pid: process.pid, timeZone, locale, jsonHash, ...run }));
};

// Runs `play` in a child process with the given environment. A child that exits non-zero can't
// run, so its process never counts as having played (exit 2, never a pass).
export const spawnRun = ({ label, env }, moduleUrl, scriptPath) => {
	const child = spawnSync(process.execPath, [SELF, "--play", moduleUrl, scriptPath], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	if (child.status !== 0) throw new CannotRun(`${label} exited ${child.status}:\n${child.stderr}`);
	const { pid, timeZone, locale, ...run } = JSON.parse(child.stdout);
	console.log(
		`determinism-gate: ${label} ran as pid ${pid}, time zone ${timeZone}, locale ${locale}`,
	);
	return { label, ...run };
};

// Records the script, formatted, to `path`.
const record = async (moduleUrl, path) => {
	const { recordScript } = await import(moduleUrl);
	// One step per line, as Prettier lays out the repo's JSON (`pnpm format:check`).
	const prettier = join(ROOT, "node_modules/prettier/bin/prettier.cjs");
	const result = spawnSync(process.execPath, [prettier, "--stdin-filepath", SCRIPT], {
		cwd: ROOT,
		encoding: "utf8",
		input: JSON.stringify(recordScript()),
	});
	if (result.status !== 0) throw new CannotRun(`prettier failed:\n${result.stderr}`);
	writeFileSync(path, result.stdout);
};

// A file beside `path`, so the rename that replaces `path` stays on one file system (a rename
// from os.tmpdir() can fail with EXDEV). Random, so two runs never share one.
const besideOf = (path) =>
	join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);

// Moves the new hash into place, then the new script. If the script's move is refused, the old
// hash goes back, so the folder never pairs a new script with an old hash or the other way round.
const moveIntoPlace = ({ hashTemp, hashPath, played, scriptPath }) => {
	const oldHash = existsSync(hashPath) ? readFileSync(hashPath) : null;
	renameSync(hashTemp, hashPath);
	if (played === scriptPath) return;

	try {
		renameSync(played, scriptPath);
	} catch (e) {
		if (oldHash === null) rmSync(hashPath, { force: true });
		else writeFileSync(hashPath, oldHash);
		throw e;
	}
};
const shown = (path) => relative(ROOT, path);

// The gate on a compiled sim (`moduleOf` maps a compiled file name to its URL). --record plays a
// temp recording and moves it, and the hash, over `scriptPath` and `hashPath` only after a pass;
// a fail (1) or a CannotRun (2) leaves both files as they were and removes the temp files (#287).
export const runGate = async (
	argv,
	{ moduleOf, scriptPath, hashPath, started = performance.now() },
) => {
	const isRecord = argv.includes("--record");
	const isUpdate = argv.includes("--update") || isRecord;
	const played = isRecord ? besideOf(scriptPath) : scriptPath;
	const hashTemp = besideOf(hashPath);
	try {
		if (isRecord) await record(moduleOf("recordScript.js"), played);
		const runs = PROCESSES.map((p) => spawnRun(p, moduleOf("playScript.js"), played));
		const expected = isUpdate
			? runs[0].hash
			: existsSync(hashPath)
				? readFileSync(hashPath, "utf8").trim() || null
				: null;
		const script = JSON.parse(readFileSync(played, "utf8"));
		const { failures, report } = evaluate({ script, runs, expected });
		for (const r of report) console.log(`determinism-gate: ${r}`);
		const seconds = ((performance.now() - started) / 1000).toFixed(1);
		if (failures.length > 0) {
			for (const f of failures) console.error(`determinism-gate: FAIL ${f}`);
			return 1;
		}

		if (isUpdate) {
			writeFileSync(hashTemp, `${expected}\n`);
			moveIntoPlace({ hashTemp, hashPath, played, scriptPath });
			if (isRecord) console.log(`determinism-gate: recorded ${shown(scriptPath)}`);
			console.log(`determinism-gate: wrote ${expected} to ${shown(hashPath)}`);
		}
		console.log(`determinism-gate: pass, both processes match ${shown(hashPath)} (${seconds} s)`);
		return 0;
	} finally {
		if (isRecord) rmSync(played, { force: true });
		rmSync(hashTemp, { force: true });
	}
};

const main = async (argv) => {
	// `pnpm determinism -- --update` passes the `--` through.
	const unknown = argv.filter((a) => a !== "--" && !FLAGS.includes(a));
	if (unknown.length > 0) throw new CannotRun(`unknown argument ${unknown.join(" ")}`);
	const started = performance.now();
	const dir = mkdtempSync(join(tmpdir(), "determinism-gate-"));
	try {
		return await runGate(argv, {
			moduleOf: compile(dir),
			scriptPath: join(ROOT, SCRIPT),
			hashPath: join(ROOT, HASH),
			started,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

// The shared entry check resolves symlinks on both sides: a gate that silently skipped itself
// would exit 0 (#48's review; #283).
if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	try {
		if (argv[0] === "--play") await play(argv[1], argv[2]);
		else process.exitCode = await main(argv);
	} catch (e) {
		console.error(
			`determinism-gate: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`,
		);
		process.exitCode = 2;
	}
}
