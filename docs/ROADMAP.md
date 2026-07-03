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
  `.folder.json`; via `set_chapter_theme`, the chapter `.folder.json → theme` block. Never
  touch ink/stickers/template, the rest of `media/`, or Private.
- All writes through `resolvePageRel` (Shared/ containment) + `atomicWrite`.
- No app/network API for planner state. Re-read `manifest.size` per page; geometry comes from
  each page's template.
- Closed font set (`Mulish, Newsreader, IBM Plex Mono, Caveat, Fredoka, Phosphor`).

---

## App-contract sync — 2026-07-02

The app's 2026-07-02 evening audit (its `design/DECISIONS.md` C1–C7 / #42–#48) pinned the
contract this server writes against. What that settles here:

- **The template/region contract is locked (app E0 closed).** Region attributes
  (`data-region` / `data-fill` / `data-intent` / `data-list` / `data-cols` / `data-rows` /
  `data-start-hour` / `data-rows-per-hour`), the 1024×1366 authoring space, and the theme keys
  are now pinned in the app's `FORMAT.md §2/§4` + `TEMPLATES.md §3`. Our `parseRegions` /
  `deriveFill` already consume all of it — no code change, just a stable target.
- **Coordinate space (app C1):** pages are authored at 1024×1366 AND `manifest.size` is
  authoritative per page — writers MUST read it. Already an invariant here (see above);
  now it's the app's written rule too.
- **`theme.accent` is registered (app C4).** The additive `accent` hex this server writes via
  `set_chapter_theme` is now an official optional `FORMAT.md §4` theme key (underlay body
  colour, AA-floored on cream, distinct from `chromeAccent`). **Resolves item 2 of
  `app-bugs-2026-06-30.md`.**
- **Renderer verifications (app C8, answers to item 3 of `app-bugs-2026-06-30.md`):** the app
  confirmed its renderer does **NOT clip** a region-overflowing `<image>`
  (`SVGCanvasRenderer.swift:68-73` draws anywhere) — so our `image_off_page` /
  `image_overlaps_region` warnings are the only guardrail; keep them prominent. The stacked
  wrapped-`<text>` baseline check is still owed by the app.
- **Live-page migration is app-side work (app C5 → its D21):** empty/future day-pages get
  auto-restamped to the redesigned templates; ink-bearing pages migrate via a one-tap opt-in
  (the app never re-flows ink). Nothing for this server to do besides keep the legacy region
  fallbacks until it lands.
- **Track app C7 (Shared/-gate retirement):** when the app ships its E2 encryption lock and
  retires the `Shared/`-only visibility gate, **`resolvePageRel` (`src/paths.ts`) must change
  in the same coordinated release** (the app decision names this file). Nothing to do now —
  code against the shipped `Shared/`-gate — but this is a standing cross-repo coupling.
- **`ink.svg` precision (app A5.14):** the app tightened ink coordinates to 2 decimals partly
  for our `read_ink`. Server-side we now strip `data-stroke` streams from `read_ink` by
  default (below); if payloads are still heavy, the app's lever is resample density.

### Bug/polish pass (2026-07-02, same audit)

- **`merge` no longer corrupts `ai.svg` when a region nests `<g>`.** The old regex extraction
  stopped at the first `</g>`, so a raw per-region `svg` fragment containing a nested group
  produced an unclosed `<g>` after merge — Apple's XMLParser then rejected the document and
  the gold layer silently vanished on device. `extractRegionGroups` is now depth-aware
  (`svg.ts`); merging over a prior raw-`svg` document (no region groups to preserve) warns
  `merge_discarded_raw_svg` instead of silently dropping it.
- **`create_page` is calendar-aware and deterministic.** Siblings are sorted; a month
  chapter's monthly-overview page is never picked as the template for a new day page; the
  chapter's `.folder.json → defaultTemplate` fills in when the caller passes no `template`.
  Also: a slashed `name` fails validation (it used to corrupt `.folder.json → order`), a
  brand-new chapter's title is the bare name (was the raw `"Shared/…"` arg), and a corrupt
  `.folder.json` downgrades the order-append to a warning on an already-created page.
- **`list_pages` survives bad pages.** One corrupt `manifest.json` used to fail the whole
  listing; it's now skipped with a `notes` entry naming the page. iCloud-evicted pages
  (`.manifest.json.icloud` placeholders) surface a pending-download note instead of silently
  vanishing.
- **Contract drift closed:** the raw-svg allowlist matches the app renderer
  (`ellipse`/`polyline`/`polygon` added — they were falsely warned); `weekdays` derives as
  `shared` (the monthly templates print Sun–Sat themselves; `ai` invited double-printing);
  `marker: "checkbox"` on a template that prints its own boxes (`todo-*`, cozy/colorful
  dailies) warns `printed_checkboxes` (the locked SHARED-VISUAL-SPEC §2 rule, previously
  unenforced); `template.styled` now derives from banners/stickers only (every shipped
  template prints a microcap, so the old any-`<text>` heuristic marked ALL 27 styled and the
  "bare → go full" guidance was unreachable); the named presets' text/serif/accent pass
  through the same cream-legibility floor as the adaptive palette (bright's `#E86A92` day
  numbers were ~2.9:1 on cream, under AA).
- **Hardening/polish:** `escapeXml` escapes quotes and all caller-supplied colours are
  hex-validated at the schema (a stray `"` could previously emit malformed XML — an invisible
  AI layer); `atomicWrite` sweeps stale `*.tmp-*` droppings (crash leftovers used to sync to
  the iPad); `composeCalendar` warns `calendar_days_outside_grid` instead of silently dropping
  days beyond the printed grid; same-name/different-bytes images in one write de-collide with
  a suffix; `fetch_image` never overwrites an earlier fetch and its description matches the
  real temp path; `read_ink` strips per-stroke `data-stroke` streams by default
  (`includeStrokeData` opts into the verbatim file); dead `baselineFor` removed; the
  `resolveTheme` docblock matches `isAdaptive` (only `harmony`/`varietyDial` select the
  adaptive palette).

---

## Done (previous passes)

- **Fixes from the 2026-06-30 CoWork struggle** — the nightly run put a habit sticker over the
  schedule and a surprise sticker over the date, to-dos came out gold not lavender, and long
  to-do text ran off the panel. Three server changes address the *placement/theming* side (the
  root cause — the user's live June pages predate the `ainotes` redesign, so a sticker has no
  AI-owned home — is filed as an app bug + a scoped page migration, see `docs/app-bugs-2026-06-30.md`):
  - **Image placement warnings.** `composeAiSvg` now computes each image's *absolute* bbox and
    warns when it leaves the page (`image_off_page` — catches a negative-`y` sticker pushed into
    the date/chrome band) or overlaps *another* region's box (`image_overlaps_region`, naming the
    region + its `fill` — catches habit-sticker-over-schedule). The prior check only compared an
    image to its own region box. Warnings only — never blocks the write. `bboxesOverlap` in `svg.ts`.
  - **Default-on wrap** for flow-placed body text: a line with no `row`/`time`/`y` in a
    width-bounded region now wraps to the region width by default (was opt-in `wrap: true`), so a
    long to-do/note no longer overflows the panel. Explicit `wrap: false` opts out; row/time
    lines keep single-segment placement. (Generalises the Phase-2.5 "default-on for ainotes" note.)
  - **`set_chapter_theme` tool (10th tool)** — writes a chapter's `.folder.json → theme` block so
    a mood is set once and every page inherits it (`write_underlay` already reads it as the
    default). Adds an explicit **`accent`** hex key (additive to `FORMAT.md §4`) that tints body
    text / markers / banners — the way to make e.g. lavender to-dos a chapter default, since no
    named preset is lavender and `harmony` only derives from the (neutral) template.
    `deriveAccentPalette` in `color.ts` (same cream-legibility floor as `derivePalette`);
    `writeChapterTheme` in `page.ts`. Invariant extended: the server may also write the chapter
    theme block (passed keys only; order + other fields preserved).

- **Match the 2026-06 template/region redesign** — brought the server's vocabulary and grid
  handling in line with the app's committed redesign (`../onionskin` `seed.version
  12-template-redesign`):
  - **Self-describing schedule grid.** `parseRegions` now reads `data-start-hour` /
    `data-rows-per-hour` (+ the advisory `data-list` bucket) onto `Region`
    (`startHour`/`rowsPerHour`/`list`), surfaced by `read_page`; `composeAiSvg` anchors a
    clock `time` to the region's own grid when the caller omits `startHour` (a per-call value
    still overrides). So callers no longer hard-code the hour.
  - **New region vocabulary.** `FILL_BY_NAME`/`REGION_DEFAULTS` updated — `ainotes` (`ai`,
    serif AI-voice home), `focus` (`shared`, was `goals`); `notes` is `ink` everywhere;
    `last`→`ai`; `morning`/`afternoon`/`evening`/`photos`→`shared`. Retired names
    (`quote`/`affirmation`/`priorities`/`goals`/`summary`) kept as **legacy fallbacks** so
    older un-tagged live pages still derive sanely. The serif register is `ainotes`. The
    to-do "priority" star is a **typographic ★** (no marker primitive).
  - Docs (`README`, `CLAUDE.md`, `AUTHORING`, `MCP-INTEGRATION`, `SHARED-VISUAL-SPEC`) and the
    self-seeding smoke test retargeted to the new vocabulary (153 checks).
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
  - `REGION_DEFAULTS` updated for that era's renames (`affirmation → quote`, `header`,
    `goals`) — names since retired to legacy fallbacks by the 2026-06 redesign (above).
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
  default-on for the free-text box region `ainotes`, where there's no row to disturb.)
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

### 2.6 Washi-tape schedule blocks (drawn, not a sticker) · Effort M · Feasibility HIGH · **PARKED**
**Park until the app is stable** — Claude Code is still implementing the template redesign;
do not start this while the app is in flux. Roadmap-only for now.

Today the schedule shows time via a **sticker** (the user's current MCP approach). The goal is
to draw **washi-tape-style time-blocks** directly in `ai.svg`: a soft, rounded, semi-opaque
filled box spanning an event's start→end on the grid, with the label inside — the paper-planner
"washi over the hours" look, instead of text-on-a-line or a sticker glyph. This is exactly what
the **redesigned templates already ask for**: `schedule`/`agenda` carry
`data-start-hour`/`data-rows-per-hour` and an intent of *"AI places **bars by clock**, not text
on lines"* (`../onionskin` Templates, 2026-06 redesign). The grid is already self-describing —
the server now parses those attributes and anchors `time` to them (see Done) — so what's left is
the *drawing*, which is why this stays parked separately from the contract match.

Shape of the work (all server-side, renderer-safe):
- **A duration primitive.** A schedule line needs an end as well as a start — e.g. `time` +
  `endTime` (or `durationMin`) → a block from start-row to end-row, vs. today's single-baseline
  `time` snap (`rowForTime`, `svg.ts`). Precedence and the existing `time`-only behaviour stay.
  The start/end → row math reuses the parsed `startHour`/`rowsPerHour` already on the region.
- **Washi styling within the renderer subset.** A rounded `<rect>` (`rx`) + low-opacity solid
  fill + the label `<text>`; **solid fills only — no gradients** (renderer limitation), so a
  washi "tint" is one translucent solid, palette-derived (`harmony`) or per-block `fill`.
  Confirm the renderer honours `rx`/`fill-opacity`; drawn-shape fallback (plain rect) otherwise.
- **Overflow/fit warnings** reuse the existing machinery (block past the region box, zero/negative
  duration, a `time`/`endTime` outside the grid).

Out of scope here: a `star` *marker primitive* — the contract uses a typographic ★ in the to-do
text, which needs no new code.

### 2.7 Surface the templates' printed label slots · Effort M · Feasibility HIGH
The 2026-06 catalogue templates print a dashed **label slot** *inside* each region — a
`<rect data-region="label-…" data-fill="shared" data-intent="optional section label…">`
nested in the region's `<g>` (e.g. `daily-minimal`'s slot at region-local `(0,-54) 118×34`).
`parseRegions` only scans top-level `<g id="region-*">`, so these sub-regions (and their
fills/intents) are invisible to `read_page` — and the server's own `label` banner hard-codes
`x=24, baseline y=-12` (`svg.ts`), so its pill half-overlaps the printed dashed slot instead
of filling it: visible double decoration on every shipped template. Work: parse label
sub-regions onto `Region` (or a `labelSlot` field), aim the `label` banner at the printed
slot's geometry when one exists, and keep today's margin placement as the fallback for
templates without slots.

### 2.8 Read `settings.json → underlayVoice` · Effort S · Feasibility HIGH
The app's `FORMAT.md §4` publishes a root-level `settings.json` with
`underlayVoice { name, tone, notes }` (`tone ∈ calm·warm·upbeat·dry·none`; `none` = no
written note) and explicitly invites an external MCP to read it to personalize the `ainotes`
voice. No code here touches it, so an orchestrator can't honour the user's chosen tone/name
through the tool surface. Work: read it defensively (absent/garbled → null) and surface it on
`get_library` (and/or `read_page`) so the note-writing prompt can use it. Read-only — the
server never writes `settings.json`.

---

## Phase 3 — parked / app-dependent

- **Bulk authoring** across many pages in one call — orchestration the caller already does
  via N calls; revisit if it's a real pain point.
- **MCPB bundling / distribution** (`README.md`) — only if this leaves single-user local use.
- **`ai.svg` history / undo** — tension with the "only write `ai.svg` + manifest ai block"
  invariant; the app may own undo. `merge` + `clear_underlay` already cover most "oops" cases.
- **New template types / regions** — owned by the app; the server follows once templates ship.
- **Calendar-chapter-aware `create_page` — remainder** — `defaultTemplate` is now honoured
  and the monthly-overview page is never cloned for a day page (2026-07-02 pass, above). Still
  unread from the chapter's `.folder.json`: **`weekdayTemplates`** (an MCP-created Saturday
  page should get the declared weekend template) and **`deletedDays`** (recreating a
  tombstoned day leaves a contradictory state — the server should refuse, or clear the
  tombstone). Revisit when auto-creating dated pages into a calendar chapter is a real flow;
  note the app's materializer usually creates day pages first anyway (create-on-write is a
  safety net beyond its rolling window).
- **`resolvePageRel` change when the app retires the Shared/ gate (app C7)** — see the
  2026-07-02 sync section: coordinated release, nothing to do until the app's E2 lock ships.
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
3. ~~How is schedule hour-anchoring encoded?~~ Resolved: the `schedule`/`agenda` regions now
   carry `data-start-hour`/`data-rows-per-hour` in the template; the server parses them and
   anchors `time` to that grid (a per-call `startHour` still overrides). No printed hour labels.

## Verification

`npm run smoke` (self-seeding e2e; the run prints its own pass/fail count — don't pin the
number here, it grows every pass) · `npm run call -- <tool> [args]` (drive a tool in a fresh
process) · `npx tsc --noEmit`. Keep the smoke test deriving coordinates and region names from
parsed geometry — the fixtures keep changing.
