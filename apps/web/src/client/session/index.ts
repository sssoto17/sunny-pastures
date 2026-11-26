import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The browser's session (ADR-0010, "Sync module"; ADR-0007, section 4): the only code that talks
// to Supabase Auth. The default browser persistence keeps the session across reloads (MUST-09.2),
// and a first visit signs in anonymously (MUST-09.1).

/** The player's access token. Both calls return `null` when Auth can't give one (offline, say). */
export interface Session {
	getAccessToken(): Promise<string | null>;
	refreshAccessToken(): Promise<string | null>;
}

/** The part of supabase-js's client this module uses, so a test can pass a fake. */
export type AuthClient = Pick<
	SupabaseClient["auth"],
	"getSession" | "refreshSession" | "signInAnonymously"
>;

/** Wraps an auth client. An expected failure is a `null` token; nothing here throws. */
export function createSession(auth: AuthClient): Session {
	return {
		async getAccessToken() {
			const existing = await auth.getSession();
			const token = existing.data.session?.access_token;
			if (token !== undefined) return token;

			const created = await auth.signInAnonymously();
			return created.data.session?.access_token ?? null;
		},
		async refreshAccessToken() {
			const refreshed = await auth.refreshSession();
			return refreshed.data.session?.access_token ?? null;
		},
	};
}

let browserSession: Session | null = null;

/**
 * The one session of this tab, built on first use from the public Supabase variables. Throws when
 * one is missing, with a sentence that names it and no value (#684): a deploy without them is a
 * setup mistake, not a player's. The store logs it to the console and shows "Try again".
 */
export function getBrowserSession(): Session {
	if (browserSession !== null) return browserSession;

	// Each variable is read by its full name, so Next inlines it into the client bundle.
	const url = process.env["NEXT_PUBLIC_SUPABASE_URL"]?.trim() ?? "";
	const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]?.trim() ?? "";
	const missing = [
		...(url === "" ? ["URL (NEXT_PUBLIC_SUPABASE_URL)"] : []),
		...(key === "" ? ["publishable key (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"] : []),
	];
	if (missing.length > 0) {
		const verb = missing.length === 1 ? "is" : "are";
		throw new Error(
			`The game isn't configured: the Supabase ${missing.join(" and ")} ${verb} missing.`,
		);
	}

	browserSession = createSession(createClient(url, key).auth);
	return browserSession;
}
