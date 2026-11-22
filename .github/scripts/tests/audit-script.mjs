// Test helper: runs the real `audit:changed` script (package.json) with the real .fallowrc.jsonc
// against a throwaway repo from test-repo.mjs, comparing its `work` branch with `main` (#503).
// Used by the duplication and changed-code audit tests.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "./lint-snippet.mjs";

export const CONFIG = readFileSync(join(root, ".fallowrc.jsonc"), "utf8");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const [tool, SCRIPT, ...ARGS] = scripts["audit:changed"].split(" ");
export const TOOL = tool;

/** The script's exit code and output, with `extra` arguments after its own. Check `TOOL` first. */
export const runAudit = (dir, extra = []) => {
	// Under Actions the script renders annotations into the real job summary; not for fixtures.
	const env = { ...process.env };
	delete env.GITHUB_ACTIONS;
	delete env.GITHUB_STEP_SUMMARY;
	const r = spawnSync(TOOL, [join(root, SCRIPT), ...ARGS, "--base", "main", ...extra], {
		cwd: dir,
		env,
		encoding: "utf8",
	});
	return { code: r.status, out: r.stdout + r.stderr };
};
