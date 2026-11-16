// The `.remember/` line in .prettierignore (#288). Prettier reads the root .gitignore, not the
// nested `.remember/.gitignore` the remember plugin writes, so its stray temp files failed
// `pnpm format:check` and blocked every edit through the after-edit hook (#111), as they had for
// ESLint (#256). The second test pins that the ignores reach no tracked code, outside the paths
// .prettierignore skipped before #288.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getFileInfo } from "prettier";
import { describe, expect, it } from "vitest";

import { root } from "./lint-snippet.mjs";

// The ignore files the CLI reads by default, so `format:check` sees the same list.
const ignorePath = [join(root, ".gitignore"), join(root, ".prettierignore")];
const ignored = async (file) => (await getFileInfo(join(root, file), { ignorePath })).ignored;
// Tool-written files, agent configuration and local tool config, ignored before #288.
const SKIPPED_BEFORE = /^(\.(claude|agents)\/|\.mcp\.json$|skills-lock\.json$)/;

describe("Prettier's ignore files", () => {
	it("skip the remember plugin's temporary files", async () => {
		expect(await ignored(".remember/tmp/last-ndc.ts")).toBe(true);
		expect(await ignored(".remember/tmp/last-save.json")).toBe(true);
		// The whole folder, not only tmp/.
		expect(await ignored(".remember/x.ts")).toBe(true);
	});

	it("skip no tracked file outside the paths skipped before", async () => {
		const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
			.split("\0")
			// The extensions `format:check` globs; *.md and *.yml are ignored on purpose.
			.filter((f) => /\.(ts|tsx|mts|mjs|js|json)$/.test(f) && !SKIPPED_BEFORE.test(f));
		const skipped = [];
		for (const file of tracked) if (await ignored(file)) skipped.push(file);
		expect(skipped).toEqual([]);
	});
});
