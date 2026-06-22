# onion-planner-mcp — Roadmap

This server is the **placement/rendering engine**, not the orchestrator. It is
filesystem-only, no network. The data (calendar events, weather, email-derived to-dos,
generated art) comes from *other* MCPs that an orchestrator (e.g. Claude CoWork) gathers;
our job is to render it beautifully and safely into `ai.svg`. The north-star scenario:

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

- Only ever write `ai.svg` + the manifest's `layers.ai` block (+ `modified`); on create, the
  new page's own files + chapter `.folder.json`. Never touch ink/stickers/template/Private.
- All writes through `resolvePageRel` (Shared/ containment) + `atomicWrite`.
- No network. Re-read `manifest.size` per page; geometry comes from each page's template.
- Closed font set (`Mulish, Newsreader, IBM Plex Mono, Caveat, Fredoka, Phosphor`).

---

## Done (this pass)

- **Doc/code gold sync** — `docs/MCP-INTEGRATION.md` now states the shipped `#9C7C1A`.
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

---

## Phase 2 — the delight layer (richer content, some app-side unknowns)

### 2.1 Phosphor icon glyphs (weather, decoration) · Effort M · Feasibility MEDIUM
The "umbrella in the corner." `Phosphor` is in `FONT_ENUM` but otherwise unused. Add an
`icon` on a line/element mapping a friendly name (`umbrella`, `sun`, `cloud`, `check`,
`star`) to its Phosphor codepoint. **Needs** the codepoint map and confirmation the app
ships the Phosphor cut; drawn-shape fallback otherwise. (Markers already prove the
drawn-shape path.)

### 2.2 Embed generated images into `ai.svg` · Effort M · Feasibility MEDIUM
The "motivational sticker" placed into the layer we own: emit `<image href="data:…">` with
corner/x-y placement. The `Stickers/` catalogue now ships real PNG marks (`star.png`,
`note.png`, …) — those are concrete assets to embed. **Needs** confirmation the app renderer
honors `<image>`/data-URIs; data-URIs bloat `ai.svg` (every byte syncs over iCloud) — cap size.

### 2.3 Time-aware schedule input · Effort M · Feasibility MEDIUM
Pass `time: "HH:MM"` on schedule lines; map to the nearest ruled row, so the orchestrator
needn't compute row indices. **Open dependency:** `parseRegions` reads `<line>` positions but
not hour *labels*, so the server doesn't know "row 0 = 6am." Resolve with a `startHour` +
`rowsPerHour` param, or extend the parser to read hour labels. Decide before building.

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

### 2.5 Auto text-wrap · Effort M · Feasibility MEDIUM
Build on the overflow estimator: wrap long lines to region width instead of overflowing.
Sequence after the estimator (already shipped in Phase 1).

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

---

## App-side unknowns to confirm before Phase 2

1. Does the app's compositor honor `<image>` + data-URIs in `ai.svg`? (gates 2.2)
2. Does the app ship a Phosphor font cut and honor `font-weight`? (gates 2.1)
3. How is schedule hour-anchoring encoded — parseable labels, or do we require a `startHour`? (gates 2.3)

## Verification

`npm run smoke` (self-seeding e2e, 60 checks) · `npm run call -- <tool> [args]` (drive a
tool in a fresh process) · `npx tsc --noEmit`. Keep the smoke test deriving coordinates and
region names from parsed geometry — the fixtures keep changing.
