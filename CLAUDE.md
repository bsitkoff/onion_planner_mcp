# CLAUDE.md

Guidance for working on this repo. See `README.md` for usage, `docs/ROADMAP.md` for planned
features (each linking its GitHub issue — bugs/polish live on the issue tracker), and
`docs/CHANGELOG.md` for what's shipped. **The file-format contract lives in the Onionskin app repo at
`design/FORMAT.md` — the single source of truth;** `docs/MCP-INTEGRATION.md` is the standalone
integration quickstart
that points back to it, and `docs/AUTHORING.md` covers how to fill pages.

## What this is

A **local stdio** MCP server (TypeScript, run via `tsx`) that writes the AI `ai.svg`
underlay into [Onionskin](https://onionskin.sitkoff.net) planner pages. Integration is **filesystem-only** —
it reads/writes plain SVG + JSON in the app's iCloud container. There is no network API.

Built on the official `@modelcontextprotocol/sdk`: high-level `McpServer` + `server.tool()`,
`zod` schemas. Onionskin itself is an **iPad/iOS app**; this server runs on the **Mac** against
the iCloud Drive mirror of the app's container (synced via the same Apple ID; Mac writes sync
back up to the iPad). It runs locally because reaching that mirror needs local macOS filesystem
access.

## How to document (keep docs from sprawling)

**Facts live in one place; everywhere else links.** The file-format contract — layers, regions,
the AI underlay, `manifest.json`, the on-device visual parity — is owned by
the Onionskin app repo's `design/FORMAT.md`; link to it rather than restating
(duplicated facts drift). Owners in this repo: `README.md` (usage), this file
(architecture · invariants · gotchas), `docs/AUTHORING.md` (authoring underlays + themes),
`docs/SHARED-VISUAL-SPEC.md` (the detailed visual measurements behind FORMAT.md's summary),
`docs/ON-DEVICE-UNDERLAY.md` (coexistence with the app's on-device composer). Change a shared fact
in its owner once; don't copy it across files.

## Commands

```bash
npm start          # run the server over stdio
npm run call -- <tool> [args]   # dev CLI: drive any tool in a FRESH process (see below)
npm run smoke      # copy fixtures → /tmp/onionskin-test and run the e2e test
npx tsc --noEmit   # typecheck only (no output)
npm run build      # tsc → emits to dist/ (gitignored); the server runs via tsx, so this is rarely needed
```

### Testing your own edits (the dev loop)

The **registered** `onionskin` MCP server is a long-lived `tsx` process — it caches the
code from session start and `tsx` does **not** hot-reload, so your edits won't show up
through the in-conversation `mcp__onionskin__*` tools until that server is reconnected
(`/mcp`) or Claude Code restarts. Don't test edits through it.

Instead use **`npm run call`** (`test/cli.ts`): it dispatches to the same underlying
functions the server wraps (`readPage`, `writeUnderlay`, `composeAiSvg`, the path guard),
in a brand-new process every invocation — so it always runs your latest code. It honours
`ONIONSKIN_CONTAINER`, defaulting to the **live** iCloud path, so you can test against
fixtures or live:

```bash
npm run call -- read_page Shared/Daily/2026-02-06
npm run call -- write_underlay Shared/Daily/_mcp-test '{"regions":[...]}'
ONIONSKIN_CONTAINER=/tmp/onionskin-test npm run call -- list_pages
```

A Bash-spawned process **inherits the host's Full Disk Access**, so live reads/writes work
from the CLI without reconnecting the registered server. Loop: edit → `npm run call` (or
`npm run smoke` for fixtures) → verify → only reconnect the registered server when you need
to exercise the MCP transport itself.

## Architecture

| File | Role |
|---|---|
| `src/index.ts` | MCP server + the 10 tools (zod schemas, annotations, error handling). |
| `src/paths.ts` | Container resolution (`ONIONSKIN_CONTAINER` or default iCloud path) + the **path-safety guard** (`resolvePageRel`: must be under `Shared/`, no traversal). |
| `src/library.ts` | `requireLibrary` (existence + setup-guide error), chapter/page discovery. |
| `src/template.ts` | Parse `template.svg` → `Region[]` geometry (transform, rect, rows/cols, ruled-line positions) with `fast-xml-parser`. |
| `src/svg.ts` | Compose `ai.svg` from structured region input (text lines, `calendar` grid, `<image>` placement); `imageDims` header parse; the default (no-theme) underlay palette (a chapter's own resolved ink palette, gold retired); per-region font/size/weight defaults; theme resolution (named presets + adaptive `{harmony,varietyDial,fontPersonality}` param block → `Theme`). |
| `src/color.ts` | Pure colour helpers (hex↔HSL, hex↔OKLab) + `harmony` palette derivation from the template's sampled colours, with a lightness floor on derived text so it reads on cream. The underlay lift (`liftForUnderlay = 0.14`) steps **OKLCH lightness** (perceptual); `monthlyInks` holds the 12 confirmed per-month palettes. No deps. |
| `src/page.ts` | Read a page, **atomic** ai.svg + `media/ai/` image writes (`resolveImages`/`gcOrphanMedia`), manifest status flips, `create_page`. |

The 10 tools (all in `src/index.ts`): `get_library`, `list_pages`, `read_page`, `read_ink`,
`write_underlay`, `set_underlay_status`, `clear_underlay`, `create_page`, `set_chapter_theme`,
`fetch_image`. Only five mutate the library (`write_underlay`, `set_underlay_status`,
`clear_underlay`, `create_page`, and `set_chapter_theme` — which writes only the chapter's
`.folder.json → theme` block); `read_ink` is read-only (the user's handwriting layer — read it before composing
so you place AI content *around* a `shared` region's handwriting; bulky per-stroke `data-stroke`
streams are stripped unless `includeStrokeData` is set; refuses when the chapter marks its ink
private via `permissions.inkReadable: false`, reflection chapters private by default) and `fetch_image` only writes a
validated download to the OS temp dir (HTTPS image → temp file, PNG/JPEG + 2MB check, optional `rembg`
background removal), never the library. `write_underlay` is the workhorse (structured `regions` →
composed `ai.svg`).

## How a page is addressed

A page is a folder of layered SVGs (`template → ai → stickers → ink`) plus `manifest.json`;
a chapter is a folder of pages, ordered by `.folder.json`. Page discovery is "any folder
containing `manifest.json`" (`library.findPages`), recursing under `Shared/` only.

`template.svg` carries the geometry. Each addressable region is a `<g id="region-<name>"
data-region="<name>" transform="translate(x,y)">`; `template.parseRegions` turns these into
`Region[]` with the group origin, optional `<rect>` box, `data-rows`/`data-cols` hints, a
timed-grid's `data-start-hour`/`data-rows-per-hour` (parsed onto `startHour`/`rowsPerHour` so
the `schedule`/`agenda` grid self-describes — a caller needn't pass `startHour`), the advisory
`data-list` bucket, and the **absolute positions of ruled lines** (`ruledLines` = horizontal
rules, `colLines` = vertical). Those ruled lines are the writable "rows." Each region also
carries two intent signals: **`fill`** (`ink`/`ai`/`shared`) — who fills it, from `data-fill` else derived
name → template type → geometry (`template.deriveFill`); and **`intent`** — the designer's
free-text purpose from `data-intent` (e.g. "this week's dinners"), or `null`. `fill` drives
behaviour (`shared`/`ai` are yours; an `ink` region is the user's — filling its body trips an
`ink_region_filled` warning); `intent` is advisory context, free to repurpose. Region names are
only a *default* for `fill`, not a contract — novel templates set the attributes explicitly. See
`docs/AUTHORING.md`.

`write_underlay`'s structured `regions` input is the normal path: `svg.composeAiSvg` looks
up each region by name and places each line's baseline via `row` (snap to a ruled line +
`~0.4 × row-pitch`), or a clock `time` (`"HH:MM"` → nearest row, anchored by the region's
`startHour` + `rowsPerHour` — read from the template's `data-start-hour`/`data-rows-per-hour`,
with a per-call override), or explicit `y`, or —
for boxes with no rules (e.g. `ainotes`) — line-stacking / vertical-centering
(precedence `y > row > time > order`). A line may carry a `marker` (`checkbox`/`bullet`,
drawn as a shape — no font dependency) before its text, and `wrap: true` to break long text
to the region width (continuations stack below the baseline without consuming the next ruled
row). A line may also be a `heading` (a section label) — `banner` themes draw it as a colored
pill, `underline` themes as a label + rule. The page mood is set two ways: a named **`theme`** preset
(`bright` / `cozy` / `editorial`, plus `gold` kept as a back-compat name — no longer a fixed colour) **or** the adaptive param block
**`{ harmony, varietyDial, fontPersonality }`** — the chapter-theme axis whose keys are owned by
the app's `FORMAT.md §4` (`.folder.json → theme`). `write_underlay` reads the chapter theme as the
**default** (and `read_page` surfaces it) and accepts **per-call overrides**; `harmony` derives the
day's palette from the template's *own sampled colours* (`src/color.ts`), `fontPersonality` swaps
fonts (orthogonal), `varietyDial` scales banner count + heading style. Gold is retired — the
default is a chapter's own ink palette, not a constraint — and the orchestrator is meant to pick the mood to fit the day (see
`docs/AUTHORING.md`). So callers never compute
coordinates; they reference a region name and a row index from
`read_page`. An unknown region name throws (listing the valid ones). Raw `svg` bypasses all
of this — full control, no geometry help. `composeAiSvg` returns `{ svg, warnings }`; the
warnings flag likely overflow (text past the region rect, more lines than ruled rows, a
wrapped block that overruns its row, a `time` that can't be anchored) and surface in the
`write_underlay` result — important because overnight/unattended writes have no human watching.

Two `write_underlay` modifiers: **`merge`** patches only the named regions into the
existing `ai.svg` (parsing its `<g data-region>` blocks, replacing matches, keeping the rest
**verbatim** — `svg.mergeRegions`) so an update to one region doesn't clobber the page;
**`dryRun`** composes and returns the result + warnings without writing or flipping status.
`merge` is structured-input only (rejected with raw `svg`).

A region entry may also carry **`images`** — PNG/JPEG art the caller supplies as base64
`data` **or** a local file `path` (read off disk, so a generated image never passes through
the model context — for overnight/automated writes; format is sniffed when omitted). This
server has no network/generation. The app's renderer resolves `<image href>` only as a
**page-relative file path** (no data-URIs), so `page.ts:resolveImages` validates the bytes
(magic vs `format`, 2MB cap), writes them to the page's **`media/ai/`** folder, and rewrites
the `<image href="media/ai/…">` into the region group; `svg.ts:imageDims` reads intrinsic size
(aspect-fills an omitted height). Placement is region-local via `corner`/`x`/`y`. After each
write, `gcOrphanMedia` deletes any `media/ai/*` the final (post-merge) ai.svg no longer
references; `clear_underlay` removes the folder. Images ride inside their region's `<g>`, so
`merge` preserves them with the region.

A region entry may instead carry a **`calendar`** spec (`{ month: "YYYY-MM", days?: [...] }`)
in place of `lines` — used for the gridded `month` region. `svg.composeCalendar` derives each
day's cell via `gridBounds` (an even division of the region box by `data-cols`/`data-rows`,
falling back to bracketing the parsed `colLines`/`ruledLines` with the box edges — templates
may draw only the *interior* dividers as lines and leave the outer edges to the `<rect>`).
Sunday-start, matching the `SUN…SAT` headers; emits a day number + a
`<rect data-date="YYYY-MM-DD" fill="none">` per cell. Those `data-date` rects are the app's
**tap-to-day** targets (tapping opens that day's daily page); the server only stamps the
attribute, the app handles navigation. `lines` and `calendar` are mutually exclusive per region.

`create_page` resolves its template as: explicit `template` arg → the chapter's
`.folder.json → defaultTemplate` → a **sibling page** in the chapter (sorted; a month
chapter's monthly-overview grid is never used for a new day page) → the top-level
**`Templates/<id>/` catalogue** (a catalogue template may also ship a starter
`stickers.svg`, copied on create). A fresh library ships the `Templates/` + `Stickers/` catalogues but no `Shared/`
pages, so catalogue instantiation is how the first page in a chapter gets made.

## Invariants (do not break)

- **Only ever write** `ai.svg`, the manifest's `layers.ai` block (+ top-level `modified`),
  and the page's **`media/ai/`** subfolder (AI-owned images — written + garbage-collected
  here); on create, the new page's own files + the chapter `.folder.json` order; and via
  `set_chapter_theme`, the chapter `.folder.json → theme` block (only the passed keys, order +
  other fields preserved). Never touch
  `ink.svg`, `stickers.svg`, `template.svg`, the rest of `media/`, or anything under `Private/`.
- All writes go through `resolvePageRel` (enforces `Shared/` containment) and `atomicWrite`
  (temp + rename).
- **Re-read `manifest.size` per page** — never assume `1024×1366`. The geometry comes from
  each page's own `template.svg`; don't hard-code region coordinates.

## Gotchas

- The Onionskin **fixtures change** as the app develops — and substantially. The current
  fixtures are a **fresh library** (a `Templates/` + `Stickers/` catalogue, no seeded
  `Shared/` pages). The **2026-06 region redesign** is the latest big shift: `ainotes` is the
  new AI-voice region (`fill: ai`); **`notes` is `ink` everywhere** (handwriting only — the AI
  never fills it); `goals → focus`; Daily `priorities` folded into `todo` (star the few that
  matter with a typographic ★); Agenda `summary` removed; `quote`/`affirmation` retired (→
  `ainotes`, kept only as legacy fallbacks in `FILL_BY_NAME`/`REGION_DEFAULTS`); `schedule`/
  `agenda` now self-describe their hour grid via `data-start-hour`/`data-rows-per-hour`; the
  `month` grid draws only interior dividers inside a `<rect>` box. The smoke test therefore
  **seeds its own chapters and creates pages from the catalogue**, and derives expected
  coordinates and region names from parsed geometry rather than hard-coding them — keep it that way.
- The iCloud Drive mirror may be absent on a given Mac until the iPad app has run with
  iCloud on and synced down; tools must degrade to a setup message (`LibraryMissingError`),
  never crash. (iCloud also adds sync latency in both directions — Mac write → iPad pickup
  is not instant.)
- ESM project (`"type": "module"`, NodeNext) — local imports use `.js` extensions.
- **Fonts are a closed set** (`Mulish`, `Newsreader`, `IBM Plex Mono`, `Caveat`, `Fredoka`,
  `Phosphor`) — only these render in-app; the shared `FONT_ENUM` in `index.ts` and per-region
  defaults in `svg.ts` (`REGION_DEFAULTS`) encode that. Don't introduce other font families.
- **Legibility:** gold is retired entirely (design decisions, 2026-07-09) — there is no fixed
  underlay colour any more. Every underlay text colour clears a real ≥4.5:1 WCAG contrast floor
  against paper (`floorTextHex`/`floorAccentHex`, `contrastRatio` in `src/color.ts`), and the
  default (no `harmony`/`accent`/preset) palette derives from the chapter's own `paletteCharacter`
  (or the default character if unset), lifted lighter per Rule 2 — never darker than the user's own
  ink. See `docs/SHARED-VISUAL-SPEC.md` §0 and the app's `design/INK-PALETTE.md`.
  A **banner pill** is a different contrast pair (text on the pill, not on paper): a caller's
  `labelFill`/heading `fill` lands raw on the pill and the *label colour* is picked to read on it
  (`pillTextHex`), warning `banner_label_contrast` when nothing clears — see SPEC §5.
  Only the `harmony`-**derived** palette deepens text (a lightness floor at derivation, so adaptive text
  stays legible on cream — not a runtime contrast checker). Text also carries a `font-weight` (per-region default
  600, 500 for the serif `ainotes`; per-line `weight` override) — **confirmed honoured**, since the
  app's `Mulish`/`Newsreader` are variable fonts the renderer weights at runtime.
- **The app renderer is a custom SVG subset** (SwiftUI `Canvas` + `XMLParser`, no WebKit):
  it handles `svg, g, rect, line, path, text, image, circle, ellipse, polyline, polygon`
  (`RAW_SVG_ALLOWED_ELEMENTS` in `src/svg.ts` is the source of truth) and silently drops
  anything else — notably `<tspan>`, which is why multi-line text is stacked `<text>`.
  `text-anchor`/`font-weight` do **not** inherit from a wrapping `<g>` (app
  [#211](https://github.com/bsitkoff/onionskin/issues/211)) — set them per `<text>`.
  `<image href>` resolves **only as a page-relative file path** (no data-URIs) and the
  **AI layer needs a non-nil `imageProvider`** (an app change) for images to appear at all.
  When emitting raw `svg`, stay within that element set.
- The ai layer has a 3-state status (`empty → refreshing → ready`) in `manifest.layers.ai`;
  the app only composites `ready`. `write_underlay` sets `ready` by default. Use `refreshing`
  before a long multi-step edit so a half-built page never shows.
- `npm run smoke` depends on the **sibling `../onionskin` repo** (it copies
  `../onionskin/Onionskin/Fixtures/Library`); it can't run without that checkout present.
