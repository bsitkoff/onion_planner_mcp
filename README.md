# onion-planner-mcp

A local MCP server that writes the **gold AI underlay** (`ai.svg`) into
[Onionskin](../onionskin) planner pages. Onionskin's whole integration surface is a
folder of plain files in an iCloud container — no API, no library — so this server is
**filesystem-only**: it reads `template.svg` for region geometry and writes `ai.svg` +
the manifest's status flag. Full contract: [`docs/MCP-INTEGRATION.md`](docs/MCP-INTEGRATION.md).

## What it does

Every Onionskin page is a folder compositing four SVG layers
(`template → ai → stickers → ink`). The **ai layer is yours**; the user's ink/stickers
are not. Permission is location: only pages under `Shared/` are touchable; `Private/` is
invisible. This server lets Claude fill a page's schedule, to-dos, priorities, notes, and
affirmation, then flip `manifest.json → layers.ai.status` to `ready` so the app composites
it on next foreground.

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `get_library` | read | Resolve & validate the iCloud library; list Shared chapters. **Call first.** |
| `list_pages` | read | List shared pages with title, template, size, modified, ai status. |
| `read_page` | read | One page's manifest + parsed **regions** (geometry) + current ai.svg. |
| `write_underlay` | write | Write ai.svg (structured `regions` *or* raw `svg`) + set status. |
| `set_underlay_status` | write | Flip ai status (`empty`/`refreshing`/`ready`) without rewriting. |
| `clear_underlay` | write | Reset ai.svg to empty + status `empty`. |
| `create_page` | write | Clone a sibling's template to make a new shared page. |

### Typical flow

```
get_library            → confirm the library is reachable
list_pages             → find "Shared/Daily/2026-06-14"
read_page              → learn its regions (schedule rows, affirmation box, …)
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
    { "region": "affirmation", "lines": [ { "text": "Small steps still move forward." } ] }
  ]
}
```

`row` aligns to the region's ruled lines (from `read_page`). Use `y`/`x` for explicit
placement, or pass a full `svg` document for total control.

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

The Onionskin app is on iPad; its library reaches this Mac only as an **iCloud Drive
mirror**. Touching it needs local macOS filesystem access, which the `mamastuff` Linux host
doesn't have — so, unlike most of the fleet, this stays a **local stdio** server alongside
the Obsidian ones. (MCPB bundling is the future path if it ever needs distribution.)

## Safety

- Writes **only** `ai.svg` and the manifest's `layers.ai` block (+ `modified`); on
  `create_page`, a new page folder's own files and the chapter `.folder.json` order.
- **Never** writes `ink.svg`, `stickers.svg`, or `template.svg`; never reads/writes `Private/`.
- Every write is validated to live under `Shared/` (no traversal) and is **atomic**
  (temp file + rename) so the app never reads a half-written file.
