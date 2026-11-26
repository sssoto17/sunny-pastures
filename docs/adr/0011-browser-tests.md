---
status: proposed
---

# Browser tests for the `ui` checks

The spec's `ui` checks need a real browser, and `CONSTRAINTS.md` hangs two blocking rows on them:
BASE-02 (browsers and widths) and BASE-05 (a prediction shows within 100 ms of a tap, MUST-12.1).
Both run as the required check `ci / ui` (ADR-0002). This ADR records which tool runs them, what CI
covers and what a person checks, how BASE-05 is timed without flaking, where axe runs, and how the
tool is pinned. It closes `spec.md` Open question 1.

## How this was decided

Grilled with the admin on 26 Nov 2026 in
[Design: browser-test tool for the ui checks (BASE-02, BASE-05)](https://github.com/sssoto17/sunny-pastures/issues/44);
its
[resolution comment](https://github.com/sssoto17/sunny-pastures/issues/44#issuecomment-7204127741)
is the source for every decision below, and sections 1–7 follow its decisions 1–7. The research
behind it is
[Research: browser-test tools for BASE-02 and BASE-05 in CI](https://github.com/sssoto17/sunny-pastures/issues/61)
(findings in its comments, and `docs/spikes/research-browser-test-tools.md` on the unmerged branch
`research/browser-test-tools`). Facts cited from it keep its marks: Documented or Inference. Where
the resolution comment is silent, this ADR says so rather than filling the gap.

**Pattern:** **black-box browser tests against the built app**, with a **probe injected by the
test** for timing. The tests drive the page a player loads, through the browser only; the app
carries no test code.

## 1. Safari (BASE-02): WebKit in CI, real Safari by hand

**Decision.** WebKit, Playwright's build, stands in for Safari in CI. Real Safari is checked by
hand, in `review` or `playtest`.

- **Why:** no CI setup can test "latest 2 Safari". `safaridriver` on a macOS runner tests only the
  runner image's one Safari version, and it brings WebdriverIO's `postinstall` scripts and an axe
  peer-range gap (decision 1). Playwright "doesn't work with the branded version of Safari"
  (Documented, #61).
- **Rejected:** real Safari in CI through WebdriverIO on a macOS runner, for the reasons above.

## 2. Tool: Playwright's own runner, against the built app

**Decision.** `@playwright/test` as its own runner, against the built app: `next build`, then
`next start` on the local Supabase stack. Specs go in `apps/web/e2e/`. The jsdom Vitest `ui` project
from ADR-0010 stays, for component tests.

**Rejected** (decision 2):

- **Vitest Browser Mode:** it renders components rather than the page a player loads, and holding
  server answers would need MSW.
- **WebdriverIO:** see section 1.
- **Cypress:** its WebKit support is experimental, it has no touch events, and it has a
  `postinstall` script.
- **The Chrome DevTools MCP:** for manual checks only. The resolution says no more about it.

## 3. BASE-05: a probe injected by the test

**Decision.** The test injects a probe with `page.addInitScript`; the app has no instrumentation.

1. The probe reads the trusted tap's `event.timeStamp` as the start.
2. A `MutationObserver` sees the prediction appear.
3. The probe then waits for the next `requestAnimationFrame` + `setTimeout(0)` and records the time
   elapsed since the tap.
4. `page.route` holds the game API's answer until the time is read, so the time measured is the
   prediction's, never the server's.

**Inference: the after-paint step.** A `requestAnimationFrame` callback runs before the frame that
paints the prediction is produced, not after its pixels are on screen (Documented, MDN, #61). A task
queued from it, here `setTimeout(0)`, is a common approximation of "after that frame's paint", but
#61 found **no primary source** that defines the pattern. The step may land before the pixels are on
screen, or a frame late; and headless browsers may not paint on a display's vsync (Inference, #61).
The number is a close bound, not a measured paint.

**Sampling** is a new `CONSTRAINTS.md` "Timing checks" row, **Prediction (BASE-05)**: 3 taps
discarded, then 10 measured taps per 360 px project, with the **median** compared with 100 ms. The
existing one-automatic-retry rule applies: an over-budget median is re-measured once with 10 new
taps, and the check fails only if both are over.

**Rejected** (decision 3):

- **An app-side `performance.mark`:** test code in the app.
- **A clock read on the test side:** protocol overhead between the runner and the browser.

The resolution doesn't mention the Event Timing API. #61 found that its duration is rounded to 8 ms
and that untrusted events produce no entry (Documented); it isn't used here.

## 4. Versions: BASE-02's wording

**Decision.** "Latest 2 Chrome, Firefox and Safari" becomes: Chromium, Firefox and WebKit as shipped
by the pinned `@playwright/test`, at desktop width and 360 px with touch, with Playwright bumped at
least monthly. Each bump still waits for `minimumReleaseAge` and the admin's approval. Branded
Chrome, older versions and real Safari get the manual check (section 1).

- **Why:** each Playwright version ships one Chromium (one ahead of Chrome stable), one patched
  Firefox and one WebKit (Documented, #61), so no CI run of a single pin reaches "latest minus one".
- **Not said in the resolution:** who or what proposes the monthly bump (Dependabot already raises
  weekly development-dependency updates, `.github/dependabot.yml`). `CONSTRAINTS.md` records the
  rule.

## 5. CI: one `ci / ui` job, six projects

**Decision.** A single `ci / ui` job in the CI workflow, with the app tests' path filters, the
`supabase-stack` action, and `next build` + `next start`.

- **Six projects:** {chromium, firefox, webkit} × {desktop, 360 px + touch}.
- **The timing spec** runs only in the 360 px projects, serially (`workers: 1`).
- **Browsers:** `playwright install --with-deps`, with `~/.cache/ms-playwright` cached by the
  Playwright version.
- **On failure:** traces and screenshots are uploaded and kept 7 days.
- **Required:** `ci / ui` is a required check on `main` from the PR that adds it.
- **Rejected:** a matrix job per browser (3× the Supabase setup minutes).

**The browser downloads sit outside `minimumReleaseAge`.** `minimumReleaseAge` in
`pnpm-workspace.yaml` covers npm packages only. Playwright's browsers (about 180–280 MB each,
Documented, #61) come from `playwright install`, not from the npm registry, so the 7-day rule never
sees them. The gap is covered by the **exact `@playwright/test` pin** (section 7): each Playwright
version downloads the browser builds it was released with ("Each version of Playwright needs
specific versions of browser binaries to operate", Documented, #61), so the browsers change only
when a reviewed PR moves the pin, and the pin itself passes `minimumReleaseAge`.

## 6. axe: one home, in `preview / axe`

**Decision.** `preview / axe`
([Preview gates](https://github.com/sssoto17/sunny-pastures/issues/43)) uses `@axe-core/playwright`
on the same Playwright pin, and `ci / ui` runs no axe, so BASE-03 has one home.

## 7. Pins

**Decision.** `@playwright/test` **1.65.1** and `@axe-core/playwright` **4.14.0** (peer
`playwright-core >= 1.0.0`), the newest releases at least 7 days old on 26 Nov, with no install
scripts. Approved by the admin in the grill. The resolution doesn't name the package they go in; the
build ticket #673 puts both in `apps/web` as dev dependencies.

## Consequences

- `CONSTRAINTS.md`: the BASE-02 row takes section 4's wording, and the BASE-02 and BASE-05 rows name
  this ADR and their build tickets instead of #44. "Timing checks" gains Prediction (BASE-05), and
  its over-budget bullet names "10 new taps".
- `spec.md`: Open question 1 is closed with a link here, and the `ui` row names Playwright.
- ADR-0002's `ci / ui` row and ADR-0010's `jsdom` row point here instead of #44.
- The builds are
  [CI: ci / ui with Playwright in Chromium, Firefox and WebKit (BASE-02)](https://github.com/sssoto17/sunny-pastures/issues/673)
  and
  [Test: BASE-05 prediction shows within 100 ms of a tap](https://github.com/sssoto17/sunny-pastures/issues/674).
