import { describe, expect, it } from "vitest";

import { createSim, sliceContent, stateHash } from "../../index.js";
import { plantWheat } from "./plantWheat.js";

const sim = createSim(sliceContent);
const growMs = sliceContent.crops.wheat.growSeconds * 1000;

describe("ripening", () => {
	it("happens exactly the grow time after planting, as an automated step (MUST-01.2)", () => {
		const farm = plantWheat(sim, "farm-1", 1_000);

		expect(sim.advance(farm, 1_000 + growMs - 1).plots[0]?.status).toBe("growing");
		expect(sim.advance(farm, 1_000 + growMs).plots[0]).toEqual({ status: "ready", crop: "wheat" });
	});

	it("survives times beyond 2^31 ms unchanged (D7, ADR-0003 section 10)", () => {
		const plantedAt = 2 ** 31 + 7;
		const to = 2 ** 33;
		const farm = sim.advance(plantWheat(sim, "farm-1", plantedAt), to);

		expect(farm.time).toBe(to);
		expect(farm.plots[0]).toEqual({ status: "ready", crop: "wheat" });
		expect(stateHash(farm)).toBe(stateHash(JSON.parse(JSON.stringify(farm))));
		expect(sim.advance(farm, to)).toBe(farm);
	});
});
