// The changed-code gate (CONSTRAINTS.md, the Complexity and Dead code rows; #503): the real
// `audit:changed` script and .fallowrc.jsonc, run against throwaway repos, fail what a change
// introduces and pass what it inherits. Duplication has its own suite, dupes.test.mjs.
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG, runAudit, TOOL } from "./audit-script.mjs";
import { makeRepo } from "./test-repo.mjs";

// The package entry exports everything, so nothing in these fixtures is dead unless a test adds it.
// The files sit in the sim's boundary zone, since the real config requires every file in a zone.
const PACKAGE = JSON.stringify({
	name: "fixture",
	private: true,
	main: "packages/sim/src/index.ts",
});

// A function with `n` independent branches: cyclomatic n + 1, over the threshold (20) from 20. No
// test reaches it, so its CRAP is about cyclomatic² + cyclomatic: 20 at 3 branches, 30 (the
// threshold) at 4.
const branchy = (name, n) => {
	const ifs = Array.from({ length: n }, (_, i) => `  if (x === ${String(i)}) return ${String(i)};`);
	return `export function ${name}(x: number): number {\n${ifs.join("\n")}\n  return -1;\n}\n`;
};

describe("the changed-code audit", () => {
	let repo;
	afterEach(() => repo?.cleanup());

	const audit = () => {
		expect(TOOL).toBe("node");
		repo.commit();
		return runAudit(repo.dir);
	};
	const base = (files = {}) =>
		(repo = makeRepo({
			".fallowrc.jsonc": CONFIG,
			"package.json": PACKAGE,
			"packages/sim/src/index.ts": 'export { total } from "./total";\n',
			"packages/sim/src/total.ts":
				"export const total = (a: number, b: number): number => a + b;\n",
			...files,
		}));

	it("passes a small change", () => {
		base();
		repo.write({
			"packages/sim/src/total.ts":
				"export const total = (a: number, b: number): number => b + a;\n",
		});
		expect(audit().code).toBe(0);
	});

	it("fails an unused export", () => {
		base();
		repo.write({
			"packages/sim/src/total.ts":
				"export const total = (a: number, b: number): number => a + b;\nexport const unused = 1;\n",
		});
		const r = audit();
		expect(r.code).toBe(1);
		expect(r.out).toContain("unused");
	});

	it("passes a new function under the complexity thresholds", () => {
		base();
		repo.write({
			"packages/sim/src/index.ts":
				'export { total } from "./total";\nexport { pick } from "./pick";\n',
			"packages/sim/src/pick.ts": branchy("pick", 3),
		});
		expect(audit().code).toBe(0);
	});

	it("fails a new function over the complexity thresholds", () => {
		base();
		repo.write({
			"packages/sim/src/index.ts":
				'export { total } from "./total";\nexport { pick } from "./pick";\n',
			"packages/sim/src/pick.ts": branchy("pick", 25),
		});
		const r = audit();
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/pick[\s\S]*cyclomatic|cyclomatic[\s\S]*pick/i);
	});

	it("passes an inherited complex function in a file the change touches", () => {
		const index = 'export { total } from "./total";\nexport { pick } from "./pick";\n';
		base({ "packages/sim/src/index.ts": index, "packages/sim/src/pick.ts": branchy("pick", 25) });
		repo.write({
			"packages/sim/src/pick.ts": `${branchy("pick", 25)}export const half = (x: number): number => x / 2;\n`,
			"packages/sim/src/index.ts": `${index}export { half } from "./pick";\n`,
		});
		expect(audit().code).toBe(0);
	});
});
