# onion-planner-mcp — Roadmap

This server is the **placement/rendering engine**, not the orchestrator. It is
filesystem-first: the planner contract is plain files in iCloud, and the data (calendar
events, weather, email-derived to-dos, generated art) comes from *other* MCPs that an
orchestrator (e.g. Claude CoWork) gathers. The one network-capable helper, `fetch_image`,
only downloads HTTPS PNG/JPEG files to local temp paths for filesystem embedding. Our job is
to render everything beautifully and safely into `ai.svg`. The north-star scenario:

> Overnight, the planner is set: the schedule is filled from the calendar, a weather note +
> umbrella mark sit in a corner, email-derived to-dos appear next to checkboxes, a
> motivational image tucks into the notes. Midmorning, "update my planner" slides new
> meetings into place without disturbing any of it.

### Locked design decisions

1. **All AI-authored decoration lives in `ai.svg`** — weather/umbrella as drawn marks or
   Phosphor glyphs, generated art as an embedded `<image>`. Never `stickers.svg` (the
   user's layer). "Sticker" is the user's mental model, not a literal write.
2. **Incremental updates are region-level merges** — `write_underlay` patches named regions
   and preserves the rest, so "slide a meeting in" doesn't clobber the day's other content.

### Invariants every item must respect

- Only ever write `ai.svg` + the manifest's `layers.ai` block (+ `modified`) + the page's
  **`media/ai/`** subfolder (AI-owned art); on create, the new page's own files + chapter
  `.folder.json`. Never touch ink/stickers/template, the rest of `media/`, or Private.
- All writes through `resolvePageRel` (Shared/ containment) + `atomicWrite`.
- No app/network API for planner state. Re-read `manifest.size` per page; geometry comes from
  each page's template.
- Closed font set (`Mulish, Newsreader, IBM Plex Mono, Caveat, Fredoka, Phosphor`).

---

## Done (this pass)

- **Region intent — `fill` + free-text `intent` (who fills, and what for)** — each parsed
  region now carries two signals, surfaced by `read_page`, so an open-ended template ecosystem
  can express designer intent without the server pre-coding every region type:
  - **`fill`** (`ink | ai | shared`) — the *behaviour* axis (who writes). **Derived** — explicit
    `data-fill` wins, else region-name default → template-type (`reflection/lined/dotted/blank`
    → ink) → geometry fallback (the original "lined = me" instinct, last resort). Key reframe:
    **geometry does not predict ownership** (reflection regions are ruled yet the user's;
    `schedule`/`todo` are ruled yet AI-seeded). `ai`/`shared` are the AI's; a `shared` region
    `read_ink`s first and seeds *around* the user's hand; an `ink` region is a handwriting
    surface — scaffolding only, body text trips a soft `ink_region_filled` warning.
  - **`intent`** (free text, or `null`) — the *designer's* note on what a block is for (e.g.
    "this week's dinners, one row per day"). **Advisory**: the filler reads it to fill novel
    regions as imagined, but is free to repurpose; never enforced. Region names are only a
    default for `fill`, not a contract — novel templates set `data-fill`/`data-intent` explicitly
    and are first-class.
  - `deriveFill`/`FILL_BY_NAME`/`readIntent` in `src/template.ts`; `read_page` passes
    `manifest.template` for type derivation. Filler guidance flipped from "fill the quote/todo
    regions" to "honour each region by `fill`+`intent`, skip if no real data" (`docs/AUTHORING.md`).
  - **App contract:** `data-fill="ink|ai|shared"` + free-text `data-intent` registered as
    optional region keys in `FORMAT.md §2`; `TEMPLATES.md §3` region-authoring spec refreshed
    (the identity/fill/intent model, real region vocabulary, `data-list`). Server derives by
    default, so zero template edits needed. Smoke +25 (143 total).
- **Theme contract migration (2026-06 UI-redesign handoff)** — reconciled the redesign handoff
  against the app's already-integrated decisions (`../onionskin` top commit; `DECISIONS.md`
  #34/#35/#39/#40). The underlay theme is no longer just the named enum: `write_underlay` now also
  takes the **adaptive param block** `{ harmony, varietyDial, fontPersonality }` — the chapter-theme
  axis whose **keys are owned by the app's `FORMAT.md §4`** (`.folder.json → theme`). The server
  **reads the chapter theme as the default** (`read_page` surfaces it) and accepts **per-call
  overrides**; the four named presets (`gold`/`bright`/`cozy`/`editorial`) are kept as quick picks
  over the same space. New `src/color.ts` derives the day's palette from the template's **own
  sampled colours** (`template.palette`) per `harmony` (`match`/`complement`/`warm`/`cool`/`seasonal`),
  with **derived text floored dark** so it reads on cream (legibility solved at derivation, not a
  runtime checker). `fontPersonality` swaps fonts within the closed set (clean/handwritten/editorial)
  as an orthogonal axis. Smoke +12 (118 total). **Reconciliation calls recorded** (so they don't
  regress): the handoff's *imported-full-colour-Etsy-template-as-core-model* is **rejected** (app
  ROADMAP G1 — harmony applies to BYO/cozy/colorful palettes, not a neutral-base assumption);
  **provenance is by layer** (everything in `ai.svg` is AI — no provenance markers to add, app reads
  authorship from the layer, DECISIONS #40); underlay gold stays the **single `#9C7C1A`** (the
  chrome's `#7E5C12` AA-text token is *not* adopted in the underlay — parity over a split); the
  AA-contrast "warning engine" was **dropped** as over-engineering (the background is the template's
  cream, a constant — not ours to recompute per write). See `docs/AUTHORING.md` + `SHARED-VISUAL-SPEC.md §6`.
- **Dynamic sections (planner-fidelity)** — a line `heading: true` draws a section label
  (bold, letter-spaced, hairline rule) and box regions now flow top-down, so the AI layer
  composes day-specific structure (Important / Tomorrow / Habits) into a neutral region
  *without* enriching the template — the minimal template stays a neutral scaffold by
  design. Plus a per-region `xPad` (left inset; the schedule's wider margin — templates print no
  hour gutter, so the schedule is agenda-style) and an authoring guide
  ([`docs/AUTHORING.md`](AUTHORING.md)) for filling pages with real, varied content.
- **Gold converged** — `#9C7C1A` is now the single canonical Onionskin gold across app chrome,
  this server, and the on-device composer; the former `#C9A227` is retired (no longer a
  divergence). `SHARED-VISUAL-SPEC.md` is **locked** and mirrored into `../onionskin/design/FORMAT.md`.
- **Phase 1**: `write_underlay` `merge` (region-level patch, preserves the rest verbatim);
  line `marker` (drawn `checkbox`/`bullet`); overflow/fit `warnings` (returned, non-fatal);
  `dryRun` (compose + warnings, no write). All in `svg.ts`/`page.ts`/`index.ts`.
- **Format catch-up to the current fixtures** (fixtures are now a fresh library — a
  `Templates/` + `Stickers/` catalogue, no seeded pages):
  - `create_page` instantiates from the `Templates/<id>/` catalogue when a chapter has no
    sibling to clone (copies a starter `stickers.svg` if the template ships one).
  - `REGION_DEFAULTS` updated for renamed/new regions (`affirmation → quote`, `header`, `goals`).
  - `composeCalendar` derives the grid from the box + `data-cols`/`data-rows` (robust to the
    month template now drawing only interior dividers inside a `<rect>`).
  - Smoke test rewritten to seed its own chapters + create pages from the catalogue (52 checks).
- **Phase 2.4 — search / filter pages**: `list_pages` gained optional `template`, `aiStatus`,
  `titleContains`, and `modifiedAfter`/`modifiedBefore` filters (combine with AND). The walk +
  per-page manifest read now lives in `library.listPageRows` (shared by the tool and the dev
  CLI); the return shape is unchanged. The filter surface is a single growable `PageFilter`, so
  **full-text / handwriting search is the intended follow-on** — a future `textContains` over
  OCR'd `ink.svg` slots in as one more guard behind its own data source (not the manifest),
  without reshaping the tool. Smoke test +8 checks (60 total).
- **Phase 2.3 — time-aware schedule input**: a schedule line may carry `time: "HH:MM"` (24h)
  and the server snaps it to the nearest ruled row, so the caller needn't compute row indices.
  The "decide before building" open question is **resolved by exploration**: no daily/agenda
  template carries hour labels (the schedule region is ruled `<line>`s only), so parsing is
  impossible — anchoring is explicit via per-region `startHour` + `rowsPerHour` (default 1).
  Precedence `y > row > time > order`; a `time` with no `startHour` warns and falls back to
  order (overnight-safe), and a time outside the grid pins to the nearest edge with a warning.
  `rowForTime` in `svg.ts`.
- **Phase 2.2 — embed generated images**: a region may carry `images` — base64 PNG/JPEG the
  caller supplies, or a local file `path` (optionally produced by `fetch_image` from an HTTPS
  PNG/JPEG URL; generation still lives outside this server). Investigating the **app's renderer**
  set the mechanism: it's a custom SwiftUI Canvas parser that resolves `<image href>` only as a
  **page-relative file path** (`MediaCache`, decoded via `CGImageSource`, cached by URL#mtime),
  with **no data-URI support**. So the server writes art into a dedicated **`media/ai/`**
  subfolder and references it by href — ai.svg stays tiny, art syncs once over iCloud. Per
  image: validated magic bytes vs `format`, a 2MB hard cap (+soft warn), aspect-filled height,
  corner/x-y placement within the region box, content-hash filenames. **Orphan GC** drops any
  `media/ai/*` no longer referenced by the final (post-merge) ai.svg; `clear_underlay` removes
  the folder. `resolveImages`/`gcOrphanMedia` in `page.ts`, `imageDims`/`<image>` emission in
  `svg.ts`. **Invariant extended:** the server may now also write/delete under `media/ai/`
  (never the rest of `media/`, never user layers). **App contract** (one blocking change: give
  the AI layer a real `imageProvider`) lives in the plan + app thread. Smoke +13 (84 total).
- **Phase 2.5 — auto text-wrap**: opt-in `wrap: true` per line breaks the text to the region
  width (greedy word-pack reusing the Phase-1 `estimateTextWidth`; hard-break for an over-long
  word). Continuation segments stack just below the baseline and **do not consume the next
  ruled row**, so a caller's row→content mapping is preserved. When wrapping, the width-overflow
  warning is suppressed and replaced by a vertical-fit warning if the stacked block collides
  with the next row or runs past the region box. `wrapText` in `svg.ts`. (Possible follow-up:
  default-on for the free-text box regions `quote`/`notes`, where there's no row to disturb.)
  Smoke test +11 checks (71 total).

---

## Phase 2 — the delight layer (richer content, some app-side unknowns)

### 2.1 Phosphor icon glyphs (weather, decoration) · Effort M · Feasibility MEDIUM
The "umbrella in the corner." `Phosphor` is in `FONT_ENUM` but otherwise unused. Add an
`icon` on a line/element mapping a friendly name (`umbrella`, `sun`, `cloud`, `check`,
`star`) to its Phosphor codepoint. **Needs** the codepoint map and confirmation the app
ships the Phosphor cut; drawn-shape fallback otherwise. (Markers already prove the
drawn-shape path.) **Now unblocked on the app side:** the 2026-06 handoff's icon-set request
was resolved to **map glyphs to the bundled Phosphor webfont** (no bespoke commission) — the
canonical name→codepoint mapping is published at
`../onionskin/design/design-system/readme.md` § Iconography (`Phosphor.swift`). Pull our
codepoints from there rather than guessing (wrong ones render tofu).

### 2.2 Embed generated images into `ai.svg` — ✅ shipped (see Done above)
A region may carry `images` (base64 art the caller supplies). **Design settled by reading the
app:** the renderer resolves `<image href>` only as a **file path relative to the page folder**
(`MediaCache`), with **no data-URI support** — so the server writes art to a page-owned
`media/ai/` folder and references it by href, keeping ai.svg tiny and avoiding base64 iCloud
bloat. Data-URIs were the wrong call. The one app change required: give the AI layer a real
`imageProvider` (today it's `{ _ in nil }`) — see the contract in the plan / app thread.

### 2.3 Time-aware schedule input — ✅ shipped (see Done above)
Schedule lines take `time: "HH:MM"`; snapped to the nearest ruled row via per-region
`startHour` + `rowsPerHour`. The "read hour labels from the template" alternative was ruled
out — no template carries them — so explicit anchoring is the design, not a parser change.

### 2.4 Search / filter pages — ✅ shipped (see Done above)
Metadata filters live on `list_pages`. Remaining stretch: **full-text / handwriting search**
over OCR'd `ink.svg` — a separate data source (recognized ink text, likely an app-side or
separate-pipeline concern), not manifest metadata. The `PageFilter` surface is shaped to take
a `textContains`/`query` param alongside the metadata filters when that pipeline exists.

**Open decision (someday):** where does the recognized handwriting text live so it's
searchable? Candidate idea — store it *invisibly on the AI layer* (the searchable-PDF
pattern). Tension: ai.svg is rewritten/cleared independently of the ink, so OCR text there
gets clobbered, and OCR realistically runs app-side (Apple's recognizer + live strokes), not
in this filesystem-only server. Leading alternative: app does the OCR and writes the text into
the manifest (or a sidecar) on the ink's lifecycle; server just reads it for `textContains`.
Decide before building 2.4's full-text stretch.

### 2.5 Auto text-wrap — ✅ shipped (see Done above)
Opt-in `wrap: true` per line breaks long text to the region width (reusing the Phase-1
overflow estimator), stacking continuations below the baseline without consuming the next
ruled row. Vertical-fit warning replaces the width-overflow warning when wrapping.

---

## Phase 3 — parked / app-dependent

- **Bulk authoring** across many pages in one call — orchestration the caller already does
  via N calls; revisit if it's a real pain point.
- **MCPB bundling / distribution** (`README.md`) — only if this leaves single-user local use.
- **`ai.svg` history / undo** — tension with the "only write `ai.svg` + manifest ai block"
  invariant; the app may own undo. `merge` + `clear_underlay` already cover most "oops" cases.
- **New template types / regions** — owned by the app; the server follows once templates ship.
- **Calendar-chapter-aware `create_page`** — the app's `FORMAT.md` defines chapter-level
  calendar config (`year`, `month`, `defaultTemplate`, `weekdayTemplates`, `deletedDays`) that
  the server doesn't read today. It doesn't affect the `ai.svg` write contract, so nothing's
  broken — but a future `create_page` could honor it (pick the right weekday template, respect
  `deletedDays`, default the template from the chapter) instead of just cloning a sibling /
  taking an explicit `template`. Revisit when auto-creating dated pages into a calendar chapter.
- **Live `Shared/` watcher** — app-side; out of server scope.
- **On-device underlay author (Apple Intelligence)** — already **shipped** in the app as an
  additive, opt-in sibling that coexists with and defers to this MCP (not a replacement). How
  it relates + the visual-parity handoff: [`ON-DEVICE-UNDERLAY.md`](ON-DEVICE-UNDERLAY.md).

---

## App-side unknowns to confirm before Phase 2

1. ~~Does the app honor `<image>` + data-URIs?~~ Resolved (2.2): the renderer takes
   **page-relative file paths only, no data-URIs** — so we write to `media/ai/` and href it.
   The one app change needed: give the AI layer a real `imageProvider` (currently `{ _ in nil }`).
2. Does the app ship a Phosphor font cut and honor `font-weight`? **font-weight: confirmed**
   (Mulish/Newsreader are variable fonts the renderer weights). Phosphor cut: bundled
   (`Phosphor.ttf`) — but no decoration feature is built, so this is informational.
3. ~~How is schedule hour-anchoring encoded?~~ Resolved (2.3): no template carries hour
   labels, so the caller passes `startHour` + `rowsPerHour`. No app dependency.

## Verification

`npm run smoke` (self-seeding e2e, 118 checks) · `npm run call -- <tool> [args]` (drive a
tool in a fresh process) · `npx tsc --noEmit`. Keep the smoke test deriving coordinates and
region names from parsed geometry — the fixtures keep changing.
