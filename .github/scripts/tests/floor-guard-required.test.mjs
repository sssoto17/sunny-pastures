// Required checks (#308): `guard / floor` reads ADR-0002 area 2's check-name table, so a new `if:`
// blocks only on a job or step that backs a required check, and removing a required job's `run:`
// step is a removed check. In their own file, apart from floor-guard.test.mjs, so other work on the
// guard merges cleanly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { requiredChecks } from "../floor-guard.mjs";
import { makeRepo } from "./test-repo.mjs";

const SCRIPT = fileURLToPath(new URL("../floor-guard.mjs", import.meta.url));
const TODAY = { FLOOR_GUARD_TODAY: "2026-11-10" };
const real = (path) =>
	readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
const ADR = "docs/adr/0002-github-platform.md";
const CI = ".github/workflows/ci.yml";
const CONSTRAINTS = `# Constraints\n\n## Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n| _none_ | | | | | |\n`;
const TABLE = [
	"# ADR-0002",
	"",
	"| Check | Covers |",
	"|---|---|",
	"| `guard / floor` | the floor guard |",
	"| `ci / test` | unit tests |",
	"| `ci / scripts` | the shell suites |",
	"| `preview / axe`, `preview / bundle` | the preview |",
	"",
	"`ci / mutation` is not required.",
	"",
].join("\n");
const WORKFLOW = `name: ci
jobs:
  gate:
    name: ci / gate
    steps:
      - run: echo gate
  test:
    name: ci / test
    needs: [gate]
    steps:
      - run: pnpm test
  scripts:
    name: "ci / scripts" # quoted
    needs:
      - gate
    steps:
      - name: Run the suites
        run: bash .github/scripts/shell-suites.sh
  mutation:
    name: ci / mutation
    steps:
      - name: Mutate
        run: pnpm mutate
  review:
    name: review
    steps:
      - name: Run Claude
        run: claude
`;

let repo;
afterEach(() => repo?.cleanup());
const guard = () => repo.run(SCRIPT, [], TODAY);
const setup = (files = {}) =>
	(repo = makeRepo({ "CONSTRAINTS.md": CONSTRAINTS, [ADR]: TABLE, [CI]: WORKFLOW, ...files }));
const edit = (from, to) => repo.write({ [CI]: WORKFLOW.replace(from, to) });

describe("requiredChecks", () => {
	it("reads every check name in the table's first column, and nothing else", () => {
		expect(requiredChecks(TABLE.split("\n"))).toEqual([
			"guard / floor",
			"ci / test",
			"ci / scripts",
			"preview / axe",
			"preview / bundle",
		]);
	});

	it("is empty when there is no check-name table", () => {
		expect(
			requiredChecks(["# ADR", "", "| Check | Why |", "|---|---|", "| `ci / test` | x |"]),
		).toEqual([]);
	});

	// `gh api repos/sssoto17/sunny-pastures/rulesets/26816327`, 22 Nov 2026: ruleset `main checks`.
	// The table is the one source, so it must hold every check the ruleset requires.
	it("finds every check of ruleset `main checks` in the real ADR-0002", () => {
		const ruleset = [
			"ci / audit",
			"ci / lint",
			"ci / test",
			"ci / typecheck",
			"guard / code-scan",
			"guard / floor",
			"guard / secrets",
			"ci / determinism",
			"ci / scripts",
			"guard / pr-body",
			"guard / stack-base",
			"guard / code-owned",
			"ci / bench",
			"ci / boundaries",
			"guard / acceptance",
		];
		expect(requiredChecks(real(ADR).split("\n"))).toEqual(expect.arrayContaining(ruleset));
	});
});

describe("a new `if:` in a workflow (#308)", () => {
	it.each([
		[
			"a step of a job that is no required check",
			"      - name: Run Claude\n",
			"      - name: Run Claude\n        if: always()\n",
		],
		[
			"a job that is no required check",
			"    name: review\n",
			"    name: review\n    if: github.actor != 'bot'\n",
		],
		[
			"a job the table leaves out (`ci / mutation`)",
			"    name: ci / mutation\n",
			"    name: ci / mutation\n    if: false\n",
		],
	])("passes on %s", (_, from, to) => {
		setup();
		edit(from, to);
		const r = guard();
		expect(r.out).not.toContain("[check-removed]");
		expect(r.code).toBe(0);
	});

	it.each([
		["a required job", "    name: ci / test\n", "    name: ci / test\n    if: false\n"],
		[
			"a step of a required job",
			"      - name: Run the suites\n",
			"      - name: Run the suites\n        if: false\n",
		],
		[
			"a job a required job needs, flow list",
			"    name: ci / gate\n",
			"    name: ci / gate\n    if: false\n",
		],
		[
			"a step of a job a required job needs",
			"      - run: echo gate\n",
			"      - if: false\n        run: echo gate\n",
		],
	])("fails on %s", (_, from, to) => {
		setup();
		edit(from, to);
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain(`[check-removed] ${CI}`);
	});

	it("follows a block list of `needs:`", () => {
		setup();
		repo.write({
			[CI]: WORKFLOW.replace(
				"    name: ci / test\n    needs: [gate]\n",
				"    name: ci / test\n",
			).replace("  gate:\n    name: ci / gate\n", "  gate:\n    name: ci / gate\n    if: false\n"),
		});
		expect(guard().code).toBe(1); // still needed by `ci / scripts`, through its block list
	});

	it("still counts a check the same PR drops from the table", () => {
		setup();
		repo.write({ [ADR]: TABLE.replace("| `ci / test` | unit tests |\n", "") });
		edit("    name: ci / test\n", "    name: ci / test\n    if: false\n");
		expect(guard().out).toContain(`[check-removed] ${CI}`);
	});

	it("counts every job as required, and says so, when the base has no table", () => {
		repo = makeRepo({ "CONSTRAINTS.md": CONSTRAINTS, [CI]: WORKFLOW });
		edit("    name: review\n", "    name: review\n    if: false\n");
		const r = guard();
		expect(r.out).toContain(`[check-removed] ${CI}`);
		expect(r.out).toContain("no check-name table in docs/adr/0002-github-platform.md");
	});

	it("counts any `if:` in a composite action, which a required job may use", () => {
		const action = ".github/actions/setup/action.yml";
		const steps =
			"runs:\n  using: composite\n  steps:\n    - run: pnpm install\n      shell: bash\n";
		setup({ [action]: steps });
		repo.write({ [action]: steps.replace("    - run:", "    - if: false\n      run:") });
		expect(guard().out).toContain(`[check-removed] ${action}`);
	});

	// #295's change on the real files: an `if:` on the `claude` step of `review.yml`, whose jobs are
	// no required check, against the real ADR-0002.
	it("passes #295's `if:` in the real review.yml", () => {
		const path = ".github/workflows/review.yml";
		const text = real(path);
		repo = makeRepo({ "CONSTRAINTS.md": CONSTRAINTS, [ADR]: real(ADR), [path]: text });
		const step = "      - name: Install the review skill (main's copy)\n";
		expect(text).toContain(step);
		repo.write({
			[path]: text.replace(step, `${step}        if: steps.gather.outputs.run == 'true'\n`),
		});
		const r = guard();
		expect(r.out).not.toContain("[check-removed]");
		expect(r.code).toBe(0);
	});
});

describe("a removed step in a workflow (#308)", () => {
	it("fails when the shell-suites step of `ci / scripts` goes", () => {
		setup();
		edit("      - name: Run the suites\n        run: bash .github/scripts/shell-suites.sh\n", "");
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain(`[check-removed] ${CI}`);
	});

	it("fails when any `run:` step of a required job goes", () => {
		setup();
		edit("      - run: echo gate\n", "      - run: true\n");
		expect(guard().out).toContain(`[check-removed] ${CI}`);
	});

	it("passes a `run:` step removed from a job that is no required check", () => {
		setup();
		edit("      - name: Run Claude\n        run: claude\n", "");
		expect(guard().code).toBe(0);
	});

	it("fails when the real ci.yml loses its shell-suites step", () => {
		const text = real(CI);
		const step =
			/\n {6}- name: Run the suites\n(?: {8}.*\n)*? {8}run: bash \.github\/scripts\/shell-suites\.sh\n/;
		expect(text).toMatch(step);
		repo = makeRepo({ "CONSTRAINTS.md": CONSTRAINTS, [ADR]: real(ADR), [CI]: text });
		repo.write({ [CI]: text.replace(step, "\n") });
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain(`[check-removed] ${CI}`);
	});
});
