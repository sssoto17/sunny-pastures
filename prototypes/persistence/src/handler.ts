// The imperative shell (ADR-0001): the handler owns load → advance → apply → commit and all I/O;
// the sim stays pure and the store never runs it. Transport-free so it can be tested without HTTP.

import { advance, apply, stateHash, type Action, type FarmState } from "./sim.ts";
import type { Answer, AuditableStore, GameStore } from "./store.ts";

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

/** The audit read: the farm as it was at server time `t` (integer ms, from the URL). */
export async function handleStateAt(
  store: GameStore,
  farmId: string,
  t: string,
): Promise<Reply<{ at: number; hash: string; state: FarmState }> | Reply<ErrorBody>> {
  if (!isAuditable(store)) return { status: 501, body: { error: "this store keeps no history (stateAt is B only)" } };
  const at = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isSafeInteger(at)) return { status: 400, body: { error: "t must be non-negative integer ms" } };
  const state = await store.stateAt(farmId, at);
  return { status: 200, body: { at, hash: stateHash(state), state } };
}

function isAuditable(store: GameStore): store is AuditableStore {
  return typeof (store as Partial<AuditableStore>).stateAt === "function";
}

export async function handleAction(
  store: GameStore,
  now: Clock,
  farmId: string,
  body: unknown,
): Promise<Reply<Answer> | Reply<ErrorBody>> {
  const request = parseActionRequest(body);
  if (typeof request === "string") return { status: 400, body: { error: request } };
  const { action: requested, expectedSeq, idempotencyKey } = request;

  // Before the sim: a resent action may no longer be valid, but it must get its first answer.
  const first = await store.processed(farmId, idempotencyKey);
  if (first) return { status: 200, body: first };

  // A resend can race its own first commit: `processed` ran just before that commit and found
  // nothing, but `load` ran after it, so the rules now refuse the action. Asking again before a
  // 422 gives such a resend its first answer, at the cost of one query on refusals only.
  const refuse = async (reason: string): Promise<Reply<Answer> | Reply<ErrorBody>> => {
    const answered = await store.processed(farmId, idempotencyKey);
    return answered ? { status: 200, body: answered } : { status: 422, body: { error: reason } };
  };

  // A claim's goods never come from the client: the server fills them from the inbox, so the
  // action that is applied and logged carries them and replay never reads another farm (#8).
  let action: Action;
  if (requested.type === "claimGift") {
    const gift = await store.gift(requested.giftId);
    if (!gift) return refuse(`no gift ${requested.giftId}`);
    if (gift.to !== farmId) return refuse(`gift ${gift.id} is not for ${farmId}`);
    if (gift.claimedAt !== null) return refuse(`gift ${gift.id} is already claimed`);
    action = { ...requested, goods: gift.goods };
  } else {
    action = requested;
  }

  for (let retries = 0; retries <= MAX_RETRIES; retries++) {
    const record = await store.load(farmId);
    // The farm's time never runs backwards, even if this instance's clock is behind.
    const at = Math.max(now(), record.at);
    const result = apply(advance(record.state, at), action, at);
    if (!result.ok) return refuse(result.reason);

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
    // The inbox refused the send or claim (a self-gift, or a gift claimed since we looked).
    if (outcome.kind === "refused") return refuse(outcome.reason);
  }
  return { status: 503, body: { error: `farm ${farmId} stayed busy after ${MAX_RETRIES} retries` } };
}

/** An action as the client may send it: a claim names its gift but never its goods. */
export type RequestedAction = Exclude<Action, { type: "claimGift" }> | { type: "claimGift"; giftId: string };

type ActionRequest = { action: RequestedAction; expectedSeq: number; idempotencyKey: string };

/** Farm ids, as the server's routes accept them; a gift's `to` must be one. */
const FARM_ID = /^[\w-]{1,64}$/;

/** Returns the request, or a reason it is malformed. */
function parseActionRequest(body: unknown): ActionRequest | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { action, expectedSeq, idempotencyKey } = body as Record<string, unknown>;
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") return "idempotencyKey must be a non-empty string";
  if (!Number.isSafeInteger(expectedSeq) || (expectedSeq as number) < 0) return "expectedSeq must be a non-negative integer";
  const parsed = parseAction(action);
  if (typeof parsed === "string") return parsed;
  return { action: parsed, expectedSeq: expectedSeq as number, idempotencyKey };
}

/**
 * Checks the shape only and copies just the known fields, so nothing else reaches the log. Whether
 * the rules accept the action (amounts, plot state) is the sim's call: a 422, not a 400.
 */
function parseAction(action: unknown): RequestedAction | string {
  if (typeof action !== "object" || action === null) return "action must be an object";
  const a = action as Record<string, unknown>;
  switch (a.type) {
    case "plant":
    case "harvest":
      if (!Number.isSafeInteger(a.plot)) return "action.plot must be an integer";
      return { type: a.type, plot: a.plot as number };
    case "bake":
    case "collect":
      return { type: a.type };
    case "sendGift": {
      if (typeof a.to !== "string" || !FARM_ID.test(a.to)) return "action.to must be a farm id";
      if (typeof a.goods !== "object" || a.goods === null) return "action.goods must be an object";
      const { wheat, bread } = a.goods as Record<string, unknown>;
      if (typeof wheat !== "number" || typeof bread !== "number") return "action.goods needs wheat and bread as numbers";
      return { type: "sendGift", to: a.to, goods: { wheat, bread } };
    }
    case "claimGift":
      if (typeof a.giftId !== "string" || a.giftId === "") return "action.giftId must be a non-empty string";
      if ("goods" in a) return "a claim names its gift only; the server fills its goods";
      return { type: "claimGift", giftId: a.giftId };
    default:
      return "action.type must be plant, harvest, bake, collect, sendGift or claimGift";
  }
}
