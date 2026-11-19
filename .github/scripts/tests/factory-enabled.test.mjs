import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../factory-enabled.sh", import.meta.url));
// A workflow's code without its comments: factory-switch.yml's header shows a caller's snippet.
const workflow = (name) =>
	readFileSync(fileURLToPath(new URL(`../../workflows/${name}`, import.meta.url)), "utf8")
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("#"))
		.join("\n");

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// The switch as the workflow hands it over: `vars.FACTORY_ENABLED` through `env:`, where an unset
// variable reads as the empty string. `undefined` leaves it out of the environment altogether.
function gate(value, { output = true } = {}) {
	dir = mkdtempSync(join(tmpdir(), "factory-enabled-"));
	const env = { PATH: process.env.PATH, GITHUB_WORKFLOW: "factory" };
	if (value !== undefined) env.FACTORY_ENABLED = value;
	if (output) {
		writeFileSync(join(dir, "out"), "");
		env.GITHUB_OUTPUT = join(dir, "out");
	}
	const res = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env });
	return {
		code: res.status,
		out: res.stdout + res.stderr,
		run: output ? readFileSync(join(dir, "out"), "utf8").match(/^run=(.*)$/m)?.[1] : undefined,
	};
}

describe("factory-enabled.sh", () => {
	// #106 criterion 1: anything but `true` stops the run before a token or Claude, and says so.
	it.each([
		["unset", undefined],
		["empty", ""],
		["false", "false"],
		["TRUE", "TRUE"],
		["True", "True"],
		["1", "1"],
		["yes", "yes"],
		["true with a trailing space", "true "],
		["true with a newline", "true\n"],
	])("is off when FACTORY_ENABLED is %s", (_name, value) => {
		const g = gate(value);
		expect(g.code).toBe(0);
		expect(g.run).toBe("false");
		expect(g.out).toMatch(/^SWITCH off: FACTORY_ENABLED is .*, not true: factory stops before/m);
		expect(g.out.trim().split("\n")).toHaveLength(1);
	});

	it("is on when FACTORY_ENABLED is exactly true", () => {
		const g = gate("true");
		expect(g.code).toBe(0);
		expect(g.run).toBe("true");
		expect(g.out.trim()).toBe("SWITCH on: FACTORY_ENABLED is true (workflow: factory)");
	});

	// The value is the admin's, but a newline in it must not forge a second output line.
	it("writes one run= line whatever the value holds", () => {
		const g = gate("x\nrun=true");
		expect(g.run).toBe("false");
		expect(readFileSync(join(dir, "out"), "utf8")).toBe("run=false\n");
	});

	it("fails, rather than let the caller guess, without GITHUB_OUTPUT", () => {
		const g = gate("true", { output: false });
		expect(g.code).not.toBe(0);
	});
});

// The script only answers; the workflows make that answer stop the run. A skipped job never starts,
// so the `factory` environment never hands it the App's key and no token is minted.
describe("factory-switch.yml (the reusable switch)", () => {
	const yml = workflow("factory-switch.yml");

	it("is called, never triggered by an event of its own", () => {
		expect(yml).toMatch(/^on:\n {2}workflow_call:\n/m);
		expect(yml).not.toMatch(
			/^ {2}(push|pull_request|workflow_dispatch|schedule|repository_dispatch)/m,
		);
	});

	it("reads the repo variable through env:, never as ${{ }} inside run:", () => {
		expect(yml).toContain("FACTORY_ENABLED: ${{ vars.FACTORY_ENABLED }}");
		expect(yml).toContain("run: bash .github/scripts/factory-enabled.sh\n");
		// The only expressions: the variable, and the answer passed up to the caller.
		const exprs = [...yml.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
		expect(new Set(exprs)).toEqual(
			new Set(["vars.FACTORY_ENABLED", "steps.switch.outputs.run", "jobs.switch.outputs.run"]),
		);
	});

	it("hands the answer to the caller as the output run", () => {
		expect(yml).toContain("value: ${{ jobs.switch.outputs.run }}");
		expect(yml).toContain("run: ${{ steps.switch.outputs.run }}");
	});

	it("holds no secret, environment or token beyond contents: read", () => {
		expect(yml).not.toMatch(/secrets\.|environment:|create-github-app-token|claude-code-action/);
		expect(yml).toMatch(/^permissions: \{\}$/m);
		expect(yml).toMatch(/permissions:\n\s+contents: read\n/);
	});

	it("pins every action to a full SHA", () => {
		for (const [, ref] of yml.matchAll(/uses: [^@\s]+@(\S+)/g))
			expect(ref).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("check-106-factory-switch.yml (the throwaway dispatch)", () => {
	const yml = workflow("check-106-factory-switch.yml");

	it("calls the switch first and runs its stand-in only when it says run=true", () => {
		expect(yml).toContain("uses: ./.github/workflows/factory-switch.yml");
		expect(yml).toMatch(/needs: switch\n\s+if: needs\.switch\.outputs\.run == 'true'\n/);
	});

	it("mints no token and calls no Claude, even with the switch on", () => {
		expect(yml).not.toMatch(/secrets\.|environment:|create-github-app-token|claude-code-action/);
	});
});
