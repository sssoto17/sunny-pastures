import { describe, expect, it, vi } from "vitest";

import { createSession, type AuthClient } from "../index";

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
