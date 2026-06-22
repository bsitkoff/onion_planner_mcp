# Onionskin — MCP / AI integration spec

> This is the connection surface for a **separately built** MCP server (or any tool)
> that wants to write the "AI underlay" into Onionskin pages. There is **no API and no
> library** — you connect by reading and writing plain files in a folder. If your tool
> ever needs to *ask Onionskin a question* to do its job, the format has failed; tell us.

The authoritative, exhaustive contract is [`design/FORMAT.md`](../design/FORMAT.md) in
the Onionskin app repo. This document is the **MCP-focused quickstart**: where the files
are, what to write, and the rules.

---

## 1. The one-paragraph model

Every page is a **folder**. A page composites four SVG layers in z-order:
`template.svg` (graphite grid + addressable regions) → **`ai.svg` (gold — yours to
write)** → `stickers.svg` (pink — the user's) → `ink.svg` (blue — the user's
handwriting). **Permission is location:** a page under `Shared/` may be read and written
by the user's AI; everything else is private. Your entire job is: **write `ai.svg` in a
shared page, then mark it ready.** That's the whole "connection."

---

## 2. Where the library lives

Onionskin stores everything in the app's iCloud Documents container. On a Mac signed
into the same iCloud account, that is:

```
~/Library/Mobile Documents/iCloud~com~onionskin~app/Documents/
```

(The container id is `iCloud.com.onionskin.app`; iCloud maps the dots to `~` on disk. If
the user re-provisioned under a different container id, adjust the path — it is
`~/Library/Mobile Documents/iCloud~<container-with-dots-as-tildes>/Documents/`.)

That `Documents/` directory is the **library root**. Layout:

```
Documents/                         ← library root
├─ settings.json                   ← global settings (read-only for you)
├─ Templates/                      ← catalogue of templates (read-only; create_page source)
│  ├─ templates.json               ← id/name/category/style/files per template
│  └─ daily-minimal/template.svg   ← one folder per template id
├─ Stickers/                       ← catalogue of reusable sticker PNGs (read-only)
│  └─ Marks/star.png …
├─ Shared/                         ← YOUR sandbox. Anything here is writable.
│  └─ Daily/                       ← a chapter (folder)
│     ├─ .folder.json
│     └─ 2026-06-13/               ← a page (folder; name is a human date/slug)
│        ├─ manifest.json
│        ├─ template.svg           ← read for regions; never write (copied from the catalogue)
│        ├─ ai.svg                 ← YOU write this
│        ├─ stickers.svg           ← never write
│        ├─ ink.svg                ← never write
│        └─ media/
└─ Private/                        ← off-limits. Do not read or write.
```

A fresh library ships the `Templates/` + `Stickers/` catalogues but **no `Shared/`
pages** — the app (or `create_page`) creates pages by copying a template into `Shared/`.

**Only touch pages whose path contains `…/Shared/…`.**

---

## 3. The connection recipe

### a. Find shared pages
Walk `Documents/Shared/**`. Any directory containing a `manifest.json` is a page. Read
`manifest.json`:

```json
{
  "title": "Friday",
  "template": "daily",
  "size": [1024, 1366],
  "modified": "2026-06-13T09:14:22Z",
  "layers": {
    "template": { "file": "template.svg", "z": 0 },
    "ai":       { "file": "ai.svg", "z": 1, "status": "empty" },
    "stickers": { "file": "stickers.svg", "z": 2 },
    "ink":      { "file": "ink.svg", "z": 3 }
  }
}
```

`size` is the **shared coordinate system** for every layer (currently `1024 × 1366`,
portrait points). All your geometry is in this space.

### b. Read the regions you may target
`template.svg` tags the zones you can write into, by `id`, with real geometry. Example:

```xml
<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">
  <g id="region-schedule" data-region="schedule" transform="translate(56,250)">
    <rect x="0" y="0" width="540" height="870" fill="none"/>
    <!-- ruled hour lines + labels … -->
  </g>
  <g id="region-quote" data-region="quote" transform="translate(56,1148)">…</g>
  <g id="region-todo"        data-region="todo"        transform="translate(636,520)">…</g>
</svg>
```

To write "the schedule", read `region-schedule`'s `transform` (and its rect size) and
emit elements positioned to match. The daily template exposes:
`region-header`, `region-schedule`, `region-priorities`, `region-todo`,
`region-notes`, `region-quote` (the serif quote/affirmation box). Monthly templates
expose `region-header`, `region-month`, `region-weekdays`, `region-goals`,
`region-notes`. **Region names vary by template and change as templates evolve — read
them from `read_page`/the template, don't hard-code.**

### c. Write `ai.svg`
Emit one self-contained SVG on the page's `viewBox`. Gold is `#9C7C1A` — the brand gold
(`#C9A227`) deepened for legibility on white paper; this is what the reference server emits
by default. Group your output by region so it's legible:

```xml
<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">
  <g data-region="schedule">
    <text x="86" y="284" font-family="Mulish" font-size="14" fill="#9C7C1A">04:00  pill alarm</text>
    <text x="86" y="362" font-family="Mulish" font-size="14" fill="#9C7C1A">09:00  standup</text>
  </g>
  <g data-region="quote">
    <text x="80" y="1204" font-family="Newsreader" font-size="26" fill="#9C7C1A">I am capable of embracing change.</text>
  </g>
</svg>
```

Coordinates are **absolute page coordinates** (region `translate` + your local offset),
or wrap your elements in a `<g transform="translate(...)">` matching the region — either
works; the app composites raw SVG. Fonts that render in-app: `Mulish` (sans),
`Newsreader` (serif), `IBM Plex Mono` (mono), `Caveat`, `Fredoka`, `Phosphor` (icons).
Unknown families fall back to the serif.

### d. Declare readiness — the handshake
Onionskin will **not** composite your `ai.svg` until the manifest says so. After your
write is complete, set the AI layer status and bump `modified`:

```jsonc
"layers": { "ai": { "file": "ai.svg", "z": 1, "status": "ready",
                    "updated": "2026-06-13T05:00:00Z" } }
// and update top-level "modified"
```

Valid `status`: `empty` · `refreshing` · `ready`. While you're mid-write, you may set
`refreshing` (the app shows a pulsing "refreshing underlay" and keeps the last ready
content); set `ready` only when the file is fully written. **This declared field is the
entire coordination mechanism — the app never talks to you directly.**

### e. How/when the user sees it
Today Onionskin re-reads on **app foreground** or when the user taps **"Refresh
underlay."** (A live `Shared/` watcher is planned but not shipped, so don't assume
instant pickup.) Write whenever you like; it appears on the next read.

---

## 4. Rules (the short version)

- **Write only `ai.svg`, only under `Shared/`.** Never write `ink.svg`, `stickers.svg`,
  or `template.svg`; never read or write under `Private/`.
- **Write atomically.** Write to a temp file in the same directory and rename into place,
  so the app never reads a half-written `ai.svg`. Then flip `status` to `ready`.
- **You own one file, so there is no write conflict.** The app never writes `ai.svg`;
  you never write the user's layers. (If you ever did contend a file, the policy is
  keep-both: write a `…-conflict` sibling, never overwrite.)
- **Coordinate space is `manifest.size`.** Re-read it per page; don't assume.
- **No opaque ids, no database.** Folder and file names are human and stable; everything
  is UTF-8 SVG + JSON.

---

## 5. Creating new pages (optional)

You normally write into pages the user created. If you want to *create* a shared page
(e.g., tomorrow's daily), make a folder under a shared chapter and write the full set:
`manifest.json` + `template.svg` + empty `ai.svg`/`stickers.svg`/`ink.svg` + `media/`.
You need a template — get one of two ways: **copy `template.svg` from an existing
sibling page** in the chapter (templates are self-contained per page), or, for a
brand-new/empty chapter, **copy from the top-level `Templates/<id>/` catalogue** (the
ids and their files are listed in `Templates/templates.json`; some ship a starter
`stickers.svg` too). Start the remaining layers as
`<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"></svg>`. Add the new
folder name to the chapter's `.folder.json → order`. (The reference server's
`create_page` does exactly this — sibling first, catalogue as fallback.) Prefer letting
the user create pages and just filling the underlay unless you have a reason.

---

## 6. Build it in its own repo

This server is intentionally **not** part of the Onionskin app. Build it wherever your
MCP servers live (this is Bridget's `mcp-infra` fleet pattern). It needs nothing from the
app — just filesystem access to the iCloud container above. Keep this doc (or a copy)
next to it as the integration reference, and point back to `design/FORMAT.md` for the
full contract.
