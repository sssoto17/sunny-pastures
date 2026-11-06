// The imperative shell (ADR-0001): the handler owns load → advance → apply → commit and all I/O;
// the sim stays pure and the store never runs it. Transport-free so it can be tested without HTTP.

import { advance, apply, stateHash, type Action, type FarmState } from "./sim.ts";
import type { Answer, GameStore } from "./store.ts";

/** Server time in integer ms. */
export type Clock = () => number;

export const MAX_RETRIES = 3;

export type Reply<B> = { status: number; body: B };
type ErrorBody = { error: string };

export async function handleRead(
  store: GameStore,
  now: Clock,
  farmId: string,
): Promise<Reply<{ seq: number; hash: string; state: FarmState }>> {
  const record = await store.load(farmId);
  const state = advance(record.state, Math.max(now(), record.at));
  return { status: 200, body: { seq: record.seq, hash: stateHash(state), state } };
}

export async function handleAction(
  store: GameStore,
  now: Clock,
  farmId: string,
  body: unknown,
): Promise<Reply<Answer> | Reply<ErrorBody>> {
  const request = parseActionRequest(body);
  if (typeof request === "string") return { status: 400, body: { error: request } };
  const { action, expectedSeq, idempotencyKey } = request;

  // Before the sim: a resent action may no longer be valid, but it must get its first answer.
  const first = await store.processed(farmId, idempotencyKey);
  if (first) return { status: 200, body: first };

  for (let retries = 0; retries <= MAX_RETRIES; retries++) {
    const record = await store.load(farmId);
    // The farm's time never runs backwards, even if this instance's clock is behind.
    const at = Math.max(now(), record.at);
    const result = apply(advance(record.state, at), action, at);
    if (!result.ok) return { status: 422, body: { error: result.reason } };

    const answer: Answer = {
      seq: record.seq + 1,
      hash: stateHash(result.state),
      rebased: record.seq !== expectedSeq,
      retries,
    };
    const outcome = await store.commit(farmId, {
      expectedSeq: record.seq, action, at, idempotencyKey, next: result.state, answer,
    });
    if (outcome.kind === "committed") return { status: 200, body: answer };
    if (outcome.kind === "duplicate") return { status: 200, body: outcome.answer };
  }
  return { status: 503, body: { error: `farm ${farmId} stayed busy after ${MAX_RETRIES} retries` } };
}

type ActionRequest = { action: Action; expectedSeq: number; idempotencyKey: string };

/** Returns the request, or a reason it is malformed. */
function parseActionRequest(body: unknown): ActionRequest | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { action, expectedSeq, idempotencyKey } = body as Record<string, unknown>;
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") return "idempotencyKey must be a non-empty string";
  if (!Number.isSafeInteger(expectedSeq) || (expectedSeq as number) < 0) return "expectedSeq must be a non-negative integer";
  if (typeof action !== "object" || action === null) return "action must be an object";
  const { type, plot } = action as Record<string, unknown>;
  if (type !== "plant" && type !== "harvest") return "action.type must be plant or harvest";
  if (!Number.isSafeInteger(plot)) return "action.plot must be an integer";
  return { action: { type, plot: plot as number }, expectedSeq: expectedSeq as number, idempotencyKey };
}
