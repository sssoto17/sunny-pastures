// The global `ignores` in eslint.config.mjs (#256). ESLint's flat config doesn't read .gitignore,
// so a git-ignored tool folder holding a stray .ts file failed `eslint .` and blocked every edit
// through the after-edit hook (#111): the remember plugin's `.remember/tmp/last-ndc.ts`. The second
// test pins that the ignores reach no tracked code, outside the agent folders skipped before #256.
import { execFileSync } from "node:child_process";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { root } from "./lint-snippet.mjs";

const eslint = new ESLint({ cwd: root });
// Agent configuration, ignored before #256 (eslint.config.mjs).
const AGENT_FOLDERS = /^\.(claude|agents)\//;

describe("ESLint's global ignores", () => {
	it("skip the remember plugin's temporary files", async () => {
		expect(await eslint.isPathIgnored(".remember/tmp/last-ndc.ts")).toBe(true);
	});

	it("skip no tracked file outside the agent folders", async () => {
		const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
			.split("\0")
			// isPathIgnored is also true for a file no block matches (Markdown, YAML), so only code.
			.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !AGENT_FOLDERS.test(f));
		const ignored = [];
		for (const file of tracked) if (await eslint.isPathIgnored(file)) ignored.push(file);
		expect(ignored).toEqual([]);
	});
});
