/**
 * Lazy initialisation, memoised per process (#329, decision 5): `build` runs on the first call, not
 * at import, so `next build` imports a route without its environment. A build that throws is not
 * kept, so the next request tries again.
 */
export function once<T>(build: () => T): () => T {
	let built: { value: T } | null = null;
	return () => {
		built ??= { value: build() };
		return built.value;
	};
}
