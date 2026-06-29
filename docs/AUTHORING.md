# Authoring a daily page that feels like *the* planner

This is guidance for whatever **orchestrates** this server (a session, a nightly routine —
"Claude CoWork" in the [roadmap](ROADMAP.md)). The server is the rendering engine; it draws
exactly what you hand it. A page feels right or wrong based on *what you choose to put in
it*. This doc is how to choose.

The north star is a real, lived-in paper planner: a day that's **full, specific, and the user's own**
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

## Who fills a region — `fill` and `intent`

Ownership in Onionskin is by *layer* — you write `ai.svg`, the user owns `ink.svg`
(handwriting) and `stickers.svg`, and they composite on top of you, so you never collide on
disk. But not every region is yours to fill, and **you can't assume any particular region
exists** — a template may have a `schedule` and an `ainotes`, or it may be a meal planner, a mood
tracker, a sketchbook page with regions you've never seen. So **don't look for known names;
read each region's `fill` and `intent`** (`read_page` hands you both) and honour what's there.

**`fill` — who fills it** (the behaviour axis: `ink` / `ai` / `shared`). Derived (an explicit
`data-fill` wins; else the region name, template type, then geometry), so you don't compute it.

| `fill` | Who it's for | What you do |
|---|---|---|
| **`ai`** | you | Fill it — a daily message, a title, freeform structure. |
| **`shared`** | you seed, the user augments | Seed it from real data (calendar, tasks). **`read_ink` first** and place *around* rows the user already wrote on — never clobber their hand. They add more on top. |
| **`ink`** | the user's pencil | **Leave the writing surface alone.** Light scaffolding only: a dated header, a faint section prompt (`heading: true`), or a small corner sticker/art. Body text into a ruled `ink` region trips an `ink_region_filled` warning. |

**`intent` — what the designer imagined** (free text, or `null`). A region may carry a
human-readable note like `"this week's dinners, one row per day"` or `"three things I'm grateful
for"`. Read it to fill the region *as the designer pictured it*, sourcing real data to match —
even for a region type the server has no built-in knowledge of. **It's advisory: you're free to
repurpose** a block when the day (or the user) calls for it. `intent` is never enforced; only
`fill` carries a (soft) behavioural nudge.

> Geometry is *not* who-fills. Reflection regions (`joys`, `concerns`, `morning`/`evening`,
> `memories`) are ruled or dotted yet they're the user's; `schedule`/`todo` are ruled yet
> AI-seeded. So don't reason from "lined vs blank" — read the region's `fill`.

**The loop for any template:** for each region, skip `ink` (scaffold only); for `ai`/`shared`,
fill it from real data guided by its `intent` (or, absent an `intent`, its name + shape); and
**skip a region entirely if you have nothing real for it** — an empty honest region beats a
generic filled one. Don't expect a fixed set of sections.

**Shared *within* a region already works.** A `shared` box flows your content top-down in the
whitespace (a preview, a weather note), leaving the ruled lines below free for the user's ink —
so one region can hold both your seed and their hand.

## Two principles

**1. Pull the user's real data — don't invent it.** Generic content (a stock suggestion, a
canned affirmation, weather you guessed) is the tell that a page is machine-made. Source each
region from the MCPs the orchestrator already has:

| Region / section | Source |
|---|---|
| `schedule` | the user's calendar — the day's events (use `time`; the template's `data-start-hour` anchors it) |
| `todo` | whatever task sources the orchestrator has — concrete, checkable items; **star the 2–3 that matter most** with a leading ★ in the text (priorities are folded in here, no separate region) |
| `ainotes` → weather | a weather source for *the user's* location, today (not a guess) |
| `ainotes` → "Important" | time-sensitive, real stakes (a bill, an order, a check-in) |
| `ainotes` → "Tomorrow" | tomorrow's calendar — a 2–3 line preview |
| `ainotes` → "Habits" | a fixed personal list (PT / Water / Food / Create …) as checkboxes |
| `ainotes` → affirmation | a line that fits *the user's* day, not a fortune-cookie one |
| `focus` (monthly) | the month's goals/intentions — from the user's own steer |

This table is the *intent*, not a guarantee — it's how these regions are typically used, not what
each template marks them as. Since the 2026-06 redesign, **`notes` is the user's handwriting
surface (`fill: ink`) on every template** — don't write into it; the AI's text home is `ainotes`
(`fill: ai`). So **read each region's `fill` from `read_page` and `read_ink` first** (see "Who
fills a region" above) rather than assuming any region is yours; on a `shared` region, seed in the
whitespace and leave the ruled lines for ink.

**2. Never let the page read as blank.** A light day is honest — summer, a weekend, a quiet
schedule — but an *empty page* looks broken. If the schedule is thin, lean into the other
sections: fill todos, run the habit row, preview tomorrow, write a real note. A near-empty
schedule with a rich right column and notes still feels like a planner; one lonely line in
a 15-hour grid does not.

## Pick a theme to fit the day

`write_underlay` takes a `theme` — the page palette (colored section banners, body ink,
accents, the ainotes serif color). **It is a per-day creative choice, not a fixed setting:** read
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
  { "text": "9:00 dentist; pack the forms", "wrap": true },
  { "text": "Habits",     "heading": true },
  { "text": "PT",    "marker": "checkbox" },
  { "text": "Water", "marker": "checkbox" }
] }
```

Box regions flow top-down, so heading → items → next heading stack naturally; you don't
compute any `y`. Headings ignore `marker`/`wrap` (they're labels).

## Use the placement the server already does for you

- **Schedule by clock time, not coordinates.** Give each line a `time: "HH:MM"`; the server
  snaps it to the right row using the template's own `data-start-hour`/`data-rows-per-hour`
  (the `schedule`/`agenda` regions self-describe their grid — `7`/`1` on the current daily),
  surfaced as `startHour`/`rowsPerHour` on the region from `read_page`. Pass a per-call
  `startHour`/`rowsPerHour` only to override. Don't hand-compute `row`/`y`, and don't bake the
  time into the text — the grid already shows the hour.
- **`marker`** — `checkbox` for todos/habits, `bullet` for note items. Drawn shapes, no font
  dependency.
- **`wrap: true`** — long notes/previews wrap to the region width instead of overflowing.
- **Raw per-region `svg`** — when `lines` placement isn't enough, give a region a raw `svg`
  string instead; it's emitted verbatim inside that region's group and composes/merges like
  any region (mutually exclusive with `lines`/`calendar`). Stay within the renderer's
  elements (svg/g/rect/line/path/text/image/circle); an `<image href>` here is **not**
  media-resolved, so use the structured `images` array for art. Reach for this rarely — the
  structured placement above is what keeps you aligned to the geometry.
- **`merge: true`** — a mid-day "update my planner" patches only the regions you pass and
  leaves the rest verbatim (slide a new meeting in without clearing the to-dos).
- **Write once, then check `warnings`.** A real `write_underlay` returns the same `warnings`
  a `dryRun` would, so you don't need a separate preview pass — and emitting the whole
  `regions` payload twice is the slowest part of an unattended run. Write with status `ready`,
  read the returned `warnings`, and **only if one fires** patch the affected region with a
  `merge: true` re-write. Reserve **`dryRun: true`** for when you genuinely want to preview
  without writing (it's the one call that returns the composed `aiSvg`; a real write omits it).
  Set status `refreshing` during a long multi-step build, `ready` only when the page is whole.
- **Reuse geometry across a chapter.** Sibling pages in a chapter share one `template.svg`,
  so the region names, ruled rows, and `startHour` from a single `read_page` apply to every
  page in that chapter. When filling several pages in one run (backfill / month rollover),
  `read_page` once and reuse it — don't re-read per page.

## Images (stickers / art)

A region's `images` take PNG/JPEG as base64 `data` **or** a local file `path`. For the
**overnight/automated** build, use `path`: the server reads the file off disk into the
page's `media/ai/` folder, so a ~1 MB PNG never passes through the model context.
Constraints: PNG/JPEG only, **≤ 2 MB** (no webp — the app rejects it), tucked into `notes`
or an empty corner like a sticker. Generation lives outside this server; `fetch_image` is only
a bridge from an HTTPS image URL to a local temp file for `images[].path`.

**The sourcing recipe (generate the image however you like, land it on the Mac, embed by path):**

1. Generate a small square image with whatever image tool you use. Prompt for the planner
   look: soft watercolour / doodle / washi-sticker, simple subject. Prefer a tool that returns
   a **file path**, not base64, so a ~1 MB PNG never rides through the model context.
2. Make sure the file is on this Mac (e.g. saved or copied to `/tmp/onionskin-img.png`).
   If the source is an HTTPS PNG/JPEG URL, `fetch_image` can download it to
   `/tmp/onionskin-fetch/`; optional `removeBackground` requires `rembg` and may increase file
   size, so the output is re-checked against the same 2 MB cap.
3. `write_underlay(page, regions=[{ region:"notes",
   images:[{ path:"/tmp/onionskin-img.png", width:140, corner:"bottom-right" }] }])` —
   `format` is sniffed; the server validates (≤2 MB) and copies it into `media/ai/`.

`small` (1024px) keeps it well under the 2 MB cap. Never route through
`convert_to_webp`/`get_generated_webp_images` — onionskin rejects webp (that path is for
WordPress). More detail in the project memory (`onionskin-image-gen-pipeline`).

## Smell test before `ready`

- Could this page belong to *anyone*, or is it clearly this person's day? (Names, real stakes.)
- If the schedule is light, does the rest of the page still make it feel full?
- Did any region come back with overflow `warnings`?
- Is every section here because the day actually needed it — or is it furniture?
