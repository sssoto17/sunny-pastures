import { defineConfig } from "vitest/config";

import base from "./vitest.config.mts";

// The tests that need the local Supabase stack (#371; #332 decision 3: real anonymous sign-ups).
// `pnpm test` leaves `*.stack-test.ts` out, since CI has no stack until #49, and `pnpm test:stack`
// runs them here, with `.env` loaded (`pnpm db:env` writes it). Without the stack they fail with a
// message that says how to start it, rather than skipping in silence.
export default defineConfig({
	resolve: base.resolve,
	test: { include: ["apps/*/src/**/*.stack-test.ts"], testTimeout: 15_000 },
});
