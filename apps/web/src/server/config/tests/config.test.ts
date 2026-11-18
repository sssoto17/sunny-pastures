import { describe, expect, it } from "vitest";

import { readConfig } from "../index";
import { makeEnv } from "./env";

describe("readConfig", () => {
	it("reads the database URL from the environment", () => {
		const config = readConfig(makeEnv("postgresql://db.test/farm"));

		expect(config).toEqual({ databaseUrl: "postgresql://db.test/farm" });
	});

	it("throws a config error that names a missing variable", () => {
		expect(() => readConfig({})).toThrow(/DATABASE_URL/);
	});

	it("treats an empty variable as missing", () => {
		expect(() => readConfig(makeEnv(""))).toThrow(/DATABASE_URL/);
	});
});
