import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@sunny-pastures/sim";

import type { FarmEnvelope } from "@/contract";

import {
	createFarmStore,
	selectCoins,
	selectFacility,
	selectLevel,
	selectLevelProgress,
	selectOrders,
	selectPen,
	selectPlot,
	selectStorage,
	type FarmStore,
} from "../index";
import { accept, createFakeApi, failure, newEnvelope, type FakeApi } from "./fakeApi";

const start = 1_000_000;
const plant0: Action = { type: "plant", plot: 0, crop: "wheat" };
const plant1: Action = { type: "plant", plot: 1, crop: "wheat" };

let fake: FakeApi;
let store: ReturnType<typeof createFarmStore>;

beforeEach(() => {
	vi.useFakeTimers({ now: start });
	fake = createFakeApi();
	store = createFarmStore({ api: fake.api });
});

afterEach(() => {
	store.getState().stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const state = (): FarmStore => store.getState();

/** Keeps what the store logs out of the test output, and returns it to assert on. */
function catchErrorLogs(): unknown[][] {
	const logged: unknown[][] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		logged.push(args);
	});
	return logged;
}

async function loadReady(envelope = newEnvelope(start)) {
	const loading = state().load();
	await fake.loads[0]?.answer({ ok: true, farm: envelope });
	await loading;
	return envelope;
}

describe("load", () => {
	it("starts loading, then holds the confirmed farm, advanced to now", async () => {
		expect(state().status).toBe("loading");
		const envelope = await loadReady();
		expect(state()).toMatchObject({ status: "ready", confirmed: envelope, now: start });
		expect(selectCoins(state())).toBe(50);
	});

	it("advances a farm loaded after time away to now, with no extra request", async () => {
		const before = newEnvelope(start - 600_000);
		const planted = accept(before, plant0, start - 600_000);
		if (!planted.ok) throw new Error("unreachable");

		await loadReady(planted.farm);
		expect(selectPlot(0)(state())).toEqual({ status: "ready", crop: "wheat" });
		expect(fake.loads).toHaveLength(1);
		expect(fake.sends).toHaveLength(0);
	});

	it("never sets now before the farm's time (MUST-11.3)", async () => {
		await loadReady(newEnvelope(start + 5_000));
		expect(state().now).toBe(start + 5_000);
		vi.advanceTimersByTime(1_000);
		expect(state().now).toBe(start + 5_000);
	});

	it("ticks now every second", async () => {
		await loadReady();
		vi.advanceTimersByTime(1_000);
		expect(state().now).toBe(start + 1_000);
		vi.advanceTimersByTime(2_000);
		expect(state().now).toBe(start + 3_000);
	});

	it("keeps one clock tick when two loads overlap", async () => {
		const first = state().load();
		const second = state().load();
		await fake.loads[0]?.answer({ ok: true, farm: newEnvelope(start) });
		await fake.loads[1]?.answer({ ok: true, farm: newEnvelope(start) });
		await Promise.all([first, second]);
		state().stop();
		vi.advanceTimersByTime(5_000);
		expect(state().now).toBe(start);
	});

	it("sets the error status when the farm can't load", async () => {
		const loading = state().load();
		await fake.loads[0]?.answer(failure("network"));
		await loading;
		expect(state()).toMatchObject({ status: "error", error: "The server said network." });
	});

	it("resolves with the error status when loading throws, and logs what was thrown (#684)", async () => {
		const logged = catchErrorLogs();
		const thrown = new Error("Sign-in broke.");
		const failing = createFarmStore({
			api: { ...fake.api, loadFarm: () => Promise.reject(thrown) },
		});

		await expect(failing.getState().load()).resolves.toBeUndefined();
		expect(failing.getState()).toMatchObject({
			status: "error",
			error: "Your farm could not be loaded. Please try again.",
		});
		expect(logged).toEqual([["The farm could not be loaded:", thrown]]);
	});

	it("resolves with the error status when the loaded farm can't be predicted (#684)", async () => {
		const logged = catchErrorLogs();
		const broken = { ...newEnvelope(start), state: undefined } as unknown as FarmEnvelope;

		const loading = state().load();
		await fake.loads[0]?.answer({ ok: true, farm: broken });
		await expect(loading).resolves.toBeUndefined();
		expect(state()).toMatchObject({
			status: "error",
			error: "Your farm could not be loaded. Please try again.",
		});
		expect(logged).toHaveLength(1);
	});

	it("asks for a reload when the rules version differs", async () => {
		await loadReady(newEnvelope(start, 2));
		expect(state().status).toBe("error");
		expect(state().error).toMatch(/reload to update/i);
		expect(state().predicted).toBeNull();
		vi.advanceTimersByTime(5_000);
		expect(state().now).toBe(0);
	});
});

describe("act", () => {
	it("shows the prediction before the server answers", async () => {
		await loadReady();
		state().act(plant0);
		expect(selectPlot(0)(state())).toMatchObject({ status: "growing", crop: "wheat" });
		expect(selectCoins(state())).toBe(48);
		expect(state().pending).toHaveLength(1);
		expect(fake.sends).toHaveLength(1);
		expect(fake.sends[0]?.request).toEqual({
			action: plant0,
			expectedSeq: 0,
			idempotencyKey: state().pending[0]?.idempotencyKey,
		});
		expect(state().pending[0]?.at).toBe(start);
	});

	it("reconciles a success: the server's farm becomes confirmed", async () => {
		const envelope = await loadReady();
		state().act(plant0);
		const answer = accept(envelope, plant0, start + 40);
		await fake.sends[0]?.answer(answer);
		expect(state().pending).toEqual([]);
		expect(state().confirmed).toEqual(answer.ok ? answer.farm : null);
		expect(selectPlot(0)(state())).toEqual({
			status: "growing",
			crop: "wheat",
			readyAt: start + 40 + 120_000,
		});
	});

	it("rolls a 422 back and shows the sim's message", async () => {
		await loadReady();
		state().act(plant0);
		await fake.sends[0]?.answer({
			ok: false,
			error: "refused",
			message: "Plot 1 is not empty.",
			retryAfterMs: null,
		});
		expect(state().pending).toEqual([]);
		expect(selectPlot(0)(state())).toEqual({ status: "empty" });
		expect(selectCoins(state())).toBe(50);
		expect(state().lastRefusal).toBe("Plot 1 is not empty.");
	});

	it("never sends an action the local sim refuses", async () => {
		await loadReady();
		state().act({ type: "harvest", plot: 0 });
		expect(fake.sends).toHaveLength(0);
		expect(state().pending).toEqual([]);
		expect(state().lastRefusal).toMatch(/\.$/);
	});

	it("refuses an action before the farm has loaded", () => {
		state().act(plant0);
		expect(fake.sends).toHaveLength(0);
		expect(state().lastRefusal).toBe("The farm is still loading.");
	});

	it("clears the last refusal on the next accepted prediction", async () => {
		await loadReady();
		state().act({ type: "harvest", plot: 0 });
		state().act(plant0);
		expect(state().lastRefusal).toBeNull();
	});

	it("retries with the same key after retryAfterMs, or 1 s", async () => {
		const envelope = await loadReady();
		state().act(plant0);
		await fake.sends[0]?.answer(failure("busy", 2_000));
		await vi.advanceTimersByTimeAsync(1_999);
		expect(fake.sends).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.sends).toHaveLength(2);
		await fake.sends[1]?.answer(failure("network"));
		await vi.advanceTimersByTimeAsync(1_000);
		await fake.sends[2]?.answer(failure("internal"));
		await vi.advanceTimersByTimeAsync(1_000);
		await fake.sends[3]?.answer(accept(envelope, plant0, start));
		const keys = new Set(fake.sends.map((call) => call.request.idempotencyKey));
		expect(fake.sends).toHaveLength(4);
		expect(keys.size).toBe(1);
		expect(state().pending).toEqual([]);
		expect(state().confirmed?.seq).toBe(1);
	});

	it("waits 1 s before a retry when the server gives no time", async () => {
		await loadReady();
		state().act(plant0);
		await fake.sends[0]?.answer(failure("network"));
		await vi.advanceTimersByTimeAsync(999);
		expect(fake.sends).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.sends[1]?.request.idempotencyKey).toBe(fake.sends[0]?.request.idempotencyKey);
	});

	it("retries a rate-limited action with the same key", async () => {
		await loadReady();
		state().act(plant0);
		await fake.sends[0]?.answer(failure("rate_limited", 3_000));
		await vi.advanceTimersByTimeAsync(3_000);
		expect(fake.sends).toHaveLength(2);
		expect(fake.sends[1]?.request.idempotencyKey).toBe(fake.sends[0]?.request.idempotencyKey);
		expect(state().pending).toHaveLength(1);
	});

	it("drops the action after 3 retries and says so in a sentence", async () => {
		await loadReady();
		state().act(plant0);
		for (let i = 0; i < 4; i++) {
			await fake.sends[i]?.answer(failure("busy"));
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(fake.sends).toHaveLength(4);
		expect(state().pending).toEqual([]);
		expect(selectPlot(0)(state())).toEqual({ status: "empty" });
		expect(state().lastRefusal).toMatch(/^The game server .+\.$/);
	});

	it("drops an action the server can't take, with the server's message", async () => {
		await loadReady();
		state().act(plant0);
		await fake.sends[0]?.answer(failure("bad_request"));
		expect(fake.sends).toHaveLength(1);
		expect(state().pending).toEqual([]);
		expect(state().lastRefusal).toBe("The server said bad_request.");
	});

	it("reconciles two quick actions in order", async () => {
		const envelope = await loadReady();
		state().act(plant0);
		state().act(plant1);
		expect(selectCoins(state())).toBe(46);
		expect(fake.sends).toHaveLength(1);

		const first = accept(envelope, plant0, start + 10);
		await fake.sends[0]?.answer(first);
		if (!first.ok) throw new Error("unreachable");

		expect(state().pending.map((pending) => pending.action)).toEqual([plant1]);
		expect(selectPlot(1)(state())).toMatchObject({ status: "growing" });
		expect(fake.sends[1]?.request).toMatchObject({ action: plant1, expectedSeq: 1 });

		await fake.sends[1]?.answer(accept(first.farm, plant1, start + 20));
		expect(state().pending).toEqual([]);
		expect(state().confirmed?.seq).toBe(2);
		expect(selectCoins(state())).toBe(46);
		expect(fake.sends).toHaveLength(2);
	});

	it("rolls back a refused first action under a later prediction", async () => {
		const envelope = await loadReady();
		state().act(plant0);
		state().act(plant1);
		await fake.sends[0]?.answer(failure("refused"));
		expect(state().pending.map((pending) => pending.action)).toEqual([plant1]);
		expect(selectPlot(0)(state())).toEqual({ status: "empty" });
		expect(selectPlot(1)(state())).toMatchObject({ status: "growing" });
		expect(selectCoins(state())).toBe(48);
		expect(fake.sends[1]?.request).toMatchObject({ action: plant1, expectedSeq: 0 });
		await fake.sends[1]?.answer(accept(envelope, plant1, start));
		expect(state().pending).toEqual([]);
	});

	it("asks for a reload when an answer's rules version differs", async () => {
		await loadReady();
		state().act(plant0);
		const answer = accept(newEnvelope(start, 2), plant0, start);
		await fake.sends[0]?.answer(answer);
		expect(state().status).toBe("error");
		expect(state().error).toMatch(/reload to update/i);
		state().act(plant1);
		expect(fake.sends).toHaveLength(1);
		expect(state().lastRefusal).toMatch(/reload to update/i);
	});
});

describe("the clock", () => {
	it("advances a growing crop to ready", async () => {
		const envelope = await loadReady();
		state().act(plant0);
		await fake.sends[0]?.answer(accept(envelope, plant0, start));
		vi.advanceTimersByTime(119_000);
		expect(selectPlot(0)(state())).toMatchObject({ status: "growing" });
		vi.advanceTimersByTime(1_000);
		expect(selectPlot(0)(state())).toEqual({ status: "ready", crop: "wheat" });
	});
});

describe("selectors", () => {
	it("read nothing before the farm loads", () => {
		const loading = state();
		expect(selectCoins(loading)).toBeNull();
		expect(selectLevel(loading)).toBeNull();
		expect(selectStorage(loading)).toBeNull();
		expect(selectLevelProgress(loading)).toBeNull();
		expect(selectPlot(0)(loading)).toBeNull();
		expect(selectFacility(0)(loading)).toBeNull();
		expect(selectPen(0)(loading)).toBeNull();
		expect(selectOrders(loading)).toEqual([]);
	});

	it("read the predicted farm", async () => {
		const envelope = await loadReady();
		const farm = state().predicted;
		expect(selectLevel(state())).toBe(1);
		expect(selectStorage(state())).toEqual({
			silo: { goods: {}, used: 0, capacity: 50 },
			barn: { goods: envelope.state.barn, used: 0, capacity: 50 },
		});
		expect(selectPlot(99)(state())).toBeNull();
		expect(selectFacility(0)(state())).toBeNull();
		expect(selectPen(0)(state())).toBeNull();
		expect(selectOrders(state())).toBe(farm?.board);
		expect(farm?.board).toHaveLength(3);
	});

	it("give the same storage object until the farm changes", async () => {
		await loadReady();
		expect(selectStorage(state())).toBe(selectStorage(state()));
	});

	it("read the Level from XP", async () => {
		const envelope = newEnvelope(start);
		await loadReady({ ...envelope, state: { ...envelope.state, xp: 10 } });
		expect(selectLevel(state())).toBe(2);
	});

	it("read the XP toward the next Level, and give the same object while XP stays", async () => {
		const envelope = newEnvelope(start);
		await loadReady({ ...envelope, state: { ...envelope.state, xp: 15 } });
		// The slice's Level table: Level 2 at 10 XP, Level 3 at 30.
		expect(selectLevelProgress(state())).toEqual({
			level: 2,
			xp: 15,
			levelXp: 10,
			nextLevelXp: 30,
		});
		expect(selectLevelProgress(state())).toBe(selectLevelProgress({ ...state() }));
	});

	it("read no next Level at the top Level", async () => {
		const envelope = newEnvelope(start);
		await loadReady({ ...envelope, state: { ...envelope.state, xp: 140 } });
		expect(selectLevelProgress(state())).toEqual({
			level: 5,
			xp: 140,
			levelXp: 100,
			nextLevelXp: null,
		});
	});

	it("count the goods held in the silo and the barn", async () => {
		const envelope = newEnvelope(start);
		const farm = { ...envelope.state, silo: { wheat: 12 }, barn: { egg: 3, chickenFeed: 4 } };
		await loadReady({ ...envelope, state: farm });
		expect(selectStorage(state())?.silo.used).toBe(12);
		expect(selectStorage(state())?.barn.used).toBe(7);
	});
});

describe("stop", () => {
	it("stops the clock", async () => {
		await loadReady();
		state().stop();
		vi.advanceTimersByTime(5_000);
		expect(state().now).toBe(start);
	});
});
