import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Config } from "@/server/config";

declare const playerIdBrand: unique symbol;

/**
 * A player's id, the `sub` of a verified token (#332, carried in: player id = farm id = `sub`).
 * Branded, so a raw string from a request can't stand in for one: only `readPlayer` makes one.
 */
export type PlayerId = string & { readonly [playerIdBrand]: true };

/** What `readPlayer` found. A refusal carries no reason, so a caller can't learn which check failed. */
export type PlayerResult = { ok: true; playerId: PlayerId } | { ok: false };

/** Only these two settings, so tests build auth without a database URL. */
export type AuthConfig = Pick<Config, "supabaseUrl" | "supabasePublishableKey">;

/** Reads the player behind a request (#332, decision 4). */
export interface Auth {
	/**
	 * Reads `Authorization: Bearer <access token>`, never a cookie, and verifies the token with
	 * `getClaims` and the claim checks below. Resolves to `{ ok: false }` for every bad, missing or
	 * unverifiable token, and never rejects.
	 */
	readPlayer: (request: Request) => Promise<PlayerResult>;
}

/**
 * Builds the verifier once, in `getApi()` (#332, decision 4): one Supabase client per process, so
 * the JWKS that `getClaims` caches for 10 minutes is fetched once, not per request.
 */
export function createAuth(config: AuthConfig): Auth {
	const issuer = `${config.supabaseUrl}/auth/v1`;
	const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
		auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
		global: { fetch: fetchJwksOnly(`${issuer}/.well-known/jwks.json`) },
	});

	return {
		async readPlayer(request) {
			const token = readBearerToken(request.headers.get("authorization"));
			if (token === null) {
				return refused;
			}

			try {
				const { data, error } = await client.auth.getClaims(token);
				if (error !== null || data === null) {
					return refused;
				}

				return readPlayerId(data.claims, issuer);
			} catch {
				// getClaims returns auth errors, but rethrows anything else: a segment that isn't JSON,
				// an `alg` it can't verify. Those are bad tokens too, and the reason stays here.
				return refused;
			}
		},
	};
}

const refused: PlayerResult = Object.freeze({ ok: false });

// RFC 6750, section 2.1: the scheme is case-insensitive, then one or more spaces and a b64token.
const bearerHeader = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

// Lower case only, as Auth writes it, so one player has exactly one id string and so one farm (#330:
// the farm's id is the player's id).
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// getClaims verifies locally against the JWKS, but sends a token with an HS* alg, no kid or an
// unknown kid to Auth's /user instead (#328): a network call and a database lookup that anyone
// could trigger without a token. Our keys are asymmetric (ES256 on the local stack, #332 decision
// 2), so this client may fetch the JWKS and nothing else; any other call is answered here with a
// 401, which getClaims returns as an error, and so a refusal. #332 decision 4: auth runs before
// any query.
function fetchJwksOnly(jwksUrl: string): typeof fetch {
	return (input, init) => {
		const target = input instanceof Request ? input.url : String(input);
		if (target !== jwksUrl) {
			return Promise.resolve(Response.json({ msg: "Refused locally." }, { status: 401 }));
		}

		return fetch(input, init);
	};
}

function readBearerToken(header: string | null): string | null {
	const match = header === null ? null : bearerHeader.exec(header);
	return match?.[1] ?? null;
}

// getClaims checks only the signature and `exp` (#328), so the claims that make the token one of
// ours, for a signed-in player, are checked here (#332, decision 2).
function readPlayerId(claims: Readonly<Record<string, unknown>>, issuer: string): PlayerResult {
	const { sub } = claims;
	if (
		claims["role"] !== "authenticated" ||
		claims["aud"] !== "authenticated" ||
		claims["iss"] !== issuer ||
		typeof sub !== "string" ||
		!uuid.test(sub)
	) {
		return refused;
	}

	return { ok: true, playerId: sub as PlayerId };
}
