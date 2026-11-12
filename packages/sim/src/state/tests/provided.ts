// The values the root vitest.config.mts provides to tests (D10, #200), checked as a test reads them.
import type { ProvidedContext } from "vitest";

/**
 * `value`, read with `inject(key)`, or a throw when Vitest provided nothing for `key`. That
 * happens when Vitest runs without the root config, as `vitest run` inside `packages/sim` does:
 * fast-check given no settings picks a random seed, so the properties would run on another
 * sample each time and a reach test could fail at random (#213). Run them from the repo root.
 */
export function requireProvided<Key extends keyof ProvidedContext>(
	key: Key,
	value: ProvidedContext[Key] | undefined,
): ProvidedContext[Key] {
	if (value === undefined) {
		throw new Error(
			`Vitest provided no "${key}": run the tests from the repo root, so they get its vitest.config.mts (#213).`,
		);
	}

	return value;
}
