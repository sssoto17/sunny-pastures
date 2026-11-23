import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerId } from "@/server/auth";
import type { Rules } from "@/server/rules";

import { createMemoryStore } from "../../store/tests/memoryStore";
import { createApi, type Connector } from "../index";
import { buildGetRequest, buildPlantRequest, spyOnLog } from "./helpers";

const playerId = "0b5d1e7a-3c4f-4a2b-9e8d-7f6a5b4c3d2e" as PlayerId;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("createApi", () => {
	it("answers the health check once the graph is built", () => {
		expect(createApi(connectMemory().connect).health()).toEqual({ status: "ok" });
	});

	it("builds the connection once, on the first call that needs it, not once per request", async () => {
		const { connect, builds } = connectMemory();
		const api = createApi(connect);
		expect(builds).toHaveLength(0);

		await Promise.all([api.getFarm(buildGetRequest()), api.getFarm(buildGetRequest())]);
		api.health();

		expect(builds).toHaveLength(1);
	});

	it("builds the store with the rules' version, the one each response carries (#443)", async () => {
		const { connect, builds } = connectMemory();

		const response = await createApi(connect).getFarm(buildGetRequest());

		expect(response.status).toBe(200);
		expect(builds.map((rules) => rules.rulesVersion)).toEqual([
			Number(response.headers.get("Rules-Version")),
		]);
	});

	it("wires the game routes to the connection's player and store", async () => {
		const api = createApi(connectMemory().connect);

		const response = await api.getFarm(buildGetRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ farm: { seq: 0, at: 0 } });
	});

	it("stamps an action with the server's Date.now(), in ms (T1, MUST-11.1)", async () => {
		const now = 1_790_000_000_000;
		vi.useFakeTimers({ toFake: ["Date"], now });
		const api = createApi(connectMemory().connect);

		const response = await api.postAction(buildPlantRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ farm: { seq: 1, at: now } });
		// The store logged the action at that time: a fresh load reads it back.
		const loaded = await api.getFarm(buildGetRequest());
		expect(await loaded.json()).toMatchObject({ farm: { seq: 1, at: now } });
	});

	it("sends a store error to the server's log and answers 503 busy (ADR-0006, section 8)", async () => {
		const error = new Error("Store error: connection refused.");
		const logged = spyOnLog();
		const { connect } = connectMemory({ storeError: error });

		const response = await createApi(connect).getFarm(buildGetRequest());

		expect(response.status).toBe(503);
		expect(logged).toEqual([["Game API error:", error]]);
	});
});

interface MemoryOptions {
	readonly storeError?: Error;
}

/**
 * A connector over the in-memory store that the store contract holds to B100 (ADR-0007, section 6;
 * #470) and a fixed player, so these tests see the wiring and not postgres.js or the JWKS. `builds`
 * lists the rules each build received.
 */
function connectMemory(options: MemoryOptions = {}): { connect: Connector; builds: Rules[] } {
	const builds: Rules[] = [];
	const connect: Connector = (rules) => {
		builds.push(rules);
		const store = createMemoryStore({ newFarm: rules.newFarm, replay: rules.replay });
		if (options.storeError !== undefined) {
			vi.spyOn(store, "load").mockRejectedValue(options.storeError);
		}
		return {
			store,
			readPlayer: () => Promise.resolve({ ok: true, playerId }),
		};
	};
	return { connect, builds };
}
