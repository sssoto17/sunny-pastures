import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluate, runGate, spawnRun } from "../determinism-gate.mjs";
import { CannotRun } from "../diff.mjs";

const hash = "a".repeat(64);
const other = "b".repeat(64);
const hour = 3_600_000;
// 500 steps 10 s apart, with the 8-hour gap before step 250.
const script = {
	farmId: "gate",
	steps: Array.from({ length: 500 }, (_, i) => ({
		action: { type: "harvest", plot: 0 },
		at: i * 10_000 + (i >= 250 ? 8 * hour : 0),
	})),
};
const run = (overrides = {}) => ({
	label: "process 1",
	hash,
	jsonHash: "c".repeat(64),
	accepted: 450,
	refused: 50,
	streamsMoved: { yields: true, orders: true },
	isGapBusy: true,
	problems: [],
	...overrides,
});

describe("determinism gate", () => {
	it("passes when both processes and the recorded hash agree", () => {
		const { failures, report } = evaluate({ script, runs: [run(), run()], expected: hash });

		expect(failures).toEqual([]);
		expect(report).toContain(`process 1: 450 accepted, 50 refused, state hash ${hash}`);
	});

	it("fails when the two processes end on different state hashes", () => {
		const { failures } = evaluate({
			script,
			runs: [run(), run({ hash: other })],
			expected: hash,
		});

		expect(failures).toEqual([expect.stringContaining("two processes ended on different")]);
	});

	it("fails when the processes' farms differ in plain JSON though their state hashes agree", () => {
		const { failures } = evaluate({
			script,
			runs: [run(), run({ jsonHash: "d".repeat(64) })],
			expected: hash,
		});

		expect(failures).toEqual([expect.stringContaining("two processes ended on different")]);
	});

	it("fails when both processes agree on a hash that isn't the recorded one", () => {
		const { failures } = evaluate({ script, runs: [run(), run()], expected: other });

		expect(failures).toEqual([expect.stringContaining("--update")]);
	});

	it("fails when no hash is recorded", () => {
		const { failures } = evaluate({ script, runs: [run(), run()], expected: null });

		expect(failures).toEqual([expect.stringContaining("no expected state hash")]);
	});

	it("fails on a problem a process found inside itself", () => {
		const { failures } = evaluate({
			script,
			runs: [run({ problems: ["The second play ended on another state hash."] }), run()],
			expected: hash,
		});

		expect(failures).toEqual(["process 1: The second play ended on another state hash."]);
	});

	it("fails a script the rules now accept too little of", () => {
		const { failures } = evaluate({
			script,
			runs: [run({ accepted: 399 }), run()],
			expected: hash,
		});

		expect(failures).toEqual([expect.stringContaining("accept 399 of the script's steps")]);
	});

	it("fails a script too short, without the gap, refusals or random draws to test", () => {
		const short = { ...script, steps: script.steps.slice(0, 100) };
		const { failures } = evaluate({
			script: short,
			runs: [
				run({ refused: 0, isGapBusy: false, streamsMoved: { yields: true, orders: false } }),
				run(),
			],
			expected: hash,
		});

		expect(failures).toEqual([
			"the script has 100 steps, not 500",
			"the script has no gap of 8 hours between two steps",
			"no work is in progress when the script's 8-hour gap begins",
			"the rules refuse 0 of the script's steps, fewer than 10",
			"the script never draws from the orders stream",
		]);
	});
});

// The process paths (#287): a stand-in for the compiled sim, written to a temp folder, so these
// tests run the gate's real child processes without compiling packages/sim.
const GATE = fileURLToPath(new URL("../determinism-gate.mjs", import.meta.url));
const SCRIPTS = dirname(GATE);
// sha256 of `{"steps":7}`, the plain JSON of the stand-in's final farm for a 7-step script: a
// length the recorded script doesn't have, so a child that plays another file shows.
const FINAL_7 = "20333c207540c6fd6b472ded21443c9507965e1852460d99eb1cbb1eca089d91";
const STAND_INS = {
	// Plays any script: reports what the gate's checks want, and what the process saw.
	"play.mjs": `export const playScript = (script) => ({
	final: { steps: script.steps.length },
	hash: "${hash}",
	zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	accepted: 450,
	refused: 50,
	streamsMoved: { yields: true, orders: true },
	isGapBusy: true,
	problems: [],
});
`,
	"crash.mjs": 'export const playScript = () => { throw new Error("the sim fell over"); };\n',
	"record.mjs": `export const recordScript = () => (${JSON.stringify(script)});\n`,
	// Too short for the gate's checks, so a --record of it must fail with exit 1.
	"record-short.mjs": `export const recordScript = () => (${JSON.stringify({ ...script, steps: script.steps.slice(0, 100) })});\n`,
};

let dir;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "determinism-gate-test-"));
	for (const [name, source] of Object.entries(STAND_INS)) writeFileSync(join(dir, name), source);
	vi.spyOn(console, "log").mockReturnValue(undefined);
	vi.spyOn(console, "error").mockReturnValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});
const urlOf = (name) => pathToFileURL(join(dir, name)).href;
const writeScript = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`);

describe("spawnRun", () => {
	it("plays the script at the given path in a child with the process's time zone", () => {
		const path = join(dir, "script.json");
		writeScript(path, { ...script, steps: script.steps.slice(0, 7) });

		const run = spawnRun(
			{ label: "process 2", env: { TZ: "Pacific/Chatham" } },
			urlOf("play.mjs"),
			path,
		);

		expect(run).toMatchObject({ label: "process 2", hash, zone: "Pacific/Chatham", accepted: 450 });
		expect(run.jsonHash).toBe(FINAL_7);
	});

	it("can't run when the child exits non-zero, and names the process", () => {
		const path = join(dir, "script.json");
		writeScript(path, script);

		expect(() => spawnRun({ label: "process 1", env: {} }, urlOf("crash.mjs"), path)).toThrow(
			expect.objectContaining({
				constructor: CannotRun,
				message: expect.stringMatching(/^process 1 exited 2:[\s\S]*the sim fell over/),
			}),
		);
	});
});

// A copy of the recorded script and its hash, so a real --record never touches packages/sim.
const makeTestsFolder = () => {
	const tests = join(dir, "tests");
	mkdirSync(tests);
	const scriptPath = join(tests, "determinismScript.json");
	const hashPath = join(tests, "determinismScript.hash");
	writeScript(scriptPath, { farmId: "before", steps: [] });
	writeFileSync(hashPath, `${other}\n`);
	return { tests, scriptPath, hashPath };
};
// Every entry's bytes, or a folder's listing.
const snapshotFolder = (folder) =>
	Object.fromEntries(
		readdirSync(folder, { withFileTypes: true }).map((e) => [
			e.name,
			e.isDirectory()
				? readdirSync(join(folder, e.name))
				: readFileSync(join(folder, e.name), "utf8"),
		]),
	);
const simOf = (files) => (file) => urlOf(files[file]);

const recordWith = (record, play) => simOf({ "recordScript.js": record, "playScript.js": play });

describe("runGate --record", () => {
	it("moves the new script and its hash into place after the checks pass", async () => {
		const { tests, scriptPath, hashPath } = makeTestsFolder();
		const moduleOf = recordWith("record.mjs", "play.mjs");

		await expect(runGate(["--record"], { moduleOf, scriptPath, hashPath })).resolves.toBe(0);

		expect(JSON.parse(readFileSync(scriptPath, "utf8"))).toEqual(script);
		expect(readFileSync(hashPath, "utf8")).toBe(`${hash}\n`);
		expect(readdirSync(tests).sort()).toEqual(["determinismScript.hash", "determinismScript.json"]);
	});

	// A snapshot holds every entry, dotfiles included, so a temp file left behind shows too.
	it("leaves the tests folder byte-identical when the checks fail (exit 1)", async () => {
		const { tests, scriptPath, hashPath } = makeTestsFolder();
		const before = snapshotFolder(tests);
		const moduleOf = recordWith("record-short.mjs", "play.mjs");

		await expect(runGate(["--record"], { moduleOf, scriptPath, hashPath })).resolves.toBe(1);

		expect(snapshotFolder(tests)).toEqual(before);
	});

	// The entry turns a CannotRun into exit 2.
	it("leaves the tests folder byte-identical when a process can't run (exit 2)", async () => {
		const { tests, scriptPath, hashPath } = makeTestsFolder();
		const before = snapshotFolder(tests);
		const moduleOf = recordWith("record.mjs", "crash.mjs");

		await expect(runGate(["--record"], { moduleOf, scriptPath, hashPath })).rejects.toThrow(
			CannotRun,
		);

		expect(snapshotFolder(tests)).toEqual(before);
	});

	// A move that fails half way must not leave the new script beside the old hash, or the new hash
	// beside the old script. A non-empty folder in a file's place refuses the move. In the hash's
	// place it is refused already when the old hash is read for the restore, before either rename.
	it.each([["determinismScript.json"], ["determinismScript.hash"]])(
		"leaves the tests folder byte-identical when %s can't be replaced",
		async (blocked) => {
			const { tests, scriptPath, hashPath } = makeTestsFolder();
			rmSync(join(tests, blocked));
			mkdirSync(join(tests, blocked, "occupied"), { recursive: true });
			const before = snapshotFolder(tests);
			const moduleOf = recordWith("record.mjs", "play.mjs");

			await expect(runGate(["--record"], { moduleOf, scriptPath, hashPath })).rejects.toThrow();

			expect(snapshotFolder(tests)).toEqual(before);
		},
	);
});

// A gate started through a symlink once skipped `main` and exited 0 with no output (#48's
// review); it now uses the shared `isMain` (#283). The same two links as entry-point.test.mjs.
describe("the gate started through a symlink", () => {
	const viaFileLink = (links) => {
		symlinkSync(GATE, join(links, "determinism-gate.mjs"));
		return join(links, "determinism-gate.mjs");
	};
	const viaFolderLink = (links) => {
		symlinkSync(SCRIPTS, join(links, "scripts"));
		return join(links, "scripts", "determinism-gate.mjs");
	};

	it.each([
		["a symlinked file", viaFileLink],
		["a symlinked folder", viaFolderLink],
	])("runs through %s and refuses an unknown flag with exit 2", (_, link) => {
		const links = join(dir, "links");
		mkdirSync(links);

		const r = spawnSync(process.execPath, [link(links), "--bogus"], { encoding: "utf8" });

		expect(r.status).toBe(2);
		expect(r.stderr).toContain("determinism-gate: cannot run: unknown argument --bogus");
	});
});
