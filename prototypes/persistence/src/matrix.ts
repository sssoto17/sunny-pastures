// The load matrix runner (#15 builds it, #11 runs it; ADR-0001 "Method"). One configuration
// (run × store × player count) per step, each against its own fresh schema (STORE_SCHEMA), through
// load/smoke.sh, so Locust, the spike server and Postgres all run on this machine. After each
// configuration its folder is committed and pushed, so a paused or ended session loses at most the
// configuration it was running. Started again, the runner skips every configuration whose folder
// holds done.json and reruns any half-written one from scratch. A lock keeps a second runner out.
//
// Order is run-major (run 1 of every configuration, then run 2, …): if the timebox cuts the matrix
// short, one run per configuration is what ADR-0001 counts, and that is what is done first.
//
// Run from the repo root:  node --env-file-if-exists=.env prototypes/persistence/src/matrix.ts
// (or `pnpm --filter @sunny-pastures/persistence-spike matrix`). Env, all optional:
//   MATRIX_OUT=docs/spikes/persistence/matrix  results folder (relative to the repo root)
//   STORES=A,B1,B25,B100  USERS=50,200  RUNS=3  WARMUP_S=60  MEASURE_S=300
//   LIMIT=<n>       stop after n configurations in this invocation (the dry run uses 2)
//   PUSH=0          commit but don't push; COMMIT_TRAILER=<text> appended to each commit message
//   MATRIX_ALLOW_MACHINE_CHANGE=1  resume even though machine.json describes another machine
// Needs DATABASE_URL (never printed) and `uv sync --locked` in load/ (cloud-setup.sh does both).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Sql } from "postgres";

export type StoreName = "A" | "B1" | "B25" | "B100";

export type Configuration = {
  /** `r<run>-<store>-u<users>`: the results folder's name. */
  id: string;
  run: number;
  store: StoreName;
  users: number;
  /** A fresh schema per configuration, so storage and bytes per player-hour aren't cumulative. */
  schema: string;
  /** What the spike server needs to pick the store. */
  env: { STORE: "A" } | { STORE: "B"; SNAPSHOT_N: string };
};

export type MatrixSpec = { stores: readonly StoreName[]; users: readonly number[]; runs: number };

/** Every configuration, run-major: run 1 of each store × player count, then run 2, and so on. */
export function plan({ stores, users, runs }: MatrixSpec): Configuration[] {
  const configs: Configuration[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const store of stores) {
      for (const u of users) {
        configs.push({
          id: `r${run}-${store}-u${u}`,
          run,
          store,
          users: u,
          schema: `load_r${run}_${store.toLowerCase()}_u${u}`,
          env: store === "A" ? { STORE: "A" } : { STORE: "B", SNAPSHOT_N: store.slice(1) },
        });
      }
    }
  }
  return configs;
}

export const DONE = "done.json";

/** The ids of configurations whose results are complete: their folder holds done.json. */
export function completed(root: string): Set<string> {
  if (!existsSync(root)) return new Set();
  return new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, DONE)))
      .map((d) => d.name),
  );
}

/**
 * Takes the runner's lock (a file holding its pid) and returns the release. Only one runner may
 * run on a machine: two would share the server port, and the second would delete the first's
 * half-written folder and drop its live schema. A lock whose pid is gone is a runner that died
 * (a paused or ended session), so it is taken over.
 */
export function lock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
      throw new Error(`another matrix runner (pid ${pid}) holds ${path}; wait for it, or stop it first`);
    }
    rmSync(path, { force: true }); // stale: its runner is gone
  }
  throw new Error(`could not take ${path}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What has to stay the same for every run of the matrix (ADR-0001: one environment). */
export type Machine = Record<string, string | number>;

/** The fields of `recorded` that `current` doesn't match. */
export function machineDiff(recorded: Machine, current: Machine): string[] {
  return Object.keys(recorded).filter((k) => recorded[k] !== current[k]);
}

/** CPU, cores, RAM, OS and the versions of everything on the measured path. */
export async function describeMachine(sql: Sql, loadDir: string): Promise<Machine> {
  const cpu = /^model name\s*:\s*(.+)$/m.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1] ?? "unknown";
  const os = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1] ?? "unknown";
  const [{ server_version: postgres }] = await sql<{ server_version: string }[]>`show server_version`;
  const py = execFileSync("uv", ["run", "--locked", "--quiet", "python", "-c", "import locust, platform; print(platform.python_version(), locust.__version__)"], {
    cwd: loadDir,
    encoding: "utf8",
  }).trim().split(" ");
  return {
    cpu,
    cores: cpus().length,
    ramGiB: Math.round(totalmem() / 2 ** 30),
    os,
    postgres: postgres!,
    node: process.version,
    python: py[0]!,
    locust: py[1]!,
  };
}

export const STORES: readonly StoreName[] = ["A", "B1", "B25", "B100"];

function list<T>(value: string | undefined, fallback: readonly T[], parse: (s: string) => T): T[] {
  return value ? value.split(",").map((s) => parse(s.trim())) : [...fallback];
}

function wholeNumber(name: string, value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${value}`);
  return n;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** Commits `paths` (if anything changed) and pushes, retrying network failures with backoff. */
function publish(repo: string, paths: string[], message: string, push: boolean): void {
  git(repo, "add", "--", ...paths);
  const staged = spawnSync("git", ["-C", repo, "diff", "--cached", "--quiet", "--", ...paths]).status !== 0;
  if (staged) git(repo, "commit", "-q", "-m", message, "--", ...paths);
  if (!push) return;
  const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  for (const [i, wait] of [0, 2, 4, 8, 16].entries()) {
    if (wait) spawnSync("sleep", [String(wait)]);
    const pushed = spawnSync("git", ["-C", repo, "push", "-q", "-u", "origin", `HEAD:${branch}`], { stdio: "inherit" });
    if (pushed.status === 0) return;
    // Someone else pushed to the branch (docs, another session): replay our commits on top.
    spawnSync("git", ["-C", repo, "pull", "-q", "--rebase", "origin", branch], { stdio: "inherit" });
    console.error(`push failed (attempt ${i + 1} of 5)`);
  }
  throw new Error(`could not push to ${branch}; the results are committed locally and the next start pushes them`);
}

async function main(): Promise<number> {
  const here = resolve(import.meta.dirname, "..");
  const repo = resolve(here, "../..");
  const loadDir = join(here, "load");
  const out = resolve(repo, process.env.MATRIX_OUT ?? "docs/spikes/persistence/matrix");
  const spec: MatrixSpec = {
    stores: list(process.env.STORES, STORES, (s) => {
      if (!STORES.includes(s as StoreName)) throw new Error(`STORES: unknown store ${s}`);
      return s as StoreName;
    }),
    users: list(process.env.USERS, [50, 200], (s) => wholeNumber("USERS", s, 0)),
    runs: wholeNumber("RUNS", process.env.RUNS, 3),
  };
  const warmupS = wholeNumber("WARMUP_S", process.env.WARMUP_S, 60);
  const measureS = wholeNumber("MEASURE_S", process.env.MEASURE_S, 300);
  const limit = wholeNumber("LIMIT", process.env.LIMIT, Number.MAX_SAFE_INTEGER);
  const push = process.env.PUSH !== "0";
  const trailer = process.env.COMMIT_TRAILER ? `\n\n${process.env.COMMIT_TRAILER}` : "";
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (source prototypes/persistence/cloud-setup.sh first)");
    return 1;
  }

  let release: () => void;
  try {
    release = lock(join(loadDir, "results", "matrix.lock")); // load/results is gitignored
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 4;
  }
  const { connect } = await import("./store-a.ts");
  const sql = connect(url);
  try {
    mkdirSync(out, { recursive: true });
    const rel = relative(repo, out);

    // A half-written configuration from an interrupted session runs again from scratch.
    const done = completed(out);
    for (const d of readdirSync(out, { withFileTypes: true })) {
      if (d.isDirectory() && !done.has(d.name)) rmSync(join(out, d.name), { recursive: true, force: true });
    }
    // Results that were finished but not committed or pushed when the session stopped.
    publish(repo, [rel], `load(matrix): results left by an interrupted session (#11)${trailer}`, push);

    const machinePath = join(out, "machine.json");
    const machine = await describeMachine(sql, loadDir);
    if (existsSync(machinePath)) {
      const diff = machineDiff(JSON.parse(readFileSync(machinePath, "utf8")) as Machine, machine);
      if (diff.length > 0 && process.env.MATRIX_ALLOW_MACHINE_CHANGE !== "1") {
        console.error(`machine.json describes another machine (${diff.join(", ")} differ): every matrix run must use one environment.`);
        return 3;
      }
    } else {
      writeFileSync(machinePath, JSON.stringify(machine, null, 2) + "\n");
    }
    console.log(`machine: ${Object.entries(machine).map(([k, v]) => `${k} ${v}`).join("; ")}`);

    const todo = plan(spec).filter((c) => !done.has(c.id));
    console.log(`matrix: ${plan(spec).length} configurations, ${done.size} done, ${todo.length} to run${todo.length > limit ? `, ${limit} this time` : ""}`);
    for (const config of todo.slice(0, limit)) {
      const dir = join(out, config.id);
      const startedAt = new Date();
      console.log(`\n=== ${config.id}: store ${config.store}, ${config.users} users, run ${config.run}, schema ${config.schema}`);
      await sql`drop schema if exists ${sql(config.schema)} cascade`;
      const smoke = spawnSync(join(loadDir, "smoke.sh"), "SNAPSHOT_N" in config.env ? ["B", config.env.SNAPSHOT_N] : ["A"], {
        cwd: repo,
        stdio: "inherit",
        timeout: (warmupS + measureS + 900) * 1000,
        env: {
          ...process.env,
          STORE_SCHEMA: config.schema,
          USERS: String(config.users),
          RUN_TIME: `${warmupS + measureS}s`,
          WARMUP_S: String(warmupS),
          OUT: dir,
        },
      });
      if (smoke.status !== 0) {
        console.error(`${config.id} failed (${smoke.error?.message ?? `exit ${smoke.status ?? smoke.signal}`}); it reruns on the next start.`);
        return 1;
      }
      const finishedAt = new Date();
      writeFileSync(join(dir, DONE), JSON.stringify({
        ...config,
        warmupS,
        measureS,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        machine,
      }, null, 2) + "\n");
      publish(repo, [rel], `load(matrix): ${config.id} (#11)${trailer}`, push);
      console.log(`=== ${config.id} done in ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)} s, committed${push ? " and pushed" : ""}`);
    }
    return 0;
  } finally {
    await sql.end();
    release();
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
