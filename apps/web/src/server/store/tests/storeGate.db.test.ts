import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { sliceContent, stateHash, type Action, type FarmState } from "@sunny-pastures/sim";

import { createRules } from "@/server/rules";

import { createPlayer, readStack } from "../../db/tests/stack";
import { createStore } from "../index";

// The store half of ADR-0001's determinism gate (ADR-0007 section 6, "The store gate"; #383): the
// recorded script plays through B100 on the local stack with the real rules, and the farm B100
// loads back must be the farm the sim computed in memory, ending on the recorded hash (Golden
// master). `ci / determinism` plays the same script through the sim alone, with no stack, and this
// test checks the in-memory farm's hash on its own first, so if both are green up to there and a
// load is red, the store (or the rules' `replay`, which loads run through) is at fault. This file
// reads the script and its hash, and writes neither: `determinism-gate.mjs --record` and
// `--update` own them.

/** A recorded script, as `packages/sim/src/sim/tests/playScript.ts` reads it. */
interface Script {
	readonly farmId: string;
	readonly steps: readonly { readonly action: Action; readonly at: number }[];
}

// Read from the sim's tests/ as files, not imported from playScript.ts: a module's tests reach
// another module only through its entry (docs/agents/code-style.md, "Tests"), the sim's test
// helpers aren't part of its package entry, and a file read can't write back. `Script` repeats
// playScript.ts's type.
const simTests = new URL("../../../../../../packages/sim/src/sim/tests/", import.meta.url);
const script = JSON.parse(
	readFileSync(new URL("determinismScript.json", simTests), "utf8"),
) as Script;
const recordedHash = readFileSync(new URL("determinismScript.hash", simTests), "utf8").trim();

const db = drizzle(postgres(readStack().databaseUrl));

afterAll(async () => {
	await db.$client.end();
});

const rules = createRules(sliceContent);

/** B100's snapshot interval (ADR-0001), where `load` starts from a snapshot instead of seq 0. */
const snapshotEvery = 100;

/** The wait the sim gate requires the script to hold (determinism-gate.mjs): 8 hours. */
const gapMs = 8 * 60 * 60 * 1_000;

/** Enough for some 500 commits and a few loads, each a round trip to the stack. */
const gateTimeout = 120_000;

describe("the store gate (B100 with the slice's rules)", () => {
	it(
		"loads back the farm the sim computed, at every snapshot, after the 8-hour gap and at the end, ending on the recorded hash",
		async () => {
			const playerId = await createPlayer();
			// Seeded from the script's id, not the player's (which production uses, MUST-10.3): the
			// recorded hash is for the script's farm, and the player id is only the uuid B100's
			// foreign key needs. This `newFarm` ignores the id the store hands it; the contract
			// suite checks that the store hands it the farm's id.
			const store = createStore({
				db,
				newFarm: () => rules.newFarm(script.farmId),
				replay: rules.replay,
			});
			const afterGap = findGap(script.steps);
			expect(afterGap, "the step after the 8-hour gap").toBeGreaterThan(0);
			let farm = rules.newFarm(script.farmId);
			let seq = 0;
			let at = 0;
			let isGapChecked = false;
			let refused = 0;
			const checked: string[] = [];

			async function expectLoaded(when: string): Promise<FarmState> {
				checked.push(when);
				const loaded = await store.load(playerId);
				expect(loaded, `load() ${when}`).toStrictEqual({ state: farm, seq, at });
				return loaded.state;
			}

			for (const [i, step] of script.steps.entries()) {
				// Offered to the rules as the game loop would; a refused step is never committed.
				const result = rules.sim.apply(farm, step.action, step.at);
				if (!result.ok) {
					refused++;
					continue;
				}

				const next: FarmState = result.state;
				const committed = await store.commit(playerId, {
					expectedSeq: seq,
					action: step.action,
					at: step.at,
					idempotencyKey: crypto.randomUUID(),
					next,
					answer: { seq: seq + 1, hash: stateHash(next), rebased: false, retries: 0 },
				});
				expect(committed, `commit of step ${String(i)}`).toEqual({
					kind: "committed",
					seq: seq + 1,
				});
				[farm, seq, at] = [next, seq + 1, step.at];

				// Before the first snapshot, a load is the new farm plus a replay of every row.
				if (seq === 1 || seq === snapshotEvery - 1) await expectLoaded(`at seq ${String(seq)}`);
				if (seq % snapshotEvery === 0) await expectLoaded(`at snapshot seq ${String(seq)}`);
				if (i >= afterGap && !isGapChecked) {
					isGapChecked = true;
					await expectLoaded(`after the 8-hour gap, at seq ${String(seq)}`);
				}
			}
			// The sim's half first: the farm computed in memory is the recorded one, so a red load
			// below isn't the sim's (ci / determinism checks the same in two processes).
			expect(stateHash(farm), "the in-memory farm's hash").toBe(recordedHash);
			expect({ accepted: seq, refused }).toEqual({ accepted: 475, refused: 25 });
			const end = await expectLoaded(`at the end, at seq ${String(seq)}`);

			// What the gate covered, so a script re-recorded short of a snapshot or a gap can't pass
			// it quietly: from a new farm, four snapshots and the gap, as recorded on 21 Nov 2026.
			expect(checked).toEqual([
				"at seq 1",
				"at seq 99",
				"at snapshot seq 100",
				"at snapshot seq 200",
				expect.stringMatching(/^after the 8-hour gap/u),
				"at snapshot seq 300",
				"at snapshot seq 400",
				expect.stringMatching(/^at the end/u),
			]);
			expect(stateHash(end), "the loaded farm's hash").toBe(recordedHash);
		},
		gateTimeout,
	);
});

/** The index of the first step sent 8 hours or more after the one before it, or -1. */
function findGap(steps: Script["steps"]): number {
	return steps.findIndex((step, i) => i > 0 && step.at - (steps[i - 1]?.at ?? step.at) >= gapMs);
}
