---
status: accepted
---

# Module and file organisation, and the code conventions

`packages/sim/src/` (#81, PR #121) landed as one flat folder: every file a module, each test next
to it, any file free to import any other. #82–#89 add `createSim`, content, about seven rule areas,
`advance` and the property harness, so flat would mean 25–35 files with no visible boundaries. The
admin also wants agents to write TypeScript the way the admin writes it by hand (admin, 9 Nov).
This ADR records what a module is, how `packages/sim` splits, where tests live, how files are
named, and which of the admin's conventions are adopted. #125 builds it: the configs,
`docs/agents/code-style.md` and the move of today's code.

## How this was decided

A grill on #124 with the admin, 9 Nov 2026, one question per turn, with the findings of #123
(`docs/spikes/code-style/findings.md`: conventions C1–C20 and 17 conflicts with this repo) in hand.
Q1–Q27 below are the questions in the order they were settled. The review of PR #130 added fixes,
and the admin confirmed two details there (9 Nov): property selectors enforce the outside-shape
naming row (section 6), and the *Avoid* list of `GLOSSARY.md`'s Interface entry. Where a convention clashed with
`CONSTRAINTS.md`, ADR-0002 or ADR-0003, the repo won unless the admin changed it; each change to
`CONSTRAINTS.md` is listed under [Consequences](#consequences).

"Module" and "interface" are used as `GLOSSARY.md` defines them (Q27). The rules apply to every
`packages/*` and to `apps/web/src/`, except folders whose file names a framework dictates (Next's
`app/`: `page.tsx`, `layout.tsx`, `route.ts`). Web-specific layout (route groups, `_components/`,
where `src/server/` sits) is decided when `apps/web` is created in M3. `.github/scripts/` is CI
tooling and stays flat (Q9).

## 1. A module is a folder with one entry file (Q1, Q2, Q7, Q8)

- **A module is a folder whose entry is `index.ts`.** Code outside the folder imports only the
  entry; every other file in the folder is private to it, and siblings import each other directly.
- **`index.ts` holds the module's main code**, not re-exports: `hash/index.ts` contains
  `stateHash` itself, and its helpers live in `hash/sha256.ts` and `hash/canonicalJson.ts`. Under
  NodeNext the import still names the file: `'../hash/index.js'`.
- **A module is a folder from its first line**, even when `index.ts` is its only file, and the
  folder is never renamed. Promoting `random.ts` to `random/index.ts` later would rewrite every
  caller's import for a change that isn't theirs.
- **A module deepens inside its folder, without widening its interface.** First helpers grow below
  the main export in `index.ts` (C3), then they move into private siblings (C17), then a group of
  siblings becomes a child module.
- **Modules nest, and a child is private to its parent.** `facilities/addOns/index.ts` is imported
  only by `facilities/`'s own files, through the child's `index.ts`; everything outside goes
  through `facilities/index.ts`. The same rule holds at every depth.
- **A folder is a module.** There are no grouping folders without an `index.ts` (no `rules/`),
  with one exception: a module's `tests/` folder (section 4).

**Patterns:** module pattern with information hiding (an explicit entry, private implementation);
deep modules (a small interface over a larger implementation, `codebase-design`).

**Rejected:**

- **A module is a file** (today's layout): the boundaries exist by convention only.
- **A folder with no single entry:** the folder groups files, but callers can import any of them,
  so a module's insides leak to its callers again.
- **A barrel `index.ts` that only re-exports:** one forwarding file per module that makes the module
  look shallow. The admin tried barrels in tutor (Jun 2025) and deleted them a month later (C7).
- **An entry named after its folder** (`hash/hash.ts`): never the admin's habit. The cost of many
  editor tabs named `index.ts` is accepted: "cheap and easily resolvable in most IDE settings".
- **Start as a file and promote it** (the admin's habit, C17): the move then happens one level
  down, inside the folder.
- **Flat modules only:** a big module turns back into a flat pile of files.
- **Grouping folders** such as `src/rules/plots/`: a folder without an `index.ts` would break the
  rule above, and in a package this size it adds no locality the feature names don't give.

## 2. The package entry is the one export list (Q3)

`packages/*/src/index.ts` holds only `export { … } from` and `export type { … } from` lines, and
no code. It is the only place a re-export is allowed, and nothing but re-exports is allowed in it.
`createSim` gets its own module (`sim/`).

So a change to which names a package exports is always a diff to that one file, which is what
`CONSTRAINTS.md`'s "Interface change" row reads, and the list of a package's exported names is one
short file (resolves conflict 4 with section 1).

The file lists names, not their shapes. Changing `createSim`'s signature, or a state-slice or action
type inside a feature module, changes the interface without touching `src/index.ts`. The "Interface
change" row's "the sim's state or action types" therefore spans `state/` and the feature modules,
and #125 updates the row's paths to say so.

**Pattern:** facade (one entry that lists a package's interface).

**Rejected:**

- **The package's main code in its `index.ts`**, as section 1 does for modules: every edit to
  `createSim`'s body would then trigger the "Interface change" row.
- **Subpath exports** (`@sunny-pastures/sim/hash`): a wider interface, and more paths for the row to
  watch.

## 3. `packages/sim` splits by feature (Q4, Q5, Q6)

One module per glossary concept, each owning its rules, its part of the state type, its actions
and its automated steps, next to a few shared modules. Content stays one module. This is C16's
folder structure for the sim.

```
packages/sim/src/
  index.ts      export list (section 2)
  sim/          createSim, newFarm, dispatching actions
  advance/      the next-event loop and MUST-10.6's tie key
  content/      Content types and the slice data   ("Content change" row path)
  state/        FarmState, Action, ApplyResult; the safe-integer invariant
  hash/         stateHash (canonicalJson, sha256 private)
  random/       mulberry32, streamSeed
  plots/        #82        progress/   #83 (Level, unlocks, buying)
  facilities/   #84, #85   pens/ #86   orders/ #87
```

This is the expected map, not a list of folders to create: a folder appears with the ticket that
needs it (`AGENTS.md`). #125 creates only `hash/`, `random/` and `state/` for today's code.

**Repeated logic becomes a shared module at its second occurrence** (the admin's condition on the
split). It goes into a module named for its concept, for example `storage/` (fits, put, take),
used by harvesting, collecting jobs, collecting eggs and the Collector. If an existing module owns
the concept, the helper joins that module's `index.ts` interface instead, as the purchase rule does
in `progress/`. "The same logic" means the same rule, not the same shape: two loops over different
arrays aren't duplicates. This is a deliberate change from the admin's habit of copying first
(C20).

**`fallow dupes` checks it from #125:** 0 new clones in the files a change touches, across
`packages/sim` source and tests, in `check:task` and CI. Fallow is already an approved tool
(`CONSTRAINTS.md`, "Tools are dependencies"); #125 installs it with an exact pin, sets the mode and
minimum clone size so today's code passes, and proves that a copied helper fails. #41 reuses the
install. A clone detector doesn't catch the same rule written two ways; review and the rule above
cover that, and `fallow-ignore-*` comments are already a weakened bar (Floor).

**Patterns:** package by feature (vertical slices named from `GLOSSARY.md`); a shared kernel for
cross-cutting modules; DRY at the second occurrence, extracted by concept.

**Rejected:**

- **By layer** (`state/`, `rules/`, `advance/`, `content/`): every ticket would touch every folder.
- **Content split per feature** (`plots/content.ts`): the "Content change" row would have to watch
  every feature folder.
- **A catch-all `shared/`, `lib/` or `utils/`:** a drawer of shallow functions with no owner, and
  nothing tells an agent where a new helper belongs.
- **The helper stays where it was first written:** `plots/` would become the accidental owner of
  storage, and `facilities/` would depend on `plots/`.
- **The rule of three:** the admin asked for strict.
- **Doc-only dedup:** contradicts "strict", and `AGENTS.md` turns mechanical mistakes into checks.
- **Waiting for #41 (M3):** #82–#88, where storage and buying repeat first, would go unchecked.

## 4. Tests live in a `tests/` folder inside their module (Q10–Q13)

- **A module's tests are in its own `tests/` folder:** `hash/tests/index.test.ts`,
  `hash/tests/sha256.test.ts`. They are the module's own files, so they may test a private sibling
  directly (an internal seam, such as SHA-256 against the NIST vectors). The test files of
  `.github/scripts/` move to `.github/scripts/tests/` the same way (Q9).
- **Everything in a `tests/` folder is test code,** including helpers that aren't `*.test.ts`
  (generators, builders). Lint, tsconfig and coverage key on `**/tests/**` as well as `*.test.ts`.
- **The MUST-14 property harness lives in `sim/tests/`,** the module that owns `createSim`. The
  properties import through the package entry (`../../index.js`), so they test what `apps/web`
  will call, and each feature ticket adds its action generators there.
- **A test helper used by more than one module lives in the `tests/` folder of the module that owns
  its concept** (for example farm generators in `state/tests/farms.ts`). Tests in other modules
  import it by path (`../../state/tests/farms.js`). That is the only crossing: the importer is
  test code and the target is inside another module's `tests/`. Source never imports a `tests/`
  folder, and tests reach another module's source only through its `index.ts`.
- **Lint snippet tests** (`sim-purity.test.mjs`, and #125's module-boundary snippets) live in
  `.github/scripts/tests/`, since they import ESLint and `node:*`.

This resolves conflict 2: the tests leave the code's folder but stay under `src/`, so Vitest's
`include` still finds them.

**Patterns:** co-located tests (per module, in a subfolder); tests exercise the module's
interface, with internal seams open to the module's own tests.

**Rejected:**

- **Tests beside the code** (today): the layout #124 set out to replace.
- **A central `src/tests/` tree mirroring `src/`** (the admin's own work rule from 20 Sep): tests
  outside a module need a lint exception to reach its private files, and the mirror drifts and
  leaves orphaned tests when a module is renamed or deleted.
- **A package-level `test/` folder outside `src/`:** the same exception, plus changes to the
  guarded Vitest and coverage globs.
- **The harness as its own test-only module** (`src/properties/`): a module nothing imports has no
  interface. **At package level** (`packages/sim/tests/`): the glob changes again.
- **Only lint treats helpers as tests** (they stay source for tsc and coverage): a three-way split
  that agents would have to learn.
- **A test-only module of shared helpers** (`src/testing/`): the test-side `utils/` drawer, and
  more guarded globs. **Helpers exported from the owner's `index.ts`:** test code in the shipped
  interface and on the "Interface change" row.

## 5. File and folder names (Q14, Q15)

- One lowercase word where possible (`hash/`, `random/`, `plots/`, `storage/`, `sha256.ts`);
  camelCase when a name needs more words (`addOns/`, `canonicalJson.ts`); PascalCase for React
  component files and folders in `apps/web` (C19; resolves conflict 1).
- `.test.ts` is the only suffix: no `.spec.ts`, and no `*.types.ts`, since a module's types live in
  its `index.ts` or a `types.ts` sibling.
- Never rename by case alone: case-insensitive filesystems (macOS, Windows) confuse git.
- **Enforced by `eslint-plugin-check-file`** (`filename-naming-convention`,
  `folder-naming-convention`), a new dev dependency the admin approved. The structure rules of
  sections 1 and 4 (a module folder has an `index.ts`; `tests/` is the only other folder) are
  doc only: the admin doesn't need them enforced that strictly, and prefers a maintained
  dependency to custom tooling. The import rules of sections 1 and 4 are configuration of core
  ESLint `no-restricted-imports`, proved by snippet tests. A later ESLint block's options for a
  rule replace an earlier block's, so in the sim the module-boundary patterns are merged into the
  purity rule's options in both sim blocks, not added as a block of their own; otherwise the
  purity import ban would silently drop.

**Rejected:** kebab-case everywhere (today's `canonical-json.ts`), and kebab-case modules with
PascalCase components: both buy only npm-style consistency nothing here needs. A custom layout test
in `.github/scripts/tests/` (it would also check the structure rules, but it is about 50 lines of
tooling to own). Doc only for names.

## 6. Code conventions (Q16–Q26)

Each convention is adopted, adapted or dropped, and enforced by a config where one exists. #125
turns this list into the configs and `docs/agents/code-style.md`, which holds only what the configs
can't check.

### Tooling

- **Typed linting** (Q22): `tseslint.configs.strict` becomes `strictTypeChecked` (which includes
  `strict`) plus `stylisticTypeChecked`, with `parserOptions.projectService`, and
  `disableTypeChecked` for JS and config files (`*.mjs`, `vitest.config.mts`). It adds rules and
  turns none off. It makes the type-aware rules below possible, and one of them is turned on by
  name because neither preset includes it: **`@typescript-eslint/switch-exhaustiveness-check`**,
  over the `Action` and status unions (ADR-0003 §5). It was the main reason for typed linting.
  #125 measures `check:fast` before and after against its 5 s budget; if typed linting breaks it,
  the fallback is typed rules in `check:task` only, which is a moved stage and needs an admin PR.
  Rejected: **a hand-picked set of typed rules** on top of `strict` (a list of our own that drifts
  as typescript-eslint adds rules), and **no typed linting** (it gives up exhaustiveness checking,
  which the sim's growing action and status unions lean on).
- **Prettier** (Q19; C15, resolves conflict 14): `prettier` with a committed `.prettierrc`:
  double quotes, semicolons, `trailingComma: "all"`, **tabs** (`useTabs: true`; the admin's call
  over 2 spaces), `printWidth: 100`. Scope: `*.{ts,tsx,mts,mjs,js,json}`; Markdown is out
  (hand-wrapped docs, tables). `prettier --check` runs in `check:fast` and CI. The reformat of
  today's code is its own PR in #125, so `.git-blame-ignore-revs` can name its squash commit.
  Rejected: **`@stylistic/eslint-plugin`** (formatting through lint rules, slower, with weaker
  auto-fix) and **no formatter** (quotes and indentation drift between agents).
- **Import order** (Q20; C8): `@ianvs/prettier-plugin-sort-imports`, so sorting is part of
  formatting. Groups today: packages, a blank line, relative. `apps/web` adds `@/` and its layers
  in M3. Rejected: **`eslint-plugin-simple-import-sort`** (a second tool doing a formatting job)
  and **no sorting** (the admin's most deliberate setup, at work, sorted imports through
  Prettier).
- **New dependencies** (resolves conflict 17), each approved by the admin in this grill:
  `eslint-plugin-check-file`, `prettier`, `@ianvs/prettier-plugin-sort-imports`,
  `@vitest/eslint-plugin`, plus Fallow, which `CONSTRAINTS.md` already lists.

### Types (Q16)

| | Convention | Decision | Enforced by |
|---|---|---|---|
| C1 | Strictness | Keep this repo's options; add `erasableSyntaxOnly` and `allowUnreachableCode: false`. Not `noUnusedLocals`/`noUnusedParameters`: `no-unused-vars` already covers them, and tsc's version blocks a compile mid-edit | `tsconfig.base.json` |
| C1 | `as` casts | Adapt: no `as` on object literals (type the variable instead); `as const` allowed | `@typescript-eslint/consistent-type-assertions` (`objectLiteralTypeAssertions: "never"`) |
| C4 | `interface` vs `type` | Adopt: `interface` for object shapes, `type` for unions and derived types; props are `<Component>Props` | `@typescript-eslint/consistent-type-definitions: "interface"` |
| C5 | No enums | Adopt; `as const satisfies` for fixed tables (doc) | `erasableSyntaxOnly` |
| conflict 6 | `import type` | Repo wins | `verbatimModuleSyntax` (on) |
| conflict 7 | `noImplicitAny: false`, suppressions | Repo wins | `strict`; the Floor |

An `interface` has no implicit index signature, so it doesn't satisfy `Record<string, unknown>` or
a recursive `JsonValue` type. If the sim ever proves at type level that `FarmState` is plain JSON,
relax the rule for the state types.

### Functions, classes, exports (Q17)

| | Convention | Decision | Enforced by |
|---|---|---|---|
| C2 | `function` declarations | Adopt: exported and top-level functions are declarations; arrows for callbacks and small local helpers | core `func-style: ["error", "declaration", { allowArrowFunctions: true, overrides: { namedExports: "declaration" } }]` on `{apps,packages}/**/*.{ts,tsx}`; private top-level arrows: doc |
| C2, conflict 8 | No classes | Adopt, strictly in the sim (ADR-0003 §5); doc elsewhere | `no-restricted-syntax` on `ClassDeclaration`, `ClassExpression` in the sim's `SIM_SYNTAX` |
| C3 | Main export first, helpers below | Adapt: `index.ts` starts with the interface (as few names as possible), then private helpers as `function` declarations | doc |
| C6 | Default vs named | Adopt: named only in `.ts`; default for React components (`.tsx`) and where Next requires it | core `no-restricted-exports` (`restrictDefaultExports`, all options) on `{apps,packages}/**/*.ts`, except `apps/web/src/app/**` |

### Imports (Q18)

C8: relative imports only in `packages/*`, with `.js` extensions as NodeNext requires (the repo
wins on that part of conflict 5); the `@/` alias belongs to `apps/web`, where Next resolves tsconfig
`paths`. Rejected: Node subpath imports (`#hash`; the purity rule would need a `#` exception) and a
tsconfig alias in the sim (consumers' bundlers would have to resolve the sim's private aliases).

### Naming in code (Q21; C9)

| Kind | Decision | Enforced by |
|---|---|---|
| Types, interfaces, components | PascalCase | `@typescript-eslint/naming-convention` |
| Functions, variables, parameters | camelCase; functions start with a verb | same (the verb: doc) |
| Module constants | camelCase, no UPPER_SNAKE (conflict 15). Names that mirror an outside spec keep its name (SHA-256's `K`, `H0`) | same, with the spec names in its `filter` |
| Outside shapes | snake_case only where data mirrors one (DB columns, API fields); sim state and actions are camelCase | same: object-literal and type properties may be camelCase or snake_case, everything else camelCase; in `packages/sim` properties are camelCase only (it mirrors no outside shape); whether a snake_case property really mirrors an outside shape: doc |
| Booleans | `is`, `has`, `can` prefix | same (type-aware selector, Q22) |
| Domain words | `GLOSSARY.md` terms, never its *Avoid* words | doc |
| Handlers (`apps/web`) | `handleX` inside, `onX` props | doc (M3) |

### Errors, absence, async (Q23)

| | Convention | Decision | Enforced by |
|---|---|---|---|
| C10 | Expected failures returned | Adopt (agrees with ADR-0003 §4, conflict 12); `throw` only for programmer errors | `only-throw-error` |
| C10 | Logged and dropped | Drop: handle or pass up | `no-console` in `packages/*`; empty `catch` blocked by the Floor |
| C10 | Messages to users | Full sentences ending in a period | doc |
| C11, conflict 11 | `\|\|` fallbacks | Drop for `??` (0 coins is a value) | `prefer-nullish-coalescing` |
| C11, conflict 11 | Defensive `?.` | Drop | `no-unnecessary-condition` |
| C11, conflict 10 | `null` vs `undefined` | `null` for an absent value wherever we control it (it survives JSON; ADR-0003 §5); `undefined` only where the language gives it; no `null \| undefined` unions | doc; `exactOptionalPropertyTypes` (on) |
| C11 | `==` | `===` always | core `eqeqeq: "always"` |
| C12 | `return await` | Adopt | `return-await: ["error", "always"]` |
| C12 | `.then` inside `await` | Drop; `Promise.all` for independent awaits | doc |

Rejected: **`eslint-plugin-promise`** for `.then` mixing (`prefer-await-to-then`): a plugin for one
rule.

### Comments and statements (Q24)

| | Convention | Decision | Enforced by |
|---|---|---|---|
| C13 | UPPERCASE banners | Allowed; more than two is a cue to split into a sibling | doc |
| C13 | No JSDoc | Comments say why and cite the decision (ADR section, MUST-xx, #N) (conflict 13); a doc comment on an export only when it states what the type can't (invariant, error mode, unit) | doc |
| C13 | Commented-out code | Drop: git keeps history | doc |
| C13 | TODOs | Drop: open an issue | core `no-warning-comments` (`terms: ["todo", "fixme"]`) |
| C13 | Language | English | doc |
| C14 | Guard clauses | One-line `if` without braces, then a blank line | core `curly: ["error", "multi-line"]`; the blank line: doc |
| C14 | Early return | No `else` after `return` | core `no-else-return` |
| C14 | Destructuring | Objects | core `prefer-destructuring` (`object: true`, `array: false`) |
| C14 | Ternaries | One level at most | core `no-nested-ternary` |
| C14 | Strings, spread | Templates and spread | core `prefer-template`, `prefer-spread`, `prefer-object-spread` |

Rejected: **`sonarjs/no-commented-code`** (`eslint-plugin-sonarjs`) for commented-out code: a
large plugin for one rule.

### Tests and the rest (Q25, Q26)

- **`describe`/`it` everywhere** (C18, conflict 3): a `describe` names the unit, each `it` reads as
  a sentence. Enforced by `@vitest/eslint-plugin` (`consistent-test-it`, plus `expect-expect`,
  `no-focused-tests` and `no-disabled-tests`, which back up the Floor), a new dev dependency.
  Rejected: **`test` everywhere** (against the admin's habit, and the `.github/scripts` half of
  the repo already uses `it`) and **leaving the split** (sim on `test`, scripts on `it`).
- **Config as data** (C20): adopted; it is already ADR-0003 §1 and MUST-10.4.
- **Copy before abstracting** (C20): dropped by section 3.
- **Commit subjects** (conflict 16): Conventional Commits stay. ADR-0002 makes the PR title's
  prefix the PR's type and the squash subject, and agents write the commits.
- **Conflict 9** (unseeded `Math.random`, `setTimeout` time): the purity rules win
  (ADR-0003 §3, §7).
- **Findings' open questions:** 3 (`noImplicitAny`: the repo's `strict` wins), 4 (tabs), 5
  (arrow-const fetchers become `function` declarations, C2; server actions are camelCase and
  verb-first, Q21; handler names are settled in M3), 6 (snake_case for outside shapes: keep), 7
  (tests: in each module's `tests/`) and 9 (banners: allowed, with a split cue) are answered
  above. 1, 2 and 8 (identity, AI help, how much work-A counts) are moot, since each convention was
  decided here rather than counted.

## Patterns

| Pattern | Where | Why |
| --- | --- | --- |
| Module pattern, information hiding | every module folder | Callers see one entry; the rest can change without them. |
| Deep modules | module interfaces | Much behaviour behind few names, deepened inside the folder. |
| Facade | `packages/*/src/index.ts` | One export list, so every change to the exported names is a diff to one file. |
| Package by feature, shared kernel | `packages/sim/src/` | A ticket mostly adds one folder; names match `GLOSSARY.md`. |
| DRY at the second occurrence, by concept | shared modules such as `storage/` | No copies, and no `utils/` drawer without an owner. |
| Co-located tests in a subfolder | `<module>/tests/` | Tests move with their module and may test its internal seams. |

## Consequences

- **#125 builds this,** in parts that each pass CI: the configs, the move and renames of today's
  sim code (`hash/` with `index.ts`, `canonicalJson.ts`, `sha256.ts`; `random/`; `state/` for the
  safe-integer invariant; tests into each module's `tests/`), the 43 `test(` calls to `it(`,
  `UINT32_END` to `uint32End`, `Draw` to an `interface`, and the Prettier reformat on its own.
  Behaviour doesn't change: the same tests pass, the 18 hash vectors are unchanged, and coverage
  doesn't drop.
- **What changes in the guarded configs, and why nothing stops being counted:**
  - `vitest.config.mts`: `test.include` is unchanged. `{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}`
    already matches `src/<module>/tests/*.test.ts`, and `.github/scripts/**/*.test.mjs` matches
    `.github/scripts/tests/`. `coverage.include` is unchanged. `coverage.exclude` gains
    `**/tests/**`, which removes only test helpers: every source file stays under
    `coverage.include`, since the module rules keep source out of `tests/`.
  - `packages/sim/tsconfig.json`: `exclude` gains `src/**/tests/**`; `tsconfig.test.json`:
    `include` gains `src/**/tests/**`.
  - `eslint.config.mjs`: `SIM_TEST_FILES` becomes `packages/sim/**/*.test.ts` and
    `packages/sim/**/tests/**`; the new rules above are added. No rule is turned off.
- **What `guard / floor` reports, and the Exceptions rows it needs.** An Exceptions row holds one
  Path glob, and the guard's glob has no `{a,b}` braces, so #125 writes one row per path, in the
  PR that trips it:
  - `vitest.config.mts`: the `**/tests/**` added to `coverage.exclude`; in the reformat, every
    re-indented line inside `exclude` (added) and `include` (removed).
  - `packages/sim/tsconfig.json`: `src/**/tests/**` added to `exclude`; in the reformat, the
    re-indented `exclude` line.
  - `eslint.config.mjs`: any removed line matching `configs.` or `'error'`, so replacing
    `tseslint.configs.strict` trips it, and so does the reformat (each `'error'` becomes
    `"error"`).

  The exclusions stay after the rows expire, because `CONSTRAINTS.md`'s text now says so.
- **The order of #125's PRs matters**, because CI runs the base branch's guard:
  `floor-guard.test.mjs` holds TODO, "not implemented" and suppression strings as test data. If
  they show up as added lines, they are findings that can't be waived. So the move of
  `.github/scripts` tests is a near-pure rename (git's `-M`) in its own PR, first. The Prettier
  reformat is its own PR, so `.git-blame-ignore-revs` can name its squash commit. Moving the sim's
  tests and rewriting `test(` to `it(` happen in different PRs, or git may miss the rename and
  report a deleted test.
- **`CONSTRAINTS.md` changes (in #125, admin-approved):**
  - the purity row: files in a module's `tests/` folder (not only `*.test.ts`) may also import
    `vitest` and `fast-check`;
  - "What counts for coverage": tests and test helpers (everything in a `tests/` folder) are
    excluded;
  - a new duplication row: `fallow dupes`, 0 new clones in changed files across `packages/sim`
    source and tests, at task end and in CI;
  - the "Interface change" row: "the sim's state or action types" now lives in `state/` and the
    feature modules (section 2), and the row's paths say so;
  - "Tools are dependencies" names `eslint-plugin-check-file`, `prettier`,
    `@ianvs/prettier-plugin-sort-imports` and `@vitest/eslint-plugin` next to the tools already
    listed;
  - the Exceptions rows above.
- **Paths and path logic in scripts that the layout changes** (line numbers as of `b82fc1f`):
  - `floor-guard.mjs`'s `SELF` set (line 32) and `floor-guard.test.mjs`'s `SELF_TEST` (line 90)
    name `.github/scripts/floor-guard.test.mjs`.
  - Relative URLs that change depth when the tests move into `tests/`: `floor-guard.test.mjs`
    lines 9 (`./floor-guard.mjs`), 130 (`../workflows/ci.yml`) and 237 (`../../CONSTRAINTS.md`);
    `coverage-gate.test.mjs` line 6 (`./coverage-gate.mjs`); `sim-purity.test.mjs` line 11
    (`new URL('../..')`, the repo root).
  - `test-repo.mjs` is a test helper and moves to `.github/scripts/tests/`.
  - `sim-purity.test.mjs` lints `packages/sim/src/random.ts` and `packages/sim/src/sha256.ts` by
    path, which become `random/index.ts` and `hash/sha256.ts`.
  - `coverage-gate.mjs` line 100 (`looksLikeSource`, used when the lcov is missing) tells source
    from tests by `.test.` alone, so it would count `tests/` helpers as source; it learns
    `/tests/`.

  The "Content change" row watches the content values, which live in `packages/sim/src/content/`
  (narrowed from the whole folder in #68 step 1, 12 Nov), and the "Interface
  change" row keeps `packages/*/src/index.ts` (with the addition above). `AGENTS.md` links
  `docs/agents/code-style.md` with one line.
- **Every new dependency is pinned exactly** and must be at least 7 days old (`pnpm-workspace.yaml`).
  #125 checks each plugin's peer range against ESLint 10.14.0 and Prettier 3.
- **Tickets #82–#89 follow the map** in section 3, creating each folder when its ticket needs it.
