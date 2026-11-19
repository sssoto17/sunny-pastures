# Frontend options

The meeting was held on 19 Nov 2026, and its outcomes are on #127.

Research for #128: the resource shortlist for the frontend meeting on Thu 19 Nov 2026. It covers the
rendering approach, UI libraries, styling, animation, icons, fonts and art assets for `apps/web`
(Next.js 16.4.6, React 19.3.1, App Router, TypeScript). Every package named here is a candidate
only. Nothing is installed, and adding one later needs the admin's approval and an exact pin
(`CONSTRAINTS.md`, "Tools are dependencies").

Researched on 18 Nov 2026.

## How the numbers were taken

- **Versions, release dates, licences and peer dependencies** come from the npm registry
  (`registry.npmjs.org/<package>`), read on 18 Nov 2026. "Releases in 12 months" counts stable
  versions published since 18 Nov 2025.
- **Open issues and PRs** come from the GitHub search API for each repo on the same day.
- **Bundle cost** is min / min+gzip from bundlephobia's API (`/api/size` for the whole package,
  `/api/exports-sizes` for one export) at the version given. A whole-package number is the cost of
  importing everything. A tree-shaken app pays less, so for tree-shakable libraries the table also
  gives the cost of single exports. Exports share code, so their sizes don't add up. Bundlephobia
  returned 0 for single icons, so icon costs were measured from the published ESM files on jsDelivr
  (unminified size, then gzip -9 of that file). Those are upper bounds.
- **Fonts** were measured by requesting the Google Fonts CSS2 API with a current Chrome user agent
  and downloading the `latin` WOFF2 subset, which is what `next/font/google` self-hosts.
- **Browser support** comes from MDN's browser-compat-data on GitHub.

`CONSTRAINTS.md` has no number yet for "First-load JS of the game route" (recorded at the first
preview deploy), so each candidate's own size is given. For scale: Lighthouse mobile has to keep TBT
≤ 200 ms and LCP ≤ 2500 ms (`CONSTRAINTS.md`, "Page performance").

## Summary

<!-- prettier-ignore -->
| Category | Candidates | Recommendation | Main trade-off |
| --- | --- | --- | --- |
| 1. Rendering | 4 | **DOM + CSS** for every screen, with CSS sprite animation; keep a lazy-loaded, `aria-hidden` canvas layer as a later option for a decorative farm scene | Gives up free-form 2D scene effects (particles, camera pan) in exchange for native accessibility, 0 kB of renderer and simple phone layouts |
| 2. UI components | 8 | **React Aria Components** (headless) for the few complex widgets: dialogs, tabs, tooltips, progress, toasts. Runner-up: **Base UI** | Best tested accessibility and touch handling, at a larger per-component cost than Radix or Base UI. No styled library: they fight the cosy look and cost 150–330 kB gzip whole |
| 3. Styling | 6 | **CSS Modules + custom properties** (design tokens as CSS variables), built into Next.js. Runner-up: **Tailwind CSS v4** | No new dependency and no runtime JS, but no utility shorthand. Tailwind is faster to write and is Next's own recommendation, but adds a build tool and its docs advise against mixing it with CSS Modules |
| 4. Animation | 5 | **CSS transitions and keyframes** first, plus **React's `<ViewTransition>`** for screen changes; add **Motion** (`m` + `LazyMotion`) only if a gesture or layout animation needs it | CSS costs 0 kB but can't animate list re-ordering or exit easily. Motion can, at 5–43 kB, and handles reduced motion with one setting |
| 5. Icons | 5 | **Lucide** for UI icons (ISC, released today, about 1–2 kB per icon). Game goods come from the art set (category 7), not an icon font | Lucide has no cow or barn. Phosphor has both but hasn't released since May 2025 |
| 6. Fonts | 9 families | **Nunito** (rounded, cosy, legible UI) as the one family; optionally **Fredoka** for display headings | One variable file of 38 KB covers every weight. Atkinson Hyperlegible Next is the most legible but looks neutral, not cosy |
| 7. Art | 11 rechecked, 11 new | **Microsoft Fluent Emoji** (MIT) for goods; fill feed, cream and the three facilities from **game-icons.net** (CC BY 3.0) or by hand | No licence changed. Three packs forbid redistribution, so their files can't sit in the public repo. The bakery and dairy buildings have no good source in any style |

## 1. Rendering approach

### What the game draws

Every Must screen is a panel of discrete things the player taps: a grid of plots, pens with troughs,
facility job queues, silo and barn lists, the order board, the Level panel and the away summary
(MUST-07.3), which is a list with a timeline. Nothing moves freely or collides. That is closer to a
dashboard than to a scene, which favours the DOM.

### Candidates

<!-- prettier-ignore -->
| Candidate | Fit | Licence | Maintenance (18 Nov 2026) | Bundle cost | React 19 / Next 16 / RSC | Sources |
| --- | --- | --- | --- | --- | --- | --- |
| **DOM + CSS** (React elements, CSS grid, CSS sprites with `steps()` and `image-rendering: pixelated`) | Strong. Plots, queues and lists are native buttons and lists; layout reflows to 360 px with grid and container queries | n/a | Platform | 0 kB beyond React and the app | Server Components can render static parts (labels, layout); interactive parts are Client Components | [Next.js CSS](https://nextjs.org/docs/app/getting-started/css) |
| **PixiJS** `pixi.js` 8.23.0 + `@pixi/react` 8.0.5 | Good for an animated scene; heavy for a panel UI | MIT (both) | pixi.js: 8.23.0 on 11 Nov 2026, 14 releases in 12 months, 319 open issues, 126 PRs. @pixi/react: 8.0.5 on 1 Dec 2025, 2 releases in 12 months, last push Jan 2026, 32 open issues | pixi.js whole package 995 kB / **282 kB gzip**; @pixi/react 131 kB / 40.6 kB gzip. `extend()` imports only the classes used, so the real cost is lower but wasn't measured | @pixi/react peers on `react >=19.0.0`. WebGL/WebGPU needs the browser, so it's a Client Component loaded without SSR. The README says it "should work with any React application (Remix, Next.js, etc)" and doesn't mention RSC | [pixi-react README](https://github.com/pixijs/pixi-react), [npm](https://www.npmjs.com/package/pixi.js) |
| **Konva** `konva` 10.9.1 + `react-konva` 19.3.2 | Same as PixiJS, 2D canvas instead of WebGL; simpler API | MIT (both) | konva: 10.9.1 on 31 Oct 2026, 21 releases in 12 months. react-konva: 19.3.2 on 15 Oct 2026, 12 releases, 0 open issues | konva 190 kB / **56.8 kB gzip**; react-konva 143 kB / 44.6 kB gzip | react-konva peers on `react ^19.3.0`, a match. Client Component only | [react-konva](https://github.com/konvajs/react-konva) |
| **Hybrid**: DOM for all interaction and text; a canvas layer (PixiJS or Konva) for a decorative farm backdrop only | Keeps accessibility in the DOM while allowing an ambient scene later | as above | as above | 0 kB on first load if the canvas is loaded with `next/dynamic` after the UI is interactive | Canvas part is a Client Component with `ssr: false` | [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading) |

### Judged against the requirements

- **BASE-05 (prediction within 100 ms of a tap).** The prediction is `apply()` from `packages/sim`,
  budgeted at ≤ 1 ms per call (`CONSTRAINTS.md`, "Sim speed"), then one React render. A DOM update
  of one plot or one queue is a single commit, well inside a frame. Canvas doesn't make that faster:
  the sim and React state are the same, and the canvas still has to redraw. What does threaten the
  100 ms is wrapping the prediction in a transition. Next's view-transitions guide says
  `<ViewTransition>` animations are triggered by transitions, Suspense and `useDeferredValue`, and
  that "regular `setState` calls do not trigger them". So the prediction should be a plain state
  update, with any animation layered on top. On a phone, the larger risk is a long main-thread task
  while 280 kB of PixiJS is parsed, which would also hurt TBT.
- **BASE-03 (WCAG 2.2 AA for the DOM UI).** Canvas pixels are invisible to assistive technology and
  to axe, so contrast, focus and labels can't be checked there. PixiJS has an opt-in accessibility
  module (`import 'pixi.js/accessibility'`) that "places invisible `<div>` elements over your
  canvas" with `tabIndex`, `accessibleTitle` and `accessibleHint`. It sets a tag name
  (`accessibleType`) but the guide doesn't describe ARIA roles, states or text resizing, so lists,
  tabs and dialogs would have to be rebuilt by hand
  ([PixiJS accessibility guide](https://pixijs.com/8.x/guides/components/accessibility)). I found no
  accessibility layer in Konva's docs (not confirmed either way). The DOM gives native buttons,
  focus order, text zoom, forced-colours mode and screen-reader roles for free.
- **BASE-02 (latest two Chrome, Firefox, Safari; desktop and ≥ 360 px).** DOM layouts reflow with
  CSS grid and container queries. A canvas needs its own resize handling, device-pixel-ratio scaling
  and hit testing, and its text doesn't follow the browser's font-size setting.
- **Bundle cost.** DOM + CSS adds nothing. PixiJS is the heaviest candidate in this whole document.

**Recommendation: DOM + CSS.** Animate crops, animals and facilities with CSS sprite sheets
(`background-position` with `steps()`), which needs no library and works for pixel and vector art.
Keep the hybrid as an option: if playtest 1 asks for a livelier farm, add a decorative,
`aria-hidden` canvas behind the DOM and load it lazily so it stays out of first-load JS. The
trade-off is giving up scene effects (particles, a panning camera) until that point.

## 2. UI and component libraries

### What the game needs

Most of the UI is buttons, lists and progress bars, which plain HTML covers. The widgets that are
hard to make accessible by hand are: a modal dialog (away summary, purchase confirmations), tabs
(storage: silo and barn), tooltips or popovers (recipe inputs), a toast or live region (MUST-12.3's
"Not ready yet") and a progress or meter element for timers. A library is only worth it for those.

### Candidates

Per-component sizes are bundlephobia `exports-sizes` for one export. They include each component's
shared internals, so two components cost less than their sum.

<!-- prettier-ignore -->
| Library | Kind | Licence | Maintenance (18 Nov 2026) | Bundle cost (min / gzip) | React 19 / Next 16 / RSC | Accessibility record | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **React Aria Components** 1.22.1 (Adobe) | Headless | Apache-2.0 | 1.22.1 on 9 Oct 2026, 12 releases in 12 months. Repo (react-spectrum) 551 open issues, 125 PRs, pushed today | Whole 991 kB / 279 kB. Button 12.4 kB, Dialog 5.2 kB + Modal 18.0 kB, Tabs 12.5 kB, Tooltip 9.6 kB, ProgressBar 4.5 kB, Meter 4.5 kB gzip | Peers React 16.8–19. Client Components (hooks) | Strongest documented testing: VoiceOver (macOS Safari and Chrome, iOS), JAWS and NVDA (Firefox and Chrome), TalkBack (Android Chrome). Consistent press, hover and focus across input types; no sticky hover on touch. 30+ locales and RTL | [Quality](https://react-aria.adobe.com/quality), [npm](https://www.npmjs.com/package/react-aria-components) |
| **Base UI** `@base-ui/react` 1.9.0 (MUI team) | Headless | MIT | v1.0 stable 11 Dec 2025; monthly minors since, 1.9.0 on 9 Oct 2026. 342 open issues, 142 PRs | Whole 523 kB / 166 kB. Button 3.0 kB, Dialog 20.9 kB, Tabs 11.7 kB, Tooltip 30.8 kB, Progress 3.2 kB, Meter 3.0 kB gzip | Peers React 17–19. Ships `'use client'` (fixed in 1.0.0-rc.0); RSC hotfixes in the betas | Built by Radix's and MUI's former authors; shadcn/ui made it its default in July 2026 | [Releases](https://base-ui.com/react/overview/releases), [shadcn changelog](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default) |
| **Radix Primitives** `radix-ui` 1.8.1 (WorkOS) | Headless | MIT | 1.8.1 on 12 Oct 2026, 12 releases in 12 months. 143 open issues, 156 PRs. No release between 1.4.3 (13 Aug 2025) and 1.5.0 (6 Jun 2026) | Whole 258 kB / 74.3 kB. Dialog 13.2 kB, Tabs 8.9 kB, Tooltip 19.3 kB, Progress 3.0 kB gzip | Peers React 16.8–19. A June 2026 release fixed "an infinite re-render loop in React 19" | Long record (WAI-ARIA patterns); maintainer pool has shrunk according to secondary sources | [Releases](https://www.radix-ui.com/primitives/docs/overview/releases), [npm](https://www.npmjs.com/package/radix-ui) |
| **Ark UI** `@ark-ui/react` 5.40.0 (Chakra team, Zag state machines) | Headless | MIT | 5.40.0 on 29 Oct 2026, 23 releases in 12 months. 1 open issue, 6 PRs | Whole 1,073 kB / 297 kB. Dialog 20.2 kB, Tabs 12.5 kB, Tooltip 21.7 kB, Progress 7.7 kB gzip | Peers React ≥ 18. Client Components | Follows WAI-ARIA patterns through Zag; smaller public testing record than React Aria | [GitHub](https://github.com/chakra-ui/ark) |
| **Headless UI** `@headlessui/react` 2.2.10 (Tailwind Labs) | Headless | MIT | 2.2.10 on 7 Apr 2026, the only release in 7 months. 95 open issues | Whole 209 kB / 63.0 kB gzip (uses React Aria's focus and interaction packages inside) | Peers React 18–19 | Built for Tailwind; fewer components than the others (no toast, tooltip or progress in its docs' component list); slow cadence | [Releases](https://github.com/tailwindlabs/headlessui/releases), [headlessui.com](https://headlessui.com/) |
| **shadcn/ui** CLI `shadcn` 4.23.0 | Copy-in components (Tailwind + Base UI, Radix or React Aria) | MIT | 65 CLI releases in 12 months; 762 open issues, 982 PRs | The CLI adds nothing at runtime; you pay for the primitives it copies in plus Tailwind | Supports React 19 and Tailwind v4 | Inherits the chosen primitive library's record | [Changelog](https://ui.shadcn.com/docs/changelog) |
| **Mantine** `@mantine/core` 9.8.1 | Styled | MIT | 9.8.1 on 15 Nov 2026, 39 releases in 12 months. 14 open issues | Whole 641 kB / 192 kB. MantineProvider 7.5 kB, Button 9.6 kB, Modal 21.3 kB, Tabs 9.0 kB gzip, plus its CSS file | Peers `react ^19.2.0`. CSS files, no CSS-in-JS runtime. "Mantine components cannot be used as server components"; entries ship `'use client'` | Good, not independently documented | [Next.js guide](https://mantine.dev/guides/next/) |
| **Chakra UI** `@chakra-ui/react` 3.38.0 | Styled | MIT | 3.38.0 on 3 Nov 2026, 11 releases in 12 months. 3 open issues | Whole 1,218 kB / 331 kB. Button 7.2 kB, Dialog 27.2 kB, Tabs 19.2 kB gzip, plus `@emotion/react` 8.1 kB | Peers Emotion (runtime CSS-in-JS). Next lists Chakra as "supported in Client Components" | Built on Ark/Zag | [Next CSS-in-JS](https://nextjs.org/docs/app/guides/css-in-js) |
| **MUI** `@mui/material` 9.5.0 | Styled | MIT | 9.5.0 on 9 Oct 2026, 16 releases in 12 months. 1,402 open issues | Whole 543 kB / 157 kB. Button 27.1 kB, Dialog 28.0 kB, Tabs 30.8 kB gzip, plus Emotion | Peers Emotion; Client Components | Mature, but Material Design is the opposite of cosy | [npm](https://www.npmjs.com/package/@mui/material) |

### Recommendation

**React Aria Components** for the handful of complex widgets, styled with the project's own CSS. Its
accessibility testing is the most thorough and the most public (named screen-reader and browser
pairs, mobile included), which matters because BASE-03 is checked partly by hand ("keyboard order,
focus visible, meaningful labels, target size, motion"). Its touch handling (no sticky hover, one
press model) suits a tap-first game on phones. The trade-off is size: its components cost more than
Base UI's or Radix's (Button 12.4 kB versus 3.0 kB), so use plain `<button>` for ordinary buttons
and take only Dialog, Tabs, Tooltip and the toast region from it.

**Runner-up: Base UI.** Smaller per component, stable since Dec 2025 with monthly releases, and now
shadcn's default. Pick it if React Aria's size shows up in the first-load ratchet.

**Against the styled libraries:** each brings a visual language (Material, Mantine, Chakra) that
would have to be overridden to look cosy, and Chakra and MUI add a CSS-in-JS runtime. **Against
Radix:** it still works, but its cadence paused for most of a year and shadcn has moved its default
to Base UI.

## 3. Styling

<!-- prettier-ignore -->
| Option | Fit | Licence | Maintenance (18 Nov 2026) | Runtime cost | RSC / Next 16 | Sources |
| --- | --- | --- | --- | --- | --- | --- |
| **CSS Modules + custom properties** | Tokens (colour, type, spacing, radius, motion) as CSS variables in one global file; components in `*.module.css`. Themes and `prefers-reduced-motion` are plain CSS | n/a | Built into Next.js | 0 kB JS | Works in Server and Client Components with no setup | [Next.js CSS](https://nextjs.org/docs/app/getting-started/css) |
| **Tailwind CSS v4** `tailwindcss` 4.3.5 (+ `@tailwindcss/postcss`) | Fast to build with; tokens via `@theme` become CSS variables | MIT | 4.3.5 on 6 Nov 2026, 13 releases in 12 months. 40 open issues, 71 PRs | 0 kB JS (build-time only) | Next's CSS page recommends it "for most styling needs". Needs Chrome 111, Safari 16.4, Firefox 128, which BASE-02's latest-two rule already covers. Tailwind's docs say "we don't recommend using CSS modules and Tailwind together" | [Next.js CSS](https://nextjs.org/docs/app/getting-started/css), [Tailwind compatibility](https://tailwindcss.com/docs/compatibility) |
| **vanilla-extract** `@vanilla-extract/css` 1.21.3 + Next plugin | Typed tokens and themes in TypeScript, compiled to static CSS | MIT | 1.21.3 on 8 Oct 2026, 10 releases. 47 open issues | 0 kB JS for static styles (the 32 kB gzip package runs at build time) | Next lists it as supported. The plugin's docs say Turbopack (Next 16's default) support "is experimental. Its API is unstable" | [Next plugin docs](https://vanilla-extract.style/documentation/integrations/next/) |
| **Panda CSS** `@pandacss/dev` 2.5.0 | Typed tokens and recipes, static extraction | MIT | 2.5.0 on 2 Nov 2026, 30 releases in 12 months. 13 open issues | Near 0 kB; small generated helpers if `css()` is imported at runtime | Next lists it. PostCSS plugin plus a `panda --watch` codegen step and a generated `styled-system` folder | [Panda + Next.js](https://panda-css.com/docs/installation/nextjs) |
| **styled-components** 6.6.0 | Runtime CSS-in-JS | MIT | 24 releases in 12 months | 32.8 kB / 12.9 kB gzip runtime | Client Components only, plus a style registry with `useServerInsertedHTML` | [Next CSS-in-JS](https://nextjs.org/docs/app/guides/css-in-js) |
| **Emotion** `@emotion/react` 11.14.0 | Runtime CSS-in-JS (used by Chakra and MUI) | MIT | No release since 9 Dec 2024 | 20.5 kB / 8.1 kB gzip runtime | Next's page still lists Emotion under "currently working on support" | [Next CSS-in-JS](https://nextjs.org/docs/app/guides/css-in-js) |

**Recommendation: CSS Modules + custom properties.** It adds no dependency (nothing for the admin to
approve or pin), no runtime JS, and works in Server Components. A design-token file of CSS variables
is exactly what the #128 design-system plan asks for, and reduced motion, dark mode and focus styles
are one media query each. **Runner-up: Tailwind v4**, if writing speed matters more than a minimal
toolchain. It is also zero-runtime and is Next's own recommendation, but it adds a build tool and
shapes how every component is written. Avoid runtime CSS-in-JS: it costs first-load JS and forces
Client Components. vanilla-extract's Turbopack support is still experimental.

## 4. Animation

<!-- prettier-ignore -->
| Option | Fit | Licence | Maintenance (18 Nov 2026) | Bundle cost | React 19 / RSC | Reduced motion | Sources |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CSS transitions, keyframes and `@starting-style`** | Crop growth stages, sprite loops, button feedback, progress fills, toasts entering. `@starting-style` animates elements as they appear (Chrome 117, Firefox 129, Safari 17.5) | n/a | Platform | 0 kB | Works anywhere | Manual: wrap in `@media (prefers-reduced-motion: reduce)` | [MDN BCD](https://github.com/mdn/browser-compat-data) |
| **React `<ViewTransition>`** + View Transitions API | Moving between screens (farm, order board, away summary); shared-element morphs | n/a (React, MIT) | In stable React 19.3: `react@19.3.1` exports `ViewTransition` and `addTransitionType`. Next says it works in the App Router "with no configuration" | 0 kB beyond React | Works with Server Components. Triggered only by transitions, Suspense and `useDeferredValue`, not plain `setState`. The overlay captures pointer events during the animation unless `::view-transition { pointer-events: none }` | Not automatic. React: "React doesn't automatically disable animations"; use the media query. Browser support: Chrome 111, Firefox 144, Safari 18 | [Next guide](https://nextjs.org/docs/app/guides/view-transitions), [React docs](https://react.dev/reference/react/ViewTransition) |
| **Motion** `motion` 14.14.0 (`motion/react`, formerly Framer Motion) | Layout animations (an order card leaving the board, a queue re-ordering), exit animations, gestures | MIT | 14.14.0 on 13 Nov 2026, 95 releases in 12 months. 3 open issues, 7 PRs | Motion's docs: `motion` component 43 kB; `m` + `LazyMotion` "just over 5kb" plus `domAnimation` +24 kB or `domMax` +38 kB; `useAnimate` mini 3.3 kB. Bundlephobia whole package: 188 kB / 64.3 kB gzip | Peers React 18–19. Client Components | `<MotionConfig reducedMotion="user">` disables transform and layout animations and keeps opacity and colour; `useReducedMotion()` for custom cases | [Reduce bundle size](https://motion.dev/docs/react-reduce-bundle-size), [Accessibility](https://motion.dev/docs/react-accessibility) |
| **react-spring** `@react-spring/web` 10.1.2 | Physics springs | MIT | 10.1.2 on 24 Jun 2026, 4 releases in 12 months. 62 open issues | 51.3 kB / 20.3 kB gzip | Peers React 16.8–19. Client Components | `useReducedMotion()` hook, called at the app root, stops react-spring animations | [useReducedMotion doc source](https://github.com/pmndrs/react-spring/blob/main/docs/app/routes/docs.utilities.use-reduced-motion.mdx) |
| **AutoAnimate** `@formkit/auto-animate` 0.10.2 | One-line list add, remove and move animations (order board, job queue, inventory) | MIT | 0.10.2 on 6 Nov 2026, 3 releases in 12 months. 23 open issues | 8.8 kB / **3.5 kB gzip** | `useAutoAnimate` from `@formkit/auto-animate/react`. Client Components | Automatic: "AutoAnimate respects a user's `prefers-reduced-motion` setting" | [AutoAnimate](https://auto-animate.formkit.com/) |

**Recommendation: CSS first, `<ViewTransition>` for screen changes.** Both cost nothing and cover
almost every cosy-game effect. Write one global reduced-motion rule (the Next guide's snippet sets
`::view-transition-*` durations to 0) and keep motion tokens in the CSS variables. Never put the
prediction itself inside a transition, or BASE-05's 100 ms could be lost while an animation runs
(section 1). If list re-ordering feels abrupt in playtest 1, add **AutoAnimate** (3.5 kB, honours
reduced motion by default). Add **Motion** with `m` + `LazyMotion` only if gestures or shared layout
animations are needed. Its `reducedMotion="user"` setting is the most complete reduced-motion
support here.

## 5. Icons

These are for UI chrome (settings, close, coins, timer, back). Goods, animals and buildings should
come from one art set (section 7) so they share a style.

<!-- prettier-ignore -->
| Set | Licence | Maintenance (18 Nov 2026) | Per-icon cost | Farm coverage (checked file by file) | RSC | Sources |
| --- | --- | --- | --- | --- | --- | --- |
| **Lucide** `lucide-react` 1.75.0 | ISC, with MIT for the Feather-derived icons; keep the notice | 1.75.0 on 18 Nov 2026, 101 releases in 12 months. 229 open issues, 96 PRs | `wheat` 1.6 kB raw / 0.56 kB gzip, plus about 1.3 kB gzip shared once (`Icon`, `createLucideIcon`) | Has wheat, sprout, egg, milk, bird, croissant, cookie, cake, cherry, carrot, tractor, warehouse, factory, fence, coins, shovel. **No** cow or barn | Each icon module starts with `"use client"`, so its JS ships to the client | [Licence](https://lucide.dev/license), [npm](https://www.npmjs.com/package/lucide-react) |
| **Tabler Icons** `@tabler/icons-react` 3.52.0 | MIT | 3.52.0 on 14 Nov 2026, 20 releases in 12 months. 54 open issues | `IconWheat` 1.2 kB / 0.60 kB gzip, plus about 0.9 kB gzip shared | Has wheat, plant, egg, milk, pig, bread, cookie, cake, cheese, cherry, carrot, windmill, tractor, warehouse, factory, fence, coin. **No** cow or barn | Plain components | [GitHub](https://github.com/tabler/tabler-icons) |
| **Phosphor** `@phosphor-icons/react` 2.1.10 | MIT | 2.1.10 on 22 May 2025; **no release in 12 months**; repo last pushed Jan 2026. 15 open issues | Egg 2.9 kB raw / 1.1 kB gzip (each icon carries all 6 weights), plus 0.5 kB shared | The only set with **cow and barn**, plus grains, plant, egg, bird, bread, cookie, cake, windmill, tractor, warehouse | Default components read a React context (client); an `@phosphor-icons/react/ssr` entry exists for Server Components | [GitHub](https://github.com/phosphor-icons/react) |
| **Iconoir** `iconoir-react` 7.12.2 | MIT | 7.12.2 on 4 Nov 2026, 4 releases in 12 months. 152 open issues | Egg 1.0 kB / 0.55 kB gzip, plus 0.17 kB shared | Has leaf, egg, cookie, farm, coins, industry. **No** milk, cow, bread, cake, windmill or tractor | Plain components | [GitHub](https://github.com/iconoir-icons/iconoir) |
| **Heroicons** `@heroicons/react` 2.2.0 | MIT | 2.2.0 on 18 Nov 2024; no release in 2 years. 2 open issues | CakeIcon 1.4 kB / 0.70 kB gzip, no shared runtime | A small general UI set; cake but no farm icons | Plain components | [GitHub](https://github.com/tailwindlabs/heroicons) |

All five tree-shake per icon, so the whole-package numbers bundlephobia reports (215 kB gzip for
Lucide, 1,065 kB for Phosphor) don't apply to an app that imports named icons.

**Recommendation: Lucide** for UI icons: the most active set, small per icon, and a rounded line
style that fits a cosy UI. The trade-off is that it lacks a cow and a barn, which is fine as long as
goods and buildings come from the art set. If one icon family has to cover the farm too,
**Phosphor** is the only one with every farm subject, but it has not released for 18 months. Every
icon that carries meaning needs a text label or `aria-label` (BASE-03).

## 6. Fonts

All of these are on Google Fonts under the SIL Open Font License (`ofl/` in google/fonts), so they
can be self-hosted and redistributed. `next/font/google` downloads them at build time and serves
them from the app's own domain, "meaning no requests are sent to Google by the browser", with no
layout shift ([Next.js fonts](https://nextjs.org/docs/app/getting-started/fonts)). Next recommends
variable fonts. Sizes are the `latin` WOFF2 subset; `latin-ext` loads only if those characters
appear.

<!-- prettier-ignore -->
| Family | Role | Axes measured | Latin WOFF2 | Designer (google/fonts METADATA) | Notes on legibility and feel |
| --- | --- | --- | --- | --- | --- |
| **Nunito** | UI and display | wght 200–1000 | **38.2 KB** | Vernon Adams, Cyreal, Jacques Le Bailly | Rounded terminals, open shapes, wide weight range. Cosy without being childish; readable at UI sizes |
| **Fredoka** | Display | wght 300–700 (wdth 75–125 adds to 66.2 KB) | 29.0 KB | Milena Brandão, Hafontia | Very round and bubbly. Good for headings and big numbers, too soft for body text |
| **Baloo 2** | Display | wght 400–800 | 32.4 KB | Ek Type | Chunky and friendly; Devanagari too |
| **Quicksand** | Display or light UI | wght 300–700 | 27.6 KB | Andrew Paglinawan | Rounded geometric, thin strokes; weak at small sizes and low contrast |
| **Grandstander** | Display | wght 100–900 | 41.4 KB | Tyler Finck, ETC | Playful, hand-made feel; display only |
| **Lexend** | UI | wght 100–900 | 38.8 KB | Bonnie Shaver-Troup, Thomas Jockin and others | Designed for reading proficiency; wide spacing, neutral |
| **Atkinson Hyperlegible Next** | UI | wght 200–800 | 33.2 KB | Braille Institute, Applied Design Works and others | Designed for low-vision readers; distinct letterforms (I, l, 1; 0, O). Neutral, not cosy. The original Atkinson Hyperlegible has only 400 and 700 (16.8 + 17.1 KB) |
| **Nunito Sans** | UI | wght 200–1000 | 30.3 KB | Vernon Adams and others | Nunito without rounded ends; pairs with Nunito headings |
| **Inter** | UI | wght 100–900 (opsz adds to 71.2 KB) | 47.1 KB | Rasmus Andersson | Excellent screen legibility and tabular figures, but reads as a productivity app |

**Recommendation: Nunito alone.** One 38 KB variable file gives every weight from light labels to
heavy numbers, it is rounded enough to feel cosy, and its letterforms stay clear at small sizes. Use
tabular figures (`font-variant-numeric: tabular-nums`) for timers and counts so they don't jitter.
If headings need more personality, add **Fredoka** for display only (29 KB) and preload just the
body font. **Atkinson Hyperlegible Next** is the alternative if playtest 1 shows legibility
problems. The trade-off is warmth against maximum legibility.

## 7. Art assets

Rechecked on 18 Nov 2026 against each pack's own page. itch.io pages were read with WebFetch.
OpenGameArt refuses WebFetch (HTTP 403) but answered `curl`, so those rows were read from the page
HTML. Kenney pages don't list contents, so contents come from each pack's preview image. itch.io
started answering HTTP 429 partway through; the one page that never loaded is noted.

### 7.1 Recheck of `docs/assets.md`

**No licence differs from what `docs/assets.md` records.** All 11 packs still carry the licence the
file gives. What the file leaves out is redistribution: three packs forbid sharing the files, which
matters because the repo goes public in January.

<!-- prettier-ignore -->
| Pack | `assets.md` says | Page says now (18 Nov 2026) | Changed? | Redistribution (public repo) | No-AI statement | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Sprout Lands (Cup Nooble) | Free version non-commercial only; $3.99 version allows commercial use | Free: "can be used in any non-commercial project". $3.99 or more: "can be used in any commercial or non-commercial project". "Please Credit : Cup Nooble". Has crop growth stages, cows, chickens, water troughs, hay bales, crates and a house; no mill, bakery or dairy | No | **Forbidden** in both versions: "can't be resold or redistributed even if modified". Keep files out of git | Yes: "No generative AI was used" | [itch.io](https://cupnooble.itch.io/sprout-lands-asset-pack) |
| Kenney Animal Pack Redux | CC0 | CC0, 2 Feb 2018. 30 animals in 8 styles, including chick, chicken and cow | No | Allowed (CC0) | None on the page; published 2018 | [OpenGameArt](https://opengameart.org/content/animal-pack-redux) |
| Neko Cafe (hellorumin) | Pay what you want, commercial use allowed | "Use this asset pack on free or commercial Project for free". Credit requested, not required. 6 pastries, café furniture with an oven, 16×16 px | No | **Forbidden**: "Redistribute or Resell this even if modified" is on the don't list | **None** | [itch.io](https://hellorumin.itch.io/neko-cafe-asset-pack) |
| Cozy Café Icons (Pixelandbeans) | CC-BY 4.0 | CC-BY 4.0, posted 12 Mar 2026. 15 pixel icons (32×32) including a milk carton, a cookie, a croissant and a strawberry shortcake slice | No | Allowed with credit | None on the page; text says "hand-crafted" | [OpenGameArt](https://opengameart.org/content/cozy-caf%C3%A9-icons) |
| Kenney Furniture Kit | CC0 | CC0, 3 Jan 2018. 120 objects, 3D plus isometric and top-down renders, kitchen included | No | Allowed (CC0) | None | [OpenGameArt](https://opengameart.org/content/furniture-kit) |
| Microsoft Fluent Emoji | MIT | MIT (repo licence). Last push 24 Aug 2026, not archived, 98 open issues | No | Allowed with the MIT notice | None (corporate design team) | [GitHub](https://github.com/microsoft/fluentui-emoji) |
| Farm puzzle animals (comigo) | CC0, but asks not to redistribute | "Creative Commons Zero v1.0 Universal" and "Please don't redistribute or resell it, it's naughty." | No | CC0 allows it legally; the author asks not to. Treat as not to be committed | Yes: "No generative AI was used" | [itch.io](https://comigo.itch.io/farm-puzzle-animals) |
| Kenney Isometric Miniature Farm | CC0; contents unconfirmed | "Creative Commons CC0", 60 files. **Contents from the preview:** barn or house walls, roofs, doors, decking, fences, rows of corn, grain sacks, hay bales, crates, barrels. No animals visible. Realistic 3D-render style | No | Allowed (CC0) | None | [kenney.nl](https://www.kenney.nl/assets/isometric-miniature-farm) |
| Vector Farm Pack | CC0 per search results; page refused automated access | **Now read directly:** CC0, by Viscious-Speed, 25 Apr 2012, "fetched from OpenClipArt". Tags: crops, houses, animals, trees | No (now confirmed) | Allowed (CC0) | None; predates generative AI | [OpenGameArt](https://opengameart.org/content/vector-farm-pack) |
| Kenney Food Kit | CC0; contents unconfirmed | "Creative Commons CC0", 200 files, v2.0 "Completely remade". **Contents from the preview:** cheese wheel and wedge, milk cartons, loaves and rolls, croissant, layer cakes, cookies, fried egg, corn. Low-poly 3D | No | Allowed (CC0) | None | [kenney.nl](https://www.kenney.nl/assets/food-kit) |
| Cafe and Tea Shop (Avoid) | No licence | Still no licence; a commenter asked and got no reply | No | Not without permission | None | [itch.io](https://pixelpossumstudio.itch.io/cafe-and-tea-shop-2d) |

Kenney's support page says "all game assets on the asset pages are public domain licensed (CC0)" and
"Attribution is not required" ([kenney.nl/support](https://kenney.nl/support)).

Worth adding to `docs/assets.md` (not done here): the no-redistribution terms of Sprout Lands, Neko
Cafe and comigo, Neko Cafe's missing AI statement, and the confirmed contents of the two Kenney
packs.

### 7.2 New candidates for the gaps

The gaps were the feed mill, bakery and dairy buildings, animal feed and cream.

<!-- prettier-ignore -->
| Candidate | Style | Licence (key phrase) | Price | Redistribution | No-AI statement | Covers | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Farming Sim Tileset Pack (VectoRaith) | 16×16 pixel (also 32 and 48 px) | "Use assets in both free and commercial projects"; using them "for AI learning" is forbidden | Name your price | **Forbidden** ("Redistribute, re-sell, and/or sub-license the asset files") | Tagged "No AI" | Barn, chicken coop, **silo**, farmhouse; 23 crops with 4 growth stages incl. wheat, corn, strawberry; chicken, cow | [itch.io](https://vectoraith.itch.io/farming-sim-tileset-pack) |
| Autumn Farming Asset Pack (SableBytes) | 16×16 pixel | Commercial use "with credit, provided a donation of 3 USD or higher" | $3+ for commercial use | **Forbidden** ("cannot to sold or distributed, even if modified") | "No AI was used when creating any of the game assets" | **Windmill** (usable as the feed mill), barn, coop; cows, chickens, eggs, **feed and water trough**, corn | [itch.io](https://sablebytes.itch.io/autumn-farming-asset-pack) |
| RPG Buildings & Interiors: Windmill (Szadiart) | 32×32 pixel | "free to use, personal or commercial"; credit appreciated | $6 ($2.40 on sale) | Resale forbidden; redistribution not addressed, so keep out of git | "No generative AI was used" | **Mill** (3 variants), small depot, interiors | [itch.io](https://szadiart.itch.io/rpg-buildings-and-interriors-windmill) |
| Bakery Ingredients and Dairy Products (nizychuu) | 32/64/128 px pixel icons | "individuals, corporations, commercial or non-profit" | $10+ | **Forbidden** ("refrain from redistributing or selling the materials") | "No generative AI was used" | 77 bread, ingredient and **dairy** icons; page doesn't list items, so butter, cheese and cream are likely but unconfirmed | [itch.io](https://nizychuu.itch.io/pixel-art-food-bakery-ingredients-and-dairy-products-asset-pack-32x32) |
| game-icons.net | One-colour SVG silhouettes | CC BY 3.0; credit "through an accessible menu" in a game | Free | Allowed with credit | None stated | wheat, corn, strawberry, chicken, cow, egg, milk carton, cheese, butter, bread, cookie, cake slice, **flour sack**, **grain bundle**, **windmill**, **barn**. No cream | [FAQ](https://game-icons.net/faq.html), [food tag](https://game-icons.net/tags/food.html) |
| Feed sacks and misc (OpenGameArt) | Pixel tiles | CC-BY 3.0, 5 Jan 2013 | Free | Allowed with credit | None; predates generative AI | **Feed or grain sacks**, wheat | [OpenGameArt](https://opengameart.org/content/feed-sacks-and-misc) |
| OpenMoji | Flat outline-and-colour emoji | "free to use under the CC BY-SA 4.0 license"; **share-alike** for modified emoji | Free | Allowed with credit and share-alike | None stated; made by HfG Schwäbisch Gmünd students and professors | All Unicode foods and animals | [openmoji.org](https://openmoji.org/) |
| Twemoji (jdecked fork) | Flat emoji | Graphics CC-BY 4.0, code MIT | Free | Allowed with credit | None stated | Same Unicode set | [GitHub](https://github.com/jdecked/twemoji) |
| Noto Emoji (Google) | Rounded colour emoji | Images Apache 2.0, font OFL 1.1 | Free | Allowed with the Apache notice | None stated | Same Unicode set | [GitHub](https://github.com/googlefonts/noto-emoji) |
| Bakery Building (Tiny Treats) | Low-poly 3D, cosy | "Creative Commons Zero v1.0 Universal" | $7.95+ | Allowed (CC0) | "No generative AI was used" | **Bakery exterior**, 2 colours, awnings, signs; 3D only, needs rendering to 2D | [itch.io](https://tinytreats.itch.io/bakery-building) |
| 2D Isometric Bakery Assets (Waecholo) | Isometric pixel | **No licence on the page** | €3+ | Unknown | "No generative AI was used" | Bakery interior only. Avoid unless the author grants a licence | [itch.io](https://waecholo.itch.io/2d-isometric-bakery-assets) |

Not checked: the Solaria Food & Drink icons (jamiebrownhill.itch.io) kept answering HTTP 429.

Fluent Emoji, checked asset by asset in its repo, **has** Butter, Cheese wedge, Cookie, Glass of
milk, Shortcake, Strawberry, Ear of corn, Sheaf of rice, Egg, Chicken, Cow, Bread, Croissant,
Factory, House, Hut and Tractor. It has **no** cream, animal feed, windmill, barn, bakery or dairy,
because Unicode has no emoji for them. Unicode also has no wheat emoji: "Sheaf of rice" (🌾) is the
usual stand-in, which may read as rice to some players.

### 7.3 Coverage of the Must goods and buildings

<!-- prettier-ignore -->
| Good or building | Flat or vector sources | Pixel sources |
| --- | --- | --- |
| Wheat | Fluent "Sheaf of rice" (stand-in), game-icons wheat, OpenMoji, Twemoji, Noto | Sprout Lands crops, VectoRaith wheat |
| Corn | Fluent "Ear of corn", game-icons corn | VectoRaith, SableBytes |
| Strawberries | Fluent Strawberry, game-icons strawberry | VectoRaith |
| Chickens | Fluent Chicken, Kenney Animal Pack Redux, game-icons | Sprout Lands, VectoRaith, SableBytes |
| Cows | Fluent Cow, Kenney Animal Pack Redux, game-icons | Sprout Lands, VectoRaith, SableBytes |
| Eggs | Fluent Egg, game-icons egg | SableBytes |
| Milk | Fluent Glass of milk, game-icons milk carton | Cozy Café Icons milk carton |
| Chicken feed, cow feed | **Gap.** Stand-ins: game-icons grain bundle or flour sack | Feed sacks and misc (CC-BY 3.0) |
| Cream | **Gap.** No emoji exists | nizychuu (unconfirmed) |
| Butter | Fluent Butter, game-icons butter | nizychuu (likely) |
| Cheese | Fluent Cheese wedge, game-icons cheese | nizychuu (likely) |
| Bread | Fluent Bread, game-icons bread | Neko Cafe pastries |
| Cookies | Fluent Cookie, game-icons cookie | Cozy Café Icons cookie |
| Strawberry cake | Fluent Shortcake | Cozy Café Icons strawberry shortcake |
| Feed mill | game-icons windmill (silhouette) | SableBytes windmill, Szadiart mill |
| Bakery | **Gap** (Fluent House or Hut as a stand-in) | **Gap** (Tiny Treats is 3D; Waecholo is unlicensed) |
| Dairy | **Gap** (Fluent Factory as a stand-in) | **Gap** (a barn stands in) |
| Silo, barn | game-icons barn | VectoRaith silo and barn, SableBytes barn |
| Trough | none | Sprout Lands, SableBytes |

### 7.4 Recommendation

**Fluent Emoji (MIT) as the base for goods.** It covers 13 of the 15 Must goods (all but cream and
feed, with wheat as a rice-sheaf stand-in), its files can sit in the public repo with the MIT
notice, and its flat-3D style suits a DOM UI at any size. Fill feed and the three facilities from
**game-icons.net** (CC BY 3.0, credit in `CREDITS.md` and an in-game credits screen), recoloured, or
draw cream, feed and the facilities by hand in Fluent's style. A hand-drawn derivative must keep the
MIT notice for the parts taken from Fluent.

**If the art direction is pixel instead:** Sprout Lands (paid) + VectoRaith + SableBytes give pastel
16×16 crops, animals, barn, silo, windmill and trough, all marked no-AI. All three forbid
redistribution, so their files must stay out of git (gitignored and fetched by a script, as
`docs/assets.md` plans). The bakery and dairy buildings stay uncovered in either style.

The trade-off: flat emoji art is complete, free and public-repo-safe but generic; pixel packs look
more like a cosy game but need a fetch script, paid licences and still leave two buildings to draw.

## Questions for the professor

1. Does a DOM-and-CSS game UI read as a "game" to players, or does the farm need a scene (canvas) to
   feel alive? Where would they draw the line?
2. For a solo project with a hand-checked WCAG 2.2 AA bar, is a headless library (React Aria) worth
   its size, or would they hand-build the four complex widgets?
3. CSS Modules with tokens versus Tailwind v4: which would they rather see in a bachelor report, and
   why?
4. Flat emoji art (complete, MIT) or pastel pixel art (more charm, redistribution limits): which
   fits a cosy idle game better, and how would they fill the missing buildings?
5. How should the prediction (BASE-05) be shown so a later reconciliation (MUST-12.4) doesn't feel
   like a glitch: animate the change, or snap?

## Not verified

- Konva's accessibility: no accessibility layer was found in its docs, but that wasn't confirmed.
- itch.io "No generative AI" tags are the authors' own claims. Neither Kenney page mentions AI.
- The real tree-shaken cost of PixiJS with `extend()` wasn't measured.
- Bundlephobia measures with its own bundler; Next's Turbopack output can differ. The first preview
  deploy's first-load JS number (the ratchet in `CONSTRAINTS.md`) is the figure that counts.
