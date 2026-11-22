# Code style

The conventions for TypeScript in `packages/*` and `apps/web/src/` that no config checks. ESLint,
Prettier, tsc and Fallow check the rest, so `pnpm check:fast` passing covers it. The decisions and
the reasons behind them are in ADR-0005; "module" and "interface" are used as `GLOSSARY.md` defines
them.

## Modules

- A **module** is a folder whose entry is `index.ts`, from its first line, even when `index.ts` is
  its only file. Its only other folder is `tests/`; a group of files that needs a folder of its own
  becomes a child module, with its own `index.ts`.
- `index.ts` holds the module's main code, not re-exports: its interface first, with as few names as
  it can, then its private helpers below as `function` declarations.
- A module deepens inside its folder: helpers grow below the main export, then move into private
  siblings (`hash/sha256.ts`), then a group of siblings becomes a child module. The interface stays
  the same size.
- `packages/*/src/index.ts` holds only `export { … } from` and `export type { … } from` lines: it is
  the package's one export list.
- `packages/sim/src/` splits by feature, one module per glossary concept; the expected map is in
  ADR-0005, section 3. Create a module's folder in the ticket that needs it.

## Shared logic

- Logic moves into a shared module at its **second occurrence**. Name the module for its concept
  (`storage/`, for fits, put and take), or, if a module already owns the concept, add the helper to
  that module's `index.ts` interface.
- "The same logic" means the same rule, not the same shape: two loops over different data stay two
  loops. `fallow dupes` catches exact copies; the same rule written two ways is yours to spot.

## Tests

- A module's tests live in its `tests/` folder and may test its private siblings directly
  (`hash/tests/sha256.test.ts`). They reach any other module through its `index.ts`.
- A test helper used by several modules lives in the `tests/` folder of the module that owns its
  concept (farm generators in `state/tests/farms.ts`); other modules' tests import it by path.
- The property harness lives in `sim/tests/` and imports through the package entry
  (`../../index.js`), so it tests what `apps/web` calls.
- A `describe` names the unit; each `it` reads as a sentence about it.

## Names

- Functions start with a verb.
- Domain words come from `GLOSSARY.md`, never its _Avoid_ words.
- snake_case properties only where the data mirrors an outside shape (a DB column, an API field).
- In `apps/web`: `handleX` for handlers inside a component, `onX` for the props that receive them,
  and a component's props type is `<Component>Props`.
- A file or folder changes name by more than case: macOS and Windows filesystems ignore case, and
  git gets confused.

## Imports

- In `packages/*`, imports are relative and name the file with `.js`, as NodeNext requires
  (`'../hash/index.js'`). The `@/` alias belongs to `apps/web`, where Next resolves it.

## Values, errors, async

- `null` is the absent value wherever we choose: it survives JSON. `undefined` appears only where
  the language gives it (an optional property, a missing map entry). A type is never
  `T | null | undefined`.
- Return an expected failure (ADR-0003, section 4); `throw` only for a programmer error. A message a
  player reads is a full sentence ending in a full stop.
- Independent awaits run together with `Promise.all`. Code that uses `await` uses it throughout,
  with no `.then` chains.
- A fixed table is an object `as const satisfies` its type.
- Classes stay out of `apps/web` too, as lint keeps them out of the sim: functions and plain data.

## Comments

- A comment says why, and cites the decision: an ADR section, a MUST id or an issue (`#82`).
- A doc comment on an export states what its type can't: an invariant, an error mode, a unit.
- English, always. Old code lives in git history, so delete it rather than comment it out.
- UPPERCASE banners are fine; a third banner in a file is the cue to split it into a sibling.
- A guard clause is followed by a blank line.

## Checks to know about

- Formatting and import order are Prettier's: run `pnpm exec prettier --write <files>`, then
  `pnpm check:fast`.
- `check:fast` lints only files whose own content changed. The typed rules read types from other
  files (the exhaustive `switch` over `Action`), so after changing a shared type, run `pnpm lint`
  before you trust a green `check:fast`; `check:task` does.
- Fallow (#504): run it with `--format json --quiet` and read `verdict` first; run
  `fallow fix --dry-run` before `fallow fix --yes`; never run `fallow watch`, which doesn't exit.
  The `fallow` skill points to the pinned package's own copy; after a Fallow bump, rerun
  `fallow agent install --harness claude --without guide --without mcp --without hooks`.
- Every `git commit` and `git push` an agent runs goes through `.claude/hooks/fallow-gate.sh`
  (`fallow audit` on the changes since the merge base with `origin/main`): a new clone, unused
  export or function over the complexity limits blocks it, with the findings listed and the full
  report in `.fallow/gate-report.json`. Fix the code; inherited findings don't block. When the audit
  can't run, the gate lets the command through with a `fallow-gate: ... skipping` notice, so CI
  stays the real gate. With the admin's user-scope Fallow plugin on, set `FALLOW_PLUGIN_GATE=off` so
  the audit doesn't run twice.
