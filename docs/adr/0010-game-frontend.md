---
status: proposed
---

# Game frontend

M4 ("Playable slice live", due 29 Nov 2026) needs the first player-facing UI on top of the sim and
the game API: a farm map, the slice's actions (wheat → chicken feed → eggs → cookies), the order
board and the return after time away. This ADR records how that UI is rendered, which accessibility
bar it meets, its libraries, its client state and sync, its design system and where its art comes
from. Each section names the pattern, the choice and the alternatives considered.

## How this was decided

The direction (mood, palette, fonts, interactions, art source) came from the prep in
[#128](https://github.com/sssoto17/sunny-pastures/issues/128) and the meeting with Dannie on 19 Nov,
recorded in the [outcomes comment on #127](https://github.com/sssoto17/sunny-pastures/issues/127).
The reopened items and the stack were grilled with the admin on 22–23 Nov in an attended
`/wayfinder` session, charted as
[Wayfinder: M4 Playable slice live](https://github.com/sssoto17/sunny-pastures/issues/589):
[Map rendering](https://github.com/sssoto17/sunny-pastures/issues/408) and
[Accessibility bar](https://github.com/sssoto17/sunny-pastures/issues/409) hold the resolutions;
[Reconsider Zero](https://github.com/sssoto17/sunny-pastures/issues/410) holds the sync question,
moved to M5. The research behind the libraries is `docs/spikes/frontend/options.md` (PR #412).

## Settled direction (19 Nov, carried in)

- **Mood:** a board game on a kitchen table; an isometric cartoon farm, calm and minimal.
- **Palette and type:** Harvest linen; Fredoka for headings, Nunito for body text.
- **Map:** fills the screen; scroll wheel or pinch to zoom, drag to pan, with buttons and keys as
  alternatives.
- **Interaction:** tap a lot for a status popover; its button opens a dialog for actions. Finished
  goods wait beside the building that made them and are collected with a tap.
- **Return:** attention cues on the map instead of a pop-up. The away summary (MUST-07.3) sits
  behind a banner, stretch for M4. Levelling up is the one dialog that opens by itself.
- **Buying:** pens and facilities are bought on predefined lots showing a "For sale" sign;
  drag-and-drop placement is a stretch goal.
- **Art:** LeviArt's Isometric Cartoon Farm and Cartoon Farm Items Pack; files kept out of git; a
  person draws every final pixel (AI only for ideas and reference).

## 1. Rendering: a DOM map, with canvas as the upgrade path

**Decision (admin, 22 Nov).** For M4 the farm map is DOM. One container fills the viewport and its
content moves by a CSS `transform` (`translate` + `scale`). Each lot is an absolutely positioned
React Aria `Button` holding its isometric sprite, stacked back to front by `z-index` from its
coordinates in a lot table. WONT-02 stands for M4.

- **Why:** the slice has about 10 map objects, well within what the DOM handles; hit-testing, focus,
  labels and popover anchors come with React Aria; every interaction is testable in `ci / test`, so
  the gameplay tickets can be factory-ready; no new dependency. The isometric look comes from the
  art, not the renderer.
- **Upgrade path:** once M4's goal is met, canvas is reconsidered when the map's sprite count or
  scene effects need it, behind the same map component interface. The client store (section 4) can
  be read outside React, as a render loop needs.
- **Rejected for M4:**
  - **Our own Canvas 2D renderer** (Dannie's suggestion: Phaser's approach without Phaser): a
    camera, isometric depth sorting, hit-testing, device-pixel-ratio handling, a hidden DOM layer
    for keyboards and screen readers, and DOM popovers over canvas coordinates. CI can't see pixels,
    and it would put 2–3 tickets on the critical path before any gameplay.
  - **PixiJS:** the heaviest dependency in the spike; its accessibility layer places focusable
    `<div>`s but has no roles or states.
  - **Konva:** the same trade-off as PixiJS on 2D canvas, with no documented accessibility layer.

## 2. Accessibility bar: WCAG for the interface, the genre for the map

**Decision (admin, 22 Nov, after Dannie's advice to follow the genre).** BASE-03 is narrowed:

- **WCAG 2.2 AA applies to the interface:** the HUD, buttons, popovers, dialogs, the order board and
  all text. The axe gate and the review row in `CONSTRAINTS.md` stay.
- **The map scene follows the genre's conventions.** Ambient animation (swaying wheat, pecking
  chickens) is allowed and runs by default, stilled only under `prefers-reduced-motion`: a recorded
  exception to 2.2.2 (Pause, Stop, Hide) for the map scene. Attention cues pulse a few times, then
  rest.
- **Reference for the map:** the Game Accessibility Guidelines' basic tier (no time pressure,
  alternative inputs for pan and zoom, no information by colour alone).
- **No orientation lock in M4.** iOS Safari can't lock orientation (`screen.orientation.lock()`
  needs fullscreen), so a browser "lock" could only be a rotate overlay, which blocks play and fails
  1.3.4 (technique F100). The DOM layout works in both orientations. A lock is reconsidered with the
  canvas upgrade or a native wrapper.
- **Rejected:** WCAG 2.2 AA for everything, unchanged (fights the genre on motion, for no player
  gain); dropping WCAG for game guidelines only (the interface is a web UI people read and tap, and
  the axe gate already guards it).

## 3. Libraries

Pinned exactly; each was the newest release at least 7 days old on 22–23 Nov (`minimumReleaseAge`)
and has no install scripts. Approved by the admin, one by one.

<!-- prettier-ignore -->
| Package | Pin | Use | Alternatives considered |
| --- | --- | --- | --- |
| `react-aria-components` | 1.22.1 | Headless primitives: buttons, popovers, dialogs, meters, toasts | Base UI (runner-up), Radix; styled kits (fight the look, 150–330 kB) |
| `zustand` | 5.1.0 | The client store (section 4) | `useReducer` + context; our own `useSyncExternalStore` store |
| `lucide-react` | 1.73.0 | Interface icons only (close, zoom, coins); goods come from the art | Phosphor (no release since May 2025) |
| `tailwindcss` + `@tailwindcss/postcss` | 4.3.5 | Design tokens in `@theme`, utility styling | CSS Modules + custom properties (spike's first pick: no dependency, slower to write) |
| `tailwind-variants` | 4.0.2 | Component variants keyed on props (section 6) | hand-written class maps; `cva` |
| `jsdom` (dev) | 31.0.1 | DOM for the `ui` Vitest project | `happy-dom` 21.0.4 (lighter, less complete where React Aria's popovers and pointer events need it); Vitest Browser Mode (a browser in `ci / test`; not chosen, see [ADR-0011](0011-browser-tests.md), section 2) |
| `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event` (dev) | 16.3.3, 10.4.2, 14.6.10 | Component tests by role and name | — |

- **Fonts:** Fredoka and Nunito through `next/font` (built into `next` 16.4.6), no package.
- **Not in M4:** `motion` (14.14.0 was the candidate). Ambient animation and cues are CSS keyframes;
  the "fly to storage" collect animation is stretch work, and Motion waits for it.
- **No HTTP client:** native `fetch` behind the typed wrapper in section 5. Axios was rejected: a
  dependency for what `fetch` and one function do.

## 4. Client state: an observable store (Zustand)

**Pattern:** an **observable store with selectors**. Components subscribe to the slice of state they
show, so the clock tick doesn't redraw the whole farm.

The store holds the last **confirmed** farm envelope from the API, the **pending** actions (sent,
not yet answered, each with its idempotency key), the clock's `now`, a load `status` and the last
refusal. The **predicted** farm is derived: the confirmed state with each pending action applied in
order, then advanced to `now` with the shared sim (`createSim(sliceContent)`). An action is applied
to the prediction synchronously, as a plain state update, never inside a transition (BASE-05). The
farm's time is `max(Date.now(), confirmed.at)`, so it never runs backwards (MUST-11.3). Offline
return falls out of this: a farm loaded after time away is advanced to now on load, with no extra
request.

- **Chosen: Zustand** (admin, 23 Nov): maintained, about 1 kB, no dependencies; selectors limit
  re-renders; readable outside React for the canvas upgrade; the sim's state is plain JSON.
- **Rejected:** `useReducer` + context (no dependency, but every tick re-renders every consumer,
  eating into BASE-05's 100 ms on a phone); our own store on `useSyncExternalStore` (the same
  pattern in about 30 lines, but ours to test and maintain, against the admin's rule to prefer
  maintained dependencies).

## 5. Sync module: one seam for the server

**Pattern:** a **gateway** module. All server calls live in `src/client/session/` and
`src/client/api/`; nothing else in the client calls `fetch` or Supabase.

- `session/`: one browser `supabase-js` client (already a dependency, ADR-0007 section 4), default
  browser persistence (MUST-09.2), anonymous sign-in on first use (MUST-09.1). The token travels as
  `Authorization: Bearer` (ADR-0007 section 4, Q1).
- `api/`: `loadFarm()` and `sendAction(...)` over native `fetch`, resolving to a result union keyed
  on ADR-0007's `ErrorCode`, never throwing on an HTTP error. A 401 refreshes the token and retries
  once; `busy`, `internal` and network failures retry with the same idempotency key, bounded; a
  `refused` (422) rolls the prediction back and shows the sim's message.
- **Shared contract types:** `ErrorCode`, `ErrorBody`, `FarmEnvelope` and `Answer` move to
  `apps/web/src/contract/` (types only), imported by both `server/http` and the client, so the
  client never imports server code.
- **Why a seam:** [Reconsider Zero](https://github.com/sssoto17/sunny-pastures/issues/410) is
  decided in M5. If Zero wins, it replaces this module, not the screens.
- **Rejected:** calling `fetch` from components (couples every screen to the contract); Axios
  (above).

## 6. Design system: a seam between structure and styling

**Decision (admin, 22 Nov).** Component styling is separate from the application's structure and
logic, so neither waits for the other.

- **The `components/ui` seam:** `apps/web/src/components/ui/` wraps React Aria in a small set of
  primitives (Button, IconButton, Badge, Popover, Dialog, Panel, Meter, Toast) whose **variant props
  are fixed up front** (`variant`, `size`, `tone`). The structure tickets use only these and set no
  styles; the primitives expose their props as `data-*` attributes. Positions on the map are
  computed, so they are inline `style`.
- **The design-system strand** fills the same wrappers with `tailwind-variants` styles, in place,
  with no signature change: tokens first (Harvest linen colours, a type scale with Fredoka and
  Nunito, spacing, radii, shadows, motion with a reduced-motion rule), then the primitives, then a
  pass over the game screens. Its tickets are Manual: CI can't judge looks.
- **Design tooling:** Impeccable (`pbakaus/impeccable`, Apache-2.0) for `PRODUCT.md`, `DESIGN.md`,
  critique, polish and audit, with its design hook; and the Modern Web Guidance skill. Impeccable's
  live-mode Apply can start `claude` with `bypassPermissions`, so it runs with
  `IMPECCABLE_LIVE_COPY_AGENT=chat`. Impeccable's `detect` in CI is a `.github/` change, left to the
  Tooling backlog.
- **Rejected:** styling inside each screen ticket (every factory ticket would carry design judgement
  CI can't check, and the screens would wait for tokens); a styled component kit (fights the cosy
  look).

## 7. Assets: placeholders in git, sprites from a bucket

**Decision (admin, 22 Nov).** The art packs may be used in a game but their files may not be shared,
and the repo is public.

- A **sprite manifest** (`src/client/sprites/`) maps each content id to a file name. `spriteUrl(id)`
  returns `NEXT_PUBLIC_ART_BASE_URL/<file>` when that variable is set, and a placeholder from
  `public/sprites/placeholder/` when it isn't.
- **Placeholders** are simple hand-written SVGs in the palette, committed. CI and the factory always
  run on them, so no ticket waits on the art and no secret enters the build.
- **The real sprites** are exported by the admin from the packs and uploaded, those files only, to a
  public Supabase Storage bucket. Players download them as from any deployed game; the pack files
  and PSDs never leave the admin's machine. Every pack that ships is credited in `CREDITS.md`.
- **Rejected:** a build-time download from a private store (a secret, a build step, and a build that
  breaks when the store is down); a private repo as a git submodule (fights the factory's sandbox,
  and a second repo to look after).

## 8. Zones

`.fallowrc.jsonc` gains `contract` (types only), `client` (allows `contract`, `sim`) and
`components` (allows `client`, `contract`, `sim`); `pages` also allows `components` and `client`;
`http` allows `contract`. Nothing in the browser's zones can import `src/server/**`.

## Consequences

- WONT-02's note in `moscow.md` records the canvas upgrade path; BASE-03 is reworded in the spec and
  its review row in `CONSTRAINTS.md`.
- The build tickets sit under #127: a Manual foundation ticket (dependencies and config),
  factory-ready structure tickets, and Manual design-system tickets, ordered by native blocking on
  the M4 map.
- M4 goes live on staging only; production by `v*` tag moved to M7
  ([CI: production deploy by v* tag](https://github.com/sssoto17/sunny-pastures/issues/590)).
