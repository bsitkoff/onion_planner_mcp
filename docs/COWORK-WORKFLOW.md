# Running the planner nightly with Claude CoWork

This is the **operational runbook** for the session that drives this server in production —
Bridget's Claude CoWork. It's the layer above the other two docs:

- [`MCP-INTEGRATION.md`](MCP-INTEGRATION.md) — the file-format / tool contract (the *what*).
- [`AUTHORING.md`](AUTHORING.md) — the content *craft*: pull real data, never blank, pick a
  theme, dynamic sections, the image recipe (the *what to put in each region*).
- **This doc** — *when* the job runs, *which* page it targets, the exact tool sequence, how it
  degrades, and how the workflow improves week over week.

CoWork **orchestrates** (gathers real data from Fantastical, Spark, Obsidian, weather); this
server only **renders** what it's handed into `ai.svg`. It is filesystem-only — no network, no
generation. CoWork never touches `ink.svg`, `stickers.svg`, `template.svg`, or anything under
`Private/`; it only writes the **ai layer** of pages under `Shared/`.

> **Don't hard-code anything in this doc that a tool contradicts.** The library evolves
> (chapters renamed, regions renamed, pages regenerated). Every run, let `get_library`,
> `list_pages`, and `read_page` tell you the truth. The names below are *current as of writing*
> and are examples, not constants.

---

## How it slots into the existing CoWork tasks

This is **added to Bridget's existing start-of-day and end-of-day tasks** — not a new schedule.

| Task | Targets | Does |
|---|---|---|
| **End-of-day** | **tomorrow's** daily page | The main fill: create-if-missing → gather → `dryRun` → write `ready`. |
| **Start-of-day** | **today's** daily page | Light `merge`-refresh against overnight calendar/email changes, then leave it. Never clobbers. |

Paste-ready checklists for each are at the [bottom of this doc](#paste-into-cowork).

---

## The library shape (verify each run with `get_library` / `list_pages`)

Chapters are **month-named** (`Shared/2026-06`, `Shared/2026-07`, …), each holding that month's
daily pages **plus** a monthly calendar page. A daily page is:

```
Shared/<YYYY-MM>/<YYYY-MM-DD>      e.g. Shared/2026-06/2026-06-24
   template: "daily"   title: weekday name ("Tuesday")
```

**The app pre-creates the whole month** — every day already exists as a page with
`aiStatus: "empty"`. So the common nightly path is **fill an existing empty page**, *not*
create one. `create_page` is a fallback (see [target resolution](#3-resolve-the-target-page)).

The current `daily` template's regions (from `read_page`) are:

| Region | Shape | Use |
|---|---|---|
| `schedule` | 15 ruled rows, `startHour ≈ 6` | the day's events, placed by `time` |
| `priorities` | 3 ruled rows | the 2–3 things that matter |
| `todo` | free-flow box | checkable items (`marker:"checkbox"`) |
| `notes` | ruled box | weather, Important/Tomorrow/Habits sections, or an image |
| `affirmation` | free box | the quote/line for her day |

> Region names are read from the template, not fixed. This live library still uses
> **`affirmation`** (the fixtures elsewhere rename it to `quote`). `read_page` is authoritative —
> use the names it returns and let `write_underlay` reject an unknown one.

---

## The nightly sequence (end-of-day task → tomorrow's page)

### 1. Health check
Call **`get_library` first.** If it returns the setup/`LibraryMissingError` message (the iCloud
mirror isn't present on this Mac yet), **stop and report** — do not retry or fabricate. Note that
iCloud sync is not instant: a write here reaches the iPad after a sync, not immediately.

### 2. Compute the target date
Tomorrow = run-date + 1 (absolute date — this runs overnight). Derive the chapter from the month:
target page = `Shared/<YYYY-MM>/<YYYY-MM-DD>`.

### 3. Resolve the target page
`list_pages chapter=<YYYY-MM>` and look for the date.

- **Found (the usual case)** — note its `aiStatus`. If `empty`, fill it. If already `ready`
  (a re-run, or the on-device author got there first), **prefer `merge`** to top it up rather
  than clobbering a good page.
- **Missing** — only at a **month rollover** (tomorrow is in a month the app hasn't generated
  yet, so the chapter has no pages). Fall back to `create_page` cloning the most recent existing
  daily sibling's template. (Calendar-chapter-aware creation — picking the right weekday template
  and respecting `deletedDays` — is an unbuilt roadmap item; sibling-clone is the workaround.)

### 4. Mark `refreshing`
Set `set_underlay_status … refreshing` (or write with `status:"refreshing"`) before a multi-step
build, so the app never composites a half-built page. Flip to `ready` only at the very end.

### 5. Gather real data — region → source
Pull *her* data; generic content is the tell that a page is machine-made (AUTHORING principle 1).

| Region / section | Source (CoWork's MCPs) |
|---|---|
| `schedule` | **Fantastical** — tomorrow's events. Pass each line `time:"HH:MM"` + the region's `startHour` (derive it from a filled sibling — currently ~6 — don't bake the time into the text). |
| `priorities` | top 2–3 from **Spark** (email) + **Obsidian** (tasks) + her own steer. |
| `todo` | **Obsidian** open to-dos, each `marker:"checkbox"`. |
| `notes` → weather | the **weather** MCP `get_forecast` for *her* location, tomorrow (the umbrella cue — today it's a text line; a Phosphor icon is a future upgrade). |
| `notes` → Important / Tomorrow / Habits | real stakes (a Spark thread, a bill) / day-after Fantastical events / the fixed habit list — each as a `heading` section, only on days it has content. |
| `affirmation` | a line that fits *her* day, not a fortune-cookie quote. |

### 6. Read geometry, compose, and **verify before committing**
`read_page` the target to learn its current regions/rows/`startHour`. Build the structured
`regions` payload (see AUTHORING for sections, themes, markers, wrap). Then:

1. **`dryRun:true`** — compose and read back the `warnings`. Overnight there's no human watching,
   so check for overflow (text past a region, more lines than rows, a wrap that overruns).
2. Resolve any warning (trim, `wrap:true`, fewer lines), then
3. `write_underlay` with `status:"ready"`.

### 7. Pick the theme to fit the day
`write_underlay` takes a `theme` (`gold`/`bright`/`cozy`/`editorial`) — a per-day creative
choice (AUTHORING has the table). **First read the template's `styled`/`palette` from `read_page`
and match its level** — this live `daily` is `styled:false` with an empty palette, so it's a bare
scaffold: go fuller, label the bare regions. Don't over-decorate a template that styles itself.

### 8. Optional art
For a sticker/illustration, follow the **generate → local file → `path`** recipe in AUTHORING
(make the image with any tool, land it on the Mac, pass a local `path` so ~1 MB never rides through
the model context). Guardrails: **PNG/JPEG only, ≤ 2 MB, no webp**, tucked into a corner of `notes`.

---

## The start-of-day refresh (today's page, merge)

Today's page already has last night's underlay. The morning task only **patches what changed**:
re-pull **Fantastical** (a meeting moved/added) and any urgent **Spark** item, then
`write_underlay` with **`merge:true`** on just the affected regions (e.g. `schedule`). `merge`
keeps every other region **verbatim**, so the to-dos and note you wrote last night survive. Light
touch — if nothing material changed, do nothing.

---

## Failure & degradation

- **Library missing** → stop and report (step 1). Never crash, never invent a path.
- **A data MCP is down** → fill what you *can* from the others and **never let the page read
  blank** (AUTHORING principle 2). A thin schedule with a rich right column still feels like a
  planner; one lonely line in a 15-hour grid looks broken.
- **Overflow warnings** → fix before `ready`, don't ship them.
- **Prefer structured `regions`** over raw `svg` always; only drop to raw SVG when structured
  input genuinely can't express something, and stay inside the app's element subset
  (`svg, g, rect, line, path, text, image, circle`).
- **Coexistence with the on-device author** — pages may carry a `<g data-author="onionskin-device">`
  group (Apple-Intelligence fill). That's expected; in `auto` mode the device defers to a fresh
  MCP drop. Just write normally — don't try to read or preserve that group by hand.

---

## Make the workflow better over time (the iteration loop)

A nightly job is only as good as its inputs and its prompt. **After each run, jot what felt
off** and fold a one-line fix back into the paste-in block below or the habit list:

- Wrong theme for the day's mood? → adjust the theme-picking guidance.
- A region overflowed repeatedly? → trim that source or default it to `wrap`.
- A noisy/irrelevant source (a Spark folder, an Obsidian tag)? → narrow the query.
- The habit list went stale? → edit it in the paste-in block.
- A section that's always empty? → stop emitting it.

The goal is that month two reads more like *her* than month one did — the prompt is a living
thing, not a fixed config.

---

## Paste into CoWork

Two short blocks. Drop the **End-of-day** block into the existing end-of-day task and the
**Start-of-day** block into the start-of-day task. Fill the `‹…›` placeholders once.

### Fixed inputs (set once)
- Weather location: `‹city / coords›`
- Habit list (checkboxes): `‹PT · Water · Food · Create · …›`
- Schedule `startHour`: `‹derive from a filled sibling — currently ~6›`
- The daily chapter is always the **current month** (`Shared/<YYYY-MM>`).

### End-of-day — build tomorrow's planner page
```
You orchestrate the Onionskin planner via the `onionskin` MCP; the MCP only renders.
Read docs/COWORK-WORKFLOW.md and docs/AUTHORING.md for full craft before composing.

1. get_library. If it returns a setup/missing message, STOP and tell me — do not retry.
2. Target = tomorrow's daily page: Shared/<YYYY-MM>/<YYYY-MM-DD> (absolute date, run+1).
3. list_pages chapter=<YYYY-MM>; find the date.
   - Found & empty  → fill it.
   - Found & ready  → merge to top it up (don't clobber).
   - Missing (month rollover) → create_page cloning the latest daily sibling's template.
4. Set status "refreshing".
5. read_page to learn regions, rows, and startHour (don't hard-code — names/geometry vary).
6. Gather REAL data — never invent:
     schedule    ← Fantastical (tomorrow); place by time:"HH:MM" + startHour ‹~6›.
     priorities  ← top 2–3 from Spark + Obsidian.
     todo        ← Obsidian open to-dos, marker:"checkbox".
     notes       ← weather MCP forecast for ‹location›; + Important/Tomorrow/Habits as
                   `heading` sections (only when they have content). Habits: ‹list›.
     affirmation ← a line that fits MY day, not a generic quote.
7. Pick a theme to fit the day's mood; match the template's styled/palette level.
8. dryRun:true first — read warnings, fix overflow — THEN write_underlay with status:"ready".
Non-negotiables: never leave the page reading blank; dryRun before ready; structured
`regions` not raw svg; never touch ink/stickers/template or Private/.
After the run, note anything that felt off so we can tweak this prompt.
```

### Start-of-day — refresh today's page
```
Light-touch morning refresh of TODAY's planner page via the `onionskin` MCP.

1. get_library (stop & report if missing).
2. Target = today's page: Shared/<YYYY-MM>/<YYYY-MM-DD>.
3. Re-pull Fantastical (moved/added meetings) and any urgent Spark item.
4. If something material changed: write_underlay with merge:true on ONLY the affected
   regions (usually `schedule`), status:"ready". merge keeps every other region verbatim.
5. If nothing material changed, do nothing.
Never clobber last night's to-dos/notes; never touch ink/stickers/template or Private/.
```

---

## Later upgrades (optional — not required for nightly)

From [`ROADMAP.md`](ROADMAP.md), two unbuilt items would most help *this* workflow:

1. **Phosphor weather icons** (2.1) — the north-star "umbrella in the corner." Today the weather
   note is text; an icon glyph would be the one visible upgrade.
2. **Calendar-chapter-aware `create_page`** — so the month-rollover create picks the right
   weekday template and respects `deletedDays` instead of blind-cloning a sibling.

Everything else the nightly job needs (merge, markers, time-aware schedule, wrap, themes, images,
dryRun, filters) already ships.
