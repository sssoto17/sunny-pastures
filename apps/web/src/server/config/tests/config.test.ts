import { describe, expect, it } from "vitest";

import { readConfig } from "../index";
import { makeEnv, testSupabase } from "./env";

describe("readConfig", () => {
	it("reads the database URL and the Supabase settings from the environment", () => {
		const config = readConfig(makeEnv("postgresql://db.test/farm"));

		expect(config).toEqual({
			databaseUrl: "postgresql://db.test/farm",
			supabaseUrl: "http://supabase.test",
			supabasePublishableKey: "publishable-key-for-tests",
		});
	});

	it("throws a config error that names a missing variable", () => {
		expect(() => readConfig({})).toThrow(/DATABASE_URL/);
	});

	it("treats an empty variable as missing", () => {
		expect(() => readConfig(makeEnv(""))).toThrow(/DATABASE_URL/);
	});

	it.each([["SUPABASE_URL"], ["SUPABASE_PUBLISHABLE_KEY"]])("requires %s", (name) => {
		const env = { ...makeEnv("postgresql://db.test/farm"), [name]: "" };

		expect(() => readConfig(env)).toThrow(name);
	});

	it("drops a trailing slash from the Supabase URL, so the token issuer it implies matches", () => {
		const env = makeEnv("postgresql://db.test/farm", {
			...testSupabase,
			url: "http://supabase.test/",
		});

		expect(readConfig(env).supabaseUrl).toBe("http://supabase.test");
	});

	it("refuses a Supabase URL that isn't a URL, without echoing the value", () => {
		const env = makeEnv("postgresql://db.test/farm", {
			...testSupabase,
			url: "not a url secret-ish",
		});

		expect(() => readConfig(env)).toThrow(/SUPABASE_URL/);
		expect(() => readConfig(env)).not.toThrow(/secret-ish/);
	});
});
