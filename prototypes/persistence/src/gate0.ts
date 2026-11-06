// Gate step 0 (ADR-0001, issue #6): with no database, the sim must give one state hash whether
// the script runs straight through, runs again, or is replayed from in-memory snapshots the way
// store B would replay it. If this fails, the sim is at fault; if it passes and a store fails a
// later step, that store is.
//
// Run: pnpm --filter @sunny-pastures/persistence-spike gate:0 [seed]

import { generateScript, type Script } from "./script.ts";
import { apply, newFarm, stateHash, type Action, type FarmState } from "./sim.ts";

/** The parts of the sim the gate exercises; a test can swap in a broken one. */
export type Rules = { newFarm: (seed: number) => FarmState; apply: typeof apply };

export const SNAPSHOT_INTERVALS = [1, 25, 100] as const;
export const DEFAULT_SEED = 42;

export type Gate0Result = {
  pass: boolean;
  runs: { label: string; hash: string }[];
  /** Why it failed, beyond a hash mismatch. */
  problems: string[];
  scriptHash: string;
  accepted: number;
  refused: number;
};

/** An accepted action, as store B's log would hold it. */
type LogEntry = { seq: number; action: Action; at: number };

export function runGate0(script: Script, rules: Rules = { newFarm, apply }): Gate0Result {
  const problems: string[] = [];
  const first = play(script, rules);
  const second = play(script, rules);
  const runs = [
    { label: "run 1", hash: stateHash(first.state) },
    { label: "run 2", hash: stateHash(second.state) },
  ];
  for (const n of SNAPSHOT_INTERVALS) {
    const replay = replayFromSnapshots(script, rules, n);
    runs.push({ label: `replay N=${n}`, hash: replay.hash });
    problems.push(...replay.problems);
  }
  const pass = problems.length === 0 && runs.every((r) => r.hash === runs[0]!.hash);
  return {
    pass,
    runs,
    problems,
    scriptHash: stateHash(script),
    accepted: first.log.length,
    refused: script.steps.length - first.log.length,
  };
}

/** Runs the script from a new farm. A refused action leaves no trace; an accepted one is logged. */
function play(script: Script, rules: Rules, onCommit?: (seq: number, state: FarmState) => void) {
  let state = rules.newFarm(script.seed);
  const log: LogEntry[] = [];
  onCommit?.(0, state);
  for (const { action, at } of script.steps) {
    const result = rules.apply(state, action, at);
    if (!result.ok) continue;
    state = result.state;
    log.push({ seq: log.length + 1, action, at });
    onCommit?.(log.length, state);
  }
  return { state, log };
}

/**
 * Plays the script once, keeping a snapshot after every `n`th action (and the new farm at seq 0)
 * as JSON, the way a database would hold it. Then rebuilds the final farm from every snapshot by
 * replaying the log after it. Every rebuild must agree; the hash reported is the one from the
 * latest snapshot, which is what store B's `load` would use.
 */
function replayFromSnapshots(script: Script, rules: Rules, n: number) {
  const snapshots = new Map<number, string>();
  const { log } = play(script, rules, (seq, state) => {
    if (seq % n === 0) snapshots.set(seq, JSON.stringify(state));
  });

  const problems: string[] = [];
  const hashes = new Map<number, string>();
  for (const [from, json] of snapshots) {
    let state = JSON.parse(json) as FarmState;
    for (const entry of log.slice(from)) {
      const result = rules.apply(state, entry.action, entry.at);
      if (!result.ok) {
        problems.push(`N=${n}: replay from seq ${from} refused seq ${entry.seq}: ${result.reason}`);
        break;
      }
      state = result.state;
    }
    hashes.set(from, stateHash(state));
  }

  const latest = Math.max(...snapshots.keys());
  const hash = hashes.get(latest)!;
  const disagree = [...hashes].filter(([, h]) => h !== hash).map(([seq]) => seq);
  if (disagree.length > 0) {
    problems.push(`N=${n}: replay from seq ${disagree.join(", ")} disagrees with replay from seq ${latest}`);
  }
  return { hash, problems };
}

export function report(result: Gate0Result, seed: number): string {
  const lines = [
    "Gate step 0 (ADR-0001): in-memory determinism, no database",
    `script: seed ${seed}, ${result.accepted + result.refused} actions ` +
      `(${result.accepted} accepted, ${result.refused} refused), script hash ${result.scriptHash}`,
    "",
    ...result.runs.map((r) => `${r.label.padEnd(14)} ${r.hash}`),
    ...result.problems.map((p) => `problem: ${p}`),
    "",
    result.pass ? "PASS: every run gives the same state hash" : "FAIL: the sim is not deterministic",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const seed = process.argv[2] === undefined ? DEFAULT_SEED : Number(process.argv[2]);
  if (!Number.isSafeInteger(seed)) {
    console.error(`seed must be an integer, got ${process.argv[2]}`);
    process.exit(2);
  }
  const result = runGate0(generateScript(seed));
  console.log(report(result, seed));
  process.exitCode = result.pass ? 0 : 1;
}
