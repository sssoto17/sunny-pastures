import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkStackBase } from "../stack-base-guard.mjs";

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

	it("exits 2, never a pass, without an event", () => {
		const r = run(undefined);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("cannot run");
	});
});
