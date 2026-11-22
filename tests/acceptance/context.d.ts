// The values ./vitest.config.mts provides to the acceptance tests through Vitest's provide/inject.
import "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/**
		 * What the suite runs against, from the environment (ADR-0007 section 6): the app's base URL
		 * and the Supabase project whose Auth the app trusts. Each has no trailing slash. The key is
		 * public by design, but never printed (CLAUDE.md, secrets).
		 */
		target: { baseUrl: string; supabaseUrl: string; supabasePublishableKey: string };
	}
}
