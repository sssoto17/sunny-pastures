import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkStackBase, isTopPart } from "../stack-base-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../stack-base-guard.mjs", import.meta.url));
const STACK = { number: 305, position: 2, size: 2, base: { ref: "main" } };

const event = (base, stack = null) => ({
	repository: { full_name: "sssoto17/sunny-pastures", default_branch: "main" },
	pull_request: { number: 296, base: { ref: base }, stack },
});

// A getPull that answers from a list, one entry per call, and counts its calls.
const answers = (...stacks) => {
	const calls = [];
	const getPull = async (n) => {
		calls.push(n);
		return { number: n, stack: stacks[Math.min(calls.length - 1, stacks.length - 1)] };
	};
	return { calls, getPull };
};
const noSleep = () => Promise.resolve();

describe("checkStackBase", () => {
	it("passes a PR on the default branch without asking GitHub", async () => {
		const { calls, getPull } = answers(null);
		const r = await checkStackBase(event("main"), { getPull, sleep: noSleep });
		expect(r.ok).toBe(true);
		expect(calls).toEqual([]);
	});

	it("passes a part of a native stack, from the event", async () => {
		const { calls, getPull } = answers(null);
		const r = await checkStackBase(event("270-closing-links", STACK), { getPull, sleep: noSleep });
		expect(r.ok).toBe(true);
		expect(r.message).toContain("part 2 of 2 of stack #305");
		expect(calls).toEqual([]);
	});

	it("fails a hand-chained PR: a base that isn't main, and no stack", async () => {
		const { calls, getPull } = answers(null);
		const r = await checkStackBase(event("270-closing-links"), {
			getPull,
			sleep: noSleep,
			tries: 3,
		});
		expect(r.ok).toBe(false);
		expect(r.message).toContain("270-closing-links");
		expect(r.message).toContain("scripts/stack.sh");
		expect(calls).toEqual([296, 296, 296]);
	});

	// scripts/stack.sh opens the PRs first and links the stack after, so the `opened` run can start
	// before the stack exists: it asks again before failing.
	it("passes once the stack appears while it waits", async () => {
		const { calls, getPull } = answers(null, null, STACK);
		const waits = [];
		const r = await checkStackBase(event("270-closing-links"), {
			getPull,
			sleep: async (ms) => waits.push(ms),
			tries: 5,
		});
		expect(r.ok).toBe(true);
		expect(calls).toHaveLength(3);
		expect(waits).toEqual([10000, 10000]);
	});

	it("reads the default branch from the event, not a fixed name", async () => {
		const e = event("trunk");
		e.repository.default_branch = "trunk";
		const r = await checkStackBase(e, { getPull: answers(null).getPull, sleep: noSleep });
		expect(r.ok).toBe(true);
	});
});

// ci.yml's `ci / stack` job: typecheck, lint and test run unless this says the PR is a lower part.
describe("isTopPart", () => {
	const top = { ...STACK, position: 2, size: 2 };
	const lower = { ...STACK, position: 1, size: 2 };

	it("is true on a push to main, without asking GitHub", async () => {
		const { calls, getPull } = answers(lower);
		expect(await isTopPart({ ref: "refs/heads/main" }, { getPull, sleep: noSleep })).toBe(true);
		expect(calls).toEqual([]);
	});

	it("reads the position from the event's stack", async () => {
		const { calls, getPull } = answers(null);
		expect(await isTopPart(event("main", lower), { getPull, sleep: noSleep })).toBe(false);
		expect(await isTopPart(event("270-closing-links", top), { getPull, sleep: noSleep })).toBe(
			true,
		);
		expect(calls).toEqual([]);
	});

	// On `opened` the event has no stack yet: scripts/stack.sh links it after opening the PRs.
	it("waits for the stack of a part on another part", async () => {
		const { calls, getPull } = answers(null, top);
		expect(await isTopPart(event("270-closing-links"), { getPull, sleep: noSleep })).toBe(true);
		expect(calls).toHaveLength(2);
		const second = answers(null, lower);
		const r = await isTopPart(event("270-closing-links"), {
			getPull: second.getPull,
			sleep: noSleep,
		});
		expect(r).toBe(false);
	});

	it("asks once, without waiting, for a PR on main", async () => {
		const { calls, getPull } = answers(null, lower);
		expect(await isTopPart(event("main"), { getPull, sleep: noSleep })).toBe(true);
		expect(calls).toEqual([296]);
		expect(await isTopPart(event("main"), { ...answers(lower), sleep: noSleep })).toBe(false);
	});
});

describe("stack-base-guard.mjs", () => {
	let dir;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	const run = (ev) => {
		dir = mkdtempSync(join(tmpdir(), "stack-base-"));
		const path = join(dir, "event.json");
		if (ev !== undefined) writeFileSync(path, JSON.stringify(ev));
		return spawnSync(process.execPath, [SCRIPT], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: path },
		});
	};

	it("exits 0 for a PR on main", () => {
		const r = run(event("main"));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("stack-base: pass");
	});

	it("exits 0 for a stacked part and logs the stack it saw", () => {
		const r = run(event("270-closing-links", STACK));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"position":2');
	});

	it("--top writes top=false to $GITHUB_OUTPUT for a lower part, and exits 0", () => {
		dir = mkdtempSync(join(tmpdir(), "stack-base-"));
		const path = join(dir, "event.json");
		const out = join(dir, "output");
		writeFileSync(path, JSON.stringify(event("main", { ...STACK, position: 1, size: 2 })));
		const r = spawnSync(process.execPath, [SCRIPT, "--top"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: path, GITHUB_OUTPUT: out },
		});
		expect(r.status).toBe(0);
		expect(readFileSync(out, "utf8")).toBe("top=false\n");
	});

	// ci.yml runs typecheck, lint and test unless top is exactly "false": a lookup that can't run
	// must write nothing, so they run.
	it("--top writes nothing and exits 2 when it can't tell", () => {
		dir = mkdtempSync(join(tmpdir(), "stack-base-"));
		const path = join(dir, "event.json");
		const out = join(dir, "output");
		writeFileSync(path, JSON.stringify({ pull_request: { number: 296 } }));
		writeFileSync(out, "");
		const r = spawnSync(process.execPath, [SCRIPT, "--top"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: path, GITHUB_OUTPUT: out },
		});
		expect(r.status).toBe(2);
		expect(readFileSync(out, "utf8")).toBe("");
	});

	it("exits 2, never a pass, without an event", () => {
		const r = run(undefined);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("cannot run");
	});
});
