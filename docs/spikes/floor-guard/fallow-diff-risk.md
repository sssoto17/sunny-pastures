# Can Fallow's diff-risk rules replace parts of the floor guard?

Spike #505, 22 Nov 2026. It compares every check of `.github/scripts/floor-guard.mjs` (1,845 lines,
`guard / floor`) with what Fallow's diff-risk rules (`weakened-tests`, `added-suppression`) catch in
the version this repo pins, and recommends what to delete, keep or refactor.

**Answer: no part should be deleted.** Fallow matches some forms of four floor-guard findings
(`silenced-checker`, `test-made-easier`, `test-deleted`, `assertion-removed`). Even there it isn't a
replacement: its finding can be silenced in the same PR by a comment Fallow itself ignores, or by
the PR's own Fallow config, and an Exceptions row can't clear it. The code that overlaps is about 20
lines of regex, so deleting it wouldn't shrink the complexity target either. Keep the floor guard,
refactor it (#530), fix the gap Fallow exposed (#531), and leave Fallow's rules at `warn` when #503
adds `fallow audit` to CI.

## Sources

- **Fallow 3.43.1**, the pinned devDependency (`package.json`): `pnpm exec fallow --version` prints
  `fallow 3.43.1 … signed`. The rule texts are from `pnpm exec fallow explain weakened-tests` and
  `fallow explain added-suppression`, and from the package's `schema.json` (lines 302–303 and
  2075–2084: both default `warn`, "`fallow audit` only"), `issue-registry.json` (`suppressible`,
  `suppress_comment: "// fallow-ignore-next-line …"`) and `types/output-contract.d.ts` (lines
  1266–1270: `DiffRiskRule`, and `WeakenedTestsKind` = `skip-only`, `removed-tests`,
  `assertion-drop`, `coverage-threshold`). The fallow.tools docs describe 3.46.0, so they weren't
  used.
- **What Fallow detects**, from `fallow explain`:
  - `added-suppression`: an added comment with `eslint-disable`, `oxlint-disable`, `biome-ignore`,
    `deno-lint-ignore`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `istanbul ignore`,
    `c8 ignore`, `v8 ignore` or `fallow-ignore`. "A `fallow-ignore` comment that names only
    diff-risk rules does not count."
  - `weakened-tests`: a new `.skip`, `.only`, `xit` or `fit`; fewer test cases; fewer `expect`,
    `assert` or `should` calls, reported "only when assertions are at least half of the code lines
    that the file lost"; a less strict coverage or quality threshold.
- **The floor guard**: `floor-guard.mjs` on `main` at `da2c67c`, and CONSTRAINTS.md, "Floor (always
  enforced)" and "Exceptions". Line numbers below are that file's.

## How each row was decided

Every row comes from a throwaway diff on a scratch branch made from `origin/main` (`da2c67c`),
committed, then checked with three commands. The branch was deleted afterwards and never pushed.

```sh
FLOOR_GUARD_TODAY=2026-11-22 node .github/scripts/floor-guard.mjs --base HEAD~1
pnpm exec fallow audit --base HEAD~1 --format json --quiet                     # default severities
pnpm exec fallow audit -c "$ERR" --base HEAD~1 --format json --quiet           # both rules at error
```

`$ERR` is a copy of `.fallowrc.jsonc` outside the repo with
`"rules": { "weakened-tests": "error", "added-suppression": "error" }` added. The diffs are the
functions in [the appendix](#appendix-the-diffs) (`s01` …). The Floor guard and Fallow columns quote
each tool's exit code and findings from that run. "Fallow" means its `diff_risk.findings`: no other
part of the audit reports these.

With default severities, `fallow audit` exits 0 on every diff-risk finding: the verdict is `warn`.
With the rules at `error`, the same diffs exit 1 (verdict `fail`). `--fail-on-issues` and `--ci`
leave the warn exit at 0 too (checked on `s01`). A bad base exits 2 in both tools
([row 34](#the-table)).

## The table

Verdicts: **keep** (Fallow catches none of it), **partial** (Fallow catches some forms or only
warns; the guard stays), **replace** (Fallow covers it fully: no row got it). Fallow column: caught
/ caught differently / not caught.

<!-- prettier-ignore -->
| # | Floor-guard check (finding, code) | Diff | Floor guard | Fallow 3.43.1 | Verdict |
|---|---|---|---|---|---|
| 1 | `silenced-checker`: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, `istanbul`/`c8`/`v8 ignore`, `fallow-ignore-*` (`SUPPRESSIONS`, 94–95; loop 1499–1500) | s01–s07, s11, s12, s69 (`.github/scripts/diff.mjs`) | exit 1, `[silenced-checker] apps/web/src/server/http/body.ts:1` each | caught: `added-suppression`, evidence the token (`@ts-ignore`, `eslint-disable`, `fallow-ignore` …); exit 0 (warn), exit 1 at error | partial |
| 2 | `silenced-checker`: `Stryker disable`, `nosemgrep`, `gitleaks:allow` | s08–s10 | exit 1, `[silenced-checker] …body.ts:1` | not caught: `verdict=pass diff_risk=0`, exit 0 at error too | keep |
| 3 | `silenced-checker`: `# noqa`, `# type: ignore` | s13, s14 (`tools/analysis/spike.py`) | exit 1, `[silenced-checker] tools/analysis/spike.py:1` | not caught (`diff_risk=0`): Fallow reads JS and TS only | keep |
| 4 | `silenced-checker`: inline config `/* eslint rule: value */` (`INLINE_CONFIG`, 110) | s15 | exit 1, `[silenced-checker] …body.ts:1` | not caught (`diff_risk=0`) | keep |
| 5 | `silenced-checker`: a `fallow-ignore-next-line` naming a diff-risk rule | s16 (above a `@ts-ignore`), s24 (above an `it.skip`), s59 (alone) | exit 1: s16 lines 1 and 2, s24 `silenced-checker` 56 and `test-made-easier` 57, s59 line 46 | not caught, by design: `diff_risk=0` and exit 0 at error for s16, s24 and s59. The comment also hides the finding on the next line | keep |
| 6 | `test-made-easier`: `.skip`, `.only`, `xit`, `fit` (`SKIPS`, 96; 1503) | s17, s18, s22, s23; s70 (`.github/scripts/tests/dupes.test.mjs`) | exit 1, `[test-made-easier] apps/web/src/server/http/tests/request.test.ts:56` | caught: `weakened-tests/skip-only`, line 56, evidence `it.skip`, `it.only`, `xit`, `fit` | partial |
| 7 | `test-made-easier`: `.todo`, `.skipIf(…)`, `.runIf(…)` | s19–s21 | exit 1, `[test-made-easier] …request.test.ts:56` | not caught (`diff_risk=0`) | keep |
| 8 | `test-deleted`: a test file deleted; a rename is not a deletion (1462) | s25 delete; s26 `git mv` | s25 exit 1, `[test-deleted] …request.test.ts:file`; s26 exit 0, `clean` | s25 caught: `weakened-tests/removed-tests`, evidence `test cases: 25 -> 0`; s26 `diff_risk=0` | partial |
| 9 | `assertion-removed`: fewer `expect`/`assert` in a test that stayed (1505–1512) | s27: three `expect` lines removed | exit 1, `[assertion-removed] …request.test.ts:94 (old)` | caught: `weakened-tests/assertion-drop`, evidence `assertions: 27 -> 24` | partial |
| 10 | `assertion-removed`, a whole test case removed | s28 | exit 1, `[assertion-removed] …:86 (old)` | caught differently: `weakened-tests/removed-tests`, `test cases: 25 -> 24` | partial |
| 11 | `assertion-removed`, one assertion removed with its setup lines | s61 | exit 1, `[assertion-removed] …:71 (old)` | not caught (`diff_risk=0`): assertions were under half the lost code lines | keep |
| 12 | `assertion-removed`, an assertion turned into a comment | s62 | **exit 0, `clean`**: `ASSERTIONS` (123) counts `expect` in the comment. Bug #531 | caught: `weakened-tests/assertion-drop`, `assertions: 27 -> 26` | keep, fix (#531) |
| 13 | `property-runs-cut`: a run count lowered, deleted or made a literal (`runCount`, 129; 1593–1615) | s29: `SIM_PROPERTY_RUNS … ?? 100` → `?? 10` | exit 1, `[property-runs-cut] vitest.config.mts:10 (old)` | not caught (`diff_risk=0`) | keep |
| 14 | `config-loosened`: coverage `exclude` widened in `vitest.config.*` (`configLoosening`, 461–468) | s30 | exit 1, `[config-loosened] vitest.config.mts:76` | not caught (`diff_risk=0`) | keep |
| 15 | `config-loosened`: ESLint rule `off`, `ignores` widened, a config line commented out (469–484; `commentedOut`, 412) | s32, s33, s64 | exit 1: `eslint.config.mjs:297`; `:272` and `:272 (old)`; `:268` and `:268 (old)` | not caught (`diff_risk=0`) | keep |
| 16 | `config-loosened`: a `strict` option relaxed in `tsconfig*.json` (485–509) | s34 | exit 1, `[config-loosened] tsconfig.base.json:15` and `:15 (old)` | not caught (`diff_risk=0`) | keep |
| 17 | `config-loosened`: a path in `.prettierignore`, `.semgrepignore` (`.gitleaksignore` too) (429–435) | s35, s36 | exit 1, `.prettierignore:18`; `.semgrepignore:10` | not caught (`diff_risk=0`) | keep |
| 18 | `config-loosened`: the Fallow config (453–460) | s37 `ignorePatterns`; s38 both rules `off`; s76 = s38 + a `@ts-ignore` | exit 1, `[config-loosened] .fallowrc.jsonc:4` (s76 also `silenced-checker`) | not caught; s76: `verdict=pass diff_risk=0`, so the PR's own config switches the rules off | keep |
| 19 | `config-loosened`: Prettier's settings: `.prettierrc` `overrides`, `.prettierrc` deleted, a new `.editorconfig`, a `prettier` key in `package.json` (1463, 1468–1486, 1516–1536, 436–452) | s39, s63, s40, s41 | exit 1: `.prettierrc:8`; `.prettierrc:file`; `.editorconfig:file`; `package.json:3` | not caught (`diff_risk=0`) | keep |
| 20 | `config-loosened`: `disableRules` (axe) in any code file (510–511) | s49 | exit 1, `[config-loosened] …body.ts:45` | not caught (`diff_risk=0`; the `fail` verdict is dead code, a new unused export) | keep |
| 21 | `config-loosened`: `.gitleaks.toml`, `osv-scanner.toml`, Stryker and Lighthouse configs, by keyword (453–460, row 18's branch) | s66: Stryker `thresholds` `low: 60` → `40` | exit 0, `clean`: only keywords count, not numbers | not caught (`diff_risk=0`): `coverage-threshold` doesn't read Stryker. Neither tool; the gate is ci.yml's literal `60`, not this file | keep |
| 22 | A formatting-only change in a guarded config isn't a loosening (#138; `withoutFormatting`, 341) | s68: ESLint `ignores` array re-wrapped | exit 0, `clean` | `diff_risk=0` | keep |
| 23 | `check-removed`: a `package.json` script loses a check, or skips the ratchet outside `check:task` (`scriptChecks`, 60; 1515) | s42 `check:fast` without `guard:floor`; s43 `--skip-ratchet` in `check:full` | exit 1, `[check-removed] package.json:28 (old)`; `package.json:34` | not caught (`diff_risk=0`) | keep |
| 24 | `check-removed`: a workflow step that runs a check removed, `continue-on-error: true`, a new `if:` (1536–1586) | s44, s45, s46 (`ci.yml`, `lint` job) | exit 1, `[check-removed] .github/workflows/ci.yml:152 (old)`; `:133`; `:133` | not caught (`diff_risk=0`): Fallow doesn't read YAML | keep |
| 25 | Dependabot's SHA-only bump passes; anyone else's fails (`pinnedAction`, 1544; `dependabot`, 1787) | the guard's tests (needs an Actions event) | `pnpm exec vitest run --project unit .github/scripts/tests/floor-guard.test.mjs -t "SHA-only bump"`: `5 passed`, exit 0 | no counterpart | keep |
| 26 | CONSTRAINTS.md rules: `threshold-loosened`, `-removed`, `-changed`, `severity-dropped`, `stage-moved`, `rule-removed`, `rule-narrowed` (`constraintsFindings`, 985; `compareRule`, 958) | s50 `≥ 90%` → `≥ 70%`; s71 number dropped; s75 `lines` → `files`; s52 `_(warn)_`; s53 `edit` dropped; s51 bullet deleted; s73 `nosemgrep` dropped; s72 `≤ 50 ms` → `≤ 1 s` | exit 1: `[threshold-loosened] CONSTRAINTS.md:93`, `[threshold-removed] :93`, `[threshold-changed] :253`, `[severity-dropped] :90`, `[stage-moved] :90`, `[rule-removed] :75 (old)`, `[rule-narrowed] :41`, s72 `[rule-narrowed] :98` | not caught (`diff_risk=0` each): Markdown | keep |
| 27 | The change report: every changed CONSTRAINTS.md rule quoted, carve-outs marked `warning [rule-narrowed]` (`changeReport`, 1239) | s67: "unless the admin allows them" added to a Floor bullet | exit 0, `warning [rule-narrowed]: adds "unless", adds "allows"` | no counterpart | keep |
| 28 | `unfinished-work`: a `TODO` (`TODO`, 102; 1501), never waivable | s47 | exit 1, `[unfinished-work] …body.ts:1` | not caught (`diff_risk=0`) | keep |
| 29 | `unfinished-work`: a directive that switches off a floor rule (`switchesOffFloor`, 111) | s48 `eslint-disable-next-line no-empty`; s65 `/* eslint no-empty: "off" */` | exit 1: s48 `silenced-checker` and `unfinished-work`; s65 the same | s48 caught differently: `added-suppression` (warn), a waivable kind; s65 not caught | keep |
| 30 | Waiver: an Exceptions row the PR adds clears its findings on its Path (1693–1721) | s54: s01 plus row `E99` on `body.ts` | exit 0, `silenced-checker at …body.ts:1 waived by E99` | still `added-suppression`; exit 1 at error: an Exceptions row can't clear it | keep |
| 31 | Exceptions validity, never waivable: `exception-too-broad`, `-expired`, `-too-long`, `-invalid`, `exceptions-heading-repeated` (1672–1714) | s55 Path `**`; s56 expired; s57 past the freeze; s74 no Owner; s58 second heading | exit 1: `[exception-too-broad] CONSTRAINTS.md:419`, `[exception-expired] :419`, `[exception-too-long] :419`, `[exception-invalid] :419`, `[exceptions-heading-repeated] :511` | no counterpart (`diff_risk=0`) | keep |
| 32 | Spent Exceptions rows named as a warning (#271; `spentRows`, 1414) | any run, e.g. s67 | `warning: 7 spent Exceptions row(s)`; `floor-guard-spent.test.mjs` passes (appendix) | no counterpart | keep |
| 33 | `SELF`: the guard's own files skip the suppression and stub scans only (36–39, 1498) | the guard's tests | in the 330 passing tests of `floor-guard.test.mjs` | no counterpart | keep |
| 34 | The contract: 0 clean, 1 violation, 2 couldn't run; CI runs `main`'s copy (header, 5–6; `ci.yml` 413) | `--base no-such-ref` | exit 2, `cannot run: no merge base against no-such-ref` | exit 2, `"error":true`. But Fallow reads the PR's own config (row 18), and exits 0 on a `warn` | keep |

## What Fallow catches that the floor guard doesn't

- **An assertion turned into a comment** (row 12, s62): `weakened-tests/assertion-drop`. A floor
  guard bug, filed as #531.
- **A lowered coverage threshold** in a test runner's config (s31, `thresholds: { lines: 90 }` →
  `70` in `vitest.config.mts`, added by a `pre` commit): `weakened-tests/coverage-threshold`,
  evidence `lines: 90 -> 70`; the floor guard says `clean`. The repo sets no Vitest threshold: the
  coverage floors are numbers in CONSTRAINTS.md, which row 26 guards, and `coverage-gate.mjs` reads.
  So nothing to fix today.
- **A test-only branch in source** (s60, `process.env.NODE_ENV === "test"` in `body.ts`):
  `test-only-branch` (warn). No floor rule covers it; whether one should is a question for the
  admin, not a gap in the guard.

## Recommendation

1. **Delete nothing from `floor-guard.mjs`.** Rows 1, 6, 8, 9 and 10 are the only ones Fallow
   catches, and each has a form it misses (rows 2–5, 7, 11). Where it catches, three things keep it
   from replacing the guard:
   - The finding can be silenced in the same PR with no one's approval: a
     `fallow-ignore-next-line added-suppression` comment, which Fallow doesn't count (row 5). A rule
     set to `off` in `.fallowrc.jsonc` (row 18, s76) is code-owned, but Fallow reads it from the PR
     itself, so only the floor guard reports it. The guard's one waiver is an Exceptions row in
     code-owned CONSTRAINTS.md, and CI runs `main`'s copy of the guard.
   - The default is `warn`, which exits 0.
   - It has no Path-scoped, expiring waiver, so at `error` it would block a PR whose Exceptions row
     the admin approved (row 30).

   The overlapping code is `SUPPRESSIONS`, `SKIPS`, `ASSERTION(S)` and the loop lines that use them
   (94–96, 122–123, 1498–1512): about 20 of 1,845 lines. The complexity is in the CONSTRAINTS.md
   comparison, config loosening and the per-file loop, none of which Fallow covers.

2. **Refactor the guard instead (#530).** `fallow health .github/scripts/floor-guard.mjs`
   (cyclomatic / cognitive): `guard` 95 / 152, `configLoosening` 53 / 103, `constraintsFindings` 33
   / 49, `normalizeCode` 31 / 60, `compareNumbers` 25 / 61. Backlog chore, no behaviour change.

3. **Fix the gap Fallow found (#531):** count assertions in code without its comments.

4. **Leave `weakened-tests` and `added-suppression` at their default `warn` when #503 adds
   `fallow audit` to `ci / lint`.** They're on by default in 3.43.1, so #503 needs no config for
   them: they show as annotations, a second signal, and `fallow audit` still exits 0 on them. Not
   `error`: then an approved Exceptions row couldn't clear the PR, and the agent's way out would be
   a `fallow-ignore` comment, which the floor guard flags as `silenced-checker`. Not `off`: they
   catch row 12's form. No new issue: #503 covers adopting the audit.

## Follow-up issues

- #530: chore, refactor `floor-guard.mjs` into modules, no behaviour change.
- #531: bug, an assertion turned into a comment isn't reported as `assertion-removed`.
- #503 (already filed): `fallow audit` in `ci / lint`, where recommendation 4 applies.

## Appendix: the diffs

Each function edits the work tree of the scratch branch; the runner resets it to `origin/main`, runs
`s<N>_pre` and commits it when one exists, runs `s<N>`, commits, and runs the three commands above.
Also checked:
`pnpm exec vitest run --project unit .github/scripts/tests/floor-guard.test.mjs .github/scripts/tests/floor-guard-spent.test.mjs`
(`330 passed | 2 expected fail`, exit 0).

<details>
<summary>scenarios.sh</summary>

```sh
#!/usr/bin/env bash
# Spike #505: throwaway diffs, one per floor-guard rule. Each scenario edits the work tree on the
# scratch branch spike-505-scratch (reset to origin/main before each); run.sh commits and runs
# both tools with --base HEAD~1. Nothing here is pushed.
SRC=apps/web/src/server/http/body.ts
TEST=apps/web/src/server/http/tests/request.test.ts
PY=tools/analysis/spike.py
top() { sed -i "1i $1" "$2"; }

s01() { top '// @ts-ignore' $SRC; }
s02() { top '// @ts-nocheck' $SRC; }
s03() { top '// @ts-expect-error' $SRC; }
s04() { top '// eslint-disable-next-line no-console' $SRC; }
s05() { top '/* istanbul ignore next */' $SRC; }
s06() { top '/* c8 ignore next */' $SRC; }
s07() { top '/* v8 ignore next */' $SRC; }
s08() { top '// Stryker disable next-line all' $SRC; }
s09() { top '// nosemgrep' $SRC; }
s10() { top '// gitleaks:allow' $SRC; }
s11() { top '// fallow-ignore-next-line unused-export' $SRC; }
s12() { top '// fallow-ignore-file' $SRC; }
s13() { mkdir -p tools/analysis; printf 'import os  # noqa\n' > $PY; }
s14() { mkdir -p tools/analysis; printf 'x: int = "a"  # type: ignore\n' > $PY; }
s15() { top '/* eslint no-console: "off" */' $SRC; }
s16() { top '// @ts-ignore' $SRC; top '// fallow-ignore-next-line added-suppression' $SRC; }
s17() { sed -i '0,/\tit("/s//\tit.skip("/' $TEST; }
s18() { sed -i '0,/\tit("/s//\tit.only("/' $TEST; }
s19() { sed -i '0,/\tit("/s//\tit.todo("/' $TEST; }
s20() { sed -i '0,/\tit("/s//\tit.skipIf(true)("/' $TEST; }
s21() { sed -i '0,/\tit("/s//\tit.runIf(false)("/' $TEST; }
s22() { sed -i '0,/\tit("/s//\txit("/' $TEST; }
s23() { sed -i '0,/\tit("/s//\tfit("/' $TEST; }
s25() { git rm -q $TEST; }
s26() { git mv $TEST apps/web/src/server/http/tests/requestRenamed.test.ts; }
# Three assertion lines removed from tests that stay.
s27() { python3 - "$TEST" <<'EOF'
import sys; p=sys.argv[1]; L=open(p).read().split("\n"); out=[]; n=0
for l in L:
    if n<3 and l.strip().startswith("expect(") and l.rstrip().endswith(";"): n+=1; continue
    out.append(l)
open(p,"w").write("\n".join(out))
EOF
}
# One whole test case removed (lines 85-90: "refuses a request with no content type with 415").
s28() { python3 - "$TEST" <<'EOF'
import sys; p=sys.argv[1]; L=open(p).read().split("\n")
i=next(k for k,l in enumerate(L) if 'it("refuses a request with no content type' in l)
j=next(k for k in range(i+1,len(L)) if L[k]=="\t});")
del L[i:j+1]; open(p,"w").write("\n".join(L))
EOF
}
s29() { sed -i 's/process.env\["SIM_PROPERTY_RUNS"\] ?? 100/process.env["SIM_PROPERTY_RUNS"] ?? 10/' vitest.config.mts; }
s30() { sed -i 's#"\*\*/generated/\*\*"\]#"**/generated/**", "apps/web/src/server/http/**"]#' vitest.config.mts; }
# Coverage thresholds: pre adds them (committed as base), change lowers one.
s31_pre() { sed -i 's#reportsDirectory: "coverage",#reportsDirectory: "coverage",\n\t\t\tthresholds: { lines: 90 },#' vitest.config.mts; }
s31() { sed -i 's/thresholds: { lines: 90 }/thresholds: { lines: 70 }/' vitest.config.mts; }
s32() { sed -i '0,/\t\trules: {/s//\t\trules: {\n\t\t\t"no-console": "off",/' eslint.config.mjs; }
s33() { sed -i 's#{ ignores: \[".remember/"\] }#{ ignores: [".remember/", "apps/web/src/server/http/"] }#' eslint.config.mjs; }
s34() { sed -i 's/"strict": true/"strict": false/' tsconfig.base.json; }
s35() { printf 'apps/web/src/server/http/\n' >> .prettierignore; }
s36() { printf 'apps/web/src/server/http/\n' >> .semgrepignore; }
s37() { sed -i '0,/^{$/s//{\n  "ignorePatterns": ["apps\/web\/src\/server\/http\/**"],/' .fallowrc.jsonc; }
s38() { sed -i '0,/^{$/s//{\n  "rules": { "weakened-tests": "off", "added-suppression": "off" },/' .fallowrc.jsonc; }
s39() { sed -i 's/"proseWrap": "always",/"proseWrap": "always",\n  "overrides": [{ "files": "*.ts", "options": { "requirePragma": true } }],/' .prettierrc; }
s40() { printf 'root = true\n[*]\nindent_style = space\n' > .editorconfig; }
s41() { sed -i 's/"name": "sunny-pastures",/"name": "sunny-pastures",\n\t"prettier": { "semi": false },/' package.json; }
s42() { sed -i 's/ \&\& pnpm guard:floor \&\& pnpm boundaries",/ \&\& pnpm boundaries",/' package.json; }
s43() { sed -i 's/pnpm coverage:gate \&\& pnpm bench/pnpm coverage:gate --skip-ratchet \&\& pnpm bench/' package.json; }
s44() { sed -i '0,/      - run: pnpm lint$/{/      - run: pnpm lint$/d}' .github/workflows/ci.yml; }
s45() { sed -i '0,/^  lint:$/s//  lint:\n    continue-on-error: true/' .github/workflows/ci.yml; }
s46() { sed -i '0,/^  lint:$/s//  lint:\n    if: false/' .github/workflows/ci.yml; }
s47() { top '// TODO: implement' $SRC; }
s48() { top '// eslint-disable-next-line no-empty' $SRC; }
s49() { printf 'export const opts = { disableRules: ["color-contrast"] };\n' >> $SRC; }
s50() { sed -i 's/| Changed lines ≥ 90% covered |/| Changed lines ≥ 70% covered |/' CONSTRAINTS.md; }
s51() { sed -i '/^- Secrets in source. Read them from env vars/d' CONSTRAINTS.md; }
s52() { sed -i 's/^| Lint | 0 errors from the project config |/| Lint _(warn)_ | 0 errors from the project config |/' CONSTRAINTS.md; }
s53() { sed -i 's/| `eslint .` | edit, CI | `ci \/ lint` | #40 |/| `eslint .` | CI | `ci \/ lint` | #40 |/' CONSTRAINTS.md; }
# A valid Exceptions row that waives s01's finding on its file.
s54() { s01; sed -i '/^| E8 | config-loosened/a | E99 | silenced-checker | apps/web/src/server/http/body.ts | spike #505 test row | Soto | 2026-12-01 |' CONSTRAINTS.md; }
s55() { s01; sed -i '/^| E8 | config-loosened/a | E99 | silenced-checker | ** | spike #505 test row | Soto | 2026-12-01 |' CONSTRAINTS.md; }
s56() { sed -i '/^| E8 | config-loosened/a | E99 | silenced-checker | apps/web/src/server/http/body.ts | spike #505 test row | Soto | 2026-11-01 |' CONSTRAINTS.md; }
s57() { sed -i '/^| E8 | config-loosened/a | E99 | silenced-checker | apps/web/src/server/http/body.ts | spike #505 test row | Soto | 2027-02-01 |' CONSTRAINTS.md; }
s58() { printf '\n## Exceptions\n\nA second heading.\n' >> CONSTRAINTS.md; }
s59() { printf '\n// fallow-ignore-next-line added-suppression\n' >> $SRC; }
s60() { sed -i 's/if (!Number.isSafeInteger(simPropertyRuns)/if (process.env["VITEST"] \&\& !Number.isSafeInteger(simPropertyRuns)/' vitest.config.mts; printf 'export const inTest = process.env.NODE_ENV === "test";\n' >> $SRC; }
s24() { sed -i '0,/\tit("/s//\t\/\/ fallow-ignore-next-line weakened-tests\n\tit.skip("/' $TEST; }
# One assertion removed together with four setup lines in the same test (assertions < half the lost code lines).
s61() { python3 - "$TEST" <<'PYEOF'
import sys; p=sys.argv[1]; L=open(p).read().split("\n")
i=next(k for k,l in enumerate(L) if 'it("accepts a JSON content type with a UTF-8 charset"' in l)
# drop the request setup (4 lines) and the blank line, and the one assertion line
del L[i+1:i+7]
L.insert(i+1, "\t\tawait Promise.resolve();")
open(p,"w").write("\n".join(L))
PYEOF
}
# An assertion turned into a comment that still names expect.
s62() { sed -i '0,/^\t\tawait expect(readActionRequest(request)).resolves.toMatchObject({ ok: true });/s//\t\t\/\/ await expect(readActionRequest(request)).resolves.toMatchObject({ ok: true });/' $TEST; }
s63() { git rm -q .prettierrc; }
s64() { sed -i '0,/^\t{ ignores: \["apps\/web\/next-env.d.ts"\] },/s//\t\/* { ignores: ["apps\/web\/next-env.d.ts"] }, *\//' eslint.config.mjs; }
s65() { top '/* eslint no-empty: "off" */' $SRC; }
s66() { sed -i 's/thresholds: { high: 80, low: 60, break: null }/thresholds: { high: 70, low: 40, break: null }/' stryker.config.mjs; }
s67() { sed -i 's/^- Secrets in source. Read them from env vars and keep placeholders in `.env.example`./- Secrets in source, unless the admin allows them. Read them from env vars and keep placeholders in `.env.example`./' CONSTRAINTS.md; }
s68() { sed -i 's/"\*\*\/node_modules\/", "\*\*\/coverage\/"/"**\/node_modules\/",\n\t\t\t"**\/coverage\/"/' eslint.config.mjs; }
s69() { top '// eslint-disable-next-line no-console' .github/scripts/diff.mjs; }
s70() { sed -i '0,/^\tit("/s//\tit.skip("/' .github/scripts/tests/dupes.test.mjs; }
s71() { sed -i 's/| Changed lines ≥ 90% covered |/| Changed lines covered |/' CONSTRAINTS.md; }
s72() { sed -i 's/on the largest content farm ≤ 50 ms;/on the largest content farm ≤ 1 s;/' CONSTRAINTS.md; }
s73() { sed -i 's/`Stryker disable`, `nosemgrep`, `gitleaks:allow`,/`Stryker disable`, `gitleaks:allow`,/' CONSTRAINTS.md; }
s74() { s01; sed -i '/^| E8 | config-loosened/a | E99 | silenced-checker | apps/web/src/server/http/body.ts | spike #505 test row |  | 2026-12-01 |' CONSTRAINTS.md; }
s75() { sed -i '0,/at most \*\*400 changed lines\*\*/s//at most **400 changed files**/' CONSTRAINTS.md; }
s76() { s01; s38; }
```

</details>
