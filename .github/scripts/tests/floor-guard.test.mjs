import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { enclosingKey, globToRegExp, parseDate, WAIVABLE } from "../floor-guard.mjs";
import { makeRepo } from "./test-repo.mjs";

const SCRIPT = fileURLToPath(new URL("../floor-guard.mjs", import.meta.url));
const TODAY = { FLOOR_GUARD_TODAY: "2026-11-10" };

const CONSTRAINTS = `# Constraints

## Floor

- Secrets in source: blocked.

| Dimension | Rule | Runs at | Required check |
|---|---|---|---|
| Coverage | Changed lines ≥ 90% covered | task end, CI | \`ci / test\` |
| Speed | \`advance()\` ≤ 50 ms | task end, CI | \`ci / bench\` |
| Mutation | Score ≥ 60% | CI | \`ci / mutation\` |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| _none_ | | | | | |
`;
const BASE = {
	"CONSTRAINTS.md": CONSTRAINTS,
	"packages/sim/src/a.ts": "export const a = 1;\n",
	"packages/sim/src/a.test.ts":
		"it('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(2);\n});\n",
	"tsconfig.base.json": '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
	"vitest.config.mts":
		"export default {\n  test: {\n    coverage: {\n      exclude: [\n        '**/*.test.ts',\n      ],\n    },\n  },\n};\n",
};
const row = (id, path, expires, rule = "silenced checker") =>
	`| ${id} | ${rule} | \`${path}\` | reason | Soto | ${expires} |`;
const withException = (r) => CONSTRAINTS.replace("| _none_ | | | | | |", r);

let repo;
afterEach(() => repo?.cleanup());
const setup = () => (repo = makeRepo(BASE));
const guard = (env = TODAY) => repo.run(SCRIPT, [], env);

describe("floor guard, end to end", () => {
	it("passes a clean change, committed or not", () => {
		setup();
		repo.write({ "packages/sim/src/b.ts": "export const b = 2;\n" });
		expect(guard()).toMatchObject({ code: 0 });
		repo.commit();
		expect(guard()).toMatchObject({ code: 0 });
	});

	it("exits 2, never 0, when there is no merge base", () => {
		setup();
		expect(repo.run(SCRIPT, ["--base", "no-such-ref"], TODAY).code).toBe(2);
	});

	it("blocks a suppression in code and reports the location, never the text", () => {
		setup();
		repo.write({ "packages/sim/src/a.ts": "export const a = 1;\n// @ts-ignore hunter2-value\n" });
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts:2");
		expect(r.out).not.toContain("hunter2");
	});

	it.each([
		"eslint-disable-next-line",
		"v8 ignore next",
		"@ts-nocheck",
		"fallow-ignore-file",
		"# noqa",
	])("blocks %s", (s) => {
		setup();
		repo.write({ "packages/sim/src/c.ts": `// ${s}\n` });
		expect(guard().code).toBe(1);
	});

	// #42: the security scans' own suppressions are a weakened bar like any other. A finding
	// silenced inline would turn `guard / code-scan` or `guard / secrets` green with the issue still
	// there.
	it.each([
		["nosemgrep", "packages/sim/src/c.ts", "run(x); // nosemgrep\n"],
		["nosemgrep with a rule id", "packages/sim/src/c.ts", "// nosemgrep: javascript.eval\n"],
		["gitleaks:allow", "packages/sim/src/c.ts", 'const k = "x"; // gitleaks:allow\n'],
		["gitleaks:allow in YAML", ".github/workflows/x.yml", "key: x # gitleaks:allow\n"],
	])("blocks the scanner suppression %s", (_, path, content) => {
		setup();
		repo.write({ [path]: content });
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain(`[silenced-checker] ${path}:1`);
	});

	it("ignores suppressions mentioned in prose", () => {
		setup();
		repo.write({ "docs/x.md": "Never add @ts-ignore or a TODO.\n" });
		expect(guard().code).toBe(0);
	});

	// This file is scanned for skipped tests too, so the modifiers are assembled, never written out.
	const modified = (m) =>
		`it.${m}('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(2);\n});\n`;

	it.each(["skip", "only", "todo"])("blocks a test marked %s", (m) => {
		setup();
		repo.write({ "packages/sim/src/a.test.ts": modified(m) });
		expect(guard().out).toContain("[test-made-easier]");
	});

	describe("the guard's own files", () => {
		const SELF_TEST = ".github/scripts/tests/floor-guard.test.mjs";
		const selfSetup = () =>
			(repo = makeRepo({
				...BASE,
				[SELF_TEST]: "it('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n",
			}));

		it("are checked for skipped tests", () => {
			selfSetup();
			repo.write({ [SELF_TEST]: modified("skip") });
			expect(guard().out).toContain(`[test-made-easier] ${SELF_TEST}`);
		});

		it("are checked for removed assertions and deletion", () => {
			selfSetup();
			repo.write({ [SELF_TEST]: "it('a', () => {\n  expect(1).toBe(1);\n});\n" });
			expect(guard().out).toContain(`[assertion-removed] ${SELF_TEST}`);
			rmSync(join(repo.dir, SELF_TEST));
			expect(guard().out).toContain(`[test-deleted] ${SELF_TEST}`);
		});

		it("may still spell out suppression and stub patterns", () => {
			selfSetup();
			repo.write({
				".github/scripts/floor-guard.mjs":
					"// @ts-ignore, TODO and an empty catch {} are patterns here\n",
			});
			expect(guard().code).toBe(0);
		});
	});

	// Review of #134: CI runs the PR's own package.json scripts, so dropping a check from one (or
	// skipping the ratchet outside `check:task`) weakens `ci / typecheck` or `check:full` quietly.
	describe("package.json scripts", () => {
		const SCRIPTS = (typecheck, full) =>
			`{\n  "scripts": {\n    "typecheck": "${typecheck}",\n    "check:task": "pnpm test:related && pnpm coverage:gate --skip-ratchet",\n    "check:full": "${full}"\n  }\n}\n`;
		const OK = SCRIPTS(
			"tsc -b && node .github/scripts/typecheck-reach.mjs",
			"pnpm test && pnpm coverage:gate",
		);

		it.each([
			["a check dropped from a script", SCRIPTS("tsc -b", "pnpm test && pnpm coverage:gate")],
			[
				"the ratchet skipped outside check:task",
				SCRIPTS(
					"tsc -b && node .github/scripts/typecheck-reach.mjs",
					"pnpm test && pnpm coverage:gate --skip-ratchet",
				),
			],
		])("blocks %s", (_, content) => {
			repo = makeRepo({ ...BASE, "package.json": OK });
			repo.write({ "package.json": content });
			expect(guard().out).toContain("[check-removed] package.json");
		});

		// #125: the formatting and duplication checks run as scripts too.
		describe("the formatting and duplication checks", () => {
			const GLOB = "**/*.{ts,tsx,mts,mjs,js,json}";
			const WITH = (fast, format, task) =>
				`{\n  "scripts": {\n    "format:check": "prettier --check \\"${format}\\"",\n    "check:fast": "${fast}",\n    "check:task": "${task}"\n  }\n}\n`;
			const FAST = "pnpm typecheck && pnpm format:check && pnpm guard:floor";
			const TASK = "pnpm check:fast && pnpm dupes --changed-since origin/main";
			const run = (content) => {
				repo = makeRepo({ ...BASE, "package.json": WITH(FAST, GLOB, TASK) });
				repo.write({ "package.json": content });
				return guard();
			};

			it.each([
				[
					"format:check dropped from check:fast",
					WITH("pnpm typecheck && pnpm guard:floor", GLOB, TASK),
				],
				["dupes dropped from check:task", WITH(FAST, GLOB, "pnpm check:fast")],
				[
					"prettier --check dropped from format:check",
					WITH(FAST, GLOB, TASK).replace(`prettier --check \\"${GLOB}\\"`, "true"),
				],
				["a file type dropped from the formatting glob", WITH(FAST, "**/*.{ts,tsx}", TASK)],
			])("blocks %s", (_, content) => {
				expect(run(content).out).toContain("[check-removed] package.json");
			});

			it("accepts a wider formatting glob", () => {
				expect(run(WITH(FAST, "**/*.{ts,tsx,mts,mjs,js,json,css}", TASK)).code).toBe(0);
			});
		});

		it("accepts an unrelated script edit", () => {
			repo = makeRepo({ ...BASE, "package.json": OK });
			repo.write({
				"package.json": OK.replace('"check:full"', '"lint": "eslint .",\n    "check:full"'),
			});
			expect(guard().code).toBe(0);
		});
	});

	describe("workflows", () => {
		const CI = ".github/workflows/ci.yml";
		const STEPS =
			'jobs:\n  test:\n    steps:\n      - run: pnpm test\n  floor:\n    steps:\n      - run: git show "origin/$BASE_REF:x" > "$dir/x"\n      - run: node guard.mjs\n';

		it.each([
			[
				"a removed check step",
				STEPS.replace("      - run: pnpm test\n", "      - run: echo skipped\n"),
			],
			["a changed line in the floor job", STEPS.replace("node guard.mjs", "true")],
			[
				"a job allowed to fail",
				STEPS.replace("  test:\n", "  test:\n    continue-on-error: true\n"),
			],
		])("block %s", (_, content) => {
			repo = makeRepo({ ...BASE, [CI]: STEPS });
			repo.write({ [CI]: content });
			expect(guard().out).toContain(`[check-removed] ${CI}`);
		});

		// #264: `ci / stack` decides whether typecheck, lint and test run, so it's guarded like the
		// floor job: writing `top=false` by hand would skip them, and a skipped job reports passing.
		const STACK =
			'jobs:\n  stack:\n    steps:\n      - id: top\n        run: node "$dir/stack-base-guard.mjs" --top\n  test:\n    steps:\n      - run: pnpm test\n';
		it.each([
			[
				"the decision replaced",
				STACK.replace(
					'node "$dir/stack-base-guard.mjs" --top',
					'echo top=false >> "$GITHUB_OUTPUT"',
				),
			],
			[
				"a step added to the stack job",
				STACK.replace("      - id: top\n", "      - run: true\n      - id: top\n"),
			],
		])("block %s in the stack job", (_, content) => {
			repo = makeRepo({ ...BASE, [CI]: STACK });
			repo.write({ [CI]: content });
			expect(guard().out).toContain(`[check-removed] ${CI}`);
		});

		// #264: `guard / stack-base` runs main's copy of its script from a checkout of its own; pointing
		// that checkout at the PR's head would run the PR's copy, so the job is guarded too.
		it("block a changed checkout ref in the stack-base job", () => {
			const base =
				"jobs:\n  stack-base:\n    steps:\n      - uses: actions/checkout@0000000000000000000000000000000000000000\n        with:\n          ref: ${{ github.event.repository.default_branch }}\n      - run: node guard.mjs\n";
			repo = makeRepo({ ...BASE, [CI]: base });
			repo.write({
				[CI]: base.replace(
					"${{ github.event.repository.default_branch }}",
					"${{ github.head_ref }}",
				),
			});
			expect(guard().out).toContain(`[check-removed] ${CI}`);
		});

		// #337: `guard / code-owned` runs main's copy of its script and CODEOWNERS; a PR that points the
		// run at its own list, or replaces the run, would pass its own code-owned paths.
		const OWNED =
			'jobs:\n  code-owned:\n    steps:\n      - run: node "$dir/code-owned-guard.mjs" --codeowners "$dir/CODEOWNERS"\n';
		it.each([
			["the list swapped for the PR's", OWNED.replace('"$dir/CODEOWNERS"', ".github/CODEOWNERS")],
			["the run replaced", OWNED.replace(/node .*\n/, "true\n")],
		])("block %s in the code-owned job", (_, content) => {
			repo = makeRepo({ ...BASE, [CI]: OWNED });
			repo.write({ [CI]: content });
			expect(guard().out).toContain(`[check-removed] ${CI}`);
		});

		// #125: the duplication and formatting checks run as steps of `ci / lint`.
		it.each(['pnpm dupes --changed-since "origin/$BASE_REF"', "pnpm format:check"])(
			"block a removed `%s` step",
			(step) => {
				const steps = `jobs:\n  lint:\n    steps:\n      - run: pnpm lint\n      - run: ${step}\n`;
				repo = makeRepo({ ...BASE, [CI]: steps });
				repo.write({ [CI]: steps.replace(`      - run: ${step}\n`, "") });
				expect(guard().out).toContain(`[check-removed] ${CI}`);
			},
		);

		// #99: a local action (`uses: ./…`) is read from the PR's checkout, so a PR could change what the
		// floor job runs before the base branch's guard starts. The floor job uses pinned actions only.
		it("run no action from the PR in the floor job", () => {
			const lines = readFileSync(
				fileURLToPath(new URL("../../workflows/ci.yml", import.meta.url)),
				"utf8",
			).split("\n");
			const start = lines.findIndex((l) => /^ {2}floor:\s*$/.test(l));
			const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
			const floor = lines.slice(start, end === -1 ? undefined : end);
			expect(start).toBeGreaterThan(-1);
			expect(floor.filter((l) => /uses:\s*\.\//.test(l))).toEqual([]);
			expect(floor.filter((l) => /uses:/.test(l)).every((l) => /@[0-9a-f]{40}\b/.test(l))).toBe(
				true,
			);
		});

		// Runs the real step from ci.yml, so the test breaks if the step changes shape.
		const takeGuardStep = () => {
			const lines = readFileSync(
				fileURLToPath(new URL("../../workflows/ci.yml", import.meta.url)),
				"utf8",
			).split("\n");
			const start =
				lines.findIndex((l) => l.includes("name: Take the guard from the base branch")) + 2;
			const end = lines.findIndex((l, i) => i >= start && !l.startsWith("          "));
			return lines
				.slice(start, end)
				.map((l) => l.slice(10))
				.join("\n");
		};
		// The step checks the guard's ref out as a worktree in RUNNER_TEMP, outside the checkout, so
		// the checkout the guard diffs stays clean (#132).
		const runTakeGuard = () => {
			const temp = mkdtempSync(join(tmpdir(), "runner-temp-"));
			try {
				const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", takeGuardStep()], {
					cwd: repo.dir,
					env: { ...process.env, BASE_REF: "main", RUNNER_TEMP: temp },
					encoding: "utf8",
				});
				expect(r.status).toBe(0);
				expect(repo.git("status", "--porcelain")).toBe("");
				return readFileSync(join(temp, "floor-guard", ".github/scripts/floor-guard.mjs"), "utf8");
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		};

		it("make guard / floor run the base branch's guard, not the PR's", () => {
			repo = makeRepo({
				...BASE,
				".github/scripts/floor-guard.mjs": "base guard\n",
				".github/scripts/diff.mjs": "base diff\n",
			});
			repo.git("update-ref", "refs/remotes/origin/main", "main");
			repo.write({ ".github/scripts/floor-guard.mjs": "process.exit(0);\n" });
			repo.commit();
			expect(runTakeGuard()).toBe("base guard\n");
		});

		it("make guard / floor fall back to the PR's guard while the base has none", () => {
			setup();
			repo.git("update-ref", "refs/remotes/origin/main", "main");
			repo.write({
				".github/scripts/floor-guard.mjs": "new guard\n",
				".github/scripts/diff.mjs": "new diff\n",
			});
			repo.commit();
			expect(runTakeGuard()).toBe("new guard\n");
		});

		// #99: Dependabot's weekly github-actions bump moves only the pinned SHA (#69).
		const SHA_A = "a".repeat(40);
		const SHA_B = "b".repeat(40);
		const PINNED = STEPS.replace(
			"  floor:\n    steps:\n",
			`  floor:\n    steps:\n      - uses: actions/checkout@${SHA_A} # v7.0.1\n`,
		);
		// Security review of #133: any SHA can be an imposter commit from a fork, so only Dependabot's
		// own PRs get the exemption (GITHUB_ACTOR, set by the runner).
		const DEPENDABOT = { ...TODAY, GITHUB_ACTOR: "dependabot[bot]" };
		const BUMP = PINNED.replace(`@${SHA_A} # v7.0.1`, `@${SHA_B} # v7.1.0`);
		it.each([
			["a SHA-only bump in the floor job by Dependabot", BUMP, DEPENDABOT, 0],
			[
				"a SHA-only bump in the floor job by anyone else",
				BUMP,
				{ ...TODAY, GITHUB_ACTOR: "sssoto17" },
				1,
			],
			[
				"a SHA-only bump committed by someone other than Dependabot",
				BUMP,
				{ ...DEPENDABOT, COMMIT: "yes" },
				1,
			],
			["a SHA-only bump from a fork", BUMP, { ...DEPENDABOT, FORK: "yes" }, 1],
			[
				"a SHA-only bump in a PR opened by someone else",
				BUMP,
				{ ...DEPENDABOT, AUTHOR: "sssoto17" },
				1,
			],
			[
				"another action in its place",
				PINNED.replace(`actions/checkout@${SHA_A}`, `actions/other@${SHA_B}`),
				DEPENDABOT,
				1,
			],
			["a tag instead of a SHA", PINNED.replace(`@${SHA_A} # v7.0.1`, "@v7"), DEPENDABOT, 1],
			// Review of #133: a bump in one job paired with a line deleted from, or added to, another.
			[
				"a bump elsewhere hiding a floor-job deletion",
				`jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${SHA_B} # v7.1.0\n      - run: pnpm test\n  floor:\n    steps:\n      - run: git show "origin/$BASE_REF:x" > "$dir/x"\n      - run: node guard.mjs\n`,
				DEPENDABOT,
				1,
			],
			[
				"a second checkout added to the floor job",
				PINNED.replace(
					`      - uses: actions/checkout@${SHA_A} # v7.0.1\n`,
					`      - uses: actions/checkout@${SHA_B} # v7.1.0\n      - uses: actions/checkout@${SHA_B} # v7.1.0\n`,
				),
				DEPENDABOT,
				1,
			],
		])("judge %s", (_, content, { COMMIT, FORK, AUTHOR, ...env }, code) => {
			repo = makeRepo({ ...BASE, [CI]: PINNED });
			repo.write({ [CI]: content });
			if (COMMIT) repo.commit(); // committed by "test", not dependabot[bot]
			// The pull_request event payload the runner provides (GITHUB_EVENT_PATH).
			const event = join(repo.dir, ".event.json");
			writeFileSync(
				event,
				JSON.stringify({
					pull_request: {
						user: { login: AUTHOR ?? "dependabot[bot]" },
						head: { repo: { full_name: FORK ? "someone/fork" : "sssoto17/sunny-pastures" } },
						base: { repo: { full_name: "sssoto17/sunny-pastures" } },
					},
				}),
			);
			const r = guard({ ...env, GITHUB_EVENT_PATH: event });
			expect(r.code).toBe(code);
			if (code) expect(r.out).toContain(`[check-removed] ${CI}`);
		});

		it("name the real route for a blocked floor-job change", () => {
			repo = makeRepo({ ...BASE, [CI]: STEPS });
			repo.write({ [CI]: STEPS.replace("node guard.mjs", "true") });
			const r = guard();
			expect(r.out).toContain("no bypass");
			expect(r.out).toContain("an Exceptions row for `check-removed`");
			expect(r.out).toContain("lifts `main checks`");
		});

		it("accept unrelated workflow edits, and a floor job or workflow that is new", () => {
			repo = makeRepo({ ...BASE, [CI]: STEPS });
			repo.write({ [CI]: `name: ci\n${STEPS}` });
			expect(guard().code).toBe(0);
			repo.write({
				[CI]: "jobs:\n  test:\n    steps:\n      - run: pnpm test\n",
				".github/workflows/new.yml": "jobs:\n  x:\n    if: github.actor != 'bot'\n",
			});
			repo.commit();
			repo.git("switch", "-q", "-C", "main");
			repo.git("switch", "-q", "-c", "add-floor");
			repo.write({ [CI]: STEPS });
			expect(guard().code).toBe(0);
		});
	});

	it("blocks a deleted test file but not a moved one", () => {
		setup();
		rmSync(join(repo.dir, "packages/sim/src/a.test.ts"));
		expect(guard().out).toContain("[test-deleted]");
		repo.write({ "packages/sim/src/a.test.ts": BASE["packages/sim/src/a.test.ts"] });
		renameSync(
			join(repo.dir, "packages/sim/src/a.test.ts"),
			join(repo.dir, "packages/sim/src/renamed.test.ts"),
		);
		expect(guard().code).toBe(0); // unstaged move
		repo.commit();
		expect(guard().code).toBe(0); // committed move, found by git's rename detection
	});

	it("blocks removed assertions, not edited ones", () => {
		setup();
		repo.write({
			"packages/sim/src/a.test.ts":
				"it('a', () => {\n  expect(a).toBe(1);\n  expect(a).not.toBe(3);\n});\n",
		});
		expect(guard().code).toBe(0);
		repo.write({ "packages/sim/src/a.test.ts": "it('a', () => {\n  expect(a).toBe(1);\n});\n" });
		expect(guard().out).toContain("[assertion-removed]");
	});

	it("blocks a cut property run count", () => {
		setup();
		repo.write({ "packages/sim/src/p.test.ts": "fc.assert(prop, { numRuns: 1000 });\n" });
		repo.commit();
		repo.git("switch", "-q", "-C", "main");
		repo.git("switch", "-q", "-c", "cut");
		repo.write({ "packages/sim/src/p.test.ts": "fc.assert(prop, { numRuns: 10 });\n" });
		expect(guard().out).toContain("[property-runs-cut]");
	});

	// #99: deleting the run count outright falls back to the library default.
	it.each([
		["numRuns", "fc.assert(prop, { numRuns: 1000 });\n", "fc.assert(prop);\n"],
		[
			"SIM_PROPERTY_RUNS",
			"const runs = Number(process.env.SIM_PROPERTY_RUNS ?? 100);\nexport default { runs };\n",
			"export default {};\n",
		],
	])("blocks %s deleted outright", (_, before, after) => {
		setup();
		repo.write({ "packages/sim/src/p.test.ts": before });
		repo.commit();
		repo.git("switch", "-q", "-C", "main");
		repo.git("switch", "-q", "-c", "cut");
		repo.write({ "packages/sim/src/p.test.ts": after });
		expect(guard().out).toContain("[property-runs-cut]");
	});

	// Review of #133: a run count held in a variable, one fooled by a comment, and one in a comment.
	it.each([
		[
			"a run count from a variable, deleted",
			"fc.assert(p, { seed: 1, numRuns: simPropertyRuns });\n",
			"fc.assert(p, { seed: 1 });\n",
		],
		[
			"a run count from a variable, replaced by a literal",
			"fc.assert(p, { numRuns: simPropertyRuns });\n",
			"fc.assert(p, { numRuns: 1 });\n",
		],
		[
			"a run count left only in a comment",
			"// SIM_PROPERTY_RUNS: 100 when unset\nconst runs = Number(env.SIM_PROPERTY_RUNS ?? 100);\n",
			"// SIM_PROPERTY_RUNS: 100 when unset\nconst runs = 1;\n",
		],
		[
			"a run count cut behind a comment",
			"fc.assert(p, { numRuns: 1000 });\n",
			"fc.assert(p, { numRuns: N /* 1000 */ });\n",
		],
		// Independent review of #133: kept values match one to one.
		[
			"one of two run counts removed",
			"fc.assert(a, { numRuns: 200 });\nfc.assert(b, { numRuns: 200 });\n",
			"fc.assert(a, { numRuns: 200 });\nfc.assert(b);\n",
		],
		[
			"the env default replaced by a literal",
			"// SIM_PROPERTY_RUNS: 100 when unset\nconst simPropertyRuns = Number(process.env['SIM_PROPERTY_RUNS'] ?? 100);\n",
			"// SIM_PROPERTY_RUNS: 100 when unset\nconst simPropertyRuns = 5;\n",
		],
		[
			"the provide line deleted",
			"const runs = 100;\nexport default { provide: { fastCheck: { seed: 1, numRuns: runs } } };\n",
			"const runs = 100;\nexport default {};\n",
		],
	])("blocks %s", (_, before, after) => {
		setup();
		repo.write({ "packages/sim/src/p.test.ts": before });
		repo.commit();
		repo.git("switch", "-q", "-C", "main");
		repo.git("switch", "-q", "-c", "cut");
		repo.write({ "packages/sim/src/p.test.ts": after });
		expect(guard().out).toContain("[property-runs-cut]");
	});

	it("blocks deleting a non-test file that holds a run count", () => {
		setup();
		repo.write({
			"vitest.config.mts": "export default { provide: { fastCheck: { numRuns: 100 } } };\n",
		});
		repo.commit();
		repo.git("switch", "-q", "-C", "main");
		repo.git("switch", "-q", "-c", "gone");
		rmSync(join(repo.dir, "vitest.config.mts"));
		expect(guard().out).toContain("[property-runs-cut] vitest.config.mts");
	});

	it("accepts a run count that moved within its file", () => {
		setup();
		repo.write({
			"packages/sim/src/p.test.ts": "fc.assert(a, { numRuns: 1000 });\nfc.assert(b);\n",
		});
		repo.commit();
		repo.git("switch", "-q", "-C", "main");
		repo.git("switch", "-q", "-c", "move");
		repo.write({
			"packages/sim/src/p.test.ts": "fc.assert(b);\nfc.assert(a, { numRuns: 1000 });\n",
		});
		expect(guard().code).toBe(0);
	});

	it.each([
		["every fallow-ignore form", "// fallow-ignore-next-line unused-export\n"],
		["a fallow-ignore for a block", "// fallow-ignore-start\n"],
	])("blocks %s", (_, code) => {
		setup();
		repo.write({ "packages/sim/src/c.ts": code });
		expect(guard().out).toContain("[silenced-checker]");
	});

	// #135: a new tsconfig's strictness is read through the TypeScript API now (tsconfigs.test.mjs),
	// and the code patterns of unfinished work are ESLint rules (floor-lint.test.mjs). The guard
	// keeps a TODO in any file, and keeps those rules from being switched off.
	it.each([
		["a TODO in code", "packages/sim/src/s.ts", "// TODO\n"],
		["a TODO in a file ESLint never reads", "supabase/seed.sql", "-- TODO\n"],
	])("always blocks %s", (_, file, code) => {
		setup();
		repo.write({
			[file]: code,
			"CONSTRAINTS.md": withException(row("E1", "packages/sim/**", "2026-11-20")),
		});
		expect(guard().out).toContain("[unfinished-work]");
	});

	// A directive that switches off a rule holding unfinished work can't be waived, as the work it
	// hides can't be: a blanket disable, one naming such a rule, or an inline config for one.
	it.each([
		["a disable of the stub selectors", "// eslint-disable-next-line no-restricted-syntax\n"],
		["a disable among other rules", "/* eslint-disable eqeqeq, no-empty -- why */\n"],
		[
			"a disable of empty functions",
			"// eslint-disable-line @typescript-eslint/no-empty-function\n",
		],
		["a blanket disable", "/* eslint-disable */\n"],
		["a blanket disable for one line", "f(); // eslint-disable-line\n"],
		["an inline config turning the selectors off", "/* eslint no-restricted-syntax: off */\n"],
		[
			"an inline config replacing the selectors",
			'/*eslint no-restricted-syntax: ["error", "X"]*/\n',
		],
		["an inline config turning no-empty off", "/* eslint no-empty: 0 */\n"],
	])("always blocks %s", (_, code) => {
		setup();
		repo.write({
			"packages/sim/src/s.ts": code,
			"CONSTRAINTS.md": withException(row("E1", "packages/sim/**", "2026-11-20")),
		});
		const r = guard();
		expect(r.out).toContain("[unfinished-work] packages/sim/src/s.ts:1");
		expect(r.code).toBe(1);
	});

	// Review of the #135 stack: a comment that only mentions ESLint is no inline config.
	it.each([
		["/* eslint reads this file with the root config */\n", 0],
		["/* eslint no-empty: 0 -- a real one */\n", 1],
		['/* eslint "no-empty": "off" */\n', 1],
		["/* eslint 'no-empty': 'off' */\n", 1],
		['/* eslint {"no-restricted-syntax": "off"} */\n', 1],
	])("tells prose from an inline config: %s", (code, exit) => {
		setup();
		repo.write({ "packages/sim/src/s.ts": code });
		expect(guard().code).toBe(exit);
	});

	it("waives a disable of another rule, and counts an inline config as a suppression", () => {
		setup();
		repo.write({ "packages/sim/src/s.ts": "// eslint-disable-next-line eqeqeq\n" });
		expect(guard().out).toContain("[silenced-checker]");
		repo.write({
			"CONSTRAINTS.md": withException(row("E1", "packages/sim/**", "2026-11-20")),
		});
		expect(guard().code).toBe(0);
		repo.write({ "packages/sim/src/s.ts": "/* eslint eqeqeq: off */\n" });
		const r = guard({ ...TODAY });
		expect(r.code).toBe(0);
		expect(r.out).toContain("waived by E1");
	});

	// Second comment on #135 (review of #141): lines added around unchanged ones switch them off.
	describe("block comments in a guarded config", () => {
		const CONFIG = [
			"export default [",
			"\t{ files: ['packages/**/*.ts'] },",
			"\t{ rules: { eqeqeq: 'error' } },",
			"];",
			"",
		].join("\n");
		const wrapSetup = () => {
			repo = makeRepo({ ...BASE, "eslint.config.mjs": CONFIG });
		};

		it.each([
			["around a rule", [0, 1, "\t/*", 2, "\t*/", 3], 3],
			[
				"opened on a changed line above",
				[0, "\t{ files: ['packages/**/*.ts'] }, /*", 2, "*/ ];"],
				2,
			],
		])("reports one %s", (_, edit, line) => {
			wrapSetup();
			const lines = CONFIG.split("\n");
			const edited = edit.map((l) => (typeof l === "number" ? lines[l] : l));
			repo.write({ "eslint.config.mjs": `${edited.join("\n")}\n` });
			expect(guard().out).toContain(`[config-loosened] eslint.config.mjs:${line}`);
		});

		// Review of #135: a selector deleted from the floor's lists turns its rule off with no
		// "error" on the line, so any line of the ESLint config removed and not added back counts.
		it("reports a line removed from the ESLint config, and passes one moved", () => {
			wrapSetup();
			const lines = CONFIG.split("\n");
			repo.write({ "eslint.config.mjs": [lines[0], lines[2], lines[3], ""].join("\n") });
			expect(guard().out).toContain("[config-loosened] eslint.config.mjs:2 (old)");
			repo.write({ "eslint.config.mjs": [lines[0], lines[2], lines[1], lines[3], ""].join("\n") });
			expect(guard().code).toBe(0);
		});

		it("reports one around a tsconfig's include entry", () => {
			setup();
			const config = '{\n  "include": [\n    "src"\n  ]\n}\n';
			repo.write({ "packages/sim/tsconfig.json": config });
			repo.commit();
			repo.git("switch", "-q", "-C", "main");
			repo.git("switch", "-q", "-c", "wrap");
			repo.write({
				"packages/sim/tsconfig.json": '{\n  "include": [\n    /*\n    "src"\n    */\n  ]\n}\n',
			});
			expect(guard().out).toContain("[config-loosened] packages/sim/tsconfig.json:3");
		});

		// A `/*` inside a regex literal after `return` is no comment (review of #135).
		it("passes a regex after return that holds what looks like a comment", () => {
			repo = makeRepo({
				...BASE,
				"eslint.config.mjs": `const re = () => {\n\treturn /a\\/*/;\n};\n${CONFIG}`,
			});
			repo.write({
				"eslint.config.mjs": `const re = () => {\n\treturn /b\\/*/;\n};\n${CONFIG}`,
			});
			// The old line is reported as removed; a comment from line 2 would be reported as `:2`.
			const out = guard().out;
			expect(out).toContain("eslint.config.mjs:2 (old)");
			expect(out).not.toMatch(/eslint\.config\.mjs:2$/m);
		});

		it("passes a new comment of its own, and globs that look like comments", () => {
			wrapSetup();
			repo.write({
				"eslint.config.mjs": CONFIG.replace(
					"\t{ rules",
					"\t/**\n\t * Why the rule below is on.\n\t */\n\t{ files: ['**/*.ts', 'a/**/b'] },\n\t{ rules",
				),
			});
			expect(guard().code).toBe(0);
		});
	});

	it.each([
		["a lowered minimum", ["≥ 90%", "≥ 80%"], "threshold-loosened"],
		["a raised maximum", ["≤ 50 ms", "≤ 80 ms"], "threshold-loosened"],
		["a removed rule", ["| Mutation | Score ≥ 60% | CI | `ci / mutation` |\n", ""], "rule-removed"],
		["a dropped severity", ["Score ≥ 60% |", "Score ≥ 60% _(warn)_ |"], "severity-dropped"],
		["a check moved to a later stage", ["≤ 50 ms | task end, CI", "≤ 50 ms | CI"], "stage-moved"],
	])("blocks %s in CONSTRAINTS.md", (_, [from, to], rule) => {
		setup();
		repo.write({ "CONSTRAINTS.md": CONSTRAINTS.replace(from, to) });
		const r = guard();
		expect(r.code).toBe(1);
		expect(r.out).toContain(`[${rule}] CONSTRAINTS.md`);
	});

	it("stays silent when CONSTRAINTS.md is tightened", () => {
		setup();
		repo.write({
			"CONSTRAINTS.md": CONSTRAINTS.replace("≥ 90%", "≥ 95%").replace("≤ 50 ms", "≤ 40 ms"),
		});
		expect(guard().code).toBe(0);
	});

	// The cases the stack review of #94–#97 found passing clean, run against the real file.
	describe("the real CONSTRAINTS.md", () => {
		// The real file without its Exceptions rows: a row already in the base is spent, and its
		// warning would add an annotation to every test here (#342). floor-guard-spent.test.mjs tests those.
		const REAL = readFileSync(
			fileURLToPath(new URL("../../../CONSTRAINTS.md", import.meta.url)),
			"utf8",
		).replace(/^\| E\d+ \|.*\n/gm, "");
		const edit = (text, from, to) => {
			if (!text.includes(from)) throw new Error(`CONSTRAINTS.md no longer contains: ${from}`);
			return text.replace(from, to);
		};
		const realRepo = (text = REAL) => (repo = makeRepo({ "CONSTRAINTS.md": text }));
		// The line a passage starts on in the real file, so the tests survive edits above it.
		const lineOf = (needle) => {
			const n = REAL.split("\n").findIndex((l) => l.includes(needle)) + 1;
			if (!n) throw new Error(`CONSTRAINTS.md no longer contains: ${needle}`);
			return n;
		};
		const PURITY = lineOf("| Boundaries: sim purity");

		it.each([
			[
				"the split size raised in a paragraph",
				"at most **400 changed lines**",
				"at most **800 changed lines**",
				"threshold-loosened",
			],
			// #99: numbers paired by position let a new number in front take the old one's place.
			[
				"the split size raised behind a new cap",
				"at most **400 changed lines**",
				"at most **under 10 files or 800 changed lines**",
				"threshold-loosened",
			],
			[
				"the split size raised in a new cap that took the old unit",
				"at most **400 changed lines**",
				"at most **10 changed files or 800 lines**",
				"threshold-changed",
			],
			// Security review of B2: an extra cap in another unit was compared across units.
			[
				"a cap in a new unit next to the bench budget",
				"largest content farm ≤ 50 ms",
				"largest content farm ≤ 50 ms or 5 s",
				"threshold-loosened",
			],
			// Review of #133: the same number, counting something else.
			[
				"the split size counted in files",
				"at most **400 changed lines**",
				"at most **400 changed files**",
				"threshold-changed",
			],
			[
				"the exception limit counted in weeks",
				"no more than 30 days out",
				"no more than 30 weeks out",
				"threshold-changed",
			],
			// Independent review of #133.
			[
				"a new number after a semicolon in a capped rule",
				"at most **400 changed lines**",
				"at most **400 changed lines; 900 for docs**",
				"threshold-changed",
			],
			[
				"the latency percentile changed",
				"| p95 < 300 ms on the deployed stack |",
				"| p50 < 300 ms on the deployed stack |",
				"rule-narrowed",
			],
			[
				"a cap in a new unit next to the split size",
				"at most **400 changed lines**",
				"at most **400 changed lines or 20 files**",
				"threshold-loosened",
			],
			[
				"the exception limit raised in a paragraph",
				"no more than 30 days out",
				"no more than 90 days out",
				"threshold-loosened",
			],
			[
				"a suppression dropped from a continuation line",
				"`fallow-ignore-next-line`, `fallow-ignore-file`, ",
				"",
				"rule-narrowed",
			],
			[
				"the floor guard dropped from a stage",
				"lint on changed files, floor guard, formatting",
				"lint on changed files, formatting",
				"rule-narrowed",
			],
		])("blocks %s", (_, from, to, rule) => {
			realRepo();
			repo.write({ "CONSTRAINTS.md": edit(REAL, from, to) });
			const r = guard();
			expect(r.code).toBe(1);
			expect(r.out).toContain(`[${rule}] CONSTRAINTS.md`);
		});

		// Re-review of #97: tightenings with no direction words, and a comma-only edit.
		it.each([
			[
				"the split size lowered in the interview record",
				"- **Split size:** 400 changed lines",
				"- **Split size:** 300 changed lines",
			],
			[
				"the ratchet tolerance lowered",
				"| must not fall | 0.5 points |",
				"| must not fall | 0.2 points |",
			],
			[
				"a tighter cap of the same unit added next to the split size",
				"at most **400 changed lines**",
				"at most **400 changed lines, or 300 changed lines for a spike**",
			],
			// Review of #133: "and" adds a second cap that must also hold, which tightens.
			[
				'a cap in a new unit joined with "and"',
				"at most **400 changed lines**",
				"at most **400 changed lines and 20 files**",
			],
			// The listed-items check keeps "Lighthouse mobile:" with the first segment, so LCP stays first.
			[
				"the page budgets reordered",
				"LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms",
				"LCP ≤ 2500 ms, TBT ≤ 200 ms, CLS ≤ 0.1",
			],
			[
				"a comma removed from an unlabelled list item",
				"- **Every failing check blocks the merge**, except",
				"- **Every failing check blocks the merge** except",
			],
		])("stays silent for %s", (_, from, to) => {
			realRepo();
			repo.write({ "CONSTRAINTS.md": edit(REAL, from, to) });
			expect(guard()).toMatchObject({ code: 0 });
		});

		it.each([
			[
				"the split size raised in the interview record",
				"- **Split size:** 400 changed lines",
				"- **Split size:** 500 changed lines",
			],
			[
				"the ratchet tolerance raised",
				"| must not fall | 0.5 points |",
				"| must not fall | 1 points |",
			],
		])("blocks %s", (_, from, to) => {
			realRepo();
			repo.write({ "CONSTRAINTS.md": edit(REAL, from, to) });
			expect(guard().out).toContain("[threshold-loosened] CONSTRAINTS.md");
		});

		// Re-review of #97: a second Exceptions table smuggled in under another heading.
		it.each([
			["a level-3 Exceptions heading", "###"],
			["a second level-2 Exceptions heading", "##"],
		])("ignores an exception row under %s", (_, hashes) => {
			realRepo();
			repo.write({
				"packages/sim/src/a.ts": "// @ts-ignore\n",
				"CONSTRAINTS.md": `${REAL}\n${hashes} Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${row("E1", "packages/sim/src/a.ts", "2026-11-30")}\n`,
			});
			const r = guard();
			expect(r.code).toBe(1);
			expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(r.out).not.toContain("waived by");
		});

		it("waives through the real Exceptions table", () => {
			realRepo();
			// A new row under the table's header, whatever rows the real file holds now. E99 so it can't
			// repeat a real ID.
			const HEADER = "| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n";
			repo.write({
				"packages/sim/src/a.ts": "// @ts-ignore\n",
				"CONSTRAINTS.md": edit(
					REAL,
					HEADER,
					`${HEADER}${row("E99", "packages/sim/src/a.ts", "2026-11-30")}\n`,
				),
			});
			expect(guard().out).toContain("waived by E99");
		});

		it("is clean when unchanged, and when only an issue reference changes", () => {
			realRepo();
			expect(guard().code).toBe(0);
			repo.write({
				"CONSTRAINTS.md": edit(
					REAL,
					"| Types | 0 type errors | Any error is a bug or a lie | `tsc -b` (incremental) | edit, CI | `ci / typecheck` | #40 |",
					"| Types | 0 type errors | Any error is a bug or a lie | `tsc -b` (incremental) | edit, CI | `ci / typecheck` | #41 |",
				),
			});
			expect(guard().code).toBe(0);
		});

		// #122: PR #121 added the test allowance behind a `;`, so every old item survived (830ac11).
		const ALLOWANCE =
			"; test files in `packages/sim` (`*.test.ts`) may also import `vitest` and `fast-check` and nothing else from outside the sim, and stay banned from `node:*` and from the calls above (admin, 9 Nov, #81)";
		// #125 appended a clause after it; the replays strip it, so they replay #121's edit alone.
		const AFTER_121 = edit(
			REAL,
			"; every file in a module's `tests/` folder counts as a test file here, test helpers included",
			"",
		);

		// A narrowing is a warning for the admin, never a failure (admin, 9 Nov): the guard can't tell
		// an approved carve-out from an unapproved one, and a red required check has no bypass.
		// An entry's reasons, in two tiers (admin, 9 Nov): `warning [rule-narrowed]` for strong signals,
		// `note [check]` for weak ones. Each comes right after the entry's head, warning first.
		const reasons = (r, head) => {
			expect(r.code).toBe(0);
			expect(r.out).not.toContain("floor-guard: clean");
			const lines = r.out.split("\n");
			const at = lines.findIndex((l) => l.includes(head));
			expect(at, `no report entry for ${head}`).toBeGreaterThan(-1);
			const next = lines.slice(at + 1, at + 3);
			return {
				warning: next.find((l) => l.includes("warning [rule-narrowed]: ")),
				note: next.find((l) => l.includes("note [check]: ")),
			};
		};
		const warned = (r, head) => {
			const { warning } = reasons(r, head);
			expect(warning, `no warning for ${head}`).toBeDefined();
			return warning;
		};
		const noted = (r, head) => {
			const { warning, note } = reasons(r, head);
			expect(warning, `a weak signal warned for ${head}`).toBeUndefined();
			expect(note, `no note for ${head}`).toBeDefined();
			return note;
		};
		const TIER = { warning: warned, note: noted };

		it("warns on PR #121's real rewording of the purity row", () => {
			realRepo(edit(AFTER_121, ALLOWANCE, ""));
			repo.write({ "CONSTRAINTS.md": AFTER_121 });
			const head = `changed: CONSTRAINTS.md:${PURITY} (rule "Boundaries: sim purity (MUST-10.1)")`;
			const r = guard();
			expect(warned(r, head)).toContain("adds a clause to a list cell");
			expect(reasons(r, head).note).toContain('adds "may"');
		});

		const SECRETS =
			"- Secrets in source. Read them from env vars and keep placeholders in `.env.example`.";
		it.each([
			[
				"added to a list item",
				SECRETS,
				SECRETS.replace("in source.", "in source, except in test fixtures."),
				`changed: CONSTRAINTS.md:${lineOf(SECRETS)}`,
				"warning",
				"except",
			],
			[
				"added to a paragraph",
				"Each blocking CI job is a required status check on `main`.",
				"Each blocking CI job is a required status check on `main`, unless it runs on preview deploys.",
				`changed: CONSTRAINTS.md:${lineOf("Each blocking CI job")}`,
				"warning",
				"unless",
			],
			[
				"added as a new list item",
				SECRETS,
				`${SECRETS}\n- Test files may use \`@ts-ignore\`.`,
				`added: CONSTRAINTS.md:${lineOf(SECRETS) + 1}`,
				"note",
				"may",
			],
		])("flags a carve-out %s", (_, from, to, head, tier, word) => {
			realRepo();
			repo.write({ "CONSTRAINTS.md": edit(REAL, from, to) });
			expect(TIER[tier](guard(), head)).toContain(`adds "${word}"`);
		});

		// Review of #129 (admin, 9 Nov): carve-outs the first word list missed.
		const LINT_ROW = lineOf("| Lint |");
		it.each([
			[
				'"blocked unless" made "warned unless"',
				"A weakened bar is blocked unless",
				"A weakened bar is warned unless",
				"changed: CONSTRAINTS.md:37",
				"warning",
				'adds "warned"',
			],
			[
				"a new sentence in a list item",
				SECRETS,
				SECRETS.replace("in source.", "in source. Fixtures are okay."),
				`changed: CONSTRAINTS.md:${lineOf(SECRETS)}`,
				"note",
				"adds a clause",
			],
			[
				'"fine" in a new sentence',
				SECRETS,
				SECRETS.replace("in source.", "in source. Fixtures are fine."),
				`changed: CONSTRAINTS.md:${lineOf(SECRETS)}`,
				"note",
				'adds "fine"',
			],
			[
				'", ignoring" a path',
				SECRETS,
				SECRETS.replace("in source.", "in source, ignoring `tools/`."),
				`changed: CONSTRAINTS.md:${lineOf(SECRETS)}`,
				"warning",
				'adds "ignoring"',
			],
			[
				'"outside" a path',
				SECRETS,
				SECRETS.replace("in source.", "in source outside `tools/`."),
				`changed: CONSTRAINTS.md:${lineOf(SECRETS)}`,
				"note",
				'adds "outside"',
			],
			[
				"a new row",
				"| Lint |",
				"| Lint: generated | Generated files are linted by hand | n/a | `eslint .` | CI | `ci / lint` | #40 |\n| Lint |",
				`added: CONSTRAINTS.md:${LINT_ROW}`,
				"note",
				"adds a rule",
			],
			[
				"a footnote",
				"## Stages\n",
				"## Stages\n\n[^1]: Agents run the bench on Fridays.\n",
				"added: CONSTRAINTS.md:",
				"warning",
				"adds a footnote",
			],
			[
				"an inline HTML comment",
				SECRETS,
				`${SECRETS} <!-- agents read this -->`,
				`changed: CONSTRAINTS.md:${lineOf(SECRETS)}`,
				"warning",
				"adds an HTML comment",
			],
		])("flags %s", (_, from, to, head, tier, label) => {
			realRepo();
			repo.write({ "CONSTRAINTS.md": edit(REAL, from, to) });
			expect(TIER[tier](guard(), head)).toContain(label);
		});

		it("titles the annotation by tier, so a note never reads as a narrowing", () => {
			realRepo();
			// A negation in a new rule is a prohibition, not a flip: still only a note.
			repo.write({
				"CONSTRAINTS.md": edit(REAL, SECRETS, `${SECRETS}\n- New rule: no stubs, never.`),
			});
			const notes = guard({ ...TODAY, GITHUB_ACTIONS: "true" })
				.out.split("\n")
				.filter((l) => l.startsWith("::warning"));
			expect(notes).toHaveLength(1);
			expect(notes[0]).toContain("title=CONSTRAINTS.md rule to check (admin reads)::");
		});

		// Review of #129: a rule moved between lists has the same text, so it paired as unchanged and
		// the guard logged `clean`. Moving the secrets rule into the waivable list makes it waivable.
		it("reports and warns on a rule moved out of the no-exception list", () => {
			realRepo();
			const moved = edit(
				edit(REAL, `${SECRETS}\n`, ""),
				"- A new suppression comment:",
				`${SECRETS}\n- A new suppression comment:`,
			);
			repo.write({ "CONSTRAINTS.md": moved });
			const r = guard();
			const warning = warned(
				r,
				'moved: CONSTRAINTS.md:41 (rule "list item in "Floor (always enforced)"")',
			);
			expect(warning).toContain(
				'moves from "Also blocked, with no exception possible:" to "A weakened bar is any of:"',
			);
			expect(r.out).toContain(`from: CONSTRAINTS.md:${lineOf(SECRETS)} (old)`);
		});

		it("reports a rule reordered within its list, without a warning", () => {
			realRepo();
			const expired = "- An expired row in [Exceptions](#exceptions).\n";
			repo.write({
				"CONSTRAINTS.md": edit(edit(REAL, expired, ""), `${SECRETS}\n`, `${expired}${SECRETS}\n`),
			});
			const r = guard();
			expect(r.code).toBe(0);
			expect(r.out).toContain("moved: CONSTRAINTS.md:");
			expect(r.out).not.toContain("rule-narrowed");
		});

		it("stays quiet for a blank-line-only edit", () => {
			realRepo();
			repo.write({ "CONSTRAINTS.md": edit(REAL, "## Stages\n", "## Stages\n\n") });
			expect(guard().out).toContain("floor-guard: clean");
		});

		const PURITY_TAIL = "`new Date()` with no arguments is banned too;";
		it.each([
			["a clause of several words", "; sim tests import `vitest` freely;"],
			["a two-word clause", ", tests aside;".replace("aside", "excused")],
		])("warns on %s added to a list cell, even without a narrowing word", (_, tail) => {
			realRepo();
			repo.write({
				"CONSTRAINTS.md": edit(
					REAL,
					PURITY_TAIL,
					`\`new Date()\` with no arguments is banned too${tail}`,
				),
			});
			expect(warned(guard(), `changed: CONSTRAINTS.md:${PURITY}`)).toContain(
				"adds a clause to a list cell",
			);
		});

		it("warns on a dropped negation", () => {
			realRepo();
			repo.write({
				"CONSTRAINTS.md": edit(
					REAL,
					"One automatic retry, never more.",
					"One automatic retry, more.",
				),
			});
			expect(warned(guard(), "changed: CONSTRAINTS.md:")).toContain('drops "never"');
		});

		// CONSTRAINTS.md, "Guarding the bar", names this as what the guard can't catch: it passes, but
		// it's in the report.
		it("passes a meaning change it cannot judge, and still reports it", () => {
			realRepo();
			repo.write({
				"CONSTRAINTS.md": edit(
					REAL,
					"Only the admin loosens anything.",
					"Only the agent loosens anything.",
				),
			});
			const r = guard();
			expect(r.code).toBe(0);
			expect(r.out).toContain("Only the {+agent+} loosens anything.");
			expect(r.out).not.toContain("rule-narrowed");
		});

		// Review of #122: splitting list cells at full stops let a new sentence in between two items.
		it("still fails a sentence slipped in before a full stop", () => {
			realRepo();
			repo.write({
				"CONSTRAINTS.md": edit(
					REAL,
					"`setImmediate`. `new Date()`",
					"`setImmediate`. Tests are fine. `new Date()`",
				),
			});
			const r = guard();
			expect(r.code).toBe(1);
			expect(r.out).toContain(`[rule-narrowed] CONSTRAINTS.md:${PURITY}`);
		});

		// Each case: [the text at the merge base, the text in the PR], as edits of the real file.
		const typo = (right, wrong) => [edit(REAL, right, wrong), REAL];
		const tighten = (from, to) => [REAL, edit(REAL, from, to)];
		it.each([
			["a typo fixed in a list item", typo("keep placeholders in", "keep placehodlers in")],
			[
				"a typo fixed in a prose cell",
				typo("| Any error is a bug or a lie |", "| Any eror is a bug or a lie |"),
			],
			[
				"a reworded Why cell",
				tighten("| Any error is a bug or a lie |", "| Each error is either a bug or a lie |"),
			],
			[
				"an item added to a list cell",
				tighten("`fetch`, `setTimeout`,", "`fetch`, `queueMicrotask`, `setTimeout`,"),
			],
			[
				"an item added to a list",
				tighten(
					"`fallow-ignore-file`, `# noqa`",
					"`fallow-ignore-file`, `fallow-ignore-next-file`, `# noqa`",
				),
			],
			[
				"a suppression named with a narrowing word",
				tighten("`gitleaks:allow`,", "`gitleaks:allow`, `trufflehog:allow`,"),
			],
		])("does not flag %s as narrowing", (_, [base, change]) => {
			realRepo(base);
			repo.write({ "CONSTRAINTS.md": change });
			const r = guard();
			expect(r.code).toBe(0);
			expect(r.out).toContain("changed: CONSTRAINTS.md:");
			expect(r.out).not.toContain("rule-narrowed");
		});

		// #122: every changed rule goes in front of the admin, even when nothing is flagged.
		describe("the change report", () => {
			const summaryOf = (env = {}) => {
				const file = join(repo.dir, ".summary.md");
				const r = guard({ ...TODAY, GITHUB_STEP_SUMMARY: file, ...env });
				return { ...r, summary: readFileSync(file, "utf8") };
			};

			it("shows a clean change with its old and new text, the edit marked", () => {
				const [base, change] = typo(
					"| Any error is a bug or a lie |",
					"| Any eror is a bug or a lie |",
				);
				realRepo(base);
				repo.write({ "CONSTRAINTS.md": change });
				const r = summaryOf();
				expect(r.code).toBe(0);
				expect(r.out).toContain(`changed: CONSTRAINTS.md:${lineOf("| Types |")} (rule "Types")`);
				expect(r.out).toContain("was: Any [-eror-] is a bug or a lie");
				expect(r.out).toContain("now: Any {+error+} is a bug or a lie");
				expect(r.summary).toContain(`CONSTRAINTS.md:${lineOf("| Types |")}`);
				expect(r.summary).toContain("now: Any {+error+} is a bug or a lie");
			});

			it("marks #121's added clause, and reports added and removed rules", () => {
				const SPARE = "| Spare | 1 spare row | n/a | `spare` | CI | `ci / spare` | #1 |\n";
				realRepo(edit(edit(AFTER_121, ALLOWANCE, ""), "| Lint |", `${SPARE}| Lint |`));
				// The new list item moves every later line down by one.
				repo.write({
					"CONSTRAINTS.md": edit(AFTER_121, SECRETS, `${SECRETS}\n- New rule: blocked.`),
				});
				const r = summaryOf({ GITHUB_ACTIONS: "true" });
				expect(r.out).toContain("banned too{+; test files in");
				// The spare row sat where Lint sits now.
				expect(r.out).toContain(
					`removed: CONSTRAINTS.md:${lineOf("| Lint |")} (old) (rule "Spare")`,
				);
				expect(r.out).toContain(`added: CONSTRAINTS.md:${lineOf(SECRETS) + 1} (rule "New rule")`);
				expect(r.out).toContain("now: {+New rule: blocked.+}");
				const purity = r.out
					.split("\n")
					.find((l) => l.startsWith(`::warning file=CONSTRAINTS.md,line=${PURITY + 1},`));
				expect(purity).toMatch(
					/title=CONSTRAINTS\.md rule may be narrowed \(admin reads\)::.*banned too\{\+; test files in/,
				);
			});

			it("shows changed text that is no rule: comments, fences, headings", () => {
				realRepo();
				repo.write({
					"CONSTRAINTS.md": edit(
						edit(
							REAL,
							"## Stages\n",
							"## Stages\n\n<!-- agents may skip the bench -->\n\n```\nskip it\n```\n",
						),
						"### Timing checks",
						"### Timing",
					),
				});
				// Renaming a heading also unpairs its rules (rule-removed, a failure); only the report is checked here.
				const r = guard();
				expect(r.out).toMatch(
					/other: CONSTRAINTS\.md:\d+ \(not a rule\)\n +warning \[rule-narrowed\]: adds an HTML comment.*\n +note \[check\]: adds text outside the rules, adds "may".*\n +now: \{\+<!-- agents may skip the bench -->\+\}/,
				);
				expect(r.out).toContain("now: {+skip it+}");
				expect(r.out).toContain("was: [-### Timing checks-]");
				expect(r.out).toContain("now: {+### Timing+}");
			});

			// GitHub keeps 10 warning annotations per step (REST docs, check runs, checked 9 Nov).
			it("fits GitHub's 10 annotations, pointing to the summary for the rest", () => {
				realRepo();
				repo.write({
					"CONSTRAINTS.md": REAL.replaceAll("| #40 |", "| #140 |")
						.replaceAll("| #41 |", "| #141 |")
						.replaceAll("| #43 |", "| #143 |"),
				});
				const notes = guard({ ...TODAY, GITHUB_ACTIONS: "true" })
					.out.split("\n")
					.filter((l) => l.startsWith("::warning"));
				expect(notes).toHaveLength(10);
				expect(notes[9]).toMatch(
					/^::warning file=CONSTRAINTS\.md,title=[^:]+::\d+ more changed rules are in the job summary/,
				);
			});

			// The report quotes text a PR wrote, so under Actions it must not run as a workflow command.
			it("prints quoted text inside a stop-commands block, and the annotations after it", () => {
				realRepo();
				// A rule's own text, and a table header that the report prints on a line of its own (review
				// of #122: the runner trims leading spaces before it reads a command).
				const header = edit(
					REAL,
					"| Required check | Enforced by |\n|---",
					"| Required check | ::error file=x.ts::pwned |\n|---",
				);
				const injected = edit(
					edit(header, "| `ci / typecheck` | #40 |", "| `ci / typecheck` | #41 |"),
					SECRETS,
					`${SECRETS}\n- Injected:\n::error::pwned\n\n::add-mask::x`,
				);
				repo.write({ "CONSTRAINTS.md": injected });
				const lines = guard({ ...TODAY, GITHUB_ACTIONS: "true" }).out.split("\n");
				const open = lines.findIndex((l) => l.startsWith("::stop-commands::"));
				const token = lines[open]?.slice("::stop-commands::".length);
				expect(token).toMatch(/^[0-9a-f-]{36}$/);
				const close = lines.indexOf(`::${token}::`);
				expect(close).toBeGreaterThan(open);
				const outside = lines.filter(
					(l, i) => (i < open || i > close) && l.trim().startsWith("::"),
				);
				expect(outside.length).toBeGreaterThan(0);
				expect(outside.every((l) => l.startsWith("::warning file=CONSTRAINTS.md"))).toBe(true);
				const inside = lines.slice(open + 1, close);
				expect(inside.join("\n")).toContain("::error::pwned");
				expect(inside.some((l) => l.trim().startsWith("::error file=x.ts::pwned"))).toBe(true);
			});

			it("redacts key-like text it quotes", () => {
				realRepo();
				const key = `ghp_${"a1B2".repeat(9)}`; // assembled, so no scanner reads a key in this file
				repo.write({ "CONSTRAINTS.md": edit(REAL, SECRETS, `${SECRETS}\n- Example key: ${key}.`) });
				const r = summaryOf({ GITHUB_ACTIONS: "true" });
				expect(r.out).toContain("Example key: [redacted]");
				expect(r.out + r.summary).not.toContain(key);
			});

			// `ci / test` runs these tests under Actions: the fixtures' reports must not reach its summary.
			it("doesn't inherit the test run's GITHUB_ACTIONS or GITHUB_STEP_SUMMARY", () => {
				realRepo();
				repo.write({ "CONSTRAINTS.md": edit(REAL, SECRETS, `${SECRETS} Now.`) });
				const outer = join(repo.dir, ".outer-summary.md");
				const saved = { a: process.env.GITHUB_ACTIONS, s: process.env.GITHUB_STEP_SUMMARY };
				Object.assign(process.env, { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: outer });
				try {
					const r = guard();
					expect(r.out).not.toContain("::stop-commands::");
					expect(existsSync(outer)).toBe(false);
				} finally {
					if (saved.a === undefined) delete process.env.GITHUB_ACTIONS;
					else process.env.GITHUB_ACTIONS = saved.a;
					if (saved.s === undefined) delete process.env.GITHUB_STEP_SUMMARY;
					else process.env.GITHUB_STEP_SUMMARY = saved.s;
				}
			});

			it("stays out of the log when CONSTRAINTS.md is unchanged", () => {
				setup();
				repo.write({ "packages/sim/src/b.ts": "export const b = 2;\n" });
				expect(guard().out).not.toContain("was:");
			});
		});

		// The real coverage row with its "Today" cell set, so the test keeps running the "not yet" →
		// first value change on the real file once a value is recorded there (#98).
		const NOT_YET = "not yet: recorded after the first `packages/sim` PR";
		const COVERAGE_ROW = /^(\|\s*Project coverage\s*\|)[^|]*\|/m;
		const coverageToday = (today) => {
			if (!COVERAGE_ROW.test(REAL)) throw new Error("CONSTRAINTS.md has no Project coverage row");
			return REAL.replace(COVERAGE_ROW, `$1 ${today} |`);
		};
		it("lets the coverage ratchet get its first value, then holds it", () => {
			realRepo(coverageToday(NOT_YET));
			repo.write({ "CONSTRAINTS.md": coverageToday("92.5%") });
			expect(guard().code).toBe(0);
			realRepo(coverageToday("92.5%"));
			repo.write({ "CONSTRAINTS.md": coverageToday("90%") });
			expect(guard().out).toContain("[threshold-loosened] CONSTRAINTS.md");
			repo.write({ "CONSTRAINTS.md": coverageToday("93%") });
			expect(guard().code).toBe(0);
		});
	});

	it.each([
		[
			"a strict option turned off",
			"tsconfig.base.json",
			'{\n  "compilerOptions": {\n    "strict": false\n  }\n}\n',
		],
		["a strict option removed", "tsconfig.base.json", '{\n  "compilerOptions": {\n  }\n}\n'],
		[
			"a coverage exclusion added",
			"vitest.config.mts",
			BASE["vitest.config.mts"].replace(
				"'**/*.test.ts',",
				"'**/*.test.ts',\n        'packages/sim/src/**',",
			),
		],
		[
			"a lint rule turned off",
			"eslint.config.mjs",
			"export default [{ rules: {\n  'no-unused-vars': 'off',\n} }];\n",
		],
		["a gitleaks ignore entry", ".gitleaksignore", "abc123:src/x.ts:generic-api-key:1\n"],
		// #42: the other scanner configs that can hide a finding (CONSTRAINTS.md, Floor).
		[
			"a gitleaks allowlist",
			".gitleaks.toml",
			'[extend]\nuseDefault = true\n\n[allowlist]\npaths = ["apps/web/src/server/"]\n',
		],
		["a Semgrep ignore entry", ".semgrepignore", "apps/web/src/server/\n"],
		[
			"an osv-scanner ignored vulnerability",
			"osv-scanner.toml",
			'[[IgnoredVulns]]\nid = "GHSA-xxxx-xxxx-xxxx"\nreason = "not reachable"\n',
		],
		[
			"an osv-scanner package override",
			"osv-scanner.toml",
			'[[PackageOverrides]]\nname = "lodash"\necosystem = "npm"\nignore = true\n',
		],
		["a Fallow ignore", ".fallow.toml", 'ignorePatterns = ["packages/sim/**"]\n'],
	])("blocks %s", (_, path, content) => {
		setup();
		repo.write({ [path]: content });
		expect(guard().out).toContain("[config-loosened]");
	});

	// #125: Prettier's ignore list and settings decide what the formatting check covers, so a widened
	// ignore list or a loosened setting is a moved threshold too (admin, 9 Nov).
	describe("Prettier's config", () => {
		const RC =
			'{\n  "semi": true,\n  "useTabs": true,\n  "printWidth": 100,\n  "plugins": ["@ianvs/prettier-plugin-sort-imports"],\n  "importOrder": ["<THIRD_PARTY_MODULES>", "", "^[.]"]\n}\n';
		const IGNORE = "# prose\n*.md\n";
		const run = (files) => {
			repo = makeRepo({ ...BASE, ".prettierrc": RC, ".prettierignore": IGNORE });
			repo.write(files);
			return guard();
		};

		it.each([
			["a path added to .prettierignore", { ".prettierignore": `${IGNORE}packages/sim/\n` }],
			[
				"an overrides block in .prettierrc",
				{ ".prettierrc": RC.replace('"semi": true,', '"semi": true,\n  "overrides": [],') },
			],
			[
				"requirePragma in .prettierrc",
				{ ".prettierrc": RC.replace('"semi": true,', '"semi": true,\n  "requirePragma": true,') },
			],
			[
				"the import-sort plugin dropped from .prettierrc",
				{
					".prettierrc": RC.replace('  "plugins": ["@ianvs/prettier-plugin-sort-imports"],\n', ""),
				},
			],
			[
				"a reformat mixed with an overrides block",
				{
					".prettierrc": RC.replaceAll("  ", "\t").replace(
						'"semi": true,',
						'"semi": true,\n\t"overrides": [],',
					),
				},
			],
		])("blocks %s", (_, files) => {
			expect(run(files).out).toContain("[config-loosened]");
		});

		it.each([
			[
				"a comment, a blank line and a re-included path in .prettierignore",
				{ ".prettierignore": `${IGNORE}\n# keep the fixtures formatted\n!docs/fixtures/\n` },
			],
			["a pure reformat of .prettierrc (#138)", { ".prettierrc": RC.replaceAll("  ", "\t") }],
			[
				"a reformat of .prettierrc that wraps an array",
				{
					".prettierrc": RC.replace(
						'"plugins": ["@ianvs/prettier-plugin-sort-imports"]',
						'"plugins": [\n    "@ianvs/prettier-plugin-sort-imports"\n  ]',
					),
				},
			],
		])("accepts %s", (_, files) => {
			expect(run(files).code).toBe(0);
		});

		// Prettier reads its settings from other places too, so moving them is a way around the line
		// checks (security review of #147).
		it.each([
			["deleting .prettierrc", (r) => rmSync(join(r.dir, ".prettierrc"))],
			[
				"renaming .prettierrc to .prettierrc.json",
				(r) => renameSync(join(r.dir, ".prettierrc"), join(r.dir, ".prettierrc.json")),
			],
			[
				"a nested .prettierrc",
				(r) => r.write({ "packages/sim/.prettierrc": '{ "semi": false }\n' }),
			],
			[
				"a new prettier.config.mjs",
				(r) => r.write({ "prettier.config.mjs": "export default {};\n" }),
			],
			[
				"moving .prettierrc to a file the guard skips as prose",
				(r) => {
					mkdirSync(join(r.dir, "docs"), { recursive: true });
					renameSync(join(r.dir, ".prettierrc"), join(r.dir, "docs/notes.md"));
				},
			],
			[
				"moving .prettierrc into another folder under the same name",
				(r) => {
					mkdirSync(join(r.dir, "packages/sim"), { recursive: true });
					renameSync(join(r.dir, ".prettierrc"), join(r.dir, "packages/sim/.prettierrc"));
				},
			],
			[
				"a quoted prettier key in package.yaml",
				(r) => r.write({ "package.yaml": '"prettier":\n  semi: false\n' }),
			],
			[
				"a prettier key in package.yaml's flow form",
				(r) => r.write({ "package.yaml": "{ name: x, prettier: { semi: false } }\n" }),
			],
			[
				"a prettier key in package.yaml",
				(r) => r.write({ "package.yaml": "prettier:\n  semi: false\n" }),
			],
			["a new .editorconfig", (r) => r.write({ ".editorconfig": "[*]\nend_of_line = crlf\n" })],
			[
				"a top-level prettier key in package.json",
				(r) => r.write({ "package.json": '{\n  "prettier": { "semi": false }\n}\n' }),
			],
		])("blocks %s", (_, change) => {
			repo = makeRepo({
				...BASE,
				".prettierrc": RC,
				".prettierignore": IGNORE,
				"package.json": "{}\n",
			});
			change(repo);
			expect(guard().out).toContain("[config-loosened]");
		});

		it("accepts a prettier version bump in package.json's devDependencies", () => {
			const pkg = (v) => `{\n  "devDependencies": {\n    "prettier": "${v}"\n  }\n}\n`;
			repo = makeRepo({
				...BASE,
				".prettierrc": RC,
				".prettierignore": IGNORE,
				"package.json": pkg("3.9.10"),
			});
			repo.write({ "package.json": pkg("3.9.11") });
			expect(guard().code).toBe(0);
		});

		// Its re-indented lines name `overrides` and `ignore`, which flag unless the whole file
		// parses to the same JSON as before.
		it("accepts a pure reformat of a .prettierrc that already has overrides (#138)", () => {
			const withOverrides = RC.replace(
				'"semi": true,',
				'"semi": true,\n  "overrides": [{ "files": "*.md", "options": { "proseWrap": "ignore" } }],',
			);
			repo = makeRepo({ ...BASE, ".prettierrc": withOverrides, ".prettierignore": IGNORE });
			repo.write({ ".prettierrc": withOverrides.replaceAll("  ", "\t") });
			expect(guard().code).toBe(0);
		});
	});

	// #138: a formatter (Prettier, #125) re-quotes, re-indents and re-wraps guarded configs. A line
	// that only changed formatting counts as unchanged; any change in content still flags.
	describe("formatting-only changes in guarded configs", () => {
		const ESLINT =
			"export default [\n  {\n    files: ['a/**'],\n    rules: {\n      'no-x': 'error',\n      'max-lines': ['error', 300],\n    },\n  },\n  {\n    files: ['b/**'],\n    rules: {\n      'no-y': 'error'\n    },\n  },\n];\n";
		const VITEST =
			"export default {\n  test: {\n    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.ts'],\n    coverage: {\n      exclude: [\n        '**/*.test.ts',\n      ],\n    },\n  },\n};\n";
		const configs = { ...BASE, "eslint.config.mjs": ESLINT, "vitest.config.mts": VITEST };
		const run = (files) => {
			repo = makeRepo(configs);
			repo.write(files);
			return guard();
		};

		it.each([
			["re-quoted", { "eslint.config.mjs": ESLINT.replaceAll("'", '"') }],
			["re-indented", { "eslint.config.mjs": ESLINT.replace(/^ {6}/gm, "        ") }],
			[
				"given a trailing comma",
				{ "eslint.config.mjs": ESLINT.replace("'no-y': 'error'\n", "'no-y': 'error',\n") },
			],
			[
				"with spaces changed",
				{ "eslint.config.mjs": ESLINT.replace("['error', 300]", "[ 'error' , 300 ]") },
			],
			[
				"re-wrapped",
				{
					"vitest.config.mts": VITEST.replace(
						"    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.ts'],\n",
						'    include: [\n      "packages/*/src/**/*.test.ts",\n      "tools/**/*.test.ts",\n    ],\n',
					),
				},
			],
			[
				"a re-indented exclude list",
				{
					"vitest.config.mts": VITEST.replace(
						"      exclude: [\n        '**/*.test.ts',\n      ],\n",
						"    exclude: [\n      '**/*.test.ts',\n    ],\n",
					),
				},
			],
		])("passes a config %s", (_, files) => {
			expect(run(files)).toMatchObject({ code: 0 });
		});

		it.each([
			[
				"a severity changed",
				{ "eslint.config.mjs": ESLINT.replace("'no-x': 'error'", '"no-x": "warn"') },
			],
			[
				"a rule renamed",
				{ "eslint.config.mjs": ESLINT.replace("'no-x': 'error'", '"no-z": "error"') },
			],
			[
				"a number changed",
				{ "eslint.config.mjs": ESLINT.replace("['error', 300]", '["error", 400]') },
			],
			[
				"an include item removed",
				{ "vitest.config.mts": VITEST.replace(", 'tools/**/*.test.ts'", "") },
			],
			[
				"an include glob changed",
				{ "vitest.config.mts": VITEST.replace("'tools/**/*.test.ts'", '"tools/*.test.ts"') },
			],
			[
				"an exclusion added while re-wrapping",
				{
					"vitest.config.mts": VITEST.replace(
						"      exclude: [\n        '**/*.test.ts',\n      ],\n",
						'      exclude: ["**/*.test.ts", "packages/sim/**"],\n',
					),
				},
			],
		])("still flags %s", (_, files) => {
			expect(run(files).out).toContain("[config-loosened]");
		});

		// Security review of #141: a move inside one hunk, with every line re-indented so the hunk spans
		// both blocks.
		it("does not pair a glob moved from include to exclude within one hunk", () => {
			const base =
				"export default {\n  test: {\n    include: [\n      'a/**',\n      'b/**',\n    ],\n    exclude: [\n      'c/**',\n    ],\n  },\n};\n";
			const moved =
				"export default {\n  test: {\n      include: [\n          'a/**',\n      ],\n      exclude: [\n          'b/**',\n          'c/**',\n      ],\n  },\n};\n";
			repo = makeRepo({ ...configs, "vitest.config.mts": base });
			repo.write({ "vitest.config.mts": moved });
			expect(guard().out).toContain("[config-loosened] vitest.config.mts");
		});

		it("does not pair a rule moved between config objects within one hunk", () => {
			const reindented = ESLINT.replace(/^( +)/gm, "$1$1");
			const moved = reindented
				.replace("            'no-x': 'error',\n", "")
				.replace(
					"            'no-y': 'error'\n",
					"            'no-x': 'error',\n            'no-y': 'error'\n",
				);
			expect(run({ "eslint.config.mjs": moved }).out).toContain(
				"[config-loosened] eslint.config.mjs",
			);
		});

		// Spec review of #141: a formatter changes the boundary lines too, so line pairing let these
		// through. Only a whole hunk that normalizes equal counts as formatting now.
		const SCOPES =
			"export default [\n  {\n    files: ['legacy/**'],\n    rules: {\n      'no-x': 'off',\n    },\n  },\n  {\n    files: ['**/*.ts'],\n    rules: {\n      'no-x': 'error',\n    },\n  },\n];\n";
		const tabbed = (t) => t.replace(/^( {2})+/gm, (s) => "\t".repeat(s.length / 2));
		it.each([
			[
				"override scopes swapped during a tab re-indent",
				SCOPES,
				tabbed(
					SCOPES.replace("['legacy/**']", "TMP")
						.replace("['**/*.ts']", "['legacy/**']")
						.replace("TMP", "['**/*.ts']"),
				),
			],
			[
				"later-wins overrides swapped while re-quoted",
				"export default [\n  { rules: { 'max-lines': [2, 1000] } },\n  { rules: { 'max-lines': ['error', 300] } },\n];\n",
				'export default [\n  { rules: { "max-lines": ["error", 300] } },\n  { rules: { "max-lines": [2, 1000] } },\n];\n',
			],
			[
				"a string with escaped quotes respaced",
				"export default [{ rules: { 'no-restricted-syntax': ['error', 'CallExpression[callee.name=\\'eval\\']'] } }];\n",
				"export default [{ rules: { 'no-restricted-syntax': ['error', 'CallExpression[callee.name=\\' eval \\']'] } }];\n",
			],
			[
				"a line break after return",
				"export default (t) => {\n  return t.configs.strict;\n};\n",
				"export default (t) => {\n  return\n  t.configs.strict;\n};\n",
			],
		])("still flags %s", (_, base, changed) => {
			repo = makeRepo({ ...configs, "eslint.config.mjs": base });
			repo.write({ "eslint.config.mjs": changed });
			expect(guard().out).toContain("[config-loosened] eslint.config.mjs");
		});

		// Admin's review of #141: a block comment can switch lines off without changing them.
		it.each([
			[
				"rules wrapped in a block comment, in one hunk",
				(t) =>
					t.replace(
						"      'no-x': 'error',\n      'max-lines': ['error', 300],\n",
						'      /*\n      "no-x": "error",\n      "max-lines": ["error", 300],\n      */\n',
					),
			],
			// `/*` and `*/` added as hunks of their own, unchanged lines between them and the re-quoted one.
			[
				"a rules block commented out from other hunks",
				(t) =>
					t.replace(
						"    rules: {\n      'no-x': 'error',\n      'max-lines': ['error', 300],\n    },\n",
						"    /*\n    rules: {\n      \"no-x\": \"error\",\n      'max-lines': ['error', 300],\n    },\n    */\n",
					),
			],
		])("still flags %s", (_, change) => {
			expect(run({ "eslint.config.mjs": change(ESLINT) }).out).toContain(
				"[config-loosened] eslint.config.mjs",
			);
		});

		// Re-review of #141: a dropped trailing comma joins the next line onto the item, which is new
		// code (a member access, a tagged template), unless that line closes the list.
		const LIST = (next) =>
			`export default {\n  test: {\n    include: [\n      'a/**',\n${next}\n    ],\n  },\n};\n`;
		it.each([
			["a member access", "      ['b/**'][0],"],
			["a tagged template", "      `b/**`,"],
		])("still flags a dropped comma that joins %s onto the item", (_, next) => {
			repo = makeRepo({ ...configs, "vitest.config.mts": LIST(next) });
			repo.write({ "vitest.config.mts": LIST(next).replace("      'a/**',", '      "a/**"') });
			expect(guard().out).toContain("[config-loosened] vitest.config.mts");
		});

		it("still flags a rule commented out with // during a tab re-indent", () => {
			const changed = tabbed(ESLINT).replace("\t\t\t'no-x': 'error',", "\t\t\t// 'no-x': 'error',");
			expect(run({ "eslint.config.mjs": changed }).out).toContain(
				"[config-loosened] eslint.config.mjs",
			);
		});

		it("still flags a multi-line template literal's text re-indented with tabs", () => {
			// The template's text is meaning: its lines are the selector, and indenting them changes it.
			const base = ESLINT.replace(
				"      'no-x': 'error',\n",
				() => "      'no-x': ['error', `Call\n        > Identifier`],\n",
			);
			repo = makeRepo({ ...configs, "eslint.config.mjs": base });
			repo.write({ "eslint.config.mjs": tabbed(base) });
			expect(guard().out).toContain("[config-loosened] eslint.config.mjs");
		});

		// A plain string compares by its value: Prettier re-quotes strings that hold escapes too.
		it.each([
			[
				"a string with backslash escapes",
				"'^(\\\\./|(\\\\.\\\\./)+)'",
				'"^(\\\\./|(\\\\.\\\\./)+)"',
			],
			["an escaped quote unescaped", "'it\\'s'", '"it\'s"'],
		])("passes %s re-quoted", (_, from, to) => {
			const base = ESLINT.replace(
				"      'no-x': 'error',\n",
				() => `      'no-x': ['error', ${from}],\n`,
			);
			repo = makeRepo({ ...configs, "eslint.config.mjs": base });
			repo.write({ "eslint.config.mjs": base.replace(from, () => to) });
			expect(guard()).toMatchObject({ code: 0 });
		});

		it("passes a trailing comma dropped before the closing bracket", () => {
			const base = "export default {\n  test: {\n    include: [\n      'a/**',\n    ],\n  },\n};\n";
			repo = makeRepo({ ...configs, "vitest.config.mts": base });
			repo.write({ "vitest.config.mts": base.replace("      'a/**',", '      "a/**"') });
			expect(guard().code).toBe(0);
		});

		it("still flags an include item wrapped in a block comment", () => {
			const changed = VITEST.replace(
				"    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.ts'],\n",
				'    include: [\n      "packages/*/src/**/*.test.ts",\n      /* "tools/**/*.test.ts", */\n    ],\n',
			);
			expect(run({ "vitest.config.mts": changed }).out).toContain(
				"[config-loosened] vitest.config.mts",
			);
		});

		it("still flags a selector narrowed beside escaped quotes", () => {
			const base = ESLINT.replace(
				"      'no-x': 'error',\n",
				() => "      'no-x': ['error', '\\'', '[a] [b]', '\\''],\n",
			);
			repo = makeRepo({ ...configs, "eslint.config.mjs": base });
			repo.write({ "eslint.config.mjs": base.replace("'[a] [b]'", "'[a][b]'") });
			expect(guard().out).toContain("[config-loosened] eslint.config.mjs");
		});

		it("passes a whole config re-indented with tabs and re-quoted, comments included", () => {
			const withComment = ESLINT.replace(
				"  {\n    files: ['a/**'],",
				"  // the a scope\n  {\n    files: ['a/**'],",
			);
			repo = makeRepo({ ...configs, "eslint.config.mjs": withComment });
			repo.write({ "eslint.config.mjs": tabbed(withComment).replaceAll("'", '"') });
			expect(guard().code).toBe(0);
		});

		it("passes a string re-quoted inside a template's expression", () => {
			// A replacer function: in a replacement string, "$`" would mean the text before the match.
			const base = ESLINT.replace(
				"      'no-x': 'error',\n",
				() => "      'no-x': ['error', `^${names.join('|')}$`],\n",
			);
			repo = makeRepo({ ...configs, "eslint.config.mjs": base });
			repo.write({ "eslint.config.mjs": base.replace("names.join('|')", 'names.join("|")') });
			expect(guard()).toMatchObject({ code: 0 });
		});

		it("leaves a YAML config to the exact checks", () => {
			// A re-indent alone moves `uses-http2: off` into `assertions`: in YAML, indentation is meaning.
			repo = makeRepo({
				...configs,
				".lighthouserc.yml": "ci:\n  assert:\n    assertions:\n      a: error\n  uses-http2: off\n",
			});
			repo.write({
				".lighthouserc.yml":
					"ci:\n  assert:\n    assertions:\n      a: error\n      uses-http2: off\n",
			});
			expect(guard().out).toContain("[config-loosened] .lighthouserc.yml");
		});

		it("does not pair a rule moved into another config object", () => {
			// Everything re-quoted, and `no-x` moved from the `a/**` object to the `b/**` one.
			const moved = ESLINT.replace("      'no-x': 'error',\n", "")
				.replace("      'no-y': 'error'\n", "      'no-x': 'error',\n      'no-y': 'error'\n")
				.replaceAll("'", '"');
			expect(run({ "eslint.config.mjs": moved }).out).toContain(
				"[config-loosened] eslint.config.mjs",
			);
		});

		it.each([
			[
				"a template literal re-quoted",
				"      include: [`${root}/**/*.test.ts`],\n",
				'      include: ["${root}/**/*.test.ts"],\n',
			],
			[
				"a regex whose quotes changed",
				"      'no-restricted-syntax': ['error', { selector: /'x'/ }],\n",
				"      'no-restricted-syntax': ['error', { selector: /\"x\"/ }],\n",
			],
			[
				"a regex whose spaces changed",
				"      'no-restricted-syntax': ['error', { selector: /a b/ }],\n",
				"      'no-restricted-syntax': ['error', { selector: /ab/ }],\n",
			],
			// Doubt pass on #138: whitespace between two words, and a comma inside a string, carry meaning.
			[
				"two words joined",
				"      'no-x': ['error', new Rule()],\n",
				"      'no-x': ['error', newRule()],\n",
			],
			[
				"a comma removed inside a string",
				"      'no-x': ['error', 'a,]'],\n",
				"      'no-x': ['error', 'a]'],\n",
			],
		])("does not treat %s as formatting", (_, before, after) => {
			const base = before.includes("include")
				? VITEST.replace(
						"    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.ts'],\n",
						before,
					)
				: ESLINT.replace("      'no-x': 'error',\n", before);
			const file = before.includes("include") ? "vitest.config.mts" : "eslint.config.mjs";
			repo = makeRepo({ ...configs, [file]: base });
			repo.write({ [file]: base.replace(before, after) });
			expect(guard().out).toContain("[config-loosened]");
		});
	});

	it("accepts exclusions in a config that did not exist at the merge base, and tighter lint settings", () => {
		setup();
		repo.write({
			"packages/web/vitest.config.mts":
				"export default { test: { exclude: [\n  'e2e/**',\n] } };\n",
			"eslint.config.mjs":
				"export default [{ linterOptions: {\n  maxWarnings: 0,\n}, rules: {\n  'no-console': 'error',\n} }];\n",
		});
		expect(guard().code).toBe(0);
	});

	it("waives a weakened bar when the same change adds an Exceptions row for its path", () => {
		setup();
		repo.write({
			"packages/sim/src/a.ts": "// @ts-expect-error legacy\n",
			"CONSTRAINTS.md": withException(row("E1", "packages/sim/src/a.ts", "2026-11-30")),
		});
		const r = guard();
		expect(r.code).toBe(0);
		expect(r.out).toContain("waived by E1");
	});

	it.each([
		[
			"in a code fence",
			(r) => CONSTRAINTS.replace("## Floor\n", `## Floor\n\n\`\`\`\n${r}\n\`\`\`\n`),
		],
		[
			"in another section",
			(r) =>
				CONSTRAINTS.replace(
					"- Secrets in source: blocked.\n",
					`- Secrets in source: blocked.\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${r}\n`,
				),
		],
		["in an HTML comment", (r) => `${CONSTRAINTS}\n<!--\n${r}\n-->\n`],
	])("does not waive with a row-shaped line %s", (_, place) => {
		setup();
		repo.write({
			"packages/sim/src/a.ts": "// @ts-expect-error legacy\n",
			"CONSTRAINTS.md": place(row("E1", "packages/sim/src/a.ts", "2026-11-30")),
		});
		expect(guard().out).toContain("[silenced-checker] packages/sim/src/a.ts");
	});

	it("does not waive a finding outside the row's path", () => {
		setup();
		repo.write({
			"packages/sim/src/a.ts": "// @ts-expect-error legacy\n",
			"CONSTRAINTS.md": withException(row("E1", "apps/web/**", "2026-11-30")),
		});
		expect(guard().code).toBe(1);
	});

	it("blocks an exception that runs too long or past the freeze, or has no date", () => {
		setup();
		repo.write({ "CONSTRAINTS.md": withException(row("E1", "x", "2026-12-15")) });
		expect(guard().out).toContain("[exception-too-long]"); // more than 30 days after 10 Nov
		repo.write({ "CONSTRAINTS.md": withException(row("E1", "x", "2026-12-21")) });
		expect(guard({ FLOOR_GUARD_TODAY: "2026-12-01" }).out).toContain("[exception-too-long]");
		repo.write({ "CONSTRAINTS.md": withException(row("E1", "x", "soon")) });
		expect(guard().out).toContain("[exception-invalid]");
	});

	it("fails every change once an Exceptions row has expired", () => {
		repo = makeRepo({ ...BASE, "CONSTRAINTS.md": withException(row("E1", "x", "20 Nov 2026")) });
		expect(guard().code).toBe(0);
		const r = guard({ FLOOR_GUARD_TODAY: "2026-11-21" });
		expect(r.code).toBe(1);
		expect(r.out).toContain("[exception-expired] CONSTRAINTS.md");
	});

	// #99: the gaps the #40 review found in Exceptions rows.
	describe("Exceptions rows (#99)", () => {
		const rowFor = (rule, path, expires = "2026-11-30", id = "E1") => row(id, path, expires, rule);
		const TS_IGNORE = { "packages/sim/src/a.ts": "// @ts-ignore\n" };

		it.each([
			["its own rule", "silenced-checker", 0],
			["its rule in words", "silenced checker", 0],
			["one of several rules", "config-loosened, silenced-checker", 0],
			["another rule only", "test-made-easier", 1],
		])("waives a finding when the Rule column names %s", (_, rule, code) => {
			setup();
			repo.write({
				...TS_IGNORE,
				"CONSTRAINTS.md": withException(rowFor(rule, "packages/sim/src/a.ts")),
			});
			const r = guard();
			expect(r.code).toBe(code);
			if (code) expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
		});

		it("refuses a Rule column that names no rule the guard knows", () => {
			setup();
			repo.write({
				...TS_IGNORE,
				"CONSTRAINTS.md": withException(rowFor("anything goes", "packages/sim/src/a.ts")),
			});
			expect(guard().out).toContain("[exception-invalid] CONSTRAINTS.md");
		});

		it.each(["**", "*/**", "**/*.ts", "*"])(
			"refuses the Path %s, which reaches past one folder",
			(path) => {
				setup();
				repo.write({
					...TS_IGNORE,
					"CONSTRAINTS.md": withException(rowFor("silenced-checker", path)),
				});
				const r = guard();
				expect(r.out).toContain("[exception-too-broad] CONSTRAINTS.md");
				expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			},
		);

		it("fails every change while a row has a date it cannot read", () => {
			repo = makeRepo({
				...BASE,
				"CONSTRAINTS.md": withException(rowFor("silenced-checker", "x", "soon")),
			});
			repo.write({ "packages/sim/src/b.ts": "export const b = 2;\n" });
			expect(guard().out).toContain("[exception-invalid] CONSTRAINTS.md");
		});

		it("ignores FLOOR_GUARD_TODAY under Actions", () => {
			repo = makeRepo({
				...BASE,
				"CONSTRAINTS.md": withException(rowFor("silenced-checker", "x", "2026-11-01")),
			});
			expect(guard({ FLOOR_GUARD_TODAY: "2026-10-20" }).code).toBe(0);
			// Under Actions the real date counts, and 1 Nov 2026 has passed.
			const r = guard({ FLOOR_GUARD_TODAY: "2026-10-20", GITHUB_ACTIONS: "true" });
			expect(r.out).toContain("[exception-expired] CONSTRAINTS.md");
			expect(r.out).toContain("FLOOR_GUARD_TODAY is ignored in CI");
		});

		it("does not waive with a row inside a ~~~ fence", () => {
			setup();
			const fenced = CONSTRAINTS.replace(
				"## Floor\n",
				`~~~\n## Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${rowFor("silenced-checker", "packages/sim/src/a.ts")}\n~~~\n\n## Floor\n`,
			);
			repo.write({ ...TS_IGNORE, "CONSTRAINTS.md": fenced });
			const r = guard();
			expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(r.out).not.toContain("waived by");
		});

		it("fails a second level-2 Exceptions heading", () => {
			setup();
			repo.write({ "CONSTRAINTS.md": `${CONSTRAINTS}\n## Exceptions\n\nMore.\n` });
			expect(guard().out).toContain("[exceptions-heading-repeated] CONSTRAINTS.md");
		});

		// Review of B1: formatting that renders the same, or a parser that reads fences differently
		// from CommonMark, hid an expired row. Expiry now reads every row-shaped line in the file.
		const EXPIRED = rowFor("silenced-checker", "x", "2026-11-05");
		it.each([
			["a closing-hash heading", (t) => t.replace("## Exceptions", "## Exceptions ##")],
			["an indented heading", (t) => t.replace("## Exceptions", " ## Exceptions")],
			["a setext heading", (t) => t.replace("## Exceptions", "Exceptions\n---")],
			["a lowercase heading", (t) => t.replace("## Exceptions", "## exceptions")],
			["a bold ID", (t) => t.replace("| E1 |", "| **E1** |")],
			[
				"an indented tilde line before it",
				(t) => t.replace("## Floor\n", "## Floor\n\nx\n    ~~~\n"),
			],
			["a backtick line that is no fence", (t) => t.replace("## Floor\n", "## Floor\n\n```a`\n")],
		])("still fails an expired row hidden by %s", (_, hide) => {
			repo = makeRepo({ ...BASE, "CONSTRAINTS.md": withException(EXPIRED) });
			repo.write({ "CONSTRAINTS.md": hide(withException(EXPIRED)) });
			const r = guard();
			expect(r.code).toBe(1);
			expect(r.out).toContain("[exception-expired] CONSTRAINTS.md");
		});

		it("does not waive with a row inside a fence that a non-closing line keeps open", () => {
			setup();
			const smuggled = CONSTRAINTS.replace(
				"## Floor\n",
				`~~~\n~~~ example\n## Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${rowFor("silenced-checker", "packages/sim/src/a.ts", "2026-11-30", "E2")}\n~~~\n\n## Floor\n`,
			).replace(
				"## Exceptions\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n| _none_",
				"## Exceptions ##\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n| _none_",
			);
			repo.write({ ...TS_IGNORE, "CONSTRAINTS.md": smuggled });
			const r = guard();
			expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(r.out).not.toContain("waived by");
		});

		// Security review of #131: the waiver and expiry paths read IDs differently, and added rows
		// weren't checked against today.
		it.each([
			["an emphasis mark inside the ID", "E*1", "exception-invalid"],
			["a plain ID", "E1", "exception-expired"],
		])("refuses an added row that has already expired, with %s", (_, id, finding) => {
			setup();
			repo.write({
				...TS_IGNORE,
				"CONSTRAINTS.md": withException(
					rowFor("silenced-checker", "packages/sim/src/a.ts", "2026-11-01", id),
				),
			});
			const r = guard();
			expect(r.out).toContain(`[${finding}] CONSTRAINTS.md`);
			expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(r.out).not.toContain("waived by");
		});

		// Waivers come only from the Exceptions table itself: its exact header, at the left margin.
		it.each([
			[
				"a table inside a list item",
				(r) =>
					CONSTRAINTS.replace("| ID | Rule |", "- note\n\n  | ID | Rule |").replace(
						"|---|---|---|---|---|---|\n| _none_ | | | | | |",
						`  |---|---|---|---|---|---|\n  ${r}`,
					),
			],
			[
				"a <pre> block",
				(r) =>
					CONSTRAINTS.replace(
						"| _none_ | | | | | |",
						"| _none_ | | | | | |\n\n<pre>\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n" +
							`${r}\n</pre>`,
					),
			],
			[
				"a second table with the same header",
				(r) =>
					CONSTRAINTS.replace(
						"| _none_ | | | | | |",
						`| _none_ | | | | | |\n\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${r}`,
					),
			],
			[
				"a table with another header",
				(r) =>
					CONSTRAINTS.replace(
						"| _none_ | | | | | |",
						`| _none_ | | | | | |\n\n| ID | Rule | Path | Why | Who | Until |\n|---|---|---|---|---|---|\n${r}`,
					),
			],
		])("does not waive with a row in %s", (_, place) => {
			setup();
			repo.write({
				...TS_IGNORE,
				"CONSTRAINTS.md": place(rowFor("silenced-checker", "packages/sim/src/a.ts")),
			});
			const r = guard();
			expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(r.out).not.toContain("waived by");
		});

		// Review of #131 at 3ba0c32 (admin, 9 Nov: fix all six; after this the Markdown parsing is
		// frozen, and further edge cases go to the follow-up for a real parser).
		const TABLE =
			"| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n| _none_ | | | | | |";
		const OK_ROW = rowFor("silenced-checker", "packages/sim/src/a.ts");
		it.each([
			[
				"a <details> block",
				`<details>\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${OK_ROW}\n</details>`,
			],
			[
				"a hidden <div>",
				`<div hidden>\n| ID | Rule | Path | Reason | Owner | Expires |\n|---|---|---|---|---|---|\n${OK_ROW}\n</div>`,
			],
			[
				"a table with no delimiter row",
				`| ID | Rule | Path | Reason | Owner | Expires |\n${OK_ROW}`,
			],
		])("does not waive with the table inside %s", (_, table) => {
			setup();
			repo.write({ ...TS_IGNORE, "CONSTRAINTS.md": CONSTRAINTS.replace(TABLE, table) });
			const r = guard();
			expect(r.out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(r.out).not.toContain("waived by");
		});

		it.each([
			["without its leading pipe", (l) => l.replace(/^\| /, "")],
			["in a blockquote", (l) => `> ${l}`],
		])("still fails an expired row written %s", (_, rewrite) => {
			const expired = rowFor("silenced-checker", "x", "2026-11-01");
			repo = makeRepo({ ...BASE, "CONSTRAINTS.md": withException(expired) });
			repo.write({ "CONSTRAINTS.md": withException(rewrite(expired)) });
			expect(guard().out).toContain("[exception-expired] CONSTRAINTS.md");
		});

		it("fails an ID used twice", () => {
			const first = rowFor("silenced-checker", "apps/web/");
			repo = makeRepo({ ...BASE, "CONSTRAINTS.md": withException(first) });
			repo.write({ ...TS_IGNORE, "CONSTRAINTS.md": withException(`${first}\n${OK_ROW}`) });
			const r = guard();
			expect(r.out).toContain("[exception-invalid] CONSTRAINTS.md");
			expect(r.out).not.toContain("waived by");
		});

		it.each(["2026-11-31", "00 Dec 2026", "2026-02-29"])("fails the impossible date %s", (date) => {
			setup();
			repo.write({
				...TS_IGNORE,
				"CONSTRAINTS.md": withException(rowFor("silenced-checker", "packages/sim/src/a.ts", date)),
			});
			const r = guard();
			expect(r.out).toContain("[exception-invalid] CONSTRAINTS.md");
			expect(r.out).not.toContain("waived by");
		});

		it.each([
			["Reason", "| E1 | silenced-checker | `packages/sim/src/a.ts` |  | Soto | 2026-11-30 |"],
			["Owner", "| E1 | silenced-checker | `packages/sim/src/a.ts` | reason |  | 2026-11-30 |"],
		])("fails a row with no %s", (_, r) => {
			setup();
			repo.write({ ...TS_IGNORE, "CONSTRAINTS.md": withException(r) });
			expect(guard().out).toContain("[exception-invalid] CONSTRAINTS.md");
		});

		it.each(["./packages/sim/", "packages//sim/", "packages/../sim/", "/packages/sim/", "."])(
			"fails the Path %s, which can never match",
			(path) => {
				setup();
				repo.write({
					...TS_IGNORE,
					"CONSTRAINTS.md": withException(rowFor("silenced-checker", path)),
				});
				expect(guard().out).toContain("[exception-invalid] CONSTRAINTS.md");
			},
		);

		it("counts a closing-hash or setext heading as a second Exceptions heading", () => {
			setup();
			repo.write({ "CONSTRAINTS.md": `${CONSTRAINTS}\nexceptions\n---\n\n## Exceptions ##\n` });
			expect(guard().out.match(/\[exceptions-heading-repeated\]/g)).toHaveLength(2);
		});

		it.each(["packages/*/src/**", "apps/**/x.ts", "packages/sim/*.ts", "packages/sim/a?.ts"])(
			"refuses the Path %s, a wildcard short of a whole folder",
			(path) => {
				setup();
				repo.write({
					...TS_IGNORE,
					"CONSTRAINTS.md": withException(rowFor("silenced-checker", path)),
				});
				expect(guard().out).toContain("[exception-too-broad] CONSTRAINTS.md");
			},
		);

		// Admin, 9 Nov: the widest a Path may be is one package or a folder inside it.
		it.each(["packages/**", "packages/", "apps/**", "packages/*/src/a.ts", "docs/"])(
			"refuses the Path %s, wider than one package",
			(path) => {
				setup();
				repo.write({
					...TS_IGNORE,
					"CONSTRAINTS.md": withException(rowFor("silenced-checker", path)),
				});
				expect(guard().out).toContain("[exception-too-broad] CONSTRAINTS.md");
			},
		);

		it.each(["packages/sim/**", "packages/sim/", "packages/sim/src/a.ts", "packages/sim/src/"])(
			"accepts the Path %s, one folder or file",
			(path) => {
				setup();
				repo.write({
					...TS_IGNORE,
					"CONSTRAINTS.md": withException(rowFor("silenced-checker", path)),
				});
				expect(guard().out).toContain("waived by E1");
			},
		);

		it("ignores FLOOR_GUARD_TODAY under any CI, not only Actions", () => {
			repo = makeRepo({
				...BASE,
				"CONSTRAINTS.md": withException(rowFor("silenced-checker", "x", "2026-11-01")),
			});
			expect(guard({ FLOOR_GUARD_TODAY: "2026-10-20", CI: "true" }).out).toContain(
				"[exception-expired] CONSTRAINTS.md",
			);
		});

		it("still reports an expired row behind an earlier, empty Exceptions heading", () => {
			repo = makeRepo({
				...BASE,
				"CONSTRAINTS.md": withException(rowFor("silenced-checker", "x", "2026-11-05")),
			});
			repo.write({
				"CONSTRAINTS.md": withException(rowFor("silenced-checker", "x", "2026-11-05")).replace(
					"## Floor\n",
					"## Exceptions\n\n## Floor\n",
				),
			});
			const r = guard();
			expect(r.code).toBe(1);
			expect(r.out).toContain("[exception-expired] CONSTRAINTS.md");
		});
	});

	// #132: the known misses of the line reader (#131's body, #132's 9 Nov comment), each read the
	// way GitHub renders it.
	describe("Markdown read as GitHub renders it (#132)", () => {
		const OK_ROW = row("E1", "packages/sim/src/a.ts", "2026-11-30", "silenced-checker");
		// Each edit must change the fixture, so a replace() that stops matching fails here instead of
		// passing on the unedited file.
		const run = (edit) => {
			const base = withException(OK_ROW);
			const edited = edit(base);
			expect(edited).not.toBe(base);
			setup();
			repo.write({ "packages/sim/src/a.ts": "// @ts-ignore\n", "CONSTRAINTS.md": edited });
			return guard().out;
		};

		it.each([
			[
				"a code fence holding a <div> line",
				(t) => t.replace("## Exceptions\n", "```html\n<div>\n```\n## Exceptions\n"),
			],
			[
				"a list item and a lone tag",
				(t) => t.replace("## Exceptions\n", "- item\n<span>\n## Exceptions\n"),
			],
			[
				"a closed <details> block",
				(t) =>
					t.replace("| ID |", "<details><summary>Notes</summary>Old rows.</details>\n\n| ID |"),
			],
			// Void elements never stay open, and the end of a paragraph closes an inline element
			// (review of #259).
			["an inline <span> left open", (t) => t.replace("| ID |", "Old rows: <span>none.\n\n| ID |")],
			["an <hr> and a <br/>", (t) => t.replace("| ID |", "<hr>\n\nOld rows: none.<br/>\n\n| ID |")],
			// HTML inside a list item, block quote or table cell closes with it (review of #265).
			["a <details> in a list item", (t) => t.replace("| ID |", "- <details>\n\n| ID |")],
			["a <details> in a block quote", (t) => t.replace("| ID |", "> <details>\n\n| ID |")],
			[
				"a <details> in a table cell",
				(t) =>
					t.replace(
						"## Exceptions\n",
						"| a | b |\n|---|---|\n| <details> | x |\n\n## Exceptions\n",
					),
			],
		])("waives with the Exceptions table right after %s", (_, edit) => {
			expect(run(edit)).toContain("waived by E1");
		});

		it.each([
			[
				"a delimiter row one cell short",
				(t) => t.replace("|---|---|---|---|---|---|\n", "|---|---|---|---|---|\n"),
			],
			[
				"a <details> block with blank lines",
				(t) =>
					t.replace("| ID |", "<details>\n\n| ID |").replace(OK_ROW, `${OK_ROW}\n\n</details>`),
			],
			// Review of #259: HTML ignores the slash on `<details/>`, a `<details>` above the heading
			// holds the whole section, and inline HTML opens an element as a block does.
			["a self-closed <details/>", (t) => t.replace("| ID |", "<details/>\n\n| ID |")],
			[
				"a <details> above the heading",
				(t) => t.replace("## Exceptions\n", "<details>\n\n## Exceptions\n"),
			],
			["an inline <details>", (t) => t.replace("| ID |", "Old rows: <details>\n\n| ID |")],
			// A closing tag inside a comment closes nothing (review of #265).
			[
				"a </details> only in a comment",
				(t) => t.replace("| ID |", "<details>\n<!-- </details> -->\n\n| ID |"),
			],
			// A `<!--` inside an attribute opens no comment (review of #265).
			[
				"a <details> whose attribute holds <!--",
				(t) => t.replace("| ID |", '<details title="<!--">\n\n| ID |'),
			],
			[
				"an inline <details> whose attribute holds <!--",
				(t) => t.replace("| ID |", 'Old rows: <details title="<!--">\n\n| ID |'),
			],
		])("does not waive with %s", (_, edit) => {
			const out = run(edit);
			expect(out).toContain("[silenced-checker] packages/sim/src/a.ts");
			expect(out).not.toContain("waived by");
		});

		// Known misses (admin, 15 Nov: the last fix round on the HTML reading). The browser reads
		// `<![CDATA[` and `<?` outside SVG or MathML as a comment up to the first `>`, so a
		// `</details>` there closes nothing; the guard counts it and the table waives.
		it.fails.each([
			["a </details> in a CDATA section", "<![CDATA[ </details> ]]>"],
			["a </details> in a processing instruction", "<? </details> ?>"],
		])("does not waive with %s (known miss)", (_, hidden) => {
			const out = run((t) => t.replace("| ID |", `<details>\n${hidden}\n\n| ID |`));
			expect(out).not.toContain("waived by");
		});

		it.each([
			["a block quote", "> ## Exceptions"],
			["a list item", "- ## Exceptions"],
		])("counts a heading in %s as a second Exceptions heading", (_, line) => {
			const out = run((t) => `${t}\n${line}\n`);
			expect(out).toContain("[exceptions-heading-repeated] CONSTRAINTS.md");
			expect(out).not.toContain("waived by");
		});
	});
});

describe("floor guard helpers", () => {
	// An Exceptions row's Rule column may name exactly the findings `weak` reports, so a new weak
	// finding that's missing from WAIVABLE (or a stale name in it) fails here.
	it("knows every waivable finding by name", () => {
		const source = readFileSync(SCRIPT, "utf8");
		const verdicts = source.slice(
			source.indexOf("const compareNumbers"),
			source.indexOf("const keyOf"),
		);
		const emitted = new Set([
			...[...source.matchAll(/\bweak\(\s*['"]([a-z]+(?:-[a-z]+)+)['"]/g)].map((m) => m[1]),
			...[...source.matchAll(/\brule:\s*['"]([a-z]+(?:-[a-z]+)+)['"]/g)].map((m) => m[1]),
			...[...verdicts.matchAll(/['"]([a-z]+(?:-[a-z]+)+)['"]/g)].map((m) => m[1]),
		]);
		expect([...WAIVABLE].sort()).toEqual([...emitted].sort());
	});

	it("finds the array a line sits in", () => {
		const lines = [
			"x: {",
			"  exclude: [",
			"    'a',",
			"    [1, 2],",
			"    'b',",
			"  ],",
			"  include: ['c'],",
			"}",
		];
		expect(enclosingKey(lines, 3)).toBe("exclude");
		expect(enclosingKey(lines, 5)).toBe("exclude");
		expect(enclosingKey(lines, 7)).toBe("include");
		expect(enclosingKey(lines, 8)).toBe(null);
	});

	it("matches exception paths as globs", () => {
		expect(globToRegExp("packages/sim/**").test("packages/sim/src/a.ts")).toBe(true);
		expect(globToRegExp("packages/*/src/a.ts").test("packages/sim/src/a.ts")).toBe(true);
		expect(globToRegExp("packages/*/a.ts").test("packages/sim/src/a.ts")).toBe(false);
		expect(globToRegExp("packages/sim/").test("packages/sim/src/a.ts")).toBe(true);
		expect(globToRegExp("a.ts").test("b/a.ts")).toBe(false);
	});

	it("reads ISO and written dates", () => {
		expect(parseDate("2026-12-20")).toBe(Date.UTC(2026, 11, 20));
		expect(parseDate("20 Dec 2026")).toBe(Date.UTC(2026, 11, 20));
		expect(parseDate("next week")).toBe(null);
	});
});
