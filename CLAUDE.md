# CLAUDE.md

Guidance for working on this repo. See `README.md` for usage, `docs/MCP-INTEGRATION.md`
for the Onionskin file-format contract (the authoritative spec is `../onionskin/design/FORMAT.md`),
and `docs/ROADMAP.md` for what's shipped and what's next.

## What this is

A **local stdio** MCP server (TypeScript, run via `tsx`) that writes the gold `ai.svg`
underlay into [Onionskin](../onionskin) planner pages. Integration is **filesystem-only** —
it reads/writes plain SVG + JSON in the app's iCloud container. There is no network API.

Matches the fleet convention (`../CommonPlannerMCP`): official `@modelcontextprotocol/sdk`,
high-level `McpServer` + `server.tool()`, `zod` schemas. Onionskin itself is an **iPad/iOS
app**; this server runs on the **Mac** against the iCloud Drive mirror of the app's
container (synced via the same Apple ID; Mac writes sync back up to the iPad). It stays
local (not on `mamastuff`) because reaching that mirror needs local macOS filesystem access.

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
| `src/index.ts` | MCP server + the 7 tools (zod schemas, annotations, error handling). |
| `src/paths.ts` | Container resolution (`ONIONSKIN_CONTAINER` or default iCloud path) + the **path-safety guard** (`resolvePageRel`: must be under `Shared/`, no traversal). |
| `src/library.ts` | `requireLibrary` (existence + setup-guide error), chapter/page discovery. |
| `src/template.ts` | Parse `template.svg` → `Region[]` geometry (transform, rect, rows/cols, ruled-line positions) with `fast-xml-parser`. |
| `src/svg.ts` | Compose `ai.svg` from structured region input (text lines + the `calendar` grid); gold default `GOLD` (`#9C7C1A`); per-region font/size/weight defaults. |
| `src/page.ts` | Read a page, **atomic** ai.svg writes, manifest status flips, `create_page`. |

The 7 tools (all in `src/index.ts`): `get_library`, `list_pages`, `read_page`,
`write_underlay`, `set_underlay_status`, `clear_underlay`, `create_page`. Only the last four
mutate; `write_underlay` is the workhorse (structured `regions` → composed `ai.svg`).

## How a page is addressed

A page is a folder of layered SVGs (`template → ai → stickers → ink`) plus `manifest.json`;
a chapter is a folder of pages, ordered by `.folder.json`. Page discovery is "any folder
containing `manifest.json`" (`library.findPages`), recursing under `Shared/` only.

`template.svg` carries the geometry. Each addressable region is a `<g id="region-<name>"
data-region="<name>" transform="translate(x,y)">`; `template.parseRegions` turns these into
`Region[]` with the group origin, optional `<rect>` box, `data-rows`/`data-cols` hints, and
the **absolute positions of ruled lines** (`ruledLines` = horizontal rules, `colLines` =
vertical). Those ruled lines are the writable "rows."

`write_underlay`'s structured `regions` input is the normal path: `svg.composeAiSvg` looks
up each region by name and places each line's baseline via `row` (snap to a ruled line +
`~0.4 × row-pitch`), or explicit `y`, or — for boxes with no rules (e.g. `quote`, `notes`)
— line-stacking / vertical-centering. A line may carry a `marker` (`checkbox`/`bullet`,
drawn as a shape — no font dependency) before its text. So callers never compute
coordinates; they reference a region name and a row index from `read_page`. An unknown
region name throws (listing the valid ones). Raw `svg` bypasses all of this — full control,
no geometry help. `composeAiSvg` returns `{ svg, warnings }`; the warnings flag likely
overflow (text past the region rect, more lines than ruled rows) and surface in the
`write_underlay` result — important because overnight/unattended writes have no human watching.

Two `write_underlay` modifiers: **`merge`** patches only the named regions into the
existing `ai.svg` (parsing its `<g data-region>` blocks, replacing matches, keeping the rest
**verbatim** — `svg.mergeRegions`) so an update to one region doesn't clobber the page;
**`dryRun`** composes and returns the result + warnings without writing or flipping status.
`merge` is structured-input only (rejected with raw `svg`).

A region entry may instead carry a **`calendar`** spec (`{ month: "YYYY-MM", days?: [...] }`)
in place of `lines` — used for the gridded `month` region. `svg.composeCalendar` derives each
day's cell via `gridBounds` (an even division of the region box by `data-cols`/`data-rows`,
falling back to bracketing the parsed `colLines`/`ruledLines` with the box edges — templates
may draw only the *interior* dividers as lines and leave the outer edges to the `<rect>`).
Sunday-start, matching the `SUN…SAT` headers; emits a day number + a
`<rect data-date="YYYY-MM-DD" fill="none">` per cell. Those `data-date` rects are the app's
**tap-to-day** targets (tapping opens that day's daily page); the server only stamps the
attribute, the app handles navigation. `lines` and `calendar` are mutually exclusive per region.

`create_page` sources its `template.svg` from a **sibling page** in the chapter, or — when
the chapter is new/empty (no sibling) — from the top-level **`Templates/<id>/` catalogue**
(passed as `template`; a catalogue template may also ship a starter `stickers.svg`, copied
on create). A fresh library ships the `Templates/` + `Stickers/` catalogues but no `Shared/`
pages, so catalogue instantiation is how the first page in a chapter gets made.

## Invariants (do not break)

- **Only ever write** `ai.svg` and the manifest's `layers.ai` block (+ top-level
  `modified`); on create, the new page's own files + the chapter `.folder.json` order.
  Never touch `ink.svg`, `stickers.svg`, `template.svg`, or anything under `Private/`.
- All writes go through `resolvePageRel` (enforces `Shared/` containment) and `atomicWrite`
  (temp + rename).
- **Re-read `manifest.size` per page** — never assume `1024×1366`. The geometry comes from
  each page's own `template.svg`; don't hard-code region coordinates.

## Gotchas

- The Onionskin **fixtures change** as Bridget develops the app — and substantially: the
  current fixtures are a **fresh library** (a `Templates/` + `Stickers/` catalogue, no seeded
  `Shared/` pages), daily regions were **renamed** (`affirmation → quote`, plus a new
  `header`), `todo` gained ruled lines, and the `month` grid now draws only interior dividers
  inside a `<rect>` box. The smoke test therefore **seeds its own chapters and creates pages
  from the catalogue**, and derives expected coordinates and region names from parsed geometry
  rather than hard-coding them — keep it that way.
- The iCloud Drive mirror may be absent on a given Mac until the iPad app has run with
  iCloud on and synced down; tools must degrade to a setup message (`LibraryMissingError`),
  never crash. (iCloud also adds sync latency in both directions — Mac write → iPad pickup
  is not instant.)
- ESM project (`"type": "module"`, NodeNext) — local imports use `.js` extensions.
- **Fonts are a closed set** (`Mulish`, `Newsreader`, `IBM Plex Mono`, `Caveat`, `Fredoka`,
  `Phosphor`) — only these render in-app; the shared `FONT_ENUM` in `index.ts` and per-region
  defaults in `svg.ts` (`REGION_DEFAULTS`) encode that. Don't introduce other font families.
- **Legibility:** the gold default was deepened (`#C9A227 → #9C7C1A`) and text carries a
  `font-weight` (per-region default 600, 500 for the serif `quote`; per-line `weight` override).
  The brand gold lives in the app's `FORMAT.md`; keep the server's `GOLD` constant in sync with
  it. `font-weight` only helps if the app renderer honours it and ships heavier font cuts.
- The ai layer has a 3-state status (`empty → refreshing → ready`) in `manifest.layers.ai`;
  the app only composites `ready`. `write_underlay` sets `ready` by default. Use `refreshing`
  before a long multi-step edit so a half-built page never shows.
- `npm run smoke` depends on the **sibling `../onionskin` repo** (it copies
  `../onionskin/Onionskin/Fixtures/Library`); it can't run without that checkout present.
