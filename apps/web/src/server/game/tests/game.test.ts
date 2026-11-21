import { describe, expect, it } from "vitest";

import { sliceContent } from "@sunny-pastures/sim";

import type { PlayerId } from "@/server/auth";
import { createRules } from "@/server/rules";
import type { GameStore } from "@/server/store";
import { createMemoryStore } from "@/server/store/tests/memoryStore";
import { createTiming } from "@/server/timing";
import type { Timing } from "@/server/timing";

import { loadFarm, type GameDeps } from "../index";

const rules = createRules(sliceContent);

describe("loadFarm", () => {
	it("gives a player with no action a new farm at seq 0", async () => {
		const playerId = newPlayerId();

		expect(await loadFarm(makeDeps(), playerId)).toEqual({
			kind: "loaded",
			farm: { seq: 0, at: 0, state: rules.newFarm(playerId), rulesVersion: 1 },
		});
	});

	it("answers busy when the store throws, as on an unknown rules version (ADR-0006, section 8)", async () => {
		const error = storeError();
		const store = { ...newStore(), load: () => Promise.reject(error) };

		expect(await loadFarm(makeDeps({ store }), newPlayerId())).toEqual({
			kind: "busy",
			cause: "store",
			error,
		});
	});
});

interface DepsOptions {
	readonly store?: GameStore;
	readonly serverTime?: () => number;
	readonly timing?: Timing;
}

function makeDeps({
	store = newStore(),
	serverTime = () => 1_000,
	timing = createTiming(),
}: DepsOptions = {}): GameDeps {
	return { store, rules, timing, serverTime };
}

/** The in-memory store on the slice's rules, with `conflicts` scripted (#383). */
function newStore(conflicts: readonly boolean[] = []): GameStore {
	return createMemoryStore({ newFarm: rules.newFarm, replay: rules.replay, conflicts });
}

/** What B100's `load` throws for a farm on rules the running code doesn't know (ADR-0006, s. 8). */
function storeError(): Error {
	return new Error("Store error: rules version 2 is unknown.");
}

/** A verified player's id: auth brands the token's `sub`, a UUID, which the stores require. */
function newPlayerId(): PlayerId {
	return crypto.randomUUID() as PlayerId;
}
