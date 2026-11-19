import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, type Auth } from "../index";
import {
	encodeSegment,
	makeClaims,
	makeSigningKey,
	signSharedSecretToken,
	signToken,
	stubAuthServer,
	testPlayerId,
	type SigningKey,
} from "./tokens";

/** What one case has to work with: the project's key and the issuer its tokens must name. */
interface Project {
	key: SigningKey;
	issuer: string;
}

// supabase-js caches the JWKS per process, keyed by the URL's first host label, so every test
// gets a project of its own and no key leaks from one test into the next.
let projects = 0;
let project: Project;
let auth: Auth;
let authCalls: string[];

beforeEach(async () => {
	projects += 1;
	const url = `http://project-${String(projects)}.test`;
	const key = await makeSigningKey("project-key");
	authCalls = stubAuthServer(url, [key.jwk]);
	project = { key, issuer: `${url}/auth/v1` };
	auth = createAuth({ supabaseUrl: url, supabasePublishableKey: "publishable-key-for-tests" });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function makeRequest(headers: Record<string, string>): Request {
	return new Request("http://app.test/api/farm", { headers });
}

function makeBearerRequest(token: string): Request {
	return makeRequest({ authorization: `Bearer ${token}` });
}

/**
 * Signs the project's valid claims with `changes` applied. `undefined` removes a claim, since
 * `null` would test a different case: a claim that is present but null.
 */
function signClaims(changes: Record<string, unknown>): Promise<string> {
	const claims = { ...makeClaims(project.issuer), ...changes };
	return signToken(
		project.key,
		Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined)),
	);
}

describe("readPlayer", () => {
	it("returns the player a token signed by the project's key names", async () => {
		const token = await signClaims({});

		expect(await auth.readPlayer(makeBearerRequest(token))).toStrictEqual({
			ok: true,
			playerId: testPlayerId,
		});
	});

	it("accepts the Bearer scheme in any case, as RFC 6750 allows", async () => {
		const token = await signClaims({});
		const request = makeRequest({ authorization: `bearer ${token}` });

		expect(await auth.readPlayer(request)).toStrictEqual({ ok: true, playerId: testPlayerId });
	});

	it("ignores a valid token sent as a cookie (#332, decision 1)", async () => {
		const token = await signClaims({});
		const request = makeRequest({ cookie: `sb-project-auth-token=${token}` });

		expect(await auth.readPlayer(request)).toStrictEqual({ ok: false });
	});

	// #371: every failure gives the same `{ ok: false }`, never a reason and never a throw.
	const refused: [string, () => Promise<Request>][] = [
		["no Authorization header", () => Promise.resolve(makeRequest({}))],
		["another scheme", () => Promise.resolve(makeRequest({ authorization: "Basic dXNlcjpwYXNz" }))],
		["the scheme without a token", () => Promise.resolve(makeRequest({ authorization: "Bearer" }))],
		[
			"a token followed by more words",
			async () => makeRequest({ authorization: `Bearer ${await signClaims({})} extra` }),
		],
		[
			"a token without the scheme",
			async () => makeRequest({ authorization: await signClaims({}) }),
		],
		["a token that isn't a JWT", () => Promise.resolve(makeBearerRequest("not-a-jwt"))],
		[
			"a JWT whose segments aren't JSON",
			() => Promise.resolve(makeBearerRequest("aaaa.bbbb.cccc")),
		],
		[
			"a token signed by another key under the project's kid",
			async () => {
				const other = await makeSigningKey("project-key");
				return makeBearerRequest(await signToken(other, makeClaims(project.issuer)));
			},
		],
		[
			"a token signed by another key under an unknown kid",
			async () => {
				const other = await makeSigningKey("attacker-key");
				return makeBearerRequest(await signToken(other, makeClaims(project.issuer)));
			},
		],
		[
			"an unsigned token (alg none) with no kid",
			() => {
				const header = encodeSegment({ alg: "none", typ: "JWT" });
				return Promise.resolve(
					makeBearerRequest(`${header}.${encodeSegment(makeClaims(project.issuer))}.`),
				);
			},
		],
		[
			"an unsigned token (alg none) under the project's kid",
			async () => {
				const header = { alg: "none", typ: "JWT", kid: "project-key" };
				return makeBearerRequest(await signToken(project.key, makeClaims(project.issuer), header));
			},
		],
		[
			"a token whose header claims RS256 for the project's EC key",
			async () => {
				const header = { alg: "RS256", typ: "JWT", kid: "project-key" };
				return makeBearerRequest(await signToken(project.key, makeClaims(project.issuer), header));
			},
		],
		[
			"a token signed with a guessed shared secret (HS256)",
			async () =>
				makeBearerRequest(await signSharedSecretToken("guessed", makeClaims(project.issuer))),
		],
		[
			"an expired token",
			async () => makeBearerRequest(await signClaims({ exp: Math.floor(Date.now() / 1000) - 1 })),
		],
		["a token with no expiry", async () => makeBearerRequest(await signClaims({ exp: undefined }))],
		[
			"a token from another issuer",
			async () => makeBearerRequest(await signClaims({ iss: "http://elsewhere.test/auth/v1" })),
		],
		["a token with no issuer", async () => makeBearerRequest(await signClaims({ iss: undefined }))],
		[
			"a token for another audience",
			async () => makeBearerRequest(await signClaims({ aud: "anon" })),
		],
		[
			"a token whose audience is a list",
			async () => makeBearerRequest(await signClaims({ aud: ["authenticated"] })),
		],
		[
			"a token with the anon role",
			async () => makeBearerRequest(await signClaims({ role: "anon" })),
		],
		[
			"a token with the service_role role",
			async () => makeBearerRequest(await signClaims({ role: "service_role" })),
		],
		[
			"a token whose sub isn't a UUID",
			async () => makeBearerRequest(await signClaims({ sub: "player-1" })),
		],
		[
			"a token whose sub is an upper-case UUID",
			async () => makeBearerRequest(await signClaims({ sub: testPlayerId.toUpperCase() })),
		],
		["a token with no sub", async () => makeBearerRequest(await signClaims({ sub: undefined }))],
	];

	it.each(refused)("refuses %s with the same { ok: false }", async (_name, buildRequest) => {
		const request = await buildRequest();

		expect(await auth.readPlayer(request)).toStrictEqual({ ok: false });
		// No refusal reaches Auth's /user: getClaims would send a token with an HS* alg or no kid
		// there, a network call and a database lookup per request (#332 decision 4: auth runs before
		// any query). Only a JWKS fetch for an unknown kid is allowed, and it is cached.
		expect(authCalls.filter((url) => !url.endsWith("/.well-known/jwks.json"))).toEqual([]);
	});
});
