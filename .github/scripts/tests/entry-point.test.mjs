import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { makeRepo } from "./test-repo.mjs";

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));
const TODAY = { FLOOR_GUARD_TODAY: "2026-11-10" };

// Enough of a repo for each script to reach its verdict, with nothing to flag.
const FILES = {
	"CONSTRAINTS.md": `# Constraints

## Ratchets

| Metric | Today |
|---|---|
| Project coverage | not yet |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| _none_ | | | | | |
`,
	"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
	"tsconfig.json": '{ "files": [], "references": [{ "path": "./packages/sim" }] }\n',
	"packages/sim/package.json": "{}\n",
	"packages/sim/tsconfig.json": '{ "extends": "../../tsconfig.base.json" }\n',
};

// Each script's normal output on the clean fixture: proof that `main` ran.
const CLEAN = {
	"coverage-gate.mjs": "coverage-gate: no lcov and no changed source files: pass",
	"floor-guard.mjs": "floor-guard: clean",
	"typecheck-reach.mjs": "typecheck-reach: every workspace package is referenced",
};

let repo;
let links;
afterEach(() => {
	repo?.cleanup();
	if (links) rmSync(links, { recursive: true, force: true });
});

// The two ways a script is reached through a symlink: the file itself is a link, or a folder above
// it is (a symlinked worktree, macOS /tmp → /private/tmp, a linked home).
const viaFileLink = (name) => {
	const path = join(links, name);
	symlinkSync(join(SCRIPTS, name), path);
	return path;
};
const viaFolderLink = (name) => {
	symlinkSync(SCRIPTS, join(links, "scripts"));
	return join(links, "scripts", name);
};

// A script started through a symlink saw a false `import.meta.url === argv[1]` check, skipped
// `main` and exited 0 with no output, which read as a pass (#48's review, PRs #279/#280).
describe("a script started through a symlink", () => {
	describe.each([
		["a symlinked file", viaFileLink],
		["a symlinked folder", viaFolderLink],
	])("through %s", (_, link) => {
		it.each(Object.entries(CLEAN))("runs %s and prints its verdict", (name, verdict) => {
			repo = makeRepo(FILES);
			links = mkdtempSync(join(tmpdir(), "entry-link-"));
			const r = repo.run(link(name), [], TODAY);
			expect(r).toMatchObject({ code: 0 });
			expect(r.out).toContain(verdict);
		});

		it("fails a finding with exit 1 instead of exiting 0", () => {
			repo = makeRepo({
				...FILES,
				"packages/web/package.json": "{}\n",
				"packages/web/tsconfig.json": '{ "extends": "../../tsconfig.base.json" }\n',
			});
			links = mkdtempSync(join(tmpdir(), "entry-link-"));
			const r = repo.run(link("typecheck-reach.mjs"));
			expect(r.code).toBe(1);
			expect(r.out).toContain("packages/web is not in the root tsconfig.json references");
		});
	});
});
