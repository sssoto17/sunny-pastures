import { defineConfig } from "vitest/config";

// The acceptance suite's own config (ADR-0007 section 6, "Acceptance tests"; #386): outside the
// root config's `unit` and `db` projects, which only include `{apps,packages}/*/src/**`, and with no
// coverage, since it reaches the app over HTTP only. Run it with `pnpm test:acceptance`
// (./run.mjs), which builds and starts the app and sets ACCEPTANCE_BASE_URL.
//
// The target comes from the environment, so M4 can point the same suite at a preview: the app's
// base URL, and the Supabase project the app trusts, whose Auth signs up each test's player. The
// values reach the tests through provide/inject (./context.d.ts) and no message holds one: the
// publishable key is public by design, but still never printed (CLAUDE.md, secrets).
// The repo has no @types/node, hence the declaration (as in the root vitest.config.mts).
declare const process: { env: Record<string, string | undefined> };

const target = {
	baseUrl: readUrl("ACCEPTANCE_BASE_URL"),
	supabaseUrl: readUrl("SUPABASE_URL"),
	supabasePublishableKey: readVariable("SUPABASE_PUBLISHABLE_KEY"),
};

export default defineConfig({
	// The root is this folder, so `include` can't reach the root projects' tests, nor they these.
	root: decodeURIComponent(new URL(".", import.meta.url).pathname),
	test: {
		include: ["**/*.test.ts"],
		provide: { target },
		// Each test signs up over Auth and makes a few round trips to a built app.
		testTimeout: 15_000,
		coverage: { enabled: false },
	},
});

function readVariable(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(
			`The acceptance tests need ${name}. Run them with pnpm test:acceptance, after pnpm db:start and pnpm db:env.`,
		);
	}

	return value;
}

// A stray trailing slash would double the slash in every path the tests join onto it.
function readUrl(name: string): string {
	const value = readVariable(name).replace(/\/+$/, "");
	if (!URL.canParse(value)) throw new Error(`The acceptance tests can't read ${name} as a URL.`);

	return value;
}
