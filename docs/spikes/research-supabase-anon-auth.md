# Research: Supabase anonymous sign-in verified in Next.js route handlers

Issue #328 (child of the map #324). Read on 16 Nov 2026. This note reports facts and trade-offs
only; the decision belongs to the auth seam ticket (#332). Repo context: `docs/requirements/spec.md`
MUST-09, MUST-16.5, open question 5 and SHOULD-04; `supabase/config.toml` on `origin/main`.

Source labels: **[doc]** official docs page, **[src]** source code read on GitHub, **[repo]** this
repo. Nothing here was run against a live stack; see "Not verified" at the end.

## 1. Anonymous sign-in and how the session reaches a route handler

- `supabase.auth.signInAnonymously()` creates a new user. Its options include `data` (user
  metadata) and `captchaToken`. [doc: [signInAnonymously][ref-anon]]
- An anonymous user gets the `authenticated` Postgres role, like a permanent user, and its JWT
  carries `is_anonymous: true`. This is not the `anon` API key, which creates no user. [doc:
  [Anonymous sign-ins][anon]]
- An anonymous user cannot get back in after signing out, clearing browsing data or switching
  devices. That matches MUST-09.3 ("the farm lives in this browser"). [doc: [anon]]
- Supabase warns that Next.js static rendering has cached user metadata across different anonymous
  users, and recommends dynamic rendering. [doc: [anon]] Route handlers' `GET` default changed
  from static to dynamic in Next.js 15. [doc: [route.js][next-route], version history]

**Browser storage.** `@supabase/ssr`'s `createBrowserClient` always keeps the session in cookies,
not localStorage: "The `auth.storage` option is ignored. The session is always persisted via
cookies so that a server-rendered request can read it." [src: [createBrowserClient.ts][ssr-browser]]
Default cookie options are `path=/`, `SameSite=Lax`, **`httpOnly: false`** (the browser client
writes them from JS) and a 400-day max age. [src: [constants.ts][ssr-const]] The cookie is
`sb-<project_ref>-auth-token`, split into chunks of at most 3180 characters.
[doc: [creating a client][ssr-client]; src: [chunker.ts][ssr-chunk]] Latest `@supabase/ssr`
release seen: v0.12.7.

**Two ways into a route handler.**

| | Cookies (`@supabase/ssr`) | Bearer header |
|---|---|---|
| How | Same-origin `fetch` sends the cookie. The handler builds `createServerClient(url, publishableKey, { cookies: { getAll, setAll } })` per request from `await cookies()` (`next/headers`) or `request.cookies`. | The browser reads `access_token` from its session and sends `Authorization: Bearer …`. The handler passes the token to `auth.getClaims(jwt)` or `auth.getUser(jwt)`. |
| Refresh | The server client refreshes an expired access token and calls `setAll`; route handlers can set cookies (unlike Server Components). The documented pattern also refreshes in `proxy.ts` (Next 16) / `middleware.ts` (Next ≤ 15). | The browser client refreshes on its own; the server only verifies. |
| Pitfalls | Refresh tokens are single-use: refreshing in two places can trigger reuse detection and revoke the session ("random sign-outs"). `setAll` also passes cache headers that must reach the response so a CDN doesn't cache a session. | The client code must attach the header on every call; a stateless verifier has no refresh path. |
| Fits | Pages and route handlers in one app. | Black-box acceptance tests over HTTP and Locust (`tools/load`) can send a header without a cookie jar. |

Sources: [Next.js server-side auth][ssr-next], [creating a client][ssr-client], [route.js][next-route]
(cookies and headers in route handlers), [getClaims][ref-claims] and [getUser][ref-user] (`jwt`
parameter). [repo] `refresh_token_reuse_interval = 10` and `enable_refresh_token_rotation = true`
in `supabase/config.toml`.

The Next.js guide states twice: "Never trust `supabase.auth.getSession()` inside server code" and
"anyone can forge the session cookie"; verify with `getClaims()` first. [doc: [ssr-next]]

## 2. Verifying the caller: getUser vs getClaims

| | `getUser(jwt?)` | `getClaims(jwt?)` with asymmetric keys | `getClaims` with the legacy HS256 secret |
|---|---|---|---|
| Work per request | One HTTP round trip to Auth (`GET /auth/v1/user`) every call. | Local WebCrypto signature check against the JWKS; no network call while the JWKS is cached. | Falls back to `getUser` (one round trip). |
| Catches a signed-out / deleted user before `exp` | Yes: Auth looks up the user. | No: a valid signature stays valid until `exp` (`jwt_expiry`, 3600 s in our config). | Yes (via `getUser`). |
| Returns | The current user record (fresh `app_metadata`). | The token's claims (`sub`, `role`, `is_anonymous`, `app_metadata`, `session_id`, …) as of issue time. | The token's claims. |

Facts behind the table:

- `getClaims` checks `exp` (unless `allowExpired`), then, if the header has an `HS*` alg, no `kid`,
  or WebCrypto is missing, calls `getUser(token)`; otherwise it fetches the key by `kid` from
  `<url>/auth/v1/.well-known/jwks.json` and verifies the signature. [src: [GoTrueClient.ts][gotrue-src],
  `getClaims` and `fetchJwk`; doc: [getClaims][ref-claims]]
- The JWKS cache is **module-global** keyed by storage key (`GLOBAL_JWKS`), with a 10-minute TTL
  (`JWKS_TTL`). So a fresh server client per request still reuses the cache inside one warm server
  instance; a cold serverless instance pays one JWKS fetch. An unknown `kid` forces a refetch.
  [src: [GoTrueClient.ts][gotrue-src], [constants.ts][authjs-const]]
- `getClaims` does not check `iss`/`aud` itself in the code read; it checks `exp` and the signature.
  [src: same]
- Supabase's edge caches the JWKS for 10 minutes and client libraries for up to 10 more, so a
  revoked signing key can stay trusted ~20 minutes in apps that verify themselves. [doc: [JWT
  signing keys][signing]]
- The Next.js guide calls asymmetric keys "the default for new projects". [doc: [ssr-next]] The
  signing-keys page doesn't say so itself, and whether *our* hosted project uses them is unverified.
- **Local stack:** the CLI starts Auth with a hard-coded single **ES256** key when
  `auth.signing_keys_path` is unset, and accepts `HS256,RS256,ES256`. So `getClaims` verifies
  locally on `pnpm db:start` too. [src: [gotrue.service.ts @ v2.122.0][cli-gotrue], the CLI version
  pinned in `package.json`] `supabase gen signing-key --algorithm ES256` makes a project key;
  `supabase gen bearer-jwt` mints test tokens. [doc: [gen signing-key][cli-genkey], [signing]]
- Session revocation can be checked without `getUser` by looking up the token's `session_id` in
  `auth.sessions`. [doc: [managing user data][userdata]] (A DB query, so not free either.)

**Trade-off in one line.** `getClaims` costs ~nothing per request but trusts a token until it
expires (≤ 1 h here); `getUser` costs one Auth round trip per request but sees sign-outs, bans and
deletes at once. Both are server-verified and acceptable for MUST-09.4; they differ for MUST-16.5
when an admin role is revoked (section 3).

## 3. An admin role only the admin can set (MUST-16.5, open question 5)

Facts:

- `raw_user_meta_data` / `user_metadata` "can be updated by the authenticated user" via
  `updateUser`, so it "is not a good place to store authorization data". `raw_app_meta_data` /
  `app_metadata` "cannot be updated by the user, so it's a good place to store authorization data".
  [doc: [Row Level Security][rls], `auth.jwt()` section] Supabase also ships an advisor lint
  against RLS that reads `user_metadata`. [doc: [lint 0015][lint15]]
- `app_metadata` and `user_metadata` are claims in the access token; `is_anonymous`, `role` and
  `session_id` are required claims. [doc: [JWT claims][jwt-fields]]
- `app_metadata` is written by `auth.admin.updateUserById(id, { app_metadata })`, which "should
  only be called on a server" (secret / service-role key), or by SQL on `auth.users` as a DB owner.
  [doc: [updateUserById][ref-admin]] Secret keys return 401 when used from a browser user agent.
  [doc: [new API keys][apikeys]]
- A JWT "is not always fresh": an `app_metadata` change shows in `auth.jwt()` / `getClaims` only
  after the token is refreshed. [doc: [rls]]
- A **custom access token hook** runs before a token is issued and may add claims. Its input has
  `user_id`, `claims` and `authentication_method` (which lists `anonymous` and `token_refresh`).
  It must grant to `supabase_auth_admin` and revoke from `authenticated`, `anon`, `public`.
  [doc: [custom access token hook][hook]] The RBAC guide's pattern: a `user_roles(user_id, role)`
  table with an `app_role` enum, read by the hook into a `user_role` claim; only
  `supabase_auth_admin` gets access to the table. [doc: [RBAC guide][rbac]] Local config:
  `[auth.hook.custom_access_token] enabled, uri = "pg-functions://…"`, default off. [doc: [CLI
  config][cli-config]; repo: commented out in `supabase/config.toml`]

Options (not a decision):

| Option | Who can set it | Freshness | Cost | Notes |
|---|---|---|---|---|
| A. `app_metadata.role = "admin"`, read from `getClaims` | Server with the secret key, or SQL as DB owner | Up to `jwt_expiry` (1 h) after a change | None per request | No hook, no table. Revocation lags by up to an hour. |
| B. Same claim, read with `getUser` on the audit route only | Same | Immediate | One Auth round trip per audit call | The audit route is rare, so the round trip may not matter. |
| C. `user_roles` table + custom access token hook → `user_role` claim | Whoever can write the table (DB owner / migration / seed) | Up to `jwt_expiry` | Hook runs on every token issue, anonymous ones included | Supabase's documented RBAC pattern; one more moving part (SQL function, grants, config). |
| D. `admins` table checked by the route handler (no claim) | DB owner / migration | Immediate | One DB query per audit call | Keeps the role in our schema; no Auth config. |

All four need the admin to be a real user. An anonymous player can never set any of these: none
is writable through `updateUser` with a publishable key. Whatever is chosen, the attack test for
MUST-16.5 should include a caller who sets `user_metadata.role = "admin"` and still gets 403.

## 4. Abuse limits on anonymous sign-ins

- Anonymous sign-ins hit `/auth/v1/signup` with no email/phone. Limit: **30 per hour per IP**
  by default, configurable; over the limit returns 429. Token endpoint (refresh): 150 per 5 min per
  IP. Email sent by the built-in provider: **2 per hour per project**. [doc: [rate limits][rate]]
- Calls made from a server are limited by the *server's* IP unless the request carries
  `Sb-Forwarded-For` with a **secret** key and forwarding is enabled for the project. [doc: [rate]]
  So `signInAnonymously` belongs in the browser (or the route must forward the player IP), or every
  player shares one bucket of 30/hour.
- Supabase "strongly recommend[s]" invisible CAPTCHA or Cloudflare Turnstile for anonymous
  sign-ins, because every anonymous user is a row in `auth.users`. [doc: [anon]] Providers:
  hCaptcha and Turnstile; the token goes in `options.captchaToken`. [doc: [CAPTCHA][captcha],
  [ref-anon]] Turnstile publishes dummy test keys that always pass or always fail. [doc:
  [Turnstile testing][turnstile]]
- No automatic cleanup of anonymous users; the docs give a SQL delete for ones older than 30 days.
  [doc: [anon]]
- **Local stack:** `enable_anonymous_sign_ins = false`, `enable_manual_linking = false`,
  `[auth.rate_limit] anonymous_users = 30`, `[auth.captcha]` commented out (providers listed:
  `hcaptcha`, `turnstile`). [repo: `supabase/config.toml`] The CLI maps these to Auth env
  (`GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED`, `GOTRUE_RATE_LIMIT_ANONYMOUS_USERS`,
  `GOTRUE_SECURITY_CAPTCHA_*`) and sends CAPTCHA settings only when `[auth.captcha]` is present.
  [src: [cli-gotrue]] The CAPTCHA secret would be a secret: keep it in env, not in the TOML.
- Load tests (Locust) creating many anonymous users from one IP will hit the 30/hour limit unless
  the local limit is raised or users are pre-created.

## 5. Linking an email later (SHOULD-04)

- The docs: converting an anonymous user "requires linking an identity"; for email, call
  `updateUser({ email })`, verify it (link or OTP), then optionally set a password. OAuth uses
  `linkIdentity()`. [doc: [anon]]
- **The user id stays the same.** On verification, Auth creates an email identity whose subject is
  the *existing* `user.ID` and flips `is_anonymous` to false on the same row. [src: [verify.go][verify-src]]
  So rows keyed by `auth.uid()` (the farm) follow the player to another browser after sign-in,
  which is what SHOULD-04 asks.
- `updateUser` for an anonymous user refuses a password without an email or phone. If mailer
  autoconfirm is on, an anonymous user's email is confirmed at once. [src: [user.go][user-src]]
- **Doc vs source:** the anonymous-sign-in page says conversion needs manual linking enabled. In
  the Auth source, only the `/user/identities` routes (`linkIdentity`, unlink) are gated by
  `requireManualLinkingEnabled`; `PUT /user` (`updateUser`) is not. [src: [api.go][api-src],
  [middleware.go][mw-src]] So email linking appears to work with `enable_manual_linking = false`;
  OAuth linking does not. Unverified on a running stack.
- If the email already belongs to another user, `updateUser` errors; the docs' pattern is to sign
  in to that account and move the anonymous user's rows (with a conflict policy). That moves the
  farm to a different `user_id`. [doc: [anon]]
- The built-in mailer's 2 emails/hour per project limits SHOULD-04 in production without custom
  SMTP. [doc: [rate]] Locally, the CLI falls back to a local mail catcher. [src: [cli-gotrue]]

Implication for the choice now: keying the farm on the Supabase user id (`sub`) does not block
SHOULD-04, because linking an email keeps the id. Keying it on something per-browser would.

## Not verified

- Nothing was run: no local stack, no `signInAnonymously`, no `getClaims` timing.
- Whether the hosted Supabase project uses asymmetric signing keys (affects whether `getClaims`
  falls back to `getUser` in production).
- The CLI source was read at the GitHub tag `v2.122.0`; the installed binary was not inspected.
- Email linking with `enable_manual_linking = false` (doc and source disagree; source suggests it
  works).
- Whether the custom access token hook runs on anonymous sign-in (the input lists `anonymous` as a
  method; not tested).
- The per-request cost numbers are qualitative (round trip vs local verify); no measurements.

[anon]: https://supabase.com/docs/guides/auth/auth-anonymous
[ref-anon]: https://supabase.com/docs/reference/javascript/auth-signinanonymously
[ref-claims]: https://supabase.com/docs/reference/javascript/auth-getclaims
[ref-user]: https://supabase.com/docs/reference/javascript/auth-getuser
[ref-admin]: https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid
[ssr-next]: https://supabase.com/docs/guides/auth/server-side/nextjs
[ssr-client]: https://supabase.com/docs/guides/auth/server-side/creating-a-client
[signing]: https://supabase.com/docs/guides/auth/signing-keys
[hook]: https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook
[rbac]: https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac
[rls]: https://supabase.com/docs/guides/database/postgres/row-level-security
[lint15]: https://supabase.com/docs/guides/observability/advisors?queryGroups=lint&lint=0015_rls_references_user_metadata
[jwt-fields]: https://supabase.com/docs/guides/auth/jwt-fields
[userdata]: https://supabase.com/docs/guides/auth/managing-user-data
[apikeys]: https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
[rate]: https://supabase.com/docs/guides/auth/rate-limits
[captcha]: https://supabase.com/docs/guides/auth/auth-captcha
[cli-config]: https://supabase.com/docs/guides/local-development/cli/config
[cli-genkey]: https://supabase.com/docs/reference/cli/supabase-gen-signing-key
[turnstile]: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
[next-route]: https://nextjs.org/docs/app/api-reference/file-conventions/route
[ssr-browser]: https://github.com/supabase/ssr/blob/main/src/createBrowserClient.ts
[ssr-const]: https://github.com/supabase/ssr/blob/main/src/utils/constants.ts
[ssr-chunk]: https://github.com/supabase/ssr/blob/main/src/utils/chunker.ts
[gotrue-src]: https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/GoTrueClient.ts
[authjs-const]: https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/lib/constants.ts
[cli-gotrue]: https://github.com/supabase/cli/blob/v2.122.0/apps/cli/src/commands/start/services/gotrue.service.ts
[verify-src]: https://github.com/supabase/auth/blob/master/internal/api/verify.go
[user-src]: https://github.com/supabase/auth/blob/master/internal/api/user.go
[api-src]: https://github.com/supabase/auth/blob/master/internal/api/api.go
[mw-src]: https://github.com/supabase/auth/blob/master/internal/api/middleware.go
