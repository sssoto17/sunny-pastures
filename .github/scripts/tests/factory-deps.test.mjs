import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../factory-deps.sh", import.meta.url));

let dir;
let broker;
afterEach(() => {
	broker?.kill("SIGKILL");
	broker = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

// A checkout with one workspace package, a fake bwrap that logs its options and runs the command
// after `--`, and a fake pnpm that logs its arguments, prints a line, writes the lockfile and exits
// with PNPM_EXIT. `pnpm store path` answers with a folder of the test's own.
function setup() {
	dir = mkdtempSync(join(tmpdir(), "factory-deps-"));
	const root = join(dir, "repo");
	mkdirSync(join(root, "apps", "web"), { recursive: true });
	for (const d of [".git", ".github", ".claude", "scripts"]) mkdirSync(join(root, d));
	writeFileSync(join(root, "package.json"), '{"name":"root"}\n');
	writeFileSync(join(root, "pnpm-workspace.yaml"), "minimumReleaseAge: 10080\n");
	writeFileSync(join(root, "apps", "web", "package.json"), '{"name":"web"}\n');
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, "bin", "bwrap"),
		`#!/usr/bin/env bash
while (($#)) && [[ $1 != -- ]]; do echo "$1" >>"${dir}/bwrap.args"; shift; done
shift
exec "$@"
`,
	);
	writeFileSync(
		join(dir, "bin", "pnpm"),
		`#!/usr/bin/env bash
if [[ $* == "store path" ]]; then echo "${dir}/store"; exit 0; fi
printf '%s\\n' "$@" >"${dir}/pnpm.args"
echo "Progress: resolved 1, added 1"
echo "lockfile" >pnpm-lock.yaml
exit \${PNPM_EXIT:-0}
`,
	);
	chmodSync(join(dir, "bin", "bwrap"), 0o755);
	chmodSync(join(dir, "bin", "pnpm"), 0o755);
	return {
		root,
		env: {
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			HOME: dir,
			FACTORY_DEPS: join(dir, "requests"),
			FACTORY_DEPS_OUT: join(dir, "out"),
			FACTORY_DEPS_POLL: "0.1",
		},
	};
}

// The broker as the workflow starts it, in the background from the checkout; resolves once ready.
async function serve(t, env = {}) {
	broker = spawn("bash", [SCRIPT, "serve"], {
		cwd: t.root,
		env: { ...t.env, ...env },
		stdio: "ignore",
	});
	for (let i = 0; i < 100 && !existsSync(join(dir, "out", "ready")); i++) {
		await sleep(50);
	}
}

// Claude's side: the client in its sandbox, from the checkout.
const add = (t, args, env = {}) => {
	const res = spawnSync("bash", [SCRIPT, "add", ...args], {
		cwd: t.root,
		encoding: "utf8",
		env: { ...t.env, ...env },
	});
	return { code: res.status, out: res.stdout + res.stderr };
};
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);

describe("factory-deps.sh", () => {
	it("adds a pinned package with pnpm inside its own bubblewrap, writing only what the decision allows", async () => {
		const t = setup();
		await serve(t);
		const r = add(t, ["apps/web", "zustand@5.1.0", "@scope/pkg-a@1.0.0-rc.1"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Progress: resolved 1, added 1");
		expect(read("pnpm.args").trim().split("\n")).toEqual([
			"--filter",
			"./apps/web",
			"add",
			"--save-exact",
			"--ignore-scripts",
			"--ignore-pnpmfile",
			"--config.manage-package-manager-versions=false",
			"--store-dir",
			join(dir, "store"),
			"--",
			"zustand@5.1.0",
			"@scope/pkg-a@1.0.0-rc.1",
		]);
		const bwrap = read("bwrap.args");
		// Read-only everywhere; the checkout and the store writable; every protected path read-only
		// again over the checkout; no environment carried in.
		expect(bwrap).toContain("--clearenv\n--unshare-all\n--share-net\n");
		expect(bwrap).toContain(`--ro-bind\n/\n/\n`);
		expect(bwrap).toContain(`--bind\n${t.root}\n${t.root}\n`);
		expect(bwrap).toContain(`--bind\n${join(dir, "store")}\n${join(dir, "store")}\n`);
		for (const p of [
			".git",
			".github",
			".claude",
			"scripts",
			"package.json",
			"pnpm-workspace.yaml",
		]) {
			expect(bwrap).toContain(`--ro-bind\n${t.root}/${p}\n${t.root}/${p}\n`);
		}
		// A protected file the checkout lacks can't be created: an empty read-only one stands in.
		for (const p of [".npmrc", ".gitmodules", ".env", "yarn.lock"]) {
			expect(bwrap).toContain(`--ro-bind\n${join(dir, "out", "empty")}\n${t.root}/${p}\n`);
		}
		expect(bwrap.split("\n").filter((l) => l === "--bind")).toHaveLength(2);
		expect(bwrap).not.toMatch(/(node_modules|pnpm-lock\.yaml)/);
		expect(read("out/serve.log")).toMatch(
			/^DEPS \S+: apps\/web prod zustand@5.1.0 @scope\/pkg-a@1.0.0-rc.1 -> exit 0$/m,
		);
	});

	it("adds a dev dependency with --save-dev", async () => {
		const t = setup();
		await serve(t);
		expect(add(t, ["apps/web", "--dev", "jsdom@31.0.1"]).code).toBe(0);
		expect(read("pnpm.args")).toContain("--save-exact\n--save-dev\n");
	});

	it("refuses anything but an exact version, before it asks the broker", async () => {
		const t = setup();
		await serve(t);
		for (const spec of [
			"zustand",
			"zustand@^5.1.0",
			"zustand@latest",
			"zustand@5.1",
			"-g",
			"a@1.0.0 b",
		]) {
			const r = add(t, ["apps/web", spec]);
			expect(r.code, spec).toBe(2);
			expect(r.out).toMatch(/^DEPS refused: not a package at an exact version: /m);
		}
		expect(read("pnpm.args")).toBeNull();
	});

	it("refuses a folder that isn't a workspace package", async () => {
		const t = setup();
		await serve(t);
		for (const d of ["apps/../.github", "/tmp", ".", "apps/missing"]) {
			const r = add(t, [d, "zustand@5.1.0"]);
			expect(r.code, d).toBe(2);
			expect(r.out).toMatch(/^DEPS refused: /m);
		}
		expect(read("pnpm.args")).toBeNull();
	});

	it("re-checks a request it reads, whoever wrote it", async () => {
		const t = setup();
		await serve(t);
		mkdirSync(join(dir, "requests"), { recursive: true });
		writeFileSync(join(dir, "requests", "req.x1"), "apps/web prod zustand@^5\n");
		for (let i = 0; i < 100 && !existsSync(join(dir, "out", "res.x1.status")); i++) {
			await sleep(50);
		}
		expect(read("out/res.x1.status").trim()).toBe("2");
		expect(read("out/res.x1.log")).toMatch(/^DEPS refused: not a package at an exact version/m);
		expect(read("pnpm.args")).toBeNull();
	});

	// Each case changes the checkout (before or after the broker starts) and must stop pnpm.
	it.each([
		{
			why: "pnpm-workspace.yaml changed since the run began",
			after: (root) => writeFileSync(join(root, "pnpm-workspace.yaml"), "minimumReleaseAge: 0\n"),
			says: /^DEPS refused: pnpm-workspace.yaml changed since the run began/m,
		},
		{
			why: "a protected folder is missing, so it can't be created",
			before: (root) => rmSync(join(root, ".github"), { recursive: true }),
			says: /^DEPS refused: \.github\/ is missing from the checkout$/m,
		},
	])("refuses when $why", async ({ before, after, says }) => {
		const t = setup();
		before?.(t.root);
		await serve(t);
		after?.(t.root);
		const r = add(t, ["apps/web", "zustand@5.1.0"]);
		expect(r.code).toBe(2);
		expect(r.out).toMatch(says);
		expect(read("pnpm.args")).toBeNull();
	});

	it("takes an empty pnpm config file for a missing one, as Claude Code leaves it", async () => {
		const t = setup();
		await serve(t);
		writeFileSync(join(t.root, ".npmrc"), "");
		expect(add(t, ["apps/web", "zustand@5.1.0"]).code).toBe(0);
		writeFileSync(join(t.root, ".npmrc"), "registry=https://evil.example/\n");
		const r = add(t, ["apps/web", "zustand@5.1.0"]);
		expect(r.code).toBe(2);
		expect(r.out).toMatch(/^DEPS refused: \.npmrc changed since the run began/m);
	});

	it("passes pnpm's failure on, with its output", async () => {
		const t = setup();
		await serve(t, { PNPM_EXIT: "1" });
		const r = add(t, ["apps/web", "zustand@5.1.0"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("Progress: resolved 1");
	});

	it("says so when no broker is running", () => {
		const t = setup();
		const r = add(t, ["apps/web", "zustand@5.1.0"]);
		expect(r.code).toBe(3);
		expect(r.out).toMatch(/no dependency broker is running/);
	});
});
