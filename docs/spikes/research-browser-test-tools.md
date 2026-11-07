# Research: browser-test tools for BASE-02 and BASE-05 in CI

Issue #61. It feeds the decision in #44 (browser-test tool for the `ui` checks) and touches #43
(the `preview / axe` gate). It compares Playwright, WebdriverIO and Cypress, with the Chrome
DevTools MCP as a manual-only option. **It makes no recommendation.**

Checked: 2026-11-07 (all URLs and npm registry data below were read on this date).

Each claim carries one mark:

- **Documented**: stated by the primary source linked next to it.
- **Repo record**: stated in this repo (file named).
- **Inference**: my reasoning from documented facts; not stated by any source. Treat as unverified.

## What the repo asks for

- BASE-02: "It works in the latest two versions of Chrome, Firefox and Safari, at desktop and phone
  widths (≥ 360 px)" (Repo record, `docs/requirements/spec.md`). `CONSTRAINTS.md` makes it the
  `ci / ui` check, tool decided in #44 (Repo record).
- BASE-05 / MUST-12.1: "After a tap, the prediction shows within 100 ms, before the server
  answers" (Repo record, `spec.md`). Also `ci / ui` (Repo record, `CONSTRAINTS.md`).
- Timing checks never judge a single measurement: warm-up runs are discarded, a median or p95 is
  compared, and an over-budget result is re-measured once with a full new set. There is no BASE-05
  row in that table yet (Repo record, `CONSTRAINTS.md` "Timing checks").
- Every tool, including any browser-test tool and axe-core, needs the admin's approval and an exact
  pin; `minimumReleaseAge` covers npm packages only, binaries are checked by hand (Repo record,
  `CONSTRAINTS.md` "Tools are dependencies").
- `minimumReleaseAge: 10080` (7 days) (Repo record, `pnpm-workspace.yaml`). pnpm is pinned at
  `pnpm@12.15.0` and Node at `>=24 <25` (Repo record, `package.json`). The repo is private
  (Repo record, `gh repo view`), so Actions minutes draw on the Pro plan's included compute,
  about $18 a month (Repo record, ADR-0002).
- #43 wants axe-core with tags `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa` and 0 critical or serious
  violations against the preview (Repo record, issue #43).

## Summary table

| | Playwright | WebdriverIO | Cypress |
|---|---|---|---|
| Engines on a GitHub Linux runner | Chromium (bundled), branded Chrome/Edge via `channel`, patched Firefox, WebKit (D) | Chrome, Chromium, Firefox, Edge over WebDriver/BiDi; no Safari/WebKit on Linux (D, I) | Chrome-family, Edge, Firefox ≥ 140, Electron (deprecated); WebKit **experimental** via `playwright-webkit` (D) |
| Real Safari | No: "doesn't work with the branded version of Safari" (D) | Yes, via `safaridriver`, on macOS only (D, I) | No (D) |
| 360 px + touch | viewport, `isMobile`, `hasTouch`, device descriptors; `tap()` needs `hasTouch` (D) | `setViewport`; `emulate('device')` sets touch/viewport, needs BiDi, not Safari (D, source) | `cy.viewport(360, …)` only; "no native or mobile events support" (D) |
| Trusted input events (matters for Event Timing) | input through the browser protocol (I) | input through WebDriver actions (I) | `.trigger()` events have `isTrusted` false (D); `.click()` likely the same (I) |
| axe-core adapter | `@axe-core/playwright` 4.14.0, peer `playwright-core >= 1.0.0` (D) | `@axe-core/webdriverio` 4.14.0, peer `webdriverio ^5…^9`: **v10 not in range** (D) | `cypress-axe` 1.7.0 (third party), peer `cypress ^10…^15`: **v16 not in range** (D) |
| Hold the server answer | `page.route`: matching requests "stall unless continued, fulfilled or aborted" (D) | `browser.mock().respond()`; no documented delay or hold (D, source) | `cy.intercept`: `delay`, `res.setDelay()`, a returned Promise is awaited (D) |
| npm install scripts | none in `@playwright/test`, `playwright`, `playwright-core` (D) | none in `webdriverio`; transitive `geckodriver` and `edgedriver` have `postinstall` (D) | `cypress` has `postinstall` (downloads the binary) (D) |
| Browser download | explicit `playwright install [--with-deps]`, from Microsoft's CDN (D) | at run time, Chrome for Testing / Firefox / drivers when not found (D) | Cypress binary in `postinstall`; browsers come from the machine (D) |
| Licence | Apache-2.0 (D) | MIT (D) | MIT (npm package) (D) |
| Releases, last 12 months (npm, non-prerelease) | 15 (minor about monthly) (D) | 36 (v10.0.0 on 5 Oct 2026; v9 still patched) (D) | 29 (about every two weeks) (D) |
| Newest version ≥ 7 days old on 7 Nov 2026 | 1.64.1 (14 Oct) (D) | 10.1.0 (18 Oct); 9.33.0 was published 2 Nov (D) | 16.2.1 (28 Oct) (D) |

D = Documented (sources in the sections below), I = Inference, source = read in the project's source
code rather than its docs.

## 1. Browser and width coverage (BASE-02)

### Playwright

- Supports Chromium, Firefox and WebKit, plus branded Google Chrome and Microsoft Edge through
  `channel` (`chrome`, `msedge`, beta/dev/canary). Documented,
  <https://playwright.dev/docs/browsers>, checked 2026-11-07.
- "Since the Chromium project is ahead of the branded browsers, when the world is on Google Chrome
  N, Playwright already supports Chromium N+1." For regression testing "against the current
  publicly available browsers", the docs point to the `chrome` / `msedge` channels. Documented,
  same page.
- Firefox: "Playwright's Firefox version matches the recent Firefox Stable build" and "Playwright
  doesn't work with the branded version of Firefox since it relies on patches." Documented, same
  page.
- WebKit: "derived from the latest WebKit main branch sources" and "Playwright doesn't work with
  the branded version of Safari since it relies on patches." Documented, same page.
- "Each version of Playwright needs specific versions of browser binaries to operate." Documented,
  same page. Release 1.64 ships Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2 and was tested
  against Chrome 155 / Edge 155; 1.65 ships Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2.
  Documented, <https://playwright.dev/docs/release-notes>, checked 2026-11-07.
- System requirements: Node 22.x, 24.x or 26.x; "Debian 12 / 13, Ubuntu 22.04 / 24.04 / 26.04
  (x86-64 or arm64)". Documented, <https://playwright.dev/docs/intro>, checked 2026-11-07.
- Projects config runs one test suite per browser/device: `Desktop Chrome`, `Desktop Firefox`,
  `Desktop Safari` (WebKit), `Pixel 5`, `iPhone 12`, and branded `channel: 'chrome'` /
  `'msedge'`. Documented, <https://playwright.dev/docs/test-projects>, checked 2026-11-07.
- Widths: `viewport` in config or `test.use()`, `page.setViewportSize()`, device descriptors that set
  "user agent, screen size, viewport and if it has touch enabled". `isMobile`: "Whether the meta
  viewport tag is taken into account and touch events are enabled." `hasTouch`: "Specifies if
  viewport supports touch events." Documented, <https://playwright.dev/docs/emulation> and
  <https://playwright.dev/docs/api/class-browser#browser-new-context>, checked 2026-11-07.
- `locator.tap()`: "`element.tap()` requires that the `hasTouch` option of the browser context be
  set to true." Documented, <https://playwright.dev/docs/api/class-locator>, checked 2026-11-07.
- "Latest 2 Chrome": the bundled Chromium is one version (N+1) and the `chrome` channel uses the
  Chrome installed on the runner (Chrome 156.0.8078.79 on the Ubuntu 24.04 image 20261101.360.1,
  Documented, <https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md>,
  checked 2026-11-07). Neither gives "latest minus one" by itself. Inference.
- "Latest 2 Firefox": one patched Firefox per Playwright version. Inference from the documented
  "specific versions of browser binaries".
- "Latest 2 Safari": not reachable; WebKit is a stand-in, not Safari. Inference from the documented
  statement above.

### WebdriverIO

- "WebdriverIO manages installing and running browser driver for you." For Chrome and Firefox
  "WebdriverIO will automatically download the desired browser version and driver for you"; "If
  WebdriverIO can't find an installed Chrome or Firefox it downloads the browser too." Edge must be
  installed; its driver is fetched. Documented, <https://webdriver.io/docs/capabilities>, checked
  2026-11-07.
- `browserVersion` accepts a channel (`stable`, `beta`, …), a milestone (`140`) or a partial version
  for Chrome; Firefox takes e.g. `'119.0a1'` or `'latest'`. Documented, same page.
- Chromedriver comes from Chrome for Testing by default; Geckodriver is the latest by default
  (`geckoDriverVersion` pins it); "Automated browser setup does not support Microsoft Edge";
  "Safaridriver comes pre-installed on your MacOS". Documented,
  <https://webdriver.io/docs/driverbinaries>, checked 2026-11-07.
- So two Chrome milestones and two Firefox versions are selectable per capability. Inference from
  the `browserVersion` docs; not tried.
- Safari: real Safari through `safaridriver`, which ships with macOS (Documented, driverbinaries
  page). A GitHub Linux runner has no Safari, so this needs a macOS runner. Inference. The
  `macos-15-arm64` image has "Safari 27.2" and "SafariDriver 27.2" (one Safari version per image).
  Documented, <https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md>,
  checked 2026-11-07. Two Safari versions would mean two macOS images. Inference.
- macOS runner cost in a private repo: $0.062 per minute vs $0.006 for Linux 2-core. Documented,
  <https://docs.github.com/en/billing/reference/actions-runner-pricing>, checked 2026-11-07.
  `macos-latest` is 3 CPU (M1), 7 GB RAM. Documented,
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>, checked 2026-11-07.
- Apple's own safaridriver pages (<https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari>)
  rendered without body text, so session limits and enabling steps are **unconfirmed** here.
- Widths: `setViewport({ width, height, devicePixelRatio })` "changes the viewport size, not the
  window size". Documented, <https://webdriver.io/docs/api/browser/setViewport>, checked 2026-11-07.
- `browser.emulate('device', …)`: "This feature requires WebDriver Bidi support for the browser";
  "recent versions of Chrome, Edge and Firefox have such support", Safari "does not". Touch is set
  when the descriptor has touch; mobile text layout and viewport meta are "best effort". Documented
  in the source JSDoc (main branch),
  <https://raw.githubusercontent.com/webdriverio/webdriverio/main/packages/webdriverio/src/commands/browser/emulate.ts>,
  checked 2026-11-07. The rendered docs page (<https://webdriver.io/docs/api/browser/emulate>) did
  not show this text.

### Cypress

- Chrome-family and Edge (Chromium) are supported; Firefox too, but Cypress "cannot launch Firefox
  versions older than 140"; "Electron is deprecated as a test browser". Documented,
  <https://docs.cypress.io/app/references/launching-browsers>, checked 2026-11-07.
- "Cypress supports the latest 3 major versions" of its browsers; Linux: Ubuntu ≥ 22.04, Debian ≥
  12; Node 22.x, 24.x, ≥ 26.x. Documented, <https://docs.cypress.io/app/get-started/install-cypress>,
  checked 2026-11-07.
- WebKit: "Cypress has experimental support for WebKit"; enable `experimentalWebKitSupport: true`
  and "Install the `playwright-webkit` npm package"; on Linux run `npx playwright install-deps
  webkit`. Known issues: `cy.origin()` unsupported, `forceNetworkError` disabled, `cy.type()`
  differences, missing stack-trace names, "WebKit support is experimental, so you may encounter
  issues." Documented, launching-browsers page.
- `playwright-webkit` 1.65.0 has an `install` script (`node install.js`), Apache-2.0. Documented,
  npm registry <https://registry.npmjs.org/playwright-webkit/latest>, checked 2026-11-07.
- "Cypress does not support controlling more than 1 open browser at a time." "There is not any
  native or mobile events support." Documented, <https://docs.cypress.io/app/references/trade-offs>,
  checked 2026-11-07.
- Cypress uses browsers already on the machine; the docs don't describe Cypress downloading
  browsers. Inference from the launching-browsers page.
- Widths: `cy.viewport(width, height)` and presets such as `samsung-s10` (360 × 760). The page does
  not say it emulates touch or a mobile user agent; "devicePixelRatio is not simulated". Documented,
  <https://docs.cypress.io/api/commands/viewport>, checked 2026-11-07.

### On GitHub-hosted Linux runners (all tools)

- Ubuntu 24.04 image 20261101.360.1 has Google Chrome 156.0.8078.79, Chromium 156.0.8078.0, Edge
  156.0.4314.58, Firefox 159.0, Geckodriver 0.37.1; Playwright and WebKit are not listed.
  Documented, Ubuntu2404-Readme (above).
- Each standard runner is a new VM; private-repo Linux runners have 2 CPU, 8 GB RAM. Documented,
  github-hosted-runners page (above).

## 2. axe-core inside the tool (shared with #43)

- axe-core 4.14.0, MPL-2.0, no dependencies, no install scripts. Documented, npm registry
  <https://registry.npmjs.org/axe-core>, checked 2026-11-07. Tags `wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa` exist; impact is one of minor, moderate, serious, critical. Documented,
  <https://github.com/dequelabs/axe-core/blob/develop/doc/API.md>, checked 2026-11-07.
- axe-core "fully supports" Edge ≥ 40, Chrome ≥ 42, Firefox ≥ 38, Safari ≥ 7, but "Only Chrome and
  Firefox are currently tested on every pull request." Documented,
  <https://github.com/dequelabs/axe-core>, checked 2026-11-07.

### Playwright

- Uses `@axe-core/playwright`: `new AxeBuilder({ page }).withTags([...]).analyze()`, plus
  `include`, `exclude`, `disableRules`; "AxeBuilder.analyze() will scan the page in its current
  state". Documented, <https://playwright.dev/docs/accessibility-testing>, checked 2026-11-07.
- `@axe-core/playwright` 4.14.0 (15 Oct 2026), MPL-2.0, depends on `axe-core ~4.14.0`, peer
  `playwright-core >= 1.0.0`, no install scripts. Documented, npm registry, checked 2026-11-07.
- It "does not follow Semantic Versioning"; major.minor track axe-core. Documented,
  <https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md>, checked
  2026-11-07. The README does not state which Playwright browsers are supported (its example uses
  Chromium).

### WebdriverIO

- Uses `@axe-core/webdriverio`: `new AxeBuilder({ client }).withTags([...]).analyze()`. Documented,
  <https://github.com/dequelabs/axe-core-npm/blob/develop/packages/webdriverio/README.md>, checked
  2026-11-07.
- Caveats in that README: an open issue with WebdriverIO v9 and WebDriver BiDi (#1144); it cannot
  analyse iframes inside shadow DOM; a `setLegacyMode()` fallback. Documented, same README.
- `@axe-core/webdriverio` 4.14.0 has peer `webdriverio: ^5 || ^6 || ^7 || ^8 || ^9`. WebdriverIO's
  current major is 10 (10.0.0 on 5 Oct 2026), so v10 falls outside the declared peer range.
  Documented, npm registry, checked 2026-11-07. Whether it works with v10 anyway is **unconfirmed**.

### Cypress

- Uses `cypress-axe` (community, not Deque): `cy.injectAxe()` after `cy.visit()`, then
  `cy.checkA11y(context, { runOnly: { type: 'tag', values: [...] }, includedImpacts: [...] })`.
  Documented, <https://github.com/component-driven/cypress-axe>, checked 2026-11-07.
- `cypress-axe` 1.7.0 (29 Aug 2025, no release in the last 12 months), MIT, peer
  `cypress: ^10 || … || ^15` and `axe-core: ^3 || ^4`. Cypress's current major is 16 (16.0.0 on
  1 Sep 2026), so v16 is outside the declared peer range. Documented, npm registry, checked
  2026-11-07. Whether it works with v16 anyway is **unconfirmed**.

### Shared with #43 or not

- #43's `preview / axe` runs against the Vercel preview, not inside `ci / ui` (Repo record, #43).
  Any of the three can point at a preview URL, so axe could run inside the chosen browser tool or in
  a separate runner. Inference.

## 3. Timing tap → painted prediction (BASE-05)

### Browser APIs

- `performance.mark()` / `measure()` exist in Chrome ≥ 28, Firefox ≥ 38, Safari ≥ 11. Documented,
  MDN browser-compat-data `api/Performance.json`
  (<https://github.com/mdn/browser-compat-data>), checked 2026-11-07.
- `performance.now()` "is coarsened": 5 µs in cross-origin isolated contexts, 100 µs otherwise.
  Documented, <https://developer.mozilla.org/en-US/docs/Web/API/Performance/now>, checked
  2026-11-07. Either is far below a 100 ms budget. Inference.
- `requestAnimationFrame` runs its callback "before the next repaint"; its timestamp is "the end
  time of the previous frame's rendering"; rAF is "paused in most browsers when running in
  background tabs or hidden `<iframe>`s". Documented,
  <https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame>, checked
  2026-11-07.
  - So a rAF callback marks "the frame that will paint the prediction is being produced", not
    "pixels are on screen". A common approximation is a mark inside rAF plus a follow-up task
    (e.g. `setTimeout(0)` or a `MessageChannel` message posted from the rAF callback) to land after
    that frame's paint. Inference; I found no primary source that defines this pattern.
- **Event Timing API** (`PerformanceEventTiming`): `startTime` is the event's timestamp, "a proxy
  for the time the user interaction occurred"; `duration` is "the time from `startTime` to the next
  rendering paint (rounded to the nearest 8ms)". Entries are buffered at ≥ 104 ms; a
  `PerformanceObserver` can lower `durationThreshold` to a minimum of 16 ms. Exposed events include
  `pointerdown`, `pointerup`, `click`, `touchstart`, `touchend`. Documented,
  <https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming>, checked 2026-11-07.
  - Spec status: editor's draft dated 13 Oct 2026; duration "is provided with 8 millisecond
    granularity"; "If event's isTrusted attribute value is set to false, return false" (untrusted
    events are not measured). Documented, <https://w3c.github.io/event-timing/>, checked 2026-11-07.
  - Browser support: Chrome 76, Firefox 89, Safari 26.2 ("Baseline 2025"). Documented, MDN
    browser-compat-data `api/PerformanceEventTiming.json`, checked 2026-11-07. Whether
    Playwright's WebKit build on Linux exposes it is **unconfirmed** (Inference: it derives from
    WebKit main, which is newer than Safari 26.2).
  - Consequences: a tap under 16 ms produces no entry; the 8 ms rounding is about 8% of the
    100 ms budget; and only trusted input produces entries. Inference from the documented facts.
  - Event Timing ends at the *next* paint after the handlers, which may not be the paint that shows
    the prediction if the UI updates a frame later (e.g. after a React commit scheduled later).
    Inference.
- Tool-side timing (a timestamp in the test runner before the tap and after an assertion sees the
  prediction) adds protocol round trips and polling intervals to the measurement. Inference. Example:
  Playwright's auto-retrying assertions have a 5 s default timeout; the page does not state the
  polling interval. Documented, <https://playwright.dev/docs/test-timeouts>, checked 2026-11-07.

### Which tool events are trusted

- Cypress: "events from `.trigger()` have `isTrusted` set to false, so a handler that checks
  `isTrusted` ignores them." Documented, <https://docs.cypress.io/api/commands/trigger>, checked
  2026-11-07. The `.click()` page lists the pointer/mouse events it sends but does not state
  `isTrusted` (Documented, <https://docs.cypress.io/api/commands/click>). A Cypress issue reports
  `isTrusted` false for `.click()` (<https://github.com/cypress-io/cypress/issues/8376>, a bug
  report, not docs). So Event Timing likely records nothing for a Cypress tap. Inference.
- Playwright: `locator.click()` / `tap()` act on the page "under the real conditions", unlike
  `dispatchEvent` (Documented, <https://playwright.dev/docs/input>), but the docs don't say
  `isTrusted`. That they produce trusted events (and so Event Timing entries) is Inference.
- WebdriverIO: input goes through WebDriver actions in the browser driver. Trusted events are
  Inference, not documented in the pages read.

### Holding the server answer back

- Playwright: "Once routing is enabled, every request matching the url pattern will stall unless
  it's continued, fulfilled or aborted." "Enabling routing disables http cache." "page.route() will
  not intercept requests intercepted by Service Worker" (set `serviceWorkers: 'block'`).
  Documented, <https://playwright.dev/docs/api/class-page> (route section), checked 2026-11-07.
  `route.fetch()` performs the real request so the response can be changed before `route.fulfill()`.
  Documented, <https://playwright.dev/docs/network>, checked 2026-11-07. Holding a request until the
  test has checked the prediction is therefore "don't call continue/fulfill yet". Inference from
  the stall sentence.
- WebdriverIO: `browser.mock(pattern).respond(...)` / `abort()`; "using the `mock` command requires
  support for WebDriver Bidi" (local Chromium or Firefox, Selenium Grid ≥ 4). The page documents no
  delay option. Documented, <https://webdriver.io/docs/mocksandspies>, checked 2026-11-07. In the
  source on `main`, a function passed to `respond()` is called synchronously and its result used as
  the body, so it cannot await (Inference from
  `packages/webdriverio/src/utils/interception/index.ts`, read 2026-11-07). WebDriver BiDi itself
  keeps a "blocked request map" that `session.end` continues (Documented,
  <https://w3c.github.io/webdriver-bidi/>, editor's draft 6 Nov 2026); driving that directly from
  WebdriverIO to hold a request is Inference, not tried.
- Cypress: `cy.intercept` `StaticResponse.delay` ("Minimum network latency or delay to add to the
  response time"), `res.setDelay()`, `throttleKbps`; "If a Promise is returned from the route
  callback, it will be awaited before sending the response to the browser", and it "must resolve
  within the defaultCommandTimeout". Documented, <https://docs.cypress.io/api/commands/intercept>,
  checked 2026-11-07. On WebKit, `forceNetworkError` is disabled (Documented, launching-browsers).
- Any tool: the hold could instead live in the app or a test server. Inference.
- Fake clocks: Playwright's `page.clock` overrides `performance`, `requestAnimationFrame`,
  `Event.timeStamp` and timers. Documented, <https://playwright.dev/docs/clock>, checked 2026-11-07.
  Installing it in a timing test would replace the very clock being measured. Inference.

### Run-to-run noise on CI runners

- GitHub's runner docs give specs (each standard runner is a new VM; private Linux: 2 CPU, 8 GB)
  but say nothing about performance variance between runs. Documented (by absence),
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>, checked 2026-11-07.
- Playwright: "We recommend setting workers to "1" in CI environments to prioritize stability and
  reproducibility"; sequential runs give each test the full system resources. Documented,
  <https://playwright.dev/docs/ci>, checked 2026-11-07.
- Lighthouse's variability doc (closest primary source on browser timing noise in CI): host
  resource contention is "high impact"; "Multi-tenant server environments … can also suffer from
  these issues"; "Free CI environments and 'burstable' instances are typically quite volatile";
  "The median Lighthouse score of 5 runs is twice as stable as 1 run"; it recommends aggregates
  ("the median, 90th percentile, or even min/max"), no concurrent runs, and at least 2 dedicated
  cores (4 recommended). Documented,
  <https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md>, checked 2026-11-07.
  No numeric run-to-run variance is given.
- I found **no primary source with a measured variance figure** for input-to-paint timing on
  GitHub-hosted runners. `CONSTRAINTS.md`'s "tens of percent" is a Repo record, not a cited
  measurement.
- Headless browsers may not paint on a display-driven vsync, so frame timing in CI may differ from a
  phone. Inference; not checked in any source.

## 4. Install footprint, licence, cadence, `minimumReleaseAge`

npm registry data, read 2026-11-07 from `https://registry.npmjs.org/<name>` (Documented).

| Package | Latest (published) | Newest ≥ 7 days old | Install scripts | Licence | Releases in 12 months |
|---|---|---|---|---|---|
| `@playwright/test` / `playwright` / `playwright-core` | 1.65.0 (5 Nov 2026) | 1.64.1 (14 Oct) | none | Apache-2.0 | 15 |
| `webdriverio` / `@wdio/cli` | 10.2.0 (6 Nov 2026) | 10.1.0 (18 Oct) | none in these | MIT | 36 |
| ↳ `geckodriver`, `edgedriver` (via `@wdio/utils`) | 8.0.0 (9 Oct) | 8.0.0 | `postinstall` downloads the driver, `|| echo` on failure | MIT | n/a |
| `cypress` | 16.2.1 (28 Oct 2026) | 16.2.1 | `postinstall`: `node dist/index.js --exec install` | MIT | 29 |
| `axe-core` | 4.14.0 (5 Oct) | 4.14.0 | none | MPL-2.0 | 8 |
| `@axe-core/playwright` / `@axe-core/webdriverio` | 4.14.0 (15 Oct) | 4.14.0 | none | MPL-2.0 | 6 |
| `cypress-axe` | 1.7.0 (29 Aug 2025) | 1.7.0 | none | MIT | 0 |
| `playwright-webkit` (Cypress WebKit) | 1.65.0 | (not checked) | `install`: `node install.js` | Apache-2.0 | n/a |
| `chrome-devtools-mcp` | 1.12.0 (22 Oct) | 1.12.0 | none | Apache-2.0 | 42 |

- pnpm: "Packages not listed in `allowBuilds` are disallowed by default"; `strictDepBuilds` defaults
  to `true`, so install "will exit with a non-zero exit code if any dependencies have unreviewed
  build scripts". Documented, <https://pnpm.io/settings/build>, checked 2026-11-07. So Cypress and
  WebdriverIO (through `geckodriver`/`edgedriver`) each need an `allowBuilds` entry (true or false)
  before `pnpm install` passes; Playwright's npm packages need none. Inference from these docs plus
  the registry data; AGENTS.md says to ask before allowing install scripts (Repo record).
- `minimumReleaseAge` "applies to all dependencies, including transitive ones". Documented,
  <https://pnpm.io/settings/dependency-resolution>, checked 2026-11-07.
- Engines: `@playwright/test` `node >=20` (docs: 22/24/26; 1.65 "no longer tests on Node.js 20");
  `webdriverio` `>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1`; `cypress` `^22 || ^24 || >=26`.
  Documented, npm registry and release notes. The repo pins Node `>=24 <25` (Repo record); the
  Ubuntu image caches Node 24.22.2 (Documented, runner README). WebdriverIO 10 needs ≥ 24.22.1 on
  the 24 line. Documented.

### Browser downloads

- Playwright: browsers come from an explicit `npx playwright install` (`--with-deps` also installs
  OS packages), from "Microsoft's CDN", into `~/.cache/ms-playwright`; sample sizes Chromium 281M,
  Firefox 187M, WebKit 180M, "a few hundred megabytes". "Caching browser binaries is not
  recommended" in CI (restore takes about as long as downloading; OS deps can't be cached).
  Documented, <https://playwright.dev/docs/browsers> and <https://playwright.dev/docs/ci>, checked
  2026-11-07. The browsers are binaries outside npm, so `minimumReleaseAge` doesn't cover them and
  `CONSTRAINTS.md` says binaries are checked by hand (Repo record); they are fixed per Playwright
  version (Documented, above).
- WebdriverIO: downloads Chrome/Chromium/Firefox and drivers at run time when needed (Chrome for
  Testing; latest Geckodriver by default), or uses the runner's installed browsers. Documented,
  driverbinaries/capabilities pages. Cache location is not stated on those pages. Driver versions
  float unless pinned (`geckoDriverVersion`, `browserVersion`). Documented; the consequence for
  reproducibility is Inference.
- Cypress: the binary downloads in `postinstall` from `https://download.cypress.io` into
  `~/.cache/Cypress`, one per version; `CYPRESS_INSTALL_BINARY=0` skips it; `npx cypress install`
  installs it later. pnpm ≥ 10 requires allowlisting `cypress`, and pnpm's side-effects cache "is
  not compatible with Cypress' own caching". Binary size not stated. Documented,
  <https://docs.cypress.io/app/get-started/install-cypress> and
  <https://docs.cypress.io/app/references/advanced-installation>, checked 2026-11-07.

## 5. Chrome DevTools MCP (manual only)

- "officially supports Google Chrome and Chrome for Testing only"; built for coding agents over MCP
  or a CLI; offers performance traces with insights, network analysis, screenshots, console
  messages, Puppeteer-based automation; Apache-2.0. Performance tools may send trace URLs to the
  CrUX API (`--no-performance-crux`), and usage statistics are on by default
  (`--no-usage-statistics`). Documented, <https://github.com/ChromeDevTools/chrome-devtools-mcp>,
  checked 2026-11-07.
- It covers Chrome only, so it cannot meet BASE-02's Firefox/Safari rows on its own. Inference.

## Open / unconfirmed

1. Whether `@axe-core/webdriverio` 4.14.0 works with WebdriverIO 10 (peer range stops at ^9).
2. Whether `cypress-axe` 1.7.0 works with Cypress 16 (peer range stops at ^15), and whether it is
   still maintained.
3. Whether Playwright's WebKit on Linux exposes the Event Timing API.
4. Whether Cypress `.click()` events are untrusted (only `.trigger()` is documented).
5. Apple's safaridriver limits (session count, enabling on CI) — the Apple pages did not render.
6. No primary source gives a measured run-to-run variance for input-to-paint timing on GitHub
   runners; a spike measuring it (warm-up + N runs, as `CONSTRAINTS.md` does for other timings)
   would be the only source.
7. How "latest 2 versions" maps onto each tool's browser builds (one bundled build per Playwright
   version; one Safari per macOS image) is Inference, not documented by the tools.
