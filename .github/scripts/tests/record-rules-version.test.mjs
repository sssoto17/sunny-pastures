import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../record-rules-version.mjs", import.meta.url).pathname;

const run = (...args) => {
	const { status, stderr } = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
	return { code: status, err: stderr };
};

// The script writes into the repo only once a version is released; these cases refuse before any
// write, so they leave the working tree as it was (#154).
describe("record-rules-version", () => {
	it("exits 2 with its usage when the argument isn't a rules version", () => {
		expect(run("one")).toEqual({ code: 2, err: expect.stringContaining("usage:") });
		expect(run()).toEqual({ code: 2, err: expect.stringContaining("usage:") });
	});

	it("refuses a version the registry doesn't hold", () => {
		expect(run("99")).toEqual({ code: 1, err: expect.stringContaining("no rules version 99") });
	});

	it("refuses an unreleased version, naming the hash to record in the registry first", () => {
		const { code, err } = run("1");

		expect(code).toBe(1);
		expect(err).toMatch(/version 1 isn't released: its content hashes to [0-9a-f]{64}/);
	});
});
