# Authoring a daily page that feels like *the* planner

This is guidance for whatever **orchestrates** this server (a session, a nightly routine —
"Claude CoWork" in the [roadmap](ROADMAP.md)). The server is the rendering engine; it draws
exactly what you hand it. A page feels right or wrong based on *what you choose to put in
it*. This doc is how to choose.

The north star is Bridget's real Noteful planner: a day that's **full, specific, and hers**
— a scheduled day, a few real priorities, things that actually matter, a habit check, a
look at tomorrow, a genuine note. Not a sparse page of generic placeholders.

## First: read the template, match its level

Before anything else, look at what the template already provides. `read_page` hands you a
`template` summary — `{ styled, hasLabels, hasBanners, stickersPresent, palette }` — derived
from the SVG itself (so a user-authored template reads the same as a shipped one). **Match
its level; don't fight it.**

- **`styled: false`** (a bare scaffold — no labels, banners, or stickers): *go full.* Pick a
  `theme`, add structure and art, and label the bare regions — a **region title** uses the
  region's `label` (a banner drawn in the margin above it); a **sub-section inside a box**
  (Important / Tomorrow) uses a line with `heading`.
- **`styled: true`** (it prints its own banners/labels, or ships a `stickers.svg`): it did the
  decorating. *Fill quietly into the existing slots* — no competing banners, little or no
  added art. And don't fall back to drab gold: **use `template.palette`** (the template's own
  accent colors) for your text/markers so the fill harmonizes with the design.

When in doubt, under-decorate — the user chose that template on purpose.

## Two principles

**1. Pull her real data — don't invent it.** Generic content ("Try Elicit", a stock
affirmation, weather you guessed) is the tell that a page is machine-made. Source each
region from the MCPs the orchestrator already has:

| Region / section | Source |
|---|---|
| `schedule` | Google Calendar — the day's events (use `time` + `startHour`, below) |
| `priorities` | the 2–3 things that matter today — from tasks, email, her own steer |
| `todo` | obsidian-tasks / Noah / Leona task sources — concrete, checkable items |
| `notes` → weather | the weather MCP for *her* location, today (not a guess) |
| `notes` → "Important" | time-sensitive, real stakes (a bill, an order, a check-in) |
| `notes` → "Tomorrow" | tomorrow's calendar — a 2–3 line preview |
| `notes` → "Habits" | a fixed personal list (PT / Water / Food / Create …) as checkboxes |
| `quote` | something that fits *her* day, not a fortune-cookie line |

**2. Never let the page read as blank.** A light day is honest — summer, a weekend, a quiet
schedule — but an *empty page* looks broken. If the schedule is thin, lean into the other
sections: fill todos, run the habit row, preview tomorrow, write a real note. A near-empty
schedule with a rich right column and notes still feels like a planner; one lonely line in
a 15-hour grid does not.

## Pick a theme to fit the day

`write_underlay` takes a `theme` — the page palette (colored section banners, body ink,
accents, the quote color). **It is a per-day creative choice, not a fixed setting:** read
the day and pick the mood. A rainy December packed with meetings wants something different
from a wide-open summer beach day.

| theme | feel | good for |
|---|---|---|
| `bright` | lively, saturated banners | a fun, light, or celebratory day |
| `cozy` | warm, hand-painted | a calm, rainy, or homebound day |
| `editorial` | restrained, quiet labels | a heads-down, focused work day |
| `gold` | quiet monochrome (default) | when you want the underlay to recede |

> **Two axes — theme vs template style.** Your `theme` is the underlay's *mood* (the day's
> content). It is independent of the *template's* **style** — `minimal / cozy / colorful`, how
> rich the printed page already is (visible in the template's id/name, and surfaced as the
> `styled` flag + `palette` in the page summary). They pair naturally — **minimal ↔
> `gold`/`editorial`, cozy ↔ `cozy`, colorful ↔ `bright`** — so a sensible default is to echo a
> styled template with the matching theme (or its own `palette`), then deviate when the day calls
> for it. A loud theme on an already-colorful template competes; a quiet theme lets it breathe.

Let the rest of the page agree with the theme: a cozy rainy day might run a fuller schedule
and a tea/umbrella sticker; a bright summer day, a lighter schedule and a beach motif. The
theme, the content, and the art should tell one story about *that* day.

### Adaptive theme — harmonize to the template, set the variety + font

The named presets are one way to pick a mood; the other is the **adaptive param block**, which
makes the underlay *belong* to whatever template the user is on. These three knobs live on the
**chapter** (`.folder.json → theme`, contract owned by the app's `FORMAT.md §4`); `read_page`
hands them back to you as `theme`, and `write_underlay` applies them as the **default** — pass
the same names on the call to **override** for a single day.

| Param | Values | What it does |
|---|---|---|
| `harmony` | `match` · `complement` · `warm` · `cool` · `seasonal` | Derives the day's palette from the **template's own colours** (the server samples `template.palette` for you — you don't pass colours). `match` uses the template's swatches; `complement` plays off its dominant hue; `warm`/`cool` bias; `seasonal` nudges toward the season. Empty-palette (a minimal template) → the Onionskin sticker palette + a warning. |
| `varietyDial` | `0`…`1` | How much the surface rotates: `0` steady (one quiet accent, underline headings) … `1` surprising (fuller palette, banner pills). |
| `fontPersonality` | `clean` · `handwritten` · `editorial` | AI-text voice only (orthogonal to colour): `clean` = the default Mulish/Newsreader; `handwritten` = Caveat/Fredoka; `editorial` = Newsreader-led. |

So the usual flow is: **the chapter carries the mood** (set once), and you only pass theme params
when a given day wants to deviate. Derived text is always floored dark enough to read on the
cream page — you don't need to check contrast. `harmony` takes precedence over a preset `theme`
name; `chromeAccent` in the chapter theme is the app's chrome concern and is ignored here.

**Themes are defaults, not a lock — any color is yours.** Override a banner's color with a
region's `labelFill` (region title) or a heading line's `fill` (sub-section), and body text
with a line's `fill` — any hex. So an overnight job can drive an exact palette: e.g. all
banners as lighter→darker shades of one hue for a subdued, "same-family" look. Note: the app
renders **solid fills only** — no SVG gradients — so approximate a gradient with a family of
solids.

## Dynamic structure — sections, not a busy template

The template stays **minimal on purpose** (a neutral scaffold; see the
[minimal-template principle](MCP-INTEGRATION.md)). *You* add the structure a given day
needs, in the gold layer, so pages differ day to day. Inside a neutral box region (e.g.
`notes`), use `heading: true` to draw a section label (bold, letter-spaced, with a hairline
rule); the lines after it flow below as its items. Only emit a section on the days it has
content — no "Habits" header on a day you're not tracking habits.

```jsonc
{ "region": "notes", "lines": [
  { "text": "Important",  "heading": true },
  { "text": "Renew the parking pass", "marker": "bullet" },
  { "text": "Tomorrow",   "heading": true },
  { "text": "9:00 dentist; pack Leona's forms", "wrap": true },
  { "text": "Habits",     "heading": true },
  { "text": "PT",    "marker": "checkbox" },
  { "text": "Water", "marker": "checkbox" }
] }
```

Box regions flow top-down, so heading → items → next heading stack naturally; you don't
compute any `y`. Headings ignore `marker`/`wrap` (they're labels).

## Use the placement the server already does for you

- **Schedule by clock time, not coordinates.** Pass `startHour` (the hour at ruled row 0 —
  `7` on the current daily) and each line's `time: "HH:MM"`; the server snaps it to the
  right row. Use `rowsPerHour: 2` if the grid is half-hourly. Don't hand-compute `row`/`y`,
  and don't bake the time into the text — the grid already shows the hour.
- **`marker`** — `checkbox` for todos/habits, `bullet` for note items. Drawn shapes, no font
  dependency.
- **`wrap: true`** — long notes/previews wrap to the region width instead of overflowing.
- **`merge: true`** — a mid-day "update my planner" patches only the regions you pass and
  leaves the rest verbatim (slide a new meeting in without clearing the to-dos).
- **`dryRun: true`** — compose and read back the `warnings` first; an unattended/overnight
  write has no human watching, so check for overflow before you commit. Set status
  `refreshing` during a long multi-step build, `ready` only when the page is whole.

## Images (stickers / art)

A region's `images` take PNG/JPEG as base64 `data` **or** a local file `path`. For the
**overnight/automated** build, use `path`: the server reads the file off disk into the
page's `media/ai/` folder, so a ~1 MB PNG never passes through the model context.
Constraints: PNG/JPEG only, **≤ 2 MB** (no webp — the app rejects it), tucked into `notes`
or an empty corner like a sticker. Generation lives outside this server (it has no network).

**The sourcing recipe (generate the image however you like, land it on the Mac, embed by path):**

1. Generate a small square image with whatever image tool you use. Prompt for the planner
   look: soft watercolour / doodle / washi-sticker, simple subject. Prefer a tool that returns
   a **file path**, not base64, so a ~1 MB PNG never rides through the model context.
2. Make sure the file is on this Mac (e.g. saved or copied to `/tmp/onionskin-img.png`).
3. `write_underlay(page, regions=[{ region:"notes",
   images:[{ path:"/tmp/onionskin-img.png", width:140, corner:"bottom-right" }] }])` —
   `format` is sniffed; the server validates (≤2 MB) and copies it into `media/ai/`.

`small` (1024px) keeps it well under the 2 MB cap. Never route through
`convert_to_webp`/`get_generated_webp_images` — onionskin rejects webp (that path is for
WordPress). More detail in the project memory (`onionskin-image-gen-pipeline`).

## Smell test before `ready`

- Could this page belong to *anyone*, or is it clearly Bridget's day? (Names, real stakes.)
- If the schedule is light, does the rest of the page still make it feel full?
- Did any region come back with overflow `warnings`?
- Is every section here because the day actually needed it — or is it furniture?
