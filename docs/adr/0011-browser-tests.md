---
status: proposed
---

# Browser tests for the `ui` checks

The spec's `ui` checks need a real browser, and `CONSTRAINTS.md` hangs two blocking rows on them:
BASE-02 (browsers and widths) and BASE-05 (a prediction shows within 100 ms of a tap, MUST-12.1).
Both run as the required check `ci / ui` (ADR-0002). This ADR records which tool runs them, what it
covers in CI and what is left to a person, how BASE-05 is timed without flaking, and how the tool is
pinned. It closes `spec.md` Open question 1.

## How this was decided

The question was
[Design: browser-test tool for the ui checks (BASE-02, BASE-05)](https://github.com/sssoto17/sunny-pastures/issues/44),
decided by the admin there. The research behind it is
[Research: browser-test tools for BASE-02 and BASE-05 in CI](https://github.com/sssoto17/sunny-pastures/issues/61)
(findings in its comments and in `docs/spikes/research-browser-test-tools.md` on the unmerged branch
`research/browser-test-tools`); facts cited from it below keep its marks (Documented, Inference).

**Source caveat (26 Nov 2026).** When this ADR was written, #44's resolution comment with decisions
1–7 could not be found: #44 held one comment (its proposed fields). Every decision below is taken
from what the admin wrote in the tickets filed from that resolution:
[Record the browser-test decision in ADR-0011](https://github.com/sssoto17/sunny-pastures/issues/672),
[CI: ci / ui with Playwright in Chromium, Firefox and WebKit (BASE-02)](https://github.com/sssoto17/sunny-pastures/issues/673)
and
[Test: BASE-05 prediction shows within 100 ms of a tap](https://github.com/sssoto17/sunny-pastures/issues/674).
The sections are grouped by topic and are not numbered to match decisions 1–7. Where those tickets
don't say something, this ADR says so instead of filling the gap; the admin's review checks it
against the resolution comment.

## 1. Pattern: black-box tests against the built app, with a probe for timing

**Pattern:** **black-box browser tests against the built app**, with a **probe injected by the
test** for timing (#672).

- The tests drive the production build (`next build`, then `next start` as Playwright's `webServer`)
  in a real browser, through the page only. Specs find elements by role and name (#673), as the
  component tests already do (ADR-0010, section 3).
- Timing needs a clock inside the page, so the test injects one (section 4). The app carries **no
  instrumentation** for it (#674).
- The specs live in `apps/web/e2e/`, next to `apps/web/playwright.config.ts` (#673).

## 2. Tool: Playwright, with its axe adapter

**Decision.** `@playwright/test` **1.65.1** and `@axe-core/playwright` **4.14.0**, dev dependencies
of `apps/web`, each pinned exactly (approved in #44, as #673 records). `pnpm install` needs no
`allowBuilds` entry: none of Playwright's npm packages has an install script (Documented, #61).

- **Why:** of the tools #61 compared, only Playwright covers Chromium, Firefox and WebKit on a Linux
  runner with real touch at 360 px (`hasTouch`, `isMobile`), holds a server answer until the test
  lets it go (`page.route`: matching requests "stall unless continued, fulfilled or aborted"), has
  an axe adapter whose peer range takes any Playwright version, and has no npm install scripts
  (Documented, #61's summary and resolution).
- **axe:** `@axe-core/playwright` runs axe inside the same tool. The axe gate itself is
  `preview / axe` ([Preview gates](https://github.com/sssoto17/sunny-pastures/issues/43)), not this
  ADR; #673 leaves axe to it. The tickets don't say whether `preview / axe` runs through this
  adapter or another runner.

**Rejected** (the facts are #61's; where the tickets record no reason of the admin's, that is said):

- **WebdriverIO:** the only tool that drives real Safari, but only on a macOS runner, at $0.062 a
  minute against $0.006 for Linux in a private repo, about 10 times the cost (Documented, #61). Its
  axe adapter's peer range stops at v9, while v10 is current; its transitive `geckodriver` and
  `edgedriver` have `postinstall` scripts, which need an `allowBuilds` decision; and its `mock()`
  documents no way to hold an answer (Documented, #61).
- **Cypress:** WebKit is experimental (it needs `playwright-webkit`, which has an install script);
  there is "no native or mobile events support", so no real touch at 360 px; `.trigger()` events are
  untrusted; `cypress` itself has a `postinstall` script; and `cypress-axe` is a community adapter
  whose peer range stops at v15, while v16 is current (Documented, #61).
- **The Chrome DevTools MCP:** #44 listed it for manual checks only. It isn't a CI test runner, so
  it can't be the required check `ci / ui`. The tickets record no further decision on it.
- **Vitest Browser Mode** (components in a browser inside `ci / test`, the alternative ADR-0010 left
  to #44 when it chose `jsdom` for the `ui` Vitest project): the tickets choose tests against the
  built app instead (section 1) and record no reason for rejecting it. #61 didn't research it.

## 3. BASE-02: the engines Playwright ships, plus checks by hand

**Decision.** `ci / ui` runs every spec in six Playwright projects: Chromium, Firefox and WebKit
**as shipped by the pinned `@playwright/test`**, each at desktop width and at 360 px with touch
(`hasTouch` and `isMobile`) (#672, #673). Playwright is bumped **at least monthly**, so the engines
stay current. **Real Safari, branded Chrome and older versions are checked by hand** (#672).

- **Why not "latest 2" in CI:** each Playwright version ships one Chromium (one ahead of Chrome
  stable), one patched Firefox and one WebKit built from WebKit's main branch, and it "doesn't work
  with the branded version of Safari" (Documented, #61). Neither "latest minus one" nor real Safari
  is reachable on a Linux runner (Inference, #61).
- **The CI job** (#673): on CI `forbidOnly`, no retries, trace `retain-on-failure` and 2 workers;
  the app's path filters plus the Playwright config; the local stack through the `supabase-stack`
  action; `playwright install --with-deps chromium firefox webkit` with `~/.cache/ms-playwright`
  cached by the Playwright version; traces and screenshots kept 7 days on failure.
- **Not said in the tickets:** what does the monthly bump (Dependabot, which already groups dev
  dependencies, or a person), and when the checks by hand run (each milestone gate, a release, or
  another stage). `CONSTRAINTS.md` records the rule; the trigger is left to the admin.

## 4. BASE-05: timing a tap to the painted prediction

**Decision** (#674). A timing spec runs only in the three 360 px projects, serially (`workers: 1` or
a serial `describe` in a dedicated project):

1. The test injects the probe with `page.addInitScript`; the app's code is unchanged.
2. The probe reads the trusted tap's `event.timeStamp` as the start.
3. A `MutationObserver` sees the prediction appear in the DOM.
4. The probe then waits for the next `requestAnimationFrame`, then a `setTimeout(0)`, and records
   the time elapsed since the tap.
5. `page.route` holds the game API's action answer until the time is read, and the spec asserts that
   the prediction showed while the answer was still held, so the time measured is the prediction's
   and never the server's.

**Inference: the after-paint step.** A `requestAnimationFrame` callback runs before the frame that
paints the prediction is produced, not after its pixels are on screen (Documented, MDN, #61). A
follow-up task queued from that callback, here `setTimeout(0)`, is a common approximation of "after
that frame's paint", but #61 found **no primary source** that defines it. The step can still land
before the pixels are on screen, or a frame later; headless browsers may not paint on a display's
vsync either (Inference, #61). The number it gives is a close bound, not a measured paint.

**Sampling** follows `CONSTRAINTS.md`, "Timing checks", Prediction (BASE-05): 3 taps discarded, then
10 measured taps per 360 px project, and their median is compared with 100 ms. If the median is
over, the spec re-measures once with 10 new taps and fails only if both medians are over. Each run's
samples and median go in the test output. The spec counts as part of `ci / ui` only after it runs
green on `main` three times in a row (#674).

**Rejected** (facts from #61):

- **The Event Timing API:** its `duration` is rounded to 8 ms (8% of the budget), entries start at
  16 ms at the lowest threshold, untrusted events produce none, and it ends at the next paint after
  the handlers, which may not be the one that shows the prediction (Documented and Inference, #61).
- **Timing from the test runner** (a timestamp before the tap and after an assertion sees the
  prediction): it adds protocol round trips and the assertion's polling interval to the number
  (Inference, #61).
- **Marks in the app's code** (`performance.mark` in the tap handler): #674 rules out
  instrumentation in the app; the tickets give no reason beyond that.
- **Playwright's fake clock (`page.clock`):** it replaces `performance`, `requestAnimationFrame`,
  `Event.timeStamp` and the timers, the very clock being measured (Documented and Inference, #61).
- **Real-Safari timing in CI:** checked by hand (#674, "Out of scope"), as BASE-02's real Safari is.

## 5. The pin, and the gap it covers

`minimumReleaseAge` in `pnpm-workspace.yaml` (7 days) covers npm packages only. Playwright's
browsers (about 180–280 MB each, Documented, #61) are downloaded by `playwright install` from
Microsoft's CDN, **outside `minimumReleaseAge`**. That gap is covered by the **exact
`@playwright/test` pin**: each Playwright version downloads the specific browser builds it was
released with ("Each version of Playwright needs specific versions of browser binaries to operate",
Documented, #61), so the browsers change only when a reviewed PR moves the pin, and that pin passes
the 7-day rule like any npm package. `CONSTRAINTS.md`, "Tools are dependencies", already names any
browser-test tool as a dependency that needs the admin's approval and an exact pin.

## Consequences

- `CONSTRAINTS.md`: the BASE-02 row reads as section 3, and the BASE-02 and BASE-05 rows name this
  ADR and their build tickets (#673, #674) instead of #44. "Timing checks" gains the row Prediction
  (BASE-05), and its over-budget bullet names "10 new taps".
- `spec.md`: Open question 1 is closed with a link here, and the `ui` row names Playwright.
- ADR-0002's `ci / ui` row and ADR-0010's `jsdom` row point here instead of #44.
- The builds are #673 (`ci / ui`, the six projects and the smoke spec) and #674 (the BASE-05 timing
  spec). The admin adds `ci / ui` to the `main` ruleset when #673 lands.
