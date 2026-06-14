# CLAUDE.md

Guidance for working on this repo. See `README.md` for usage and `docs/MCP-INTEGRATION.md`
for the Onionskin file-format contract (the authoritative spec is `../onionskin/design/FORMAT.md`).

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
npm run smoke      # copy fixtures → /tmp/onionskin-test and run the e2e test
npx tsc --noEmit   # typecheck
```

## Architecture

| File | Role |
|---|---|
| `src/index.ts` | MCP server + the 7 tools (zod schemas, annotations, error handling). |
| `src/paths.ts` | Container resolution (`ONIONSKIN_CONTAINER` or default iCloud path) + the **path-safety guard** (`resolvePageRel`: must be under `Shared/`, no traversal). |
| `src/library.ts` | `requireLibrary` (existence + setup-guide error), chapter/page discovery. |
| `src/template.ts` | Parse `template.svg` → `Region[]` geometry (transform, rect, rows/cols, ruled-line positions) with `fast-xml-parser`. |
| `src/svg.ts` | Compose `ai.svg` from structured region input; gold `#C9A227`; per-region font defaults. |
| `src/page.ts` | Read a page, **atomic** ai.svg writes, manifest status flips, `create_page`. |

## Invariants (do not break)

- **Only ever write** `ai.svg` and the manifest's `layers.ai` block (+ top-level
  `modified`); on create, the new page's own files + the chapter `.folder.json` order.
  Never touch `ink.svg`, `stickers.svg`, `template.svg`, or anything under `Private/`.
- All writes go through `resolvePageRel` (enforces `Shared/` containment) and `atomicWrite`
  (temp + rename).
- **Re-read `manifest.size` per page** — never assume `1024×1366`. The geometry comes from
  each page's own `template.svg`; don't hard-code region coordinates.

## Gotchas

- The Onionskin **fixtures change** as Bridget develops the app (the daily template's row
  count/pitch shifted mid-build). The smoke test derives expected coordinates from the
  parsed geometry rather than hard-coding them — keep it that way.
- The iCloud Drive mirror may be absent on a given Mac until the iPad app has run with
  iCloud on and synced down; tools must degrade to a setup message (`LibraryMissingError`),
  never crash. (iCloud also adds sync latency in both directions — Mac write → iPad pickup
  is not instant.)
- ESM project (`"type": "module"`, NodeNext) — local imports use `.js` extensions.
