// Vendored skill folders (#665): the floor guard skips the files of a third-party skill the repo
// records in skills-lock.json, and only those. In their own file, apart from floor-guard.test.mjs,
// so other work on the guard merges cleanly (as floor-guard-spent.test.mjs).
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { makeRepo } from "./test-repo.mjs";

const SCRIPT = fileURLToPath(new URL("../floor-guard.mjs", import.meta.url));
const TODAY = { FLOOR_GUARD_TODAY: "2026-11-10" };
// This file isn't one of the guard's own (SELF), so the patterns it plants are assembled.
const PENDING = ["TO", "DO"].join("");
const SUPPRESSION = ["eslint", "disable"].join("-");
const CONSTRAINTS =
	"# Constraints\n\n## Floor\n\n- Secrets in source: blocked.\n\n## Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n| _none_ | | | | | |\n";
const lock = (names) =>
	`${JSON.stringify(
		{
			version: 1,
			skills: Object.fromEntries(
				names.map((n) => [n, { source: "someone/skills", sourceType: "github" }]),
			),
		},
		null,
		2,
	)}\n`;
const BASE = {
	"CONSTRAINTS.md": CONSTRAINTS,
	"skills-lock.json": lock(["upstream"]),
	".agents/skills/upstream/SKILL.md": "# Upstream\n",
	".agents/skills/upstream/run.js": "export const run = 1;\n",
	".claude/skills/ours/SKILL.md": "# Ours\n",
	".claude/skills/ours/run.js": "export const run = 1;\n",
	".claude/hooks/hook.sh": "#!/bin/sh\n",
};

let repo;
afterEach(() => repo?.cleanup());
const setup = (base = BASE) => (repo = makeRepo(base));
const guard = () => repo.run(SCRIPT, [], TODAY);

describe("floor guard, vendored skill folders", () => {
	it("skips a PENDING and a suppression in a skill folder named in skills-lock.json", () => {
		setup();
		repo.write({
			".agents/skills/upstream/run.js": `export const run = 1;\n// ${PENDING}: upstream's\n// ${SUPPRESSION}\n`,
		});
		const r = guard();
		expect(r.out).not.toContain("[unfinished-work]");
		expect(r.out).not.toContain("[silenced-checker]");
		expect(r.code).toBe(0);
	});

	it("names the skill it skipped, so a skip is never silent", () => {
		setup();
		repo.write({ ".agents/skills/upstream/run.js": `// ${PENDING}\n` });
		expect(guard().out).toContain('skipped 1 changed file(s) of the vendored skill "upstream"');
	});

	it("skips a newly vendored folder whose entry the same diff adds", () => {
		setup();
		repo.write({
			"skills-lock.json": lock(["upstream", "fresh"]),
			".claude/skills/fresh/SKILL.md": "# Fresh\n",
			".claude/skills/fresh/scripts/live.js": `// ${PENDING}: upstream's\n`,
		});
		const r = guard();
		expect(r.code).toBe(0);
		expect(r.out).toContain('vendored skill "fresh"');
	});

	it.each([
		[
			"a PENDING in a hook",
			".claude/hooks/hook.sh",
			`#!/bin/sh\n# ${PENDING}\n`,
			"unfinished-work",
		],
		[
			"a PENDING in a skill the repo wrote",
			".claude/skills/ours/run.js",
			`// ${PENDING}\n`,
			"unfinished-work",
		],
		[
			"a suppression in a skill the repo wrote",
			".claude/skills/ours/run.js",
			`// ${SUPPRESSION}\n`,
			"silenced-checker",
		],
		["a PENDING outside .claude", "packages/sim/src/a.ts", `// ${PENDING}\n`, "unfinished-work"],
	])("still blocks %s", (_, path, content, rule) => {
		setup();
		repo.write({ [path]: content });
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain(`[${rule}] ${path}:`);
	});

	it("still blocks a PENDING in a folder the merge base had, when the same diff records it", () => {
		setup();
		repo.write({
			"skills-lock.json": lock(["upstream", "ours"]),
			".claude/skills/ours/run.js": `// ${PENDING}\n`,
		});
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain("[unfinished-work] .claude/skills/ours/run.js:1");
		expect(r.out).toContain('"ours" is new in skills-lock.json');
	});

	it("skips a folder recorded at the merge base, once a later diff changes it", () => {
		setup({ ...BASE, "skills-lock.json": lock(["upstream", "ours"]) });
		repo.write({ ".claude/skills/ours/run.js": `// ${PENDING}\n` });
		expect(guard().code).toBe(0);
	});

	it.each([
		["a path", "../hooks"],
		["a nested path", "upstream/../../hooks"],
		["the folder itself", ".."],
	])("never lets a name that is %s skip anything", (_, name) => {
		setup();
		repo.write({
			"skills-lock.json": lock(["upstream", name]),
			".claude/hooks/hook.sh": `#!/bin/sh\n# ${PENDING}\n`,
		});
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain("[unfinished-work] .claude/hooks/hook.sh:2");
	});

	it("skips nothing for an entry with no source", () => {
		setup();
		repo.write({
			"skills-lock.json": `${JSON.stringify({ skills: { fresh: { ref: "x" } } })}\n`,
			".claude/skills/fresh/run.js": `// ${PENDING}\n`,
		});
		expect(guard().code).toBe(1);
	});

	it("skips nothing when skills-lock.json doesn't parse, and says so", () => {
		setup();
		repo.write({
			"skills-lock.json": "{ not json",
			".agents/skills/upstream/run.js": `// ${PENDING}\n`,
		});
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain("skills-lock.json doesn't parse");
	});

	it("still reports a file moved into a vendored folder from outside it", () => {
		setup({
			...BASE,
			"packages/sim/src/a.test.ts": "it('a', () => {\n  expect(1).toBe(1);\n});\n",
		});
		repo.git("mv", "packages/sim/src/a.test.ts", ".agents/skills/upstream/a.test.ts");
		repo.write({
			".agents/skills/upstream/a.test.ts": `it.${"sk" + "ip"}('a', () => {\n  expect(1).toBe(1);\n});\n`,
		});
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain("[test-made-easier] .agents/skills/upstream/a.test.ts:1");
	});
});
