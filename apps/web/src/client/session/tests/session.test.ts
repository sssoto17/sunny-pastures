import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession, getBrowserSession, type AuthClient } from "../index";

type Auth = AuthClient;

function fakeAuth(
	stored: string | null,
	anonymous: string | null = "anon-token",
	refreshed: string | null = "fresh",
) {
	const wrap = (token: string | null) => ({
		data: { session: token === null ? null : { access_token: token } },
	});
	const auth = {
		getSession: vi.fn(() => Promise.resolve(wrap(stored))),
		signInAnonymously: vi.fn(() => Promise.resolve(wrap(anonymous))),
		refreshSession: vi.fn(() => Promise.resolve(wrap(refreshed))),
	};
	return { auth, typed: auth as unknown as Auth };
}

describe("the session", () => {
	it("signs in anonymously when there is no session", async () => {
		const { auth, typed } = fakeAuth(null);
		expect(await createSession(typed).getAccessToken()).toBe("anon-token");
		expect(auth.signInAnonymously).toHaveBeenCalledTimes(1);
	});

	it("reuses the stored session without signing in", async () => {
		const { auth, typed } = fakeAuth("stored");
		const session = createSession(typed);
		expect(await session.getAccessToken()).toBe("stored");
		expect(await session.getAccessToken()).toBe("stored");
		expect(auth.signInAnonymously).not.toHaveBeenCalled();
	});

	it("returns null when anonymous sign-in gives no session", async () => {
		const { typed } = fakeAuth(null, null);
		expect(await createSession(typed).getAccessToken()).toBeNull();
	});

	it("forces a refresh on request", async () => {
		const { auth, typed } = fakeAuth("stored");
		expect(await createSession(typed).refreshAccessToken()).toBe("fresh");
		expect(auth.refreshSession).toHaveBeenCalledTimes(1);
	});

	it("returns null when the refresh gives no session", async () => {
		const { typed } = fakeAuth("stored", "x", null);
		expect(await createSession(typed).refreshAccessToken()).toBeNull();
	});
});

describe("the browser session", () => {
	// Obviously fake values: the test checks they never reach the message.
	const url = "http://supabase.test";
	const key = "fake-publishable-key";

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/** The message `getBrowserSession` throws with these variables; "" for a missing one. */
	function readConfigError(env: { url: string; key: string }): string {
		vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.url);
		vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", env.key);
		try {
			getBrowserSession();
		} catch (thrown) {
			return thrown instanceof Error ? thrown.message : String(thrown);
		}
		throw new Error("getBrowserSession did not throw.");
	}

	it("names the missing URL, and prints no value (#684)", () => {
		const message = readConfigError({ url: "", key });
		expect(message).toBe(
			"The game isn't configured: the Supabase URL (NEXT_PUBLIC_SUPABASE_URL) is missing.",
		);
		expect(message).not.toContain(key);
	});

	it("names the missing publishable key, and prints no value (#684)", () => {
		const message = readConfigError({ url, key: "" });
		expect(message).toBe(
			"The game isn't configured: the Supabase publishable key " +
				"(NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) is missing.",
		);
		expect(message).not.toContain(url);
	});

	it("names both when both are missing, or only blank (#684)", () => {
		expect(readConfigError({ url: " ", key: "" })).toBe(
			"The game isn't configured: the Supabase URL (NEXT_PUBLIC_SUPABASE_URL) and " +
				"publishable key (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) are missing.",
		);
	});
});
