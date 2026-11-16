#!/usr/bin/env node
// sim-changed.mjs: runs a command, with extra environment variables when the branch changes
// packages/sim (#272). `check:task` runs `pnpm test:related` through it with
// SIM_PROPERTY_RUNS=1000, so a sim change meets its property tests at the run count `ci / test`
// uses, not only at the default 100 (retro 2026-11-15, row 4: #175 and #176 passed `check:task`
// and failed CI).
//
// "Changes packages/sim" reads the change the way `vitest run --changed <base>` does, so it agrees
// with the files `test:related` picks: committed since the merge base (`<base>...HEAD`), staged,
// and modified or untracked in the working tree (vitest 5.0.5, GitVCSProvider.findChangedFiles).
//
// Usage: node .github/scripts/sim-changed.mjs [--base <ref>] NAME=VALUE... -- <command...>
//   (default base: origin/main)
// Exit codes: the command's own; 2 when the change can't be read or the arguments are wrong. The
// command never runs on a change the script couldn't read, so a 2 never runs it at the low count.
import { spawnSync } from "node:child_process";

import { CannotRun, git, isMain } from "./diff.mjs";

const SIM = "packages/sim/";

// The base, the NAME=VALUE pairs and the command. `--base <ref>` counts only as the first
// argument, so a `--base` inside the command never moves the comparison.
export const parseArgs = (argv) => {
	const hasBase = argv[0] === "--base";
	const base = hasBase ? argv[1] : "origin/main";
	if (!base || base.startsWith("-") || base.includes("="))
		throw new CannotRun("--base needs a ref");
	const rest = hasBase ? argv.slice(2) : argv;
	const split = rest.indexOf("--");
	const pairs = split > -1 ? rest.slice(0, split) : [];
	const command = split > -1 ? rest.slice(split + 1) : [];
	if (split < 0 || command.length === 0)
		throw new CannotRun("usage: sim-changed.mjs [--base <ref>] NAME=VALUE... -- <command...>");
	const env = {};
	for (const pair of pairs) {
		const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(pair);
		if (!m) throw new CannotRun(`not a NAME=VALUE pair: ${pair}`);
		env[m[1]] = m[2];
	}
	return { base, env, command };
};

// The changed paths, relative to the top of the work tree, as vitest's `--changed <base>` reads
// them. Throws CannotRun when git can't answer: a missing base must not read as "no change".
export const changedPaths = (base) => {
	const top = git(["rev-parse", "--show-toplevel"])?.trim();
	if (!top) throw new CannotRun("not inside a git work tree");
	const lists = [
		["diff", "--name-only", "-z", `${base}...HEAD`],
		["diff", "--cached", "--name-only", "-z"],
		["ls-files", "-z", "--other", "--modified", "--exclude-standard"],
	].map((args) => {
		const out = git(["-C", top, ...args]);
		if (out === null) throw new CannotRun(`git ${args[0]} failed (is ${base} fetched?)`);
		return out.split("\0").filter(Boolean);
	});
	return lists.flat();
};

const main = () => {
	const { base, env, command } = parseArgs(process.argv.slice(2));
	const changed = changedPaths(base).some((p) => p.startsWith(SIM));
	const names = Object.entries(env).map(([k, v]) => `${k}=${v}`);
	console.error(
		changed
			? `sim-changed: packages/sim changed against ${base}, running with ${names.join(" ")}`
			: `sim-changed: no change in packages/sim against ${base}`,
	);
	const r = spawnSync(command[0], command.slice(1), {
		stdio: "inherit",
		env: changed ? { ...process.env, ...env } : process.env,
	});
	if (r.error) throw new CannotRun(`could not start ${command[0]}: ${r.error.message}`);
	return r.status ?? 1;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (e) {
		if (!(e instanceof CannotRun)) throw e;
		console.error(`sim-changed: could not run: ${e.message}`);
		process.exitCode = 2;
	}
}
