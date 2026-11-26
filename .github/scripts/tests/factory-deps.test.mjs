import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
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
	// The broker leaves its copies read-only, as it does on the runner.
	if (dir) spawnSync("chmod", ["-R", "u+w", dir]);
	if (dir) rmSync(dir, { recursive: true, force: true });
});

// A checkout with one workspace package, a fake bwrap that logs its options and runs the command
// after `--`, and a fake pnpm (the version package.json pins) that logs its arguments, prints a
// line, writes LOCK to the lockfile and exits with PNPM_EXIT. `pnpm store path` answers with a
// folder of the test's own.
function setup() {
	dir = mkdtempSync(join(tmpdir(), "factory-deps-"));
	const root = join(dir, "repo");
	mkdirSync(join(root, "apps", "web"), { recursive: true });
	for (const d of [".git", ".github", ".claude", "scripts"]) mkdirSync(join(root, d));
	writeFileSync(join(root, "package.json"), '{"name":"root","packageManager":"pnpm@12.15.0"}\n');
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
if [[ $* == --version ]]; then echo \${PNPM_VERSION:-12.15.0}; exit 0; fi
if [[ $* == "store path"* ]]; then echo "${dir}/store"; exit 0; fi
printf '%s\\n' "$@" >"${dir}/pnpm.args"
echo "Progress: resolved 1, added 1"
printf '%s\\n' "\${LOCK:-lockfileVersion: '9.0'}" >pnpm-lock.yaml
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
			FACTORY_DEPS_WAIT: "5",
			FACTORY_DEPS_BWRAP: join(dir, "bin", "bwrap"),
			FACTORY_DEPS_STEP_PATH: join(dir, "bin"),
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
// The usual request, refused with a message matching `says`.
const expectRefused = (t, says) => {
	const r = add(t, ["apps/web", "zustand@5.1.0"]);
	expect(r.code).toBe(2);
	expect(r.out).toMatch(says);
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
			"--config.block-exotic-subdeps=true",
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
		for (const p of [".git", ".github", ".claude", "scripts"]) {
			expect(bwrap).toContain(`--ro-bind\n${t.root}/${p}\n${t.root}/${p}\n`);
		}
		// The pnpm config as the broker copied it at start-up, never the live file: a change made
		// after the check can't reach pnpm.
		for (const p of ["package.json", "pnpm-workspace.yaml", ".npmrc"]) {
			expect(bwrap).toContain(`--ro-bind\n${join(dir, "out", "config", p)}\n${t.root}/${p}\n`);
		}
		expect(read("out/config/pnpm-workspace.yaml")).toBe("minimumReleaseAge: 10080\n");
		// The pnpm that runs is the broker's copy, with only it and the system's commands on PATH.
		expect(bwrap).toContain(`--setenv\nPATH\n${join(dir, "out", "bin")}:/usr/bin:/bin\n`);
		expect(read("out/bin/pnpm")).toBe(read("bin/pnpm"));
		// What the broker keeps can't be changed by the user Claude runs as.
		for (const f of ["config/pnpm-workspace.yaml", "ws/apps/web/package.json", "bin/pnpm"]) {
			expect(statSync(join(dir, "out", f)).mode & 0o222, f).toBe(0);
		}
		// A protected file the checkout lacks can't be created: an empty read-only one stands in.
		for (const p of [".gitmodules", ".env", "yarn.lock"]) {
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
		writeFileSync(join(dir, "requests", "req.x1"), "apps/web\nprod\nzustand@^5\n");
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
			why: "the workspace package is a link out of the checkout",
			before: (root) => {
				mkdirSync(join(dir, "elsewhere"));
				writeFileSync(join(dir, "elsewhere", "package.json"), "{}\n");
				rmSync(join(root, "apps", "web"), { recursive: true });
				symlinkSync(join(dir, "elsewhere"), join(root, "apps", "web"));
			},
			says: /^DEPS refused: apps\/web\/package.json isn't a file in the checkout$/m,
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
		expectRefused(t, says);
		expect(read("pnpm.args")).toBeNull();
	});

	it("takes an empty pnpm config file for a missing one, as Claude Code leaves it", async () => {
		const t = setup();
		await serve(t);
		writeFileSync(join(t.root, ".npmrc"), "");
		expect(add(t, ["apps/web", "zustand@5.1.0"]).code).toBe(0);
		writeFileSync(join(t.root, ".npmrc"), "registry=https://evil.example/\n");
		expectRefused(t, /^DEPS refused: \.npmrc changed since the run began/m);
	});

	// Claude's sandbox can write home and /opt, which are on the step's PATH: the broker must never
	// run a command from there outside its bubblewrap.
	it("runs only /usr/bin and /bin commands itself, whatever the step's PATH holds", async () => {
		const t = setup();
		const planted = join(dir, "planted");
		mkdirSync(planted);
		for (const c of ["sleep", "mv", "head", "rm", "cat", "sha256sum", "realpath", "bwrap"]) {
			writeFileSync(join(planted, c), `#!/bin/sh\necho ${c} >>"${dir}/hijacked"\nexit 1\n`);
			chmodSync(join(planted, c), 0o755);
		}
		await serve(t, { PATH: `${planted}:${t.env.PATH}` });
		expect(add(t, ["apps/web", "zustand@5.1.0"]).code).toBe(0);
		expect(read("hijacked")).toBeNull();
	});

	it("keeps serving after a request it can't read", async () => {
		const t = setup();
		await serve(t);
		mkdirSync(join(dir, "requests", "req.dir1", "x"), { recursive: true });
		await sleep(300);
		expect(add(t, ["apps/web", "zustand@5.1.0"]).code).toBe(0);
	});

	it("refuses a workspace package.json that gained a dependency outside the request", async () => {
		const t = setup();
		await serve(t);
		const web = join(t.root, "apps", "web", "package.json");
		writeFileSync(web, '{"name":"web","dependencies":{"x":"https://evil.example/x.tgz"}}\n');
		expectRefused(t, /^DEPS refused: apps\/web\/package.json changed its dependencies/m);
		expect(read("pnpm.args")).toBeNull();
		// The requested name itself may change: pnpm add rewrites it.
		writeFileSync(web, '{"name":"web","scripts":{"t":"x"},"dependencies":{"zustand":"^5"}}\n');
		expect(add(t, ["apps/web", "zustand@5.1.0"]).code).toBe(0);
	});

	it("puts the lockfile back when it gained a source the registry didn't give", async () => {
		const t = setup();
		writeFileSync(join(t.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		await serve(t, { LOCK: "  resolution: {tarball: https://evil.example/x.tgz}" });
		expectRefused(
			t,
			/^DEPS refused: the lockfile gained a tarball, git, directory or link source/m,
		);
		expect(readFileSync(join(t.root, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: '9.0'\n");
	});

	it("refuses every request when it found no pnpm of the pinned version", async () => {
		const t = setup();
		await serve(t, { PNPM_VERSION: "11.0.0" });
		expectRefused(t, /^DEPS refused: the broker found no pnpm binary of the version/m);
		expect(read("out/bin/pnpm")).toBeNull();
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
