# The admin's JS/TS conventions, from their handwritten code

Spike #123, 9 Nov 2026. It reports what the admin does when they write JavaScript and TypeScript by
hand, so the design grill (#124) can decide from evidence and the build (#125) can turn the decisions
into `docs/agents/code-style.md`, ESLint and tsconfig rules. It records habits, not
recommendations; opinions are confined to [Notes for the grill](#notes-for-the-grill) at the end.

## How this was gathered

- **Read-only.** Five reader agents, one per repo group, read files and ran only read-only git
  (`log`, `show`, `blame`, one `status` per personal repo). Nothing was installed, built or run in
  the scanned repos, and no `.env*` file was opened. For Billetto (work code), only the admin's own
  commits were read, and this doc gives patterns and counts only: no code, no internal names.
- **Counts** come from grep/find over each group's handwritten files; "N of M" means N files contain
  the pattern. Regex counts can miss multi-line forms. Readers spot-checked by reading files, and
  five counts were re-run independently with the same result (rta files and classes, dmp
  `interface` and default exports, foofest `??`, zero test files).
- **Rule names** in "Enforce" were checked against the pinned `eslint@10.14.0` and
  `@typescript-eslint/eslint-plugin@8.72.1` packages. Plugin status is from the npm registry on
  9 Nov 2026.

## Sources and what counted as handwritten

The admin commits as `Soto` (GitHub and work) and, in 2023–2025 school and tutor repos, under their
KEA student identity with the same student number. Both count as the admin; see
[open question 1](#open-questions-for-the-admin).

| Set (used below) | Path | When | Stack | Handwritten files | AI help | How it was told apart |
|---|---|---|---|---|---|---|
| **dmp** | `Dev/personal/dmp` | Mar–May 2026, plus about 70 uncommitted files after 7 May | Next.js 16, **TS** | 66 (median 42 lines, max 165) | none in history | Only author. Excluded 2 Supabase docs boilerplate clients and the create-next-app files left unchanged. |
| **dream** | `Dev/personal/dream_music_player` | Dec 2025 | Next.js 16, JS | 89 (median 39, max 260) | none | Only author. Python `server/` out of scope. |
| **portfolio** | `Dev/personal/portfolio` | Jun 2026 | Next.js, TS | 17, **low weight** | likely: "agent setup" commits add `AGENTS.md` the day the components land | Style unlike the other repos (type predicates, `as const`, explanatory comments). |
| dmp_sotofy, dmp_v2 | `Dev/personal/` | Nov 2025 | starter kit / Python | 0 | n/a | Unchanged Next.js + Supabase starter; no JS at all. |
| **rta** | `repos/game-rta` | 22–24 Jun 2026 (last day uncommitted) | plain browser JS, no build | 17 JS (median 60, max 183) | 0 of 17 commits; two guards in the uncommitted refactor might be | Only author; `assets/` and the stock `.vscode` template excluded. |
| **tutor** | `Dev/tutor/` (4 of 11 repos) | Apr–Jul 2025 | Next.js 15, JS | 38 (median 32, max 250) | none | Kept nextjs-petfinder 11, async-exhibit 22, tailwind-ui-add-members 3, todo 2. Excluded: shadcn `components/ui` (17), a public SaaS course follow-along (parity-deals), a teacher's starter and backend, a student group's shop. Astro recaps and a student project the admin corrected are extra evidence only. |
| **school** | `Dev/school/` | Nov 2023–Dec 2025 | vanilla JS, Next.js JS, Payload (TS config) | 248: vanilla 26, Next exercises 70, foofest 28, payload 109, ux-exam 9, other 6 | none; WEBDEV 2nd semester (2026) excluded as AI-assisted | `git blame -w` majority in group work; teacher templates found by course names, download markers and identical copies; scaffolds and generated Payload files excluded; 2026 re-edits of old repos kept out. |
| **work-H** | `repos/billetto` (one internal Next.js app) | 16–18 Sep 2026 | Next.js, **TS** | 85 files, 888 added lines (23 commits) | none: the only admin commits without an AI trailer | Commits with no `Co-Authored-By` trailer, minus 2 bulk commits and 4 with AI-style bodies. |
| **work-A** | same | Sep–Nov 2026 | same | 629 files, 72.6k added lines | **yes**: 536 of 567 admin JS/TS commits (94.5%) carry a Claude trailer, and every one since 25 Sep | Shows what the admin accepts and enforces, not what they type. |
| **work-cfg** | same | 20 Sep 2026 | ESLint, Prettier, tsconfig | 1 commit | none | The lint, format and import-order rules the admin wrote by hand. |

**About 560 handwritten files in all.** The most recent handwritten code is work-H (Sep 2026), rta
(Jun 2026) and dmp (Mar–May 2026), so those carry the most weight below. School is the early era.

**How much of it is TypeScript.** Most handwritten code is JavaScript (dream, rta, tutor, school).
TypeScript the admin wrote alone is dmp (66 files, mid-refactor, `noImplicitAny: false`), work-H
(85 files, mostly refactors), and 41 Payload config files that annotate values with framework types
and declare no types of their own. Findings about types (C1, C4, C5, the `import type` part of C8)
rest on that thin base.

## Conventions

Each entry gives the pattern, the evidence, how consistent it is, and how it could be enforced.
"Already on" means the rule is active in this repo today.

### C1. Type strictness

- **Pattern.** JavaScript until Dec 2025, TypeScript from Mar 2026. In dmp the admin tightened the
  scaffold's tsconfig by hand (commits `070e71e`, `33259d7`, 6 May 2026): `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly`,
  `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
  `allowUnreachableCode: false`, and also **`noImplicitAny: false`**.
- **Evidence.** dmp: `as` casts in 12 of 66 files, 2 `@ts-expect-error`, 2 `eslint-disable`. work-H:
  0 `any`; work tsconfig is `strict`. payload: TS only for config, and the admin converted the
  scaffold's `.tsx` pages to `.jsx`.
- **Consistency.** Strict options chosen one by one, looser in practice.
- **Enforce.** tsconfig (this repo is already stricter); `erasableSyntaxOnly` (TS 6.0.3 has it);
  `@typescript-eslint/consistent-type-assertions` (in typescript-eslint's `stylistic`, an existing
  dependency, not enabled here) to limit `as`.

### C2. Functions, not classes; `function` declarations

- **Components are `function` declarations**: dmp 26 of 26, dream 54 of 54, tutor 0 arrow components,
  foofest 37 function vs 1 arrow file, payload 36 vs 5, work-H 3 of 3, work-A 105 vs 0.
  The exception is the Oct–Nov 2024 Next exercises (next-shop 22 arrow vs 5).
- **Top-level helpers are declarations too**: dmp 40 of 66 files vs 8 with top-level arrow consts;
  work-H 10 declarations vs 2 arrows; work-A 1,465 vs 457. Arrows appear for one-line service
  functions, small local helpers and callbacks. Two swings back to arrow-const exports: tutor fetchers
  (Jul 2025, `export const getEvents = async () =>`) and ux-exam (Nov 2025, 5 of 9 files).
- **Classes are rare in React/TS code**: dmp 4 of 66 (API clients and an error class; the newest code
  moves to function services), work-H 1 (replaced the next day), work-A 9 in 72.6k lines, tutor 0,
  school 0.
- **Conflict: rta is class-first.** The plain-JS game has 18 classes in 11 of 17 files, 1 `function`
  declaration, 116 `#private` field references in 9 files, 26 getters and 10 setters. Its setters take deltas:
  `state.score = 3` adds 3.
- **Enforce.** Core `func-style` (`"declaration"`; `allowArrowFunctions` keeps one-liners;
  `overrides.namedExports` targets exports only); core `prefer-arrow-callback` (on in work-cfg).
  Classes: `no-restricted-syntax` on `ClassDeclaration`, or doc only.

### C3. One main export per file, private helpers below it

- **Evidence.** Files that define more than one component: dmp 14 of 26 component files, dream 28 of
  54, foofest 19 of 34, payload 13 of 34; tutor 13 of 38 files have private helper functions. The
  default export comes first and the helpers follow, so the main component reads like a table of
  contents. work-H puts helpers below the exported function that uses them (1 of 1).
- **Consistency.** Stable from 2025 on. Files grow by adding helpers: tutor `CreateEvent.jsx` reaches
  250 lines with 3 helpers, foofest `FormSections.jsx` 418 with 11. **Enforce.** Doc only.

### C4. `interface` for shapes, `type` for unions and derived types

- **Evidence.** dmp: `interface` in 20 of 66 files (props and object shapes, often with `extends`),
  `type` in 8 to 10 (unions, intersections, `ReturnType` aliases). work-H: interface 3, type 11; work-A:
  interface 99 (52 files), type 193 (88). Props are named `<Component>Props` (work-A 33 vs 6 plain
  `Props`; dmp 9 `XProps`, 3 `Props`). Every other set declares no types of its own.
- **Consistency.** The same split in dmp and work. Thin evidence (see above).
- **Enforce.** `@typescript-eslint/consistent-type-definitions` with `"interface"`. It only rewrites
  object-literal type aliases, so unions stay `type`. It is in `stylistic` and not enabled here.

### C5. No enums; string unions; `as const satisfies`

- **Evidence.** 0 `enum` in every set. dmp uses string-literal unions for variants. School and rta
  compare plain strings and use `{ label, value }` arrays. work-H: `as const` 4 and `satisfies` 4 (3
  files); work-A: `as const` 29, `satisfies` 4, plus `keyof typeof` for derived types. By volume,
  the admin uses `satisfies` more by hand than the AI does.
- **Enforce.** tsconfig `erasableSyntaxOnly` (bans enums, namespaces and parameter properties; the admin
  set it in dmp), or `no-restricted-syntax` on `TSEnumDeclaration`.

### C6. Default exports for components, named for everything else

- **Evidence.** Components: dmp 22 of 26 default, dream 46 of 54, tutor 28 of 38. Lib/data modules:
  named (dmp 41 of 66 files have inline named exports). work-H: default 10 lines in 8 files, named 22 in
  11; work-A 129 vs 1,005. rta: default per class file (10 of 17), named for data. ux-exam: 8 of 9
  files named-only. The newest dmp code (`lib/api/*`) uses an export list at the bottom (5 of 66).
- **Enforce.** Core `no-restricted-exports` with `restrictDefaultExports`, scoped by file glob (for
  example lib only). "Default for components" has no core rule.

### C7. `index` files hold real code; barrels are avoided

- **Evidence.** An `index` file is a folder's main module, not a list of re-exports: dmp
  `components/ui/Button/index.tsx` and `lib/Spotify/index.ts`; rta `view/index.js` (a compositor) and
  `config/index.js` (a selector); work-H 24 of 85 touched files are component-folder `index` files;
  payload has 22 `index.jsx` and 17 `index.ts` in feature folders.
- **Barrels.** Tried and dropped in tutor (async-exhibit added `components/index.jsx` in Jun 2025 and
  deleted it in Jul). 0 `export *` in personal, tutor, rta and school. work-H has one `export *`
  barrel, over an ORM schema split per domain; work-A has 9 re-export lines in 3 files. payload uses
  registry files (`blocks/index.jsx`, `export { A, B }` in 4 of 109 files).
- **Enforce.** `no-restricted-syntax` on `ExportAllDeclaration` and `ExportNamedDeclaration[source]`.

### C8. Imports

- **Alias over relative**: `@/` in dmp 28 of 66 files (relative `../` in 14, never deeper than one
  level), dream 61 of 89, tutor 24 of 38, foofest 20 of 28; work-H 79 alias lines vs 11 relative.
  Relative paths stay inside a folder (`./styles`, `./types`). No file extensions in Next code; `.js`
  in rta (18 of 18, required by browser ESM) and ux-exam.
- **Order.** None by hand in personal and tutor (blank-line groups in 9 of 59 dmp files). foofest
  labels groups with `// COMPONENTS` and `// FUNCTIONS` comments (18 of 39 files). payload: the admin
  added `prettier-plugin-organize-imports` (20 May 2025). work-cfg: Prettier sorts imports into 14
  hand-written groups (builtins, react/next, packages, env, vendor clients, UI layers, assets, lib,
  other aliases, relative), with blank lines between them.
- **`import type`** is rare by hand: dmp 6 of 66, work-H 0 statements (2 inline specifiers), payload 5
  of 109. work-A has 198, enforced by a rule an agent added.
- **Enforce.** tsconfig `paths`; core `no-restricted-imports` patterns (for example `../*`); core
  `sort-imports` only sorts members within an import and can't express groups, so groups need a
  plugin or Prettier (see "Tools named above"); `verbatimModuleSyntax` (already on) and
  `@typescript-eslint/consistent-type-imports` for `import type`.

### C9. Naming

| Kind | Admin's habit | Evidence | Conflicts |
|---|---|---|---|
| Components, types | PascalCase | every set | none |
| Functions | camelCase, verb first; fetchers named by HTTP verb (`getEvents`, `postOrder`, `patchSub`) | dmp, tutor, school | school payload also uses PascalCase hooks and helpers (`Slugify`) |
| Module constants | camelCase; **no UPPER_SNAKE** | 0 in personal and rta; rare in school (`SERVER_URL`) | work: UPPER_SNAKE in work-H 7 (5 files), work-A 546 (215 files) |
| Booleans | `is`/`has` prefix | dmp 24 of 66 files, dream 35 of 89, ux-exam 4 of 4 | rta mostly bare (`active`, `muted`: 4 bare vs 3 prefixed) |
| Handlers | `handleX` inner functions, or inline arrows | dmp 7 of 66, dream 7 of 89; tutor and school mostly inline | rta `onX` in an `events` object; work-A `on*` props 63 vs `handle*` 2 |
| Server actions | PascalCase in Dec 2025 → camelCase `handleX` in 2026 | dream 14 of 14, dmp 4 of 4 | between eras |
| Data mirroring an outside shape | keeps snake_case (API fields, DB columns, DOM ids); env vars renamed on destructure | dmp 7 of 66, dream 18 of 89; rta 7 DOM-linked names in 6 of 17 files; dream env rename 12 of 89 | camelCase everywhere else |
| Domain names | generic names renamed to domain-prefixed ones, plural row types to singular | work-H rename commit (15 files); dmp `SpotifyAlbum` | none |
| `.map` index | named `id`, used as the React key | tutor 12 of 38, foofest, payload | none |

- **Enforce.** `@typescript-eslint/naming-convention` (no shared config enables it; the boolean-prefix
  selector needs type information); snake_case exceptions go in its `filter`. Core `id-length` for
  short names.

### C10. Errors are returned, not thrown

- **Expected failures come back as values**: dream `return { error: "…" }` in 9 of 89 files and
  `!res.ok` checks in 10; dmp destructures `{ data, error }` in 8 of 66. School validation builds an
  errors object field by field and returns it with the form values (Nov 2024 to Nov 2025), with
  `throw` 0 times in all five sets. work-H: 23 result-object literals in 6 files vs 4 `throw`.
- **try/catch is rare**: dmp 1 of 66, dream 1 of 89, tutor 1 of 38 (used as control flow), at most 1
  per school set, rta 0, work-H 0.
- **Errors are often logged and dropped**: `console.log` in dmp 15 of 66 files, dream 9 of 89, early
  school 11 of 26; `.catch((err) => console.log(err))`; tutor and school fetchers don't check `res.ok`.
  Messages to users are full sentences ending in a period ("Please enter a valid email.").
- **Conflict.** work-A mixes the two (296 `throw new Error` vs 214 result objects), bridged by a wrapper
  that turns throws into results.
- **Enforce.** Returned errors: doc only. Core `no-console`. `@typescript-eslint/only-throw-error`
  (type-checked configs). The empty `catch {}` is already blocked by the Floor.

### C11. `null`, `undefined`, `?.` and `??`

- **`||` for fallbacks, not `??`**: dmp `||` in 12 of 66 files vs `??` in 2; dream 0 `??`; tutor 0;
  school 0 in all five sets; rta 2. **Conflict:** work uses `??` (work-H 5, work-A 452).
- **Heavy, defensive `?.`**: dmp 75 uses in 21 of 66 files, dream 170 in 28 of 89, foofest 66, payload
  69. Early school 0; rta 0.
- **Absence.** Personal: `undefined` for "not loaded yet", a bare `return;` from components (dmp 7 of 66,
  dream 4 of 89), `null` for API-shaped fields, and unions mixing both (`string | null | undefined`).
  Tutor writes neither. work: `null` dominates (work-H 40 vs 4 `undefined`; work-A 2,800 vs 451),
  with `return null` and a loose `== null` (work-H 3 loose vs 1 strict). `==` elsewhere: 13 of 89 dream
  files, 0 in dmp.
- **Enforce.** `@typescript-eslint/prefer-nullish-coalescing` and `prefer-optional-chain` (in
  `stylistic-type-checked`, which needs typed linting); `@typescript-eslint/no-unnecessary-condition`
  (`strict-type-checked`) would report defensive `?.`. Core `eqeqeq` (option `null: "ignore"` allows
  `== null`). For null vs undefined: `no-restricted-syntax`, or a plugin rule (`unicorn/no-null`).

### C12. Async

- **Evidence.** async/await by default, with `return await` everywhere in dmp and dream. `.then` is mixed
  into await expressions (`await fetch(url).then((res) => res.json())`): dmp 7 of 66 files, dream 7 of
  89, every tutor file that uses `.then` (4), 18 sites across school 2024–2025. `Promise.all` 0 times
  in personal and tutor. Early school (2023–24) used `.then` chains only. work-A: `.then(` 9 vs
  `await` 5,008. React `cache()` wraps readers in dmp, tutor and payload.
- **Enforce.** `@typescript-eslint/return-await` (`strict-type-checked`): its default would report
  `return await` outside try/catch, so the habit needs `"always"`. `.then` mixing: a plugin rule
  (`promise/prefer-await-to-then`).

### C13. Comments

- **UPPERCASE section banners** split a file (`// EVENT LISTENERS`, `// AUTH`, `// API ENDPOINTS`):
  dmp 7 of 66, dream 2 of 89, tutor 6 of 38, foofest 17 of 28, payload 19 of 109, ux-exam 6 of 9,
  early school 9 of 26; work-H uses one section marker. rta has none.
- **No JSDoc**: 0 in personal (172 files), tutor, school, rta and work-H. work-A has 1,337 JSDoc blocks,
  all AI-written, and in two handwritten diffs the admin deleted long explanatory comments.
- **Commented-out code is left in place**: dmp 124 lines in 12 files, dream 68 in 9, rta 43 in 3,
  payload 135 in 17. work cleans it up by HEAD (5 lines left).
- **TODOs**: dmp 7 of 66 files; about 0 elsewhere. **Language**: English only in every set after the
  first-semester exercises (Nov 2023).
- **Enforce.** Core `no-warning-comments` for TODO (the Floor already blocks a TODO standing in for an
  implementation). Commented-out code: a plugin rule (`sonarjs/no-commented-code`). Banners: doc only.

### C14. Statements and control flow (choices Prettier leaves open)

- **Guard clauses as one-line `if` without braces, then a blank line**: dmp 14 of 66 files, dream 24
  of 89, rta 4 sites, work-H 8 in 5 files, work-A 407. Earlier school code prefers `if`/`else` with an
  explicit `else` (early-return patterns 0 of 26 early files, 9 of 109 payload).
- **`const` by default**: `let` in dmp 3 of 66, tutor 1 of 38, foofest 1 vs 164 `const`; `var` 0 except
  2 loops in rta's first draft. Already on here (`prefer-const`, `no-var` via typescript-eslint).
- **Destructuring everywhere**, nested in parameters: dmp 17 of 66, dream 51 of 89, tutor 17 of 38,
  payload 46 of 109, rta 14 lines in 7 files. work-cfg turns on `prefer-destructuring` for objects.
- **Ternaries** in JSX and class strings, nested in dream, tutor and payload (rta 0). **Default
  parameters**: dmp 10 of 66, dream 22 of 89, rta 9 sites. work-cfg turns on `prefer-template`,
  `prefer-spread` and `prefer-object-spread`.
- **Enforce.** Core `curly` with `"multi-line"`, `no-else-return`, `no-nested-ternary`,
  `prefer-destructuring`, `prefer-template`.

### C15. Formatting (what Prettier does settle), for the record

- **Double quotes and semicolons** in every set (dmp 66 of 66; rta 17 of 17; tutor 111 of 111
  imports), except the Payload scaffold's own config (single quotes, no semicolons).
- **Indentation splits**: tabs in dream (77 of 89), portfolio, rta (17 of 17) and 2026 re-saves of
  school repos; 2 spaces in dmp (with a `.prettierrc`), work-cfg, tutor and school 2023–25.
- **Trailing commas**: `es5` in dream, tutor and work-cfg; `all` in dmp and rta. Prettier mostly runs
  from the editor with no repo config. **Enforce:** Prettier, a new dependency.

### C16. Folder structure

- **Next apps.** Route groups by access (dmp `(api)/(auth)/(public)`, tutor `(public)/(auth)`), with
  route-private `_components/`. At the top, folders by type (`components/`, `lib/`, `data/`, `hooks/`);
  inside a concern, files by layer (dmp `lib/auth/{actions,dal,dto,session,user}.ts`).
- **work-H/work-cfg.** By role: routes; `components/` as domain folder → component folder; a data-access
  layer with one module per domain and a `types/` folder of `*.types.ts`; typed `env/`; `hooks/`;
  `lib/` for pure helpers; `services/<vendor>/` for third-party clients; `tests/`. The admin moved
  hooks, data access and vendor clients out of `lib/` by hand (16–18 Sep), then locked the layers in
  lint: routes may not import vendor clients, and shared code may not import routes.
- **rta.** By role inside a feature root: `js/game/{config,logic,entities,view}`, mirrored by
  `style/game/`.
- **school.** ux-exam (Nov 2025): by feature, then one role file each
  (`auth/{api,modules,utils,variables,script}.js`). payload: one folder per feature with role-named
  files (`config.ts` 25, `index.jsx` 22, `index.client.jsx` 5, `access.ts` 3, `hooks.ts` 4).
- **Enforce.** Core `no-restricted-imports` in per-folder config blocks; `import-x/no-restricted-paths`
  (work uses the `import` equivalent); Fallow boundaries (#41, already named in `CONSTRAINTS.md`).

### C17. How a module grows

- **A file becomes a folder with an `index` and siblings.** rta: `view.js` (161 lines) →
  `view/index.js` → a 41-line compositor plus 4 siblings (22–24 Jun 2026). dmp: `lib/spotify/*.ts`
  (Mar 2026) → `lib/Spotify/{schema/,services/,index.ts}` (May 2026), with one schema file per API
  resource and one service file per API area; UI components become `Button/{index.tsx,styles.ts,types.tsx}`.
  foofest's 2026 cleanup: `Filter.jsx` → `Filter/{index,Buttons,Options}.jsx`. payload went through
  three layouts in four weeks (prefixed files, then generic `config.ts` + `index.jsx`, then
  `blocks/`, `collections/`, `globals/`).
- **Before splitting,** files grow by private helpers (C3) and banner sections (C13). Data moves out
  into `config/` or JSON (rta audio tracks and difficulty files, school `data/*.json`). Old versions
  are kept next to new ones for a while (dmp `lib/Spotify/old.ts`).
- **File sizes.** Median (max) lines: dmp 42 (165), dream 39 (260), tutor 32 (250), rta 60 (183).
- **Enforce.** Doc only; core `max-lines` could prompt a split.

### C18. Tests

- **No tests in any personal, tutor, rta or school repo** (0 `*.test.*` or `*.spec.*` files).
- **work went through three layouts.** 7 Sep: beside the source (AI-likely). 16 Sep, by hand: a `tests/`
  folder inside each component or route folder (15 of 15 work-H test files, `index.test.tsx` mirroring
  `index.tsx`). From 20 Sep: one central `src/tests/` tree mirroring `src/`, a rule the admin wrote by
  hand (91 of 117 admin-touched test files at HEAD).
- **Style.** Always `.test.` (0 `.spec.` in work-H); `.integration.test.ts` for database tests (62 of
  117) with their own Vitest config; `describe`/`it` (work-A `it` 1,303 vs `test` 1).
- **Enforce.** Vitest `include`; location: a plugin rule (`check-file/folder-match-with-fex`, which
  work-cfg uses); `it` vs `test`: `vitest/consistent-test-it`.

### C19. File and folder names

- **Component files are PascalCase**: dmp 26 of 26, dream 54 of 54, Next exercises 55 of 70, tutor in 3
  of 4 repos (kebab-case only where a teacher's starter set it). work-cfg: PascalCase component files,
  and `index.tsx` for a component folder.
- **Other modules are lowercase single words** (`dal.ts`, `session.ts`; rta 17 of 17). Multi-word names
  changed over time: snake_case (dream `auth_actions.js`; work-H data modules before the rule) → dotted
  (`player.types.ts` in dmp) → camelCase with a plural suffix (`*.types.ts`), enforced by work-cfg.
- **Folders**: PascalCase for component and library-wrapper folders (work-cfg, payload, dmp
  `lib/Spotify/`), lowercase or camelCase elsewhere. Client parts take a `.client.jsx` suffix (dream 5, payload 5).
- **Enforce.** A plugin: `check-file/filename-naming-convention`, `folder-naming-convention`,
  `filename-blocklist` (what work-cfg uses), or `unicorn/filename-case` (files only).

### C20. Other things that recur

- **Config as data**, mapped by components: nav and option arrays in tutor (9 of 38 files spread props),
  rta difficulty files, school JSON form steps.
- **Copy-paste before abstraction**: a query-string builder copied 3 times (dmp) and 4 times (dream),
  a token-retry block 3 times (tutor), `randomize()` in 3 classes (rta).
- **Commit messages** written by hand are short, with no Conventional Commits prefix (personal, rta
  17 of 17, work-H); prefixes arrive with commitlint and AI help.

## Conflicts with this repo (listed for #124, not resolved)

| # | Admin's habit | This repo | Where it's set |
|---|---|---|---|
| 1 | Lowercase single-word modules, camelCase multi-word, PascalCase components, dotted or `*.types.ts` suffixes (C19) | kebab-case files (`canonical-json.ts`, `state-hash.ts`); no rule yet | `packages/sim/src/` |
| 2 | Tests in a central `src/tests/` tree or a sibling `tests/` folder (C18) | Tests beside the code (`random.test.ts`). Vitest `include` is `{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}` and coverage `include` is `{apps,packages}/*/src/**/*.{ts,tsx}`: a `src/tests/` tree still matches, a `packages/sim/test/` folder would not run | `vitest.config.mts` |
| 3 | `describe`/`it` (C18) | 26 `test()` calls and no `it` in the sim | `packages/sim/src/*.test.ts` |
| 4 | `index` holds the module's code; no re-export barrels (C7) | `src/index.ts` is a re-export entry, named in the "Interface change" escalation row and in `exports` | `CONSTRAINTS.md`; `packages/sim/package.json` |
| 5 | `@/` alias, no file extensions (C8) | NodeNext with `.js` extensions on relative imports; the sim's lint refuses every non-relative import, so an alias would be refused there | `tsconfig.base.json`; `eslint.config.mjs` (`no-restricted-imports`) |
| 6 | Types imported as values; `import type` rare (C8) | `verbatimModuleSyntax: true` requires type-only imports to be marked | `tsconfig.base.json` |
| 7 | `noImplicitAny: false`, `as` casts, `@ts-expect-error` and `eslint-disable` in dmp (C1) | `strict`, no relaxing (a moved threshold); every new suppression is blocked by the Floor | `tsconfig.base.json`; `CONSTRAINTS.md` Floor |
| 8 | Mutable class state with delta setters and `#private` fields (rta, C2) | Plain immutable JSON data, `apply(state, action, at)` | ADR-0003 §5 and "Patterns" |
| 9 | Unseeded `Math.random()` and `setTimeout` time (rta) | `Math.random` and `Date` banned; seeded streams; time arrives as an argument | `eslint.config.mjs` sim rules; ADR-0003 §3, §7 |
| 10 | `undefined` for "nothing yet", `null \| undefined` unions (dmp, C11) | State must survive JSON, which drops `undefined`; `exactOptionalPropertyTypes` separates a missing key from `undefined`; the sim writes `null` 19 times and `undefined` 8 | ADR-0003 §5; `tsconfig.base.json` |
| 11 | `\|\|` fallbacks, defensive `?.` (C11) | No rule today; not in conflict with a written rule, but `no-unnecessary-condition` or `prefer-nullish-coalescing` would report them | `eslint.config.mjs` (`strict`, not type-checked) |
| 12 | Returned errors (C10) | **Agrees**: refusals are returned, throws are for programmer errors | ADR-0003 §4 |
| 13 | No JSDoc, terse comments, UPPERCASE banners, commented-out code kept, TODOs (C13) | Long explanatory comments in configs and sim (no rule); a TODO standing in for an implementation is blocked | repo code; `CONSTRAINTS.md` Floor |
| 14 | Double quotes; Prettier from the editor (C15) | No formatter; sim code uses single quotes | repo code |
| 15 | camelCase module constants, no UPPER_SNAKE (C9) | The sim has 3 UPPER_SNAKE or single-capital constants (`UINT32_END`, `K`, `H0`) and 8 camelCase | `packages/sim/src/` |
| 16 | Commit subjects without a prefix (C20) | Conventional Commits (`feat(sim): …`) | `git log` |
| 17 | Any rule above that needs a plugin or Prettier | Every tool needs the admin's approval and an exact pin; npm releases younger than 7 days are refused | `CONSTRAINTS.md` "Tools are dependencies"; `pnpm-workspace.yaml` |

ADR-0003 §10 (integer-only maths, no 32-bit operators on times): no conflict reported, though the
readers didn't search for transcendental maths or 32-bit operators specifically.

## Tools named above (each a new dev dependency for the admin to approve, row 17)

| Package | Rules mentioned | Latest | Registry last updated |
|---|---|---|---|
| `eslint-plugin-check-file` | `filename-naming-convention`, `folder-naming-convention`, `folder-match-with-fex`, `filename-blocklist` | 3.3.2 | 2026-07-18 |
| `eslint-plugin-unicorn` | `filename-case`, `no-null` | 79.0.0 | 2026-10-23 |
| `eslint-plugin-import-x` (fork of `eslint-plugin-import` 2.32.0, last updated 2025-06-20, which work-cfg uses) | `order`, `no-restricted-paths` | 4.18.1 | 2026-11-09: younger than 7 days, so pnpm would refuse it today |
| `eslint-plugin-simple-import-sort` | `imports`, `exports` | 14.0.0 | 2026-07-16 |
| `@vitest/eslint-plugin` | `consistent-test-it` | 1.6.28 | 2026-10-22 |
| `eslint-plugin-sonarjs` | `no-commented-code` | 4.2.2 | 2026-09-28 |
| `eslint-plugin-promise` | `prefer-await-to-then` | 7.3.0 | 2026-04-27 |
| `prettier` | formatting (C15) | 3.9.10 | 2026-10-10 |
| `@ianvs/prettier-plugin-sort-imports` | import groups as Prettier output (C8) | 4.7.1 | 2026-02-04 |

The type-aware typescript-eslint rules (C10–C12) add no dependency, but they need typed linting
(`parserOptions.projectService`), which this repo's `eslint.config.mjs` doesn't set today.

## Open questions for the admin

No question was put to the admin during the scan; these are for the grill.

1. Are the KEA student identity (2023–2025) and `Soto` both you? The scan assumed so.
2. AI help: was portfolio (Jun 2026) written with an agent? Was rta's uncommitted 24 Jun refactor (the
   observer, the `TypeError` guards, "view adapter")?
3. In dmp: are `lib/api/index.ts` and `errors.ts` (a class-based API client, unlike the rest) yours? Is
   the uncommitted tree after 7 May yours, and from when? Is `noImplicitAny: false` deliberate?
4. Tabs or 2 spaces, and do you have an editor-wide Prettier setting?
5. Server actions: PascalCase (Dec 2025) or `handleX` (2026)? Arrow-const exports for fetchers (Jul and
   Nov 2025) or `function` declarations (dmp, work)?
6. Is snake_case for names that mirror an API, a DB column or a DOM id a rule you want to keep?
7. Tests: was the central `src/tests/` tree (work) your preference or a lint convenience, after the
   sibling `tests/` folder you set up by hand?
8. Does work-A (AI-assisted, 94.5% of your work commits) count as your style, or only as what you
   accept? Do the 2026 edits to old school repos (classes, tab re-indent) count?
9. Were the UPPERCASE section banners and import-group comments taught on the course (the 2023 game
   template has them), or your own?

## Notes for the grill

_Opinion, not findings._

- **Weight dmp and work-H for anything about types.** They are the only TypeScript the admin wrote
  alone, and it's a thin base: treat type rules (C1, C4, C5, `import type`, `??`) as new decisions
  for this repo rather than copies of a habit. Several of the admin's JavaScript habits (`||`
  fallbacks, untyped imports, `undefined` for "nothing yet") already clash with this repo's tsconfig.
- **The habits most stable across eras and repos** are: `function` declarations, one main export with
  helpers below, returned errors, no enums, no barrels, `index` as the folder's real module, a file
  turning into a folder as it grows, and the layered folder rules the admin wrote by hand at work.
  These look like the strongest candidates to adopt.
- **The ones that drift by era** (component arrows vs declarations, UPPER_SNAKE, `??`, tabs, test
  location) need a decision, not a count. For tests, #124 has to state the `include` and coverage
  changes for any layout outside `src/` (conflict 2).
