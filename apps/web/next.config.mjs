// A `.mjs` file, so it sits in no type-checked program and ESLint lints it untyped, as the root
// tool configs are (eslint.config.mjs).

/** @type {import("next").NextConfig} */
const config = {
	// The sim imports its files as `./x/index.js`, as NodeNext requires (ADR-0005, C8), and ships
	// its TypeScript source (`exports: ./src/index.ts`). Turbopack in Next 16.4 can't map `.js` to
	// `.ts`, so `dev` and `build` run webpack (`--webpack`), whose `extensionAlias` does (#393).
	webpack: (webpackConfig) => {
		webpackConfig.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
		return webpackConfig;
	},
};

export default config;
