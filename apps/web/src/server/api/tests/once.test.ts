import { describe, expect, it, vi } from "vitest";

import { once } from "../once";

describe("once", () => {
	it("doesn't build until the first call", () => {
		const build = vi.fn(() => ({}));

		once(build);

		expect(build).not.toHaveBeenCalled();
	});

	it("builds on the first call and returns the same value after", () => {
		const build = vi.fn(() => ({}));
		const get = once(build);

		const first = get();

		expect(get()).toBe(first);
		expect(build).toHaveBeenCalledTimes(1);
	});

	it("builds again on the next call when a build throws", () => {
		const build = vi
			.fn<() => object>()
			.mockImplementationOnce(() => {
				throw new Error("Config error.");
			})
			.mockImplementation(() => ({}));
		const get = once(build);

		expect(get).toThrow("Config error.");
		expect(get()).toEqual({});
		expect(build).toHaveBeenCalledTimes(2);
	});
});
