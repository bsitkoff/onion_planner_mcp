# onion-planner-mcp

A local MCP server that writes the **AI underlay** (`ai.svg`) into
[Onionskin](https://onionskin.sitkoff.net) planner pages. Onionskin's whole integration surface is a
folder of plain files in an iCloud container — no app API, no hosted service — so the core
planner integration is **filesystem-only**: it reads `template.svg` for region geometry and
writes `ai.svg` + the manifest's status flag. The optional `fetch_image` helper only downloads
HTTPS image files to local temp paths for later filesystem embedding. Full contract:
[`docs/MCP-INTEGRATION.md`](docs/MCP-INTEGRATION.md).
Planned work: [`docs/ROADMAP.md`](docs/ROADMAP.md) · shipped history:
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) · bugs/polish:
[issues](https://github.com/bsitkoff/onion_planner_mcp/issues).

## What it does

Every Onionskin page is a folder compositing four SVG layers
(`template → ai → stickers → ink`). The **ai layer is yours**; the user's ink/stickers
are not. Writing the underlay needs no permission (it isn't a privacy surface — 2026-07-09
app decisions); the gated operation is reading the user's *ink*, per-chapter, once the app
ships its ink-read toggle. Today the server still enforces `Shared/`-only containment
(`Private/` is invisible) until the app retires that gate — a same-release change
([#13](https://github.com/bsitkoff/onion_planner_mcp/issues/13)). This server lets Claude
fill a page's schedule, to-dos, focus, and the `ainotes` AI-voice block, then flip
`manifest.json → layers.ai.status` to `ready` so the app composites it on next foreground.
The underlay renders in **the chapter's own colours** (its `paletteCharacter`/theme, lifted
lighter than the user's ink and contrast-floored) — gold is retired.

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `get_library` | read | Resolve & validate the iCloud library; list Shared chapters + the global `underlayVoice` setting, if set. **Call first.** |
| `list_pages` | read | List shared pages with title, template, size, modified, ai status. Optional filters (AND): `chapter`, `template`, `aiStatus`, `titleContains`, `modifiedAfter`/`modifiedBefore`. |
| `read_page` | read | One page's manifest + parsed **regions** (geometry) + current ai.svg. |
| `read_ink` | read | Read the user's `ink.svg` layer for context without modifying it. |
| `write_underlay` | write | Write ai.svg (structured `regions` *or* raw `svg`) + set status. `merge` patches named regions; `dryRun` previews without writing; returns fit `warnings` plus structured `warningDetails`. |
| `set_underlay_status` | write | Flip ai status (`empty`/`refreshing`/`ready`) without rewriting. |
| `clear_underlay` | write | Reset ai.svg to empty + status `empty`. |
| `create_page` | write | New shared page from a sibling's template, or from the `Templates/` catalogue by id. |
| `set_chapter_theme` | write | Set a chapter's default theme (`.folder.json → theme`): `paletteCharacter`, explicit `accent`, `customInk1/2`, `harmony`/`varietyDial`/`fontPersonality`, `displayName`. Only the passed keys change; page order is preserved. `write_underlay` applies it as the default, `read_page` surfaces it. |
| `fetch_image` | helper | Download an HTTPS PNG/JPEG to an `onionskin-fetch/` folder under the **OS temp dir** (`$TMPDIR` on macOS — not `/tmp`) and return a local path for `images[].path`; optional background removal requires `rembg`. |

### Typical flow

```
get_library            → confirm the library is reachable
list_pages             → find "Shared/Daily/2026-06-14"
read_page              → learn its regions (schedule rows, ainotes box, …)
write_underlay         → place text by region/row; server computes coordinates; status=ready
```

`write_underlay` structured input does the geometry for you:

```jsonc
{
  "page": "Shared/Daily/2026-06-14",
  "regions": [
    { "region": "schedule", "lines": [
      { "text": "9:00 standup", "row": 2 },
      { "text": "13:00 1:1", "row": 6 } ] },
    { "region": "todo", "lines": [
      { "text": "Email the registrar", "marker": "checkbox" } ] },
    { "region": "ainotes", "lines": [ { "text": "Small steps still move forward." } ] }
  ]
}
```

`row` aligns to the region's ruled lines (from `read_page`). Use `y`/`x` for explicit
placement, `marker` (`checkbox`/`bullet`) for a leading mark, and `time` to place
a schedule line by the clock (anchored by the template's `data-start-hour`, or a per-call
`startHour` override). For hand-placed content in a single region, give it a raw
`svg` string (emitted verbatim inside that region's group, composes/merges like any
region; mutually exclusive with `lines`/`calendar`) — or pass a full top-level `svg`
document for total control. A line with
`heading: true` is drawn as a **section label** (bold, letter-spaced, with a hairline rule)
and the lines after it flow below as its items — that's how the AI layer adds day-specific
structure (an "Important" / "Tomorrow" / "Habits" block) into a neutral region without the
template pre-printing it. Pass `merge: true` to update only the regions you supply and
leave the rest of the page intact (e.g. slide a new meeting into the schedule without
clearing the to-dos); pass `dryRun: true` to get the composed SVG plus overflow `warnings`
and structured `warningDetails` back without writing.

**Filling a page well** — pulling your real data, never leaving it blank, and using sections
to give each day its own shape — is its own craft: see
[`docs/AUTHORING.md`](docs/AUTHORING.md).

For a monthly page, give the `month` region a `calendar` spec instead of `lines` — the
server lays out the grid (Sunday-start) from the template, drawing day numbers and a
`data-date` tap target per cell so tapping a date opens that day:

```jsonc
{ "region": "month",
  "calendar": { "month": "2026-02", "days": [ { "day": 14, "text": "Valentine" } ] } }
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ONIONSKIN_CONTAINER` | `~/Library/Mobile Documents/iCloud~com~onionskin~app/Documents` | Absolute path to the library's `Documents/` dir. Set this if you re-pointed the iCloud container id, or to test against a fixture copy. |

Onionskin is an **iPad/iOS app**; this server runs on the **Mac**. The bridge is iCloud
Drive: the iPad app writes its container, and iCloud mirrors it to the Mac at the path
above (same Apple ID). Writes from this server sync back up to the iPad. If that mirror
isn't present yet (the iPad app hasn't run with iCloud on, or hasn't synced to this Mac),
every tool returns a clear setup message instead of crashing.

## Run

```bash
npm install
npm start                      # tsx src/index.ts (stdio)
npm run smoke                  # end-to-end test against a /tmp fixture copy
```

The `smoke` script copies `../onionskin/Onionskin/Fixtures/Library` to `/tmp/onionskin-test`
and runs the full read→write→clear→create flow plus the Private/traversal refusals.

## Why local stdio

The Onionskin app is on iPad; its library reaches your Mac only as an **iCloud Drive
mirror**. Touching it needs local macOS filesystem access — which a remote/Linux MCP host
wouldn't have — so this stays a **local stdio** server running on the Mac. (MCPB bundling is
the future path if it ever needs distribution.)

## Safety

- Writes **only** `ai.svg`, the manifest's `layers.ai` block (+ `modified`), and the page's
  `media/ai/` folder (AI-owned art — written and garbage-collected there); on `create_page`, a
  new page folder's own files and the chapter `.folder.json` order; via `set_chapter_theme`,
  the chapter `.folder.json → theme` block (only the passed keys; order and other fields are
  preserved).
- **Never** writes `ink.svg`, `stickers.svg`, `template.svg`, or the rest of `media/`; never
  reads/writes `Private/`.
- Every write is validated to live under `Shared/` (no traversal) and is **atomic**
  (temp file + rename) so the app never reads a half-written file.
- `fetch_image` is the one network-capable helper: it accepts HTTPS only, validates PNG/JPEG
  bytes and the 2 MB cap, and writes only to OS temp storage.
