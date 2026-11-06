// Request timings for the load runs (#10): where a request's server time goes, split into load
// (store reads: load, processed, gift, stateAt; B's replay is part of load), commit (store writes) and
// sim (the rest of the handler: advance, apply, hashing, parsing). Sent as Server-Timing and
// written to the server's CSV.
//
// Pattern: Decorator. `timed(store)` wraps a GameStore and adds up how long its calls take, so
// neither the handler nor the stores know they are measured. Alternatives considered: timing
// calls inside the handler (it would grow a timer parameter and mix measurement into the loop
// #8 is changing), and timing inside each store (four copies, and B's replay hidden from A's).

import { createWriteStream } from "node:fs";
import type { GameStore } from "./store.ts";

export type Timings = { loadMs: number; commitMs: number };

/** A per-request view of `store` that adds each call's duration to `timings`. */
export function timed(store: GameStore): { store: GameStore; timings: Timings } {
  const timings: Timings = { loadMs: 0, commitMs: 0 };
  const measure = <T>(bucket: keyof Timings, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    return run().finally(() => {
      timings[bucket] += performance.now() - start;
    });
  };
  const view: GameStore & { stateAt?: (id: string, t: number) => Promise<unknown> } = {
    load: (id) => measure("loadMs", () => store.load(id)),
    processed: (id, key) => measure("loadMs", () => store.processed(id, key)),
    commit: (id, entry) => measure("commitMs", () => store.commit(id, entry)),
    gift: (giftId) => measure("loadMs", () => store.gift(giftId)),
  };
  // Only an auditable store gets stateAt, so the handler's 501 on A still works.
  const auditable = store as GameStore & { stateAt?: (id: string, t: number) => Promise<unknown> };
  if (typeof auditable.stateAt === "function") {
    const stateAt = auditable.stateAt.bind(store);
    view.stateAt = (id, t) => measure("loadMs", () => stateAt(id, t));
  }
  return { store: view, timings };
}

export type TimingRow = {
  /** Wall-clock ms when the response was sent (not the offset clock). */
  t: number;
  store: string;
  method: string;
  /** read, action, stateAt, seed, storage or none. */
  route: string;
  farm: string;
  status: number;
  loadMs: number;
  simMs: number;
  commitMs: number;
  totalMs: number;
  /** The answer's retries for an accepted action, otherwise null. */
  retries: number | null;
  offsetMs: number;
};

/** Microsecond precision is plenty, and keeps the header and the CSV identical. */
export const round = (ms: number): number => Math.round(ms * 1000) / 1000;

export function serverTimingHeader(row: TimingRow): string {
  return `load;dur=${row.loadMs}, sim;dur=${row.simMs}, commit;dur=${row.commitMs}, total;dur=${row.totalMs}`;
}

const COLUMNS = [
  "t", "store", "method", "route", "farm", "status",
  "loadMs", "simMs", "commitMs", "totalMs", "retries", "offsetMs",
] as const satisfies readonly (keyof TimingRow)[];

export const CSV_HEADER = `${COLUMNS.join(",")}\n`;

export function csvLine(row: TimingRow): string {
  // Farm ids match [\w-]+ and the other fields are fixed words or numbers: nothing to quote.
  return `${COLUMNS.map((c) => row[c] ?? "").join(",")}\n`;
}

/** Appends rows to `path` through a buffered stream, so a request never waits on the disk. */
export function csvSink(path: string): { write: (row: TimingRow) => void; close: () => Promise<void> } {
  const out = createWriteStream(path, { flags: "w" });
  out.write(CSV_HEADER);
  return {
    write: (row) => void out.write(csvLine(row)),
    close: () => new Promise((resolve) => out.end(resolve)),
  };
}
