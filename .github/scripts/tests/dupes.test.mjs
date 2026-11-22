// The duplication check (CONSTRAINTS.md, duplication row; ADR-0005, section 3): the real
// `audit:changed` script and .fallowrc.jsonc, duplication only, run against throwaway repos, fail a
// copied helper (#125; `fallow dupes` until #503).
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG, runAudit, TOOL } from "./audit-script.mjs";
import { makeRepo } from "./test-repo.mjs";

// A helper well over the minimum size: 8 lines, about 90 tokens.
const helper = (name) => `export function ${name}(value: unknown, path: string): string[] {
  const found: string[] = [];
  if (typeof value === 'number' && !Number.isSafeInteger(value)) found.push(\`\${path} is unsafe\`);
  else if (Array.isArray(value)) value.forEach((item, i) => found.push(...${name}(item, \`\${path}[\${String(i)}]\`)));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) found.push(...${name}(item, \`\${path}.\${key}\`));
  }
  return found;
}
`;

describe("the duplication check", () => {
	let repo;
	afterEach(() => repo?.cleanup());

	// Duplication only: these fixtures' modules have no entry point, so every export is unused.
	const dupes = () => {
		expect(TOOL).toBe("node");
		repo.commit();
		return runAudit(repo.dir, ["--only", "dupes"]);
	};
	const base = (files = {}) =>
		(repo = makeRepo({
			".fallowrc.jsonc": CONFIG,
			"packages/sim/src/state/index.ts": helper("unsafeNumbers"),
			...files,
		}));

	it("passes a change with no copies", () => {
		base();
		repo.write({ "packages/sim/src/hash/index.ts": "export const answer = 42;\n" });
		expect(dupes().code).toBe(0);
	});

	it("fails a helper copied into another module", () => {
		base();
		repo.write({ "packages/sim/src/plots/index.ts": helper("unsafeNumbers") });
		const r = dupes();
		expect(r.code).toBe(1);
		expect(r.out).toContain("packages/sim/src/plots/index.ts");
	});

	it("fails a helper copied between test files, which Fallow skips by default", () => {
		base();
		repo.write({
			"packages/sim/src/plots/tests/a.test.ts": helper("walk"),
			"packages/sim/src/plots/tests/b.test.ts": helper("walk"),
		});
		expect(dupes().code).toBe(1);
	});

	it("passes the same shape with other names, since a clone is the same rule, not the same shape", () => {
		base();
		const renamed = helper("badNumbers")
			.replaceAll("found", "seen")
			.replaceAll("value", "node")
			.replaceAll("item", "child");
		repo.write({ "packages/sim/src/plots/index.ts": renamed });
		expect(dupes().code).toBe(0);
	});

	// #503: the audit's `new-only` gate passes an inherited clone outside the sim.
	it("passes a clone the change inherits outside packages/sim, in a file it touches", () => {
		base({
			"apps/web/src/a/index.ts": helper("walk"),
			"apps/web/src/b/index.ts": helper("walk"),
		});
		repo.write({ "apps/web/src/b/index.ts": `${helper("walk")}export const answer = 42;\n` });
		expect(dupes().code).toBe(0);
	});

	// The sim keeps its bar from before #503: no clone at all in a file the change touches.
	it("fails a clone the change inherits in a packages/sim file it touches", () => {
		base({ "packages/sim/src/plots/index.ts": helper("unsafeNumbers") });
		repo.write({
			"packages/sim/src/plots/index.ts": `${helper("unsafeNumbers")}export const answer = 42;\n`,
		});
		expect(dupes().code).toBe(1);
	});

	it("reports only clones in changed files", () => {
		base({ "packages/sim/src/plots/index.ts": helper("unsafeNumbers") });
		repo.write({ "packages/sim/src/hash/index.ts": "export const answer = 42;\n" });
		expect(dupes().code).toBe(0);
	});
});
