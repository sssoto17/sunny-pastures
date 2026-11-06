// The store contract from ADR-0001 ("Store interface"), with the spike's idempotency amendment:
// `processed` lets the handler find a repeated key before it runs the sim, and the store keeps
// the whole first answer so a duplicate returns it unchanged. (Admin decision, 2026-11-06.)

import type { Action, FarmState } from "./sim.ts";

/** A farm as stored: the state after action `seq`, taken at `at`, not advanced. */
export type FarmRecord = { state: FarmState; seq: number; at: number };

/** What POST /farms/:id/actions answers for an accepted action. */
export type Answer = { seq: number; hash: string; rebased: boolean; retries: number };

export type CommitEntry = {
  /** The seq that was loaded; the commit writes expectedSeq + 1. */
  expectedSeq: number;
  action: Action;
  at: number;
  idempotencyKey: string;
  next: FarmState;
  /** Stored with the key, returned as-is when the key is seen again. */
  answer: Answer;
};

export type CommitResult =
  | { kind: "committed"; seq: number }
  | { kind: "duplicate"; answer: Answer }
  | { kind: "conflict" };

export interface GameStore {
  load(playerId: string): Promise<FarmRecord>;
  processed(playerId: string, idempotencyKey: string): Promise<Answer | null>;
  commit(playerId: string, entry: CommitEntry): Promise<CommitResult>;
}

/** A store that keeps history and can rebuild a farm at an earlier time (B only). */
export interface AuditableStore extends GameStore {
  /** The farm as it was at server time `t`: its actions up to `t`, then advanced to `t`. */
  stateAt(playerId: string, t: number): Promise<FarmState>;
}

/** The store loaded or met something it can't trust; never a simulation error. */
export class StoreError extends Error {
  override name = "StoreError";
}
