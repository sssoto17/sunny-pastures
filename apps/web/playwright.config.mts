import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig, type PlaywrightTestProject } from "@playwright/test";

// The browser tests (ADR-0011; CONSTRAINTS.md, "Browsers and widths (BASE-02)"; #673): black-box
// specs in e2e/ against the built app, `next start` on the production build from `next build`, on
// the local Supabase stack. Pattern: one project per engine and width, so a spec runs in all six
// unless it asks for fewer (the BASE-05 timing spec, #674, runs in the phone projects only).
// Rejected: a CI matrix job per browser, which pays for the stack three times (ADR-0011, section 5).
//
// A `.mts` file, as the root vitest.config.mts is: Playwright needs a default export, and lint
// allows one in a `.ts` file under apps/ only where Next needs it (ADR-0005, C6).
//
// Run it after `pnpm db:start`, `pnpm db:reset`, `pnpm db:env` and a build whose NEXT_PUBLIC_*
// variables name the same stack (`ci / ui` in .github/workflows/ci.yml builds that way).

// `CI` is set on GitHub's runners.
const isCi = process.env["CI"] !== undefined;
// Away from `next dev`'s 3000 and the acceptance run's 3100, so neither can answer for this build.
const port = 3200;
const baseUrl = `http://127.0.0.1:${String(port)}`;

const browsers = ["chromium", "firefox", "webkit"] as const;
// Desktop width, and BASE-02's 360 px phone width with touch, in portrait.
const widths = {
	desktop: { viewport: { width: 1280, height: 800 } },
	phone: { viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true },
} as const;

export default defineConfig({
	testDir: "e2e",
	// `.test.ts` is the only test suffix (ADR-0005, section 5).
	testMatch: "**/*.test.ts",
	forbidOnly: isCi,
	retries: 0,
	// Playwright's own default on a local machine.
	workers: isCi ? 2 : "50%",
	reporter: isCi ? [["list"], ["github"]] : "list",
	use: {
		baseURL: baseUrl,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: browsers.flatMap((browserName) =>
		Object.entries(widths).map(([width, options]): PlaywrightTestProject => ({
			name: `${browserName}-${width}`,
			use: { browserName, ...options },
		})),
	),
	webServer: {
		command: `pnpm exec next start --port ${String(port)} --hostname 127.0.0.1`,
		// The health route reads the config as the game routes do, so it answers 200 only once the
		// server has the stack's variables (#470).
		url: `${baseUrl}/api/health`,
		// A server left on the port would answer for another build, so the run stops instead.
		reuseExistingServer: false,
		env: { ...readStackEnv(), NEXT_TELEMETRY_DISABLED: "1" },
	},
});

/**
 * The stack's variables from the repo root's `.env`, which `pnpm db:env` writes, over the shell's,
 * as the acceptance run reads them (tests/acceptance/run.mjs). Next reads `.env` files from
 * apps/web only, so the server gets them here. `.env` is optional; nothing here prints a value.
 */
function readStackEnv(): Record<string, string> {
	const file = new URL("../../.env", import.meta.url);
	if (!existsSync(file)) return {};

	const values = parseEnv(readFileSync(file, "utf8"));
	return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value ?? ""]));
}
