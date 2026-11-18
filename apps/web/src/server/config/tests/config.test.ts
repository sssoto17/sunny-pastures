import { describe, expect, it } from "vitest";

import { readConfig } from "../index";

// Environment names are UPPER_SNAKE, an outside shape the naming rule doesn't allow as keys.
const envWith = (databaseUrl: string) => Object.fromEntries([["DATABASE_URL", databaseUrl]]);

describe("readConfig", () => {
	it("reads the database URL from the environment", () => {
		const config = readConfig(envWith("postgresql://db.test/farm"));

		expect(config).toEqual({ databaseUrl: "postgresql://db.test/farm" });
	});

	it("throws a config error that names a missing variable", () => {
		expect(() => readConfig({})).toThrow(/DATABASE_URL/);
	});

	it("treats an empty variable as missing", () => {
		expect(() => readConfig(envWith(""))).toThrow(/DATABASE_URL/);
	});
});
