# onion-planner-mcp — Changelog

Shipped history, newest first — moved out of [`ROADMAP.md`](ROADMAP.md) on 2026-07-05 so the
roadmap holds only planned feature development (bugs/polish live on the
[issue tracker](https://github.com/bsitkoff/onion_planner_mcp/issues)). Entries below the
2026-07-05 line are the roadmap's old "shipped" sections, moved verbatim.

---

## Image-sizing + raw-svg guardrails — 2026-07-05

The 2026-07-05 morning CoWork run failed in ways a human had to catch by eye; this pass turns
each of those into a write-time signal (issues #1–#6, closed by `135d2e5`):

- **`image_aspect_mismatch`** (warning) — a caller-supplied `width`+`height` off the source
  aspect renders visibly stretched (the app scales `<image>` to the exact box); the message
  gives the aspect-true height. The stretched-date-sticker failure, caught at write time.
- **`image_small_for_region`** (info) — a center/default-placed image floating tiny in a big
  box (the unusable ~90px habits tracker); deliberate corner/x-y accents stay quiet.
- **`image_dimensions_large`** (info) — the docs' ≤1536px guideline is now actually checked.
- **`raw_svg_large`** (warning) — a >256KB raw `svg` doc, almost always embedded art that
  should be `images[].path`.
- `fetch_image` no longer leaves its download behind when `removeBackground` fails.
- Schema + `AUTHORING.md` now state the washi preference outright: an event with a real
  start/end gets `endTime`/`durationMin` (duration block); a bare `time` line is for
  point-in-time notes. And: omit image `height` to aspect-fill.
- **Sub-hour events no longer vanish** (#17): a `time`+`endTime` span that snaps to zero rows
  (a 20-min meeting on a 1-row-per-hour grid) used to drop the whole line — block *and* text.
  It now falls back to a plain time-anchored line; `washi_block_zero_duration` downgraded to
  info ("drawn as a plain time line instead"). Found by dryRun against the live 2026-07-06
  page while switching the skills to washi blocks.

Smoke 261 passed / 0 failed (+8) · tsc clean.

---

## Image-authoring hardening — 2026-07-03

A live end-to-end run — generate art with a remote image MCP (`gemini-image`), decode to a
local PNG, place it into a real daily page (`Shared/2026-07/2026-07-03`), render on the iPad —
proved the **pipeline works** (generate → decode → `images[].path` → `media/ai/` href → composited
on device; a clean die-cut sticker landed correctly). But it surfaced that **getting *clean* art
into the underlay was the fragile part, and the fragility fell on the *agent***: the author had to
*know* model quirks (Gemini's `transparent_bg` paints an opaque **checkerboard**, not alpha —
confirmed: corner pixels `srgba(97,97,97,1)`, alpha mean 250/255) and hand-roll image surgery
(rembg cleanly cut a solid subject but **erased** a diffuse floral spray; a magenta chroma-key
preserved it where rembg failed). This pass moved that burden into the server + docs, and fixed
the wrap-correctness bugs the same test exposed. All items below shipped.

### Correctness bugs the test exposed (`svg.ts`)
- **E. Box-region wrap cursor now reserves space for wrapped continuations.** `flowBaselines`
  previously advanced its running cursor by a flat line-height regardless of how many segments a
  line wrapped into, so the next line's baseline landed on top of the previous line's own
  continuations. `flowLineAdvance` mirrors the render loop's own wrap predicate/width math (font,
  marker/icon advance, `wrapText`) to reserve `Math.max(lineH, segments.length * subPitch)`
  instead — the common non-wrapping case keeps today's rhythm; a wrapping line reserves real height.
- **F. Overflow warnings now catch a box-region wrap collision, not just ruled-row/box-bottom
  overflow.** The Phase-2.5 `wrapped_text_vertical_overflow` check gained a box-region-only branch
  comparing a wrapped line's reach against the *next* line's own reserved flow baseline
  (`flowBases[i+1]`) — a defense-in-depth backstop once E's cursor fix is in place, and the only
  guard for an explicit-`y` next line placed too close to a wrapping flow line above it.
- **G. `ainotes`/`quote`/`affirmation` default size dropped 26px → 16px** (`REGION_DEFAULTS`,
  `svg.ts`) — the old default all but guaranteed overflow for a multi-sentence AI-voice note.

### The server absorbs the image knockout (`page.ts` / `index.ts` / new `src/png.ts`)
- **A. `images[].knockout` — background removal in the placement path.** A region's `images[]`
  (base64 `data` or local `path`) can now carry `knockout: "subject" | "chroma" | "none"`
  (default `"none"`), resolved in `page.ts:resolveImages` before the `media/ai/` write:
  - `"subject"` — a saliency cutout via the same rembg pipeline `fetch_image`'s `removeBackground`
    already uses (same Python-API-direct invocation, same clear-error-on-missing-dep behaviour) —
    best for a clean single subject.
  - `"chroma"` + `chromaColor` (+ `tolerance`, default 30) — keys a solid uniform background to
    transparent. A pure pixel op needing no new dependency: a new minimal PNG codec (`src/png.ts`)
    hand-rolls chunk framing/CRC32/scanline (un)filtering on top of Node's built-in `zlib` for the
    DEFLATE stream, scoped to 8-bit RGB/RGBA non-interlaced PNGs (sufficient for AI-generated art;
    other PNG shapes reject with a clear, actionable error rather than mis-decoding).
  A knocked-out image's resolved format is always `"png"` regardless of any declared `format`
  (chroma needs alpha; rembg's own output is already PNG).
- **D. base64→path decode pattern — documented, not built.** Scoped to `docs/AUTHORING.md` only
  (extends the existing "sourcing recipe"): decode a remote image MCP's base64 response to a local
  temp file and pass `images[].path`, rather than inlining `data`, for overnight/automated writes.
  `fetch_image` stays URL-only — building a generalized base64/file-input bridge for it was lower
  leverage than the correctness fixes and knockout feature in this same pass.

### Teaching the agent to prompt *any* image model (`docs/AUTHORING.md`)
- **B. Model-agnostic prompting recipe**, added to `docs/AUTHORING.md`: don't rely on "transparent
  background" (many models bake an opaque checkerboard into the actual pixels); clean single
  subject → generate normally → `knockout:"subject"`; diffuse/soft art (sprays, washes, foliage) →
  generate on a solid uniform colour absent from the subject (e.g. magenta) → `knockout:"chroma"` +
  matching `chromaColor`; soft-edged vignette → generate on the page's own `paperColor` (C) and
  place it opaque, no knockout. Format constraints (PNG/JPEG, ≤2MB, ≤~1536px) stated once.
- **C. `read_page` surfaces `template.paperColor`.** Investigating this against the real
  `../onionskin` template fixtures found that **no shipped template draws its own full-bleed
  background rect** — the page's paper colour is the app's own fixed canvas constant. `paperColorOf`
  (`template.ts`) still scans for a template-drawn background rect first (forward-compatible with a
  future template that has one), but falls back to a new `PAPER_COLOR = "#FFFEFB"` constant (the
  app's `--paper-0` / `Palette.swift paper0`) rather than `null` — the same shared-constant pattern
  as `GOLD` — so the field is actually usable today instead of shipping as a no-op.

### Label / grid ergonomics the test surfaced
- **H. `read_page` regions report `labelFilled`.** `template.hasLabels`/`Region.labelSlot` only
  ever reported the *template's* geometry, not whether a region's printed label slot was actually
  filled — a page of blank pills, wrongly assumed styled. `read_page` now cross-references each
  region's `labelSlot` against the current `ai.svg`: it extracts that region's own group (via
  `extractRegionGroups`, now exported from `svg.ts` — the same depth-aware scanner the
  2026-07-02 merge fix introduced) and checks for the label banner's `letter-spacing="0.1em"`
  marker (unique to that render path). `RegionRead.labelFilled` is `true`/`false`/`null` (no slot
  to begin with) — so an agent no longer has to assume a printed slot means content exists.
- **I. Optional server-stamped hour labels (`showHours`).** A region with ruled rows and a
  resolvable `startHour` can now request compact hour labels ("7a"/"12p") stamped at each
  whole-hour row — for an agenda-style grid that prints no hour numbers of its own. A no-op with
  an info-level `time_unruled_region`/`time_missing_start_hour` warning (reusing the existing
  codes, not a content-dropping severity) when there's nothing to anchor to.

**Not an app bug.** The on-device renderer faithfully drew the *opaque* checkerboard pixels our PNG
contained — the checkerboard was baked into our generated image, not a render fault (the clean sticker
confirms alpha is honoured). No app-side items came out of this test.

Smoke test: +25 (250 total, 0 failed) · `npx tsc --noEmit` clean · chroma knockout additionally
verified against a real fixture library over the actual filesystem/CLI path (not just the smoke
suite's synthetic fixtures), decoding the written `media/ai/*.png` back to confirm per-pixel alpha.


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

- **2.6 — washi-tape schedule blocks.** A schedule line carrying `time` + (`endTime` or
  `durationMin`) now draws a soft, rounded, translucent-tinted block spanning start→end rows
  (`washiBlockFragment` in `svg.ts`) instead of a single baseline — the "washi tape over the
  hours" look. Tint defaults to the chapter's `theme.accent` (palette-derived, per the roadmap's
  original framing), overridable per-block via `blockFill`/`blockOpacity`. `endTime`/
  `durationMin` are mutually exclusive (`.refine()` in `index.ts`, mirroring `marker`/`icon`);
  `endTime` wins if a caller somehow sends both to the compose layer directly. Three new warning
  codes: `washi_block_clamped` (span partly outside the grid — pinned to fit, still drawn),
  `washi_block_zero_duration` (end ≤ start — not drawn), `washi_block_missing_start` (`endTime`/
  `durationMin` without a `time` start — ignored); reuses `time_unruled_region`/
  `time_missing_start_hour` for the shared no-grid conditions. Renderer support (`rx` corner
  radius, `fill-opacity` translucency) confirmed directly against
  `../onionskin/Onionskin/SVG/SVGCanvasRenderer.swift` — no workaround needed. Unparked once the
  app's region/template contract (E0) settled with no further churn expected.
- **Calendar-chapter-aware `create_page` — remainder (`weekdayTemplates` + `deletedDays`).**
  Template precedence now reads the chapter's `.folder.json → weekdayTemplates`
  (`weekdayTemplateFor` in `page.ts`) between the explicit `template` arg and the chapter's
  `defaultTemplate` — an MCP-created Saturday/Sunday page picks up the declared weekend
  template. A page named in `.folder.json → deletedDays` is refused by default
  (`checkNotDeleted` in `page.ts`) — a new `clearDeleted: true` create-page option opts into
  clearing the tombstone and recreating the day, rather than silently resurrecting a day the
  user deliberately deleted. Unblocked once the app's own materializer started actually
  writing/reading both keys (previously parked pending a real calendar-chapter-creation flow).
- **2.8 — read `settings.json → underlayVoice`.** `readUnderlayVoice` (`library.ts`) reads the
  library root's `settings.json → underlayVoice` defensively (absent/garbled → `null`, never
  throws), mirroring the existing `.folder.json → theme` pattern. Surfaced on both `get_library`
  and `read_page` (the latter so a caller filling one page's `ainotes` doesn't need a prior
  `get_library` round-trip just for the voice hint). Read-only — the server never writes
  `settings.json`.
- **2.7 — surface printed label slots.** `parseRegions` (`template.ts`) now disambiguates a
  region's own box `<rect>` from a nested `<rect data-region="label-*">` label slot by attribute
  rather than assuming a fixed child order (today's shipped templates happen to put the label
  rect last, but that's a convention, not a guarantee `parseRegions` should lean on). The new
  `Region.labelSlot` field surfaces the slot's region-local box; `write_underlay`'s region-title
  `label` banner (`svg.ts`) now aims at that geometry when present — banner style fills the slot's box exactly,
  underline style anchors off its origin — falling back to the old fixed-margin placement
  (`x=24, y=-12`) for templates without a slot.
- **2.1 — Phosphor icon glyphs (plumbing only, scoped-partial).** A line may carry `icon`
  (mutually exclusive with `marker`), font-rendering a Phosphor glyph via a new
  `PHOSPHOR_CODEPOINTS` map (`svg.ts`) and `iconFragment` helper (parallel to `markerFragment`).
  **Deliberately incomplete:** the map only includes the 22 names confirmed in the app's
  `Phosphor.swift` (house, gear, bookOpen, sticker, smiley, etc.) — an unrecognized name is
  rejected at the schema. The actually-useful weather/decoration set the roadmap wanted
  (umbrella, sun, cloud, check, star) is **not yet published by the app** and stays deferred;
  wiring those up is a follow-on once `Phosphor.swift` adds them — don't guess codepoints.

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

## App-side unknowns — resolution record

1. ~~Does the app honor `<image>` + data-URIs?~~ Resolved (2.2): the renderer takes
   **page-relative file paths only, no data-URIs** — so we write to `media/ai/` and href it.
   The one app change needed: give the AI layer a real `imageProvider` (currently `{ _ in nil }`).
2. Does the app ship a Phosphor font cut and honor `font-weight`? **font-weight: confirmed**
   (Mulish/Newsreader are variable fonts the renderer weights). Phosphor cut: bundled
   (`Phosphor.ttf`) — but no decoration feature is built, so this is informational.
3. ~~How is schedule hour-anchoring encoded?~~ Resolved: the `schedule`/`agenda` regions now
   carry `data-start-hour`/`data-rows-per-hour` in the template; the server parses them and
   anchors `time` to that grid (a per-call `startHour` still overrides). No printed hour labels.
