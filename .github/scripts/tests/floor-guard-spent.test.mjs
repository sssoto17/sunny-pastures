// Spent Exceptions rows (#271): a row in the merge base's table can no longer waive anything, so
// `guard / floor` names it as a warning, never a finding. In their own file, apart from
// floor-guard.test.mjs, so other work on the guard merges cleanly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { makeRepo } from "./test-repo.mjs";

const SCRIPT = fileURLToPath(new URL("../floor-guard.mjs", import.meta.url));
const TODAY = { FLOOR_GUARD_TODAY: "2026-11-10" };
const NONE = "| _none_ | | | | | |";
const constraints = (rows) =>
	`# Constraints\n\n## Floor\n\n- Secrets in source: blocked.\n\n## Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${rows.join("\n") || NONE}\n`;
const row = (id, path, expires = "2026-11-30") =>
	`| ${id} | silenced-checker | \`${path}\` | reason | Soto | ${expires} |`;

// The rows each cleanup PR removed, verbatim from `git show <base>:CONSTRAINTS.md`, and the files
// their Paths named, which all existed at that base.
const BASES = {
	"be771f4 (#139)": {
		rows: [
			"| E1 | check-removed | `.github/workflows/ci.yml` | The floor job runs `actions/setup-node` directly instead of the PR's own `./.github/actions/setup` (#99, part 4). A follow-up PR removes this row once that merges | Soto | 2026-11-12 |",
		],
		files: [".github/workflows/ci.yml"],
		ids: ["E1"],
	},
	"d956567 (#172)": {
		rows: [
			"| E2 | config-loosened | `eslint.config.mjs` | #125 part 2: `tseslint.configs.strict` is replaced by `strictTypeChecked`, which includes it, plus `stylisticTypeChecked` (ADR-0005, section 6). `disableTypeChecked` covers only JS and config files, where no typed rule ran before; the default-export rule's `ignores` keeps it out of Next's `app/`. No rule that ran before is turned off | Soto | 2026-11-23 |",
			"| E3 | config-loosened | `vitest.config.mts` | #125 part 2: `coverage.exclude` adds `**/tests/**`, so test helpers aren't counted as source. Every source file stays under `coverage.include`, since source never sits in a `tests/` folder (ADR-0005, section 4) | Soto | 2026-11-23 |",
			"| E4 | config-loosened | `packages/sim/tsconfig.json` | #125 part 2: `exclude` adds `src/**/tests/**`, which `tsconfig.test.json` now compiles, with the same strict options (ADR-0005, section 4) | Soto | 2026-11-23 |",
			"| E5 | config-loosened | `.fallowrc.jsonc` | #125 part 2c: the new Fallow config sets `ignoreDefaults: false`, which tightens: Fallow's defaults leave `*.test.ts` files out of duplication, and the duplication row covers the sim's tests | Soto | 2026-11-23 |",
			"| E6 | config-loosened | `eslint.config.mjs` | #125 part 3: the new file-name rules' `ignores` keeps them out of Next's `app/`, whose file names the framework dictates (ADR-0005, section 5). No rule that ran before changes | Soto | 2026-11-23 |",
		],
		files: [
			"eslint.config.mjs",
			"vitest.config.mts",
			"packages/sim/tsconfig.json",
			".fallowrc.jsonc",
		],
		ids: ["E2", "E3", "E4", "E5", "E6"],
	},
	"7445d76 (#238)": {
		rows: [
			"| E1 | check-removed | .github/workflows/check-103-claude.yml | #103's check moves from the draft `scripts/setup/workflows/` (never run by GitHub) to `.github/workflows/`; git pairs the two as a rename, so the job's new `if:` reads as a loosened check. The job is new and required nowhere. Remove this row in the follow-up that deletes the workflow or turns it into #68's reviewer | Soto | 2026-12-12 |",
			'| E7 | rule-removed, rule-narrowed | CONSTRAINTS.md | #68 step 1 (admin, 12 Nov): the "Weakened bar, before `guard / floor`" row is removed because its end condition is met, and the "Content change" row is narrowed from the `content/` folder to content values (Interview record). The guard sees only a PR\'s own diff, so this row is needed only by the PR that makes the change. Remove it in the next PR that edits this file, or let it expire | Soto | 2026-11-26 |',
		],
		files: [".github/workflows/check-103-claude.yml"],
		ids: ["E1", "E7"],
	},
};

let repo;
afterEach(() => repo?.cleanup());
const setup = (rows, files = []) =>
	(repo = makeRepo({
		"CONSTRAINTS.md": constraints(rows),
		...Object.fromEntries(files.map((f) => [f, "x\n"])),
	}));
const guard = (env = TODAY) => repo.run(SCRIPT, [], env);
// The IDs the spent-rows warning lists, one per indented line under it.
const named = (out) => {
	const m = /^floor-guard: warning: \d+ spent Exceptions row\(s\).*\n((?: {2}.*\n?)*)/m.exec(out);
	return m ? [...m[1].matchAll(/^ {2}(E\d+) /gm)].map((x) => x[1]) : [];
};

describe("spent Exceptions rows (#271)", () => {
	it.each(Object.entries(BASES))(
		"names every row at %s, the base of its cleanup PR",
		(_, { rows, files, ids }) => {
			setup(rows, files);
			// The cleanup PR: the rows go, and at #238's base the workflow goes with them.
			repo.write({ "CONSTRAINTS.md": constraints([]) });
			if (files.includes(".github/workflows/check-103-claude.yml"))
				repo.git("rm", "-q", ".github/workflows/check-103-claude.yml");
			repo.commit();
			const r = guard();
			expect(r.code).toBe(0);
			expect(named(r.out)).toEqual(ids);
			expect(r.out).toContain("this PR removes it");
			for (const f of files) expect(r.out).toContain(`\`${f}\``);
		},
	);

	it("names a base row that a later, unrelated PR leaves in place, and stays green", () => {
		setup([row("E1", "packages/sim/src/a.ts")], ["packages/sim/src/a.ts"]);
		repo.write({ "packages/sim/src/b.ts": "export const b = 2;\n" });
		const r = guard();
		expect(r.code).toBe(0);
		expect(named(r.out)).toEqual(["E1"]);
		expect(r.out).toContain("remove it in this PR");
		expect(r.out).not.toContain("no file matches");
	});

	it("says when no file in the checkout matches a row's Path, file or folder", () => {
		setup(
			[row("E1", "packages/sim/src/gone.ts"), row("E2", "packages/sim/"), row("E3", "apps/web/**")],
			["packages/sim/src/a.ts"],
		);
		const out = guard().out;
		expect(named(out)).toEqual(["E1", "E2", "E3"]);
		expect(out).toMatch(/^ {2}E1 .*no file matches its Path/m);
		expect(out).not.toMatch(/^ {2}E2 .*no file matches/m);
		expect(out).toMatch(/^ {2}E3 .*no file matches its Path/m);
	});

	it("names nothing when the base has no rows, or a row-shaped line outside the table", () => {
		setup([], ["packages/sim/src/a.ts"]);
		expect(named(guard().out)).toEqual([]);
		const fenced = constraints([]).replace(
			"## Floor\n",
			`## Floor\n\n\`\`\`\n${row("E1", "packages/sim/src/a.ts")}\n\`\`\`\n`,
		);
		repo = makeRepo({ "CONSTRAINTS.md": fenced, "packages/sim/src/a.ts": "x\n" });
		expect(named(guard().out)).toEqual([]);
	});

	it("does not name a row this PR rewrites, since the new text is what waives", () => {
		setup(
			[row("E1", "packages/sim/src/a.ts"), row("E2", "packages/sim/src/a.ts")],
			["packages/sim/src/a.ts"],
		);
		repo.write({
			"CONSTRAINTS.md": constraints([
				row("E1", "packages/sim/src/a.ts", "2026-12-01"),
				row("E2", "packages/sim/src/a.ts"),
			]),
		});
		expect(named(guard().out)).toEqual(["E2"]);
	});

	it("under Actions, adds one warning annotation on the row and a job summary section", () => {
		setup([row("E1", "packages/sim/src/a.ts")], ["packages/sim/src/a.ts"]);
		const summary = `${repo.dir}/summary.md`;
		const r = guard({ ...TODAY, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary });
		expect(r.code).toBe(0);
		const notes = r.out.split("\n").filter((l) => l.startsWith("::warning"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/^::warning file=CONSTRAINTS\.md,line=11,title=[^:]+::.*E1/);
		expect(readFileSync(summary, "utf8")).toContain("### floor guard: spent Exceptions rows");
	});

	it("keeps GitHub's 10 annotations when the change report fills them", () => {
		const rules = Array.from({ length: 12 }, (_, i) => `- Rule ${i}: at least ${i + 1}.`);
		const text = constraints([row("E1", "packages/sim/src/a.ts")]).replace(
			"- Secrets in source: blocked.",
			rules.join("\n"),
		);
		repo = makeRepo({ "CONSTRAINTS.md": text, "packages/sim/src/a.ts": "x\n" });
		repo.write({ "CONSTRAINTS.md": text.replace(/at least (\d+)/g, "at least $1 or more") });
		const notes = guard({ ...TODAY, GITHUB_ACTIONS: "true" })
			.out.split("\n")
			.filter((l) => l.startsWith("::warning"));
		expect(notes).toHaveLength(10);
		expect(notes.filter((l) => l.includes("spent Exceptions"))).toHaveLength(1);
	});
});
