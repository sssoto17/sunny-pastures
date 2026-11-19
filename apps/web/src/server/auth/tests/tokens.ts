import { vi } from "vitest";

/** An ES256 signing key, as the local stack's Auth holds one (#328): its private half and its JWK. */
export interface SigningKey {
	kid: string;
	privateKey: CryptoKey;
	jwk: JsonWebKey & { kid: string };
}

/** Makes a P-256 key pair whose public half is published under `kid`. */
export async function makeSigningKey(kid: string): Promise<SigningKey> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
}

/** Encodes one JWT segment: JSON, then base64url. */
export function encodeSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Signs `payload` with `key` as an ES256 JWT. `header` replaces the default header. */
export async function signToken(
	key: SigningKey,
	payload: object,
	header: object = { alg: "ES256", typ: "JWT", kid: key.kid },
): Promise<string> {
	const input = `${encodeSegment(header)}.${encodeSegment(payload)}`;
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key.privateKey,
		new TextEncoder().encode(input),
	);
	return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

/** Signs `payload` as an HS256 JWT with `secret`, the legacy shared-secret shape. */
export async function signSharedSecretToken(secret: string, payload: object): Promise<string> {
	const input = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(payload)}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
	return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

/** The player every valid test token names. */
export const testPlayerId = "6f0c2a3e-8a8b-4c1d-9e2f-0123456789ab";

/** The claims Supabase Auth puts in an anonymous player's access token, valid for an hour. */
export function makeClaims(issuer: string): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		iss: issuer,
		aud: "authenticated",
		role: "authenticated",
		sub: testPlayerId,
		iat: now,
		exp: now + 3600,
		is_anonymous: true,
		session_id: "0d9a7c1e-3b2f-4e5d-8c7b-6a5f4e3d2c1b",
	};
}

/**
 * Stands in for Supabase Auth at `url`, the network boundary `getClaims` reaches: the JWKS endpoint
 * serves `keys`, and every other call (the `getUser` fallback for a token without a usable `kid`) is
 * refused with 401, as Auth refuses a token it didn't sign. Returns the URLs called, in order.
 * Undo with `vi.unstubAllGlobals()`.
 */
export function stubAuthServer(url: string, keys: readonly JsonWebKey[]): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL) => {
			const target = input instanceof Request ? input.url : String(input);
			calls.push(target);
			if (target === `${url}/auth/v1/.well-known/jwks.json`) {
				return Promise.resolve(Response.json({ keys }));
			}

			return Promise.resolve(
				Response.json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 401 }),
			);
		}),
	);
	return calls;
}
