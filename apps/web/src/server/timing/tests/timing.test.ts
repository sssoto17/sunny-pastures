import { afterEach, describe, expect, it, vi } from "vitest";

import { createTiming } from "../index";

/** A clock that returns each reading in turn, in milliseconds. */
function fakeClock(...readings: number[]): () => number {
	return () => {
		const reading = readings.shift();
		if (reading === undefined) {
			throw new Error("The fake clock ran out of readings.");
		}

		return reading;
	};
}

describe("createTiming", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records one phase as name;dur=<ms>", () => {
		const timing = createTiming(fakeClock(10, 12.5));

		const value = timing.withTiming("load", () => "farm");

		expect(value).toBe("farm");
		expect(timing.serverTiming()).toBe("load;dur=2.5");
	});

	it("sums a phase that runs more than once under one name, as a retry does", () => {
		const timing = createTiming(fakeClock(0, 4, 10, 13));

		timing.withTiming("commit", () => null);
		timing.withTiming("commit", () => null);

		expect(timing.serverTiming()).toBe("commit;dur=7");
	});

	it("records a phase that throws, then rethrows its error", () => {
		const timing = createTiming(fakeClock(0, 6));
		const error = new Error("The store is down.");

		expect(() =>
			timing.withTiming("load", () => {
				throw error;
			}),
		).toThrow(error);
		expect(timing.serverTiming()).toBe("load;dur=6");
	});

	it("times an async phase until its promise settles", async () => {
		let now = 0;
		const timing = createTiming(() => now);

		const value = await timing.withTiming("load", async () => {
			await Promise.resolve();
			now = 9;
			return "farm";
		});

		expect(value).toBe("farm");
		expect(timing.serverTiming()).toBe("load;dur=9");
	});

	it("records an async phase that rejects, then rejects with its error", async () => {
		let now = 0;
		const timing = createTiming(() => now);
		const error = new Error("The commit conflicted.");

		const committing = timing.withTiming("commit", async () => {
			await Promise.resolve();
			now = 3;
			throw error;
		});

		await expect(committing).rejects.toBe(error);
		expect(timing.serverTiming()).toBe("commit;dur=3");
	});

	it("leaves out a phase that never ran, rather than sending it as 0", () => {
		const timing = createTiming(fakeClock(0, 1, 3, 4));

		timing.withTiming("total", () => timing.withTiming("load", () => null));

		expect(timing.serverTiming()).toBe("load;dur=2, total;dur=4");
	});

	it("sends a phase that ran in 0 ms, since it did run", () => {
		const timing = createTiming(fakeClock(5, 5));

		timing.withTiming("sim", () => null);

		expect(timing.serverTiming()).toBe("sim;dur=0");
	});

	it("lists the phases as load, sim, commit, total, whatever order they ran in", () => {
		const timing = createTiming(fakeClock(0, 1, 1, 3, 3, 6, 6, 10));

		timing.withTiming("total", () => null);
		timing.withTiming("commit", () => null);
		timing.withTiming("sim", () => null);
		timing.withTiming("load", () => null);

		expect(timing.serverTiming()).toBe("load;dur=4, sim;dur=3, commit;dur=2, total;dur=1");
	});

	it("renders null when no phase ran, so the caller sends no header", () => {
		expect(createTiming(fakeClock()).serverTiming()).toBeNull();
	});

	it("rounds a duration to the microsecond, as the spike's load runs did", () => {
		const timing = createTiming(fakeClock(0, 1.23456789));

		timing.withTiming("sim", () => null);

		expect(timing.serverTiming()).toBe("sim;dur=1.235");
	});

	it("reads the monotonic performance.now when no clock is passed", () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(108.5);
		const timing = createTiming();

		timing.withTiming("total", () => null);

		expect(timing.serverTiming()).toBe("total;dur=8.5");
	});
});
