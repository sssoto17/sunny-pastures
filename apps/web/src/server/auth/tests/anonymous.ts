import { createClient } from "@supabase/supabase-js";

import { readConfig, type Config, type Env } from "@/server/config";

import type { AuthConfig } from "../index";

/** A fresh anonymous player on the local stack. The token is a secret: never print or log it. */
export interface AnonymousPlayer {
	accessToken: string;
	/** The token's `sub`, as Auth reports it. */
	playerId: string;
}

/**
 * Reads the stack's settings for `pnpm test:stack`. Without them it throws a message that says how
 * to get them, naming variables only, never a value.
 */
export function readStackConfig(env: Env): Config {
	try {
		return readConfig(env);
	} catch (error) {
		throw new Error(
			"pnpm test:stack needs the local Supabase stack: run pnpm db:start, then pnpm db:env.",
			{ cause: error },
		);
	}
}

/**
 * Signs up a new anonymous player against the local stack, `POST /auth/v1/signup` with the
 * publishable key (#332 decision 3), through the same supabase-js call the browser client makes.
 * A failure reports Auth's status and error code only, never the token or the key.
 */
export async function signUpAnonymous(config: AuthConfig): Promise<AnonymousPlayer> {
	const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
		auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
	});
	const { data, error } = await client.auth.signInAnonymously();
	if (error !== null || data.session === null || data.user === null) {
		const status = error?.status ?? "none";
		const code = error?.code ?? "none";
		throw new Error(
			`Anonymous sign-up failed (status ${String(status)}, code ${code}). Is the local stack running with anonymous sign-ins on?`,
		);
	}

	return { accessToken: data.session.access_token, playerId: data.user.id };
}
