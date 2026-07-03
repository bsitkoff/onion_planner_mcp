# Shared visual spec — LOCKED (mirrored in `../onionskin/design/FORMAT.md`)

> The contract between the two underlay authors (this MCP + the on-device sibling) is *visual
> parity*, not a shared engine. This pins the canonical values; the cross-author decisions that
> were open as **Q:** are now **resolved** (see each section + the summary at the end). Resolved
> 2026-06 against the shipped app (catalogue templates, on-device composer). The agreed parts
> (§0–4 + markers) are mirrored into `../onionskin/design/FORMAT.md`; §5–6 are MCP-only reference.
>
> Scope = the on-device author's subset: **schedule (agenda), to-do list, note band, monthly
> event markers.** §5–6 (banners/themes) are MCP behaviour, kept here so the boundary is explicit.

## 0. Global tokens

- **Gold — `#9C7C1A`, canonical (one value in the underlay).** Shared by the app chrome, this
  MCP, and the on-device composer (`colors.css`, `Palette.swift`, `FORMAT.md`). The former brand
  gold `#C9A227` is retired (converged 2026-06; `../onionskin/design/DECISIONS.md` #35). It is
  deepened so AI text stays legible on the cream page.
  - *Note (2026-06 redesign review):* the **chrome** additionally defines `--gold-ink #7E5C12`,
    an AA-tuned gold for *small text on light* (distinct from `--gold-1 #9C7C1A`, used for fills).
    The **underlay deliberately does not adopt the split** — both authors emit the single
    `#9C7C1A` here, so visual parity stays trivial. (The underlay text we emit is bold/large
    enough that `#9C7C1A` clears AA-large on cream; the second token is a chrome concern.)
- **Fonts (closed set):** `Mulish` (sans), `Newsreader` (serif), `IBM Plex Mono` (mono),
  `Caveat`, `Fredoka`, `Phosphor` (icons). Unknown families fall back to the serif.
- **Defaults:** body weight `600`; left inset `24px` from a region's left edge.
- **Solid fills only** (the renderer has no gradient support).
- **Two style axes (don't conflate):** a *template's* **style** — `minimal / cozy / colorful`,
  how rich the printed page is — is independent of the *underlay's* **theme** (§6), the day's
  mood. They pair naturally (minimal ↔ gold/editorial, cozy ↔ cozy, colorful ↔ bright) but are
  separate vocabularies on purpose.

## 1. Schedule (agenda)

- Text: **Mulish 15 / weight 600 / gold**.
- **Resolved — no template prints hour labels.** Verified across the catalogue (e.g.
  `daily-minimal` exposes `region-schedule` as ruled rows only, no `HH:00` gutter). So the
  schedule reads as a **sequential agenda**: place items by `row` (snap to a ruled line), or by
  clock `time` anchored via the region's `startHour` + `rowsPerHour` when the caller wants clock
  alignment. There is no printed hour gutter to clear, so the `52px` schedule inset now acts as a
  plain left margin (kept for breathing room; reduce to the `24px` default if a flush look is
  wanted — cosmetic, safe either way).
- Baseline: drop to `ruledLine + 0.40 × row-pitch` below the ruled line it lands on.

## 2. To-do list

- Text: **Mulish 15 / 600 / gold**.
- **Resolved — most templates print their own checkbox squares.** Verified: `todo-*` print a
  full column of `26×26` boxes; `daily-cozy` / `daily-colorful` print ~7 in their to-do region;
  `daily-minimal` prints none (ruled rows only). **Rule: inspect the template.** If it prints
  boxes, the author writes **text only**, aligned to the ruled rows — do *not* also draw a marker
  (that yields double boxes). If it prints none, the author may draw `marker: "checkbox"`.
- Checkbox marker (when author-drawn): square, side `round(0.85 × size)`, stroke
  `max(1, round(size/12))`, corner `rx 2`, `fill none`, gold stroke; box top = `baseline −
  side`; text starts at `box + round(0.4 × size)` past the left inset.

## 3. Note band

- Text: **Mulish 14 / 600 / gold**.
- **Resolved — wrap is on for free-text regions** (`ainotes`, and any unruled AI box). Stacking: first-line top
  pad `≈ 1.2 × size`; line leading `≈ 1.5 × size`; wrapped continuations `≈ 1.3 × size` below the
  baseline (they don't consume the next ruled row). Geometry follows the region `<rect>` (a single
  open band, or ruled lines when the template draws them).

## 4. Monthly event markers

- **Resolved — templates ship a blank grid, no printed day numbers.** Verified: `monthly-*`
  expose `region-month` with `data-cols="7" data-rows="6"` and no numbers. So an author (the app's
  default seed, or the MCP) draws the numbers **and** the tap targets:
- Day number: **Mulish 18 / 600 / accent (gold)**, at cell top-left — `x = cellLeft + 8`,
  `baseline = cellTop + 18 + 4`.
- Event label: **Mulish 12 / 500 / accent**, under the number (`baseline + 12 + 6`).
- Tap target: `<rect data-date="YYYY-MM-DD" fill="none">` covering the cell. **Both authors must
  emit this identically** — Sunday-start, matching the `SUN…SAT` headers.
- Event marker style: a small gold **dot** (`r 4`) on days with events, plus the optional text
  label; gold, not by-event-type (keep it quiet — the page styling carries the colour).

## 5. Banners / labels / headings — MCP only (reference)

> **Resolved — the on-device sibling draws no banners/labels** (content-only; it relies on the
> template's printed labels). So this section is MCP behaviour; on-device parity is §0–4 + markers.

- **Heading banner** (themed "banner" style): pill `<rect rx="6">` in the banner color,
  height `round(1.15 × size) + 6`, top `baseline − round(0.82 × size) − 3`; label **weight 700**,
  **letter-spacing 0.08em**, color `#FFFFFF`, inset `12px`. "Underline" style instead: bold
  label + hairline rule (`stroke = ink`, `opacity 0.4`) at `baseline + round(0.45 × size)`.
- **Region label** (title banner): same pill at **size 15 / weight 800 / letter-spacing 0.1em**.
  When the template prints a dashed label slot (`<rect data-region="label-<name>">` nested in
  the region's own `<g>`), the banner pill stretches to **fill that slot's box exactly**
  (underline style anchors its text off the slot's origin only, since it draws no box); when a
  template prints no slot, it falls back to the **margin above** the region (local baseline
  `y = −12`), unchanged from before.
- Pill width (no-slot fallback only): `round(len × size × 0.82) + 2 × 12` — deliberately
  generous (the app's bold, tracked label renders wider than the body-text width heuristic).

## 6. Themes (MCP underlay mood — the second axis)

The underlay mood is drivable two ways, both *defaults, not law* (any banner/text color is
overridable per element):

1. **Named presets** (quick pick / back-compat): `gold` (mono, underline headings), `bright`
   (teal/coral/pink/grape banners, `#3A3A3A` ink), `cozy` (rose/sage/gold/plum, `#4A4A4A` ink),
   `editorial` (terracotta/greige, underline).
2. **The adaptive param block** — `{ harmony, varietyDial, fontPersonality }`, the chapter-theme
   axis. **The contract keys are owned by the app's `FORMAT.md §4`** (`.folder.json → theme`); not
   restated here. MCP-side consumption:
   - **`harmony`** (`match`/`complement`/`warm`/`cool`/`seasonal`) derives the day's palette from
     the template's **own sampled colours** (`read_page`'s `template.palette`); empty → the
     Onionskin sticker palette, with a warning. Derived **text** roles are floored dark so they
     read on cream (legibility solved at derivation, not warned per write); banner fills are banded
     so white pill text reads.
   - **`varietyDial`** (0…1) scales banner count + saturation, and picks heading style
     (`<0.4` → quiet underline, else banner pills).
   - **`fontPersonality`** (`clean`/`handwritten`/`editorial`) swaps font families only (within the
     closed set: `clean`=Mulish/Newsreader, `handwritten`=Caveat/Fredoka, `editorial`=Newsreader-led)
     — an **orthogonal axis**, layered on any palette including the gold default.
   - **`chromeAccent`** is the app's concern (chrome only) — accepted and ignored.

`write_underlay` reads the chapter theme as the **default** and accepts per-call **overrides**
(field-by-field; a per-call preset name given alone wins outright). The app passes the same block
to the on-device composer.

> **Resolved — the MCP picks a per-day theme; the on-device sibling renders one quiet style**
> (the canonical gold, matched to the template). The MCP's theme is the underlay *mood* axis and
> is independent of the template's *style* (§0). The orchestrator picks the theme to fit the day,
> or sets it once on the chapter (see `AUTHORING.md`).

## 7. Washi-tape schedule blocks — MCP only

> **Resolved — MCP-only decoration.** The on-device sibling draws no duration blocks; this is
> underlay-authored, matching the app renderer's confirmed support for `rx` + `fill-opacity`.

A schedule line with `time` + (`endTime` or `durationMin`) draws a block instead of a single
baseline: rounded `<rect rx="6">` (reusing §5's one corner-radius convention) with
`fill-opacity` (default **0.22**, a translucent "tape" tint) instead of a solid fill — the only
element in this file to use `fill-opacity` rather than `opacity`. Tint defaults to the chapter's
`theme.accent` (the same per-line-override pattern as a label's `labelFill` over
`theme.banners[...]`), overridable per-block via `blockFill`. The label text sits vertically
centred inside the block at `y1 + height − round(height × 0.28)` — the same centring ratio as
§5's label-slot text. Left inset = the region's `xPad`; right edge = `region.width − xPad`
(mirroring the underline-heading rule's right-edge convention). A span partly outside the
region's ruled grid is pinned to fit and still drawn (warns `washi_block_clamped`); a
zero/negative-duration span isn't drawn at all (warns `washi_block_zero_duration`).

## Resolved decisions (consolidated)

1. **Gold:** `#9C7C1A` is canonical everywhere; `#C9A227` retired. (§0)
2. **Schedule:** no template prints hour labels → agenda placement (`row`, or `time` via
   `startHour`/`rowsPerHour`); the 52px inset is now just a margin. (§1)
3. **To-do:** most templates print their own checkboxes → author writes **text only** there;
   draw a marker only when the template prints none. (§2)
4. **Note band:** wrap **on** for `ainotes` (free-text AI box); geometry from the region rect. (§3)
5. **Monthly:** templates print no day numbers → author draws numbers + `data-date` rects;
   marker = gold dot (+ optional label). (§4)
6. **Banners:** MCP draws them; on-device is content-only. (§5)
7. **Theme:** the underlay mood is set by named presets *or* the adaptive `{ harmony, varietyDial,
   fontPersonality }` block (chapter `.folder.json → theme`, keys owned by app `FORMAT.md §4`);
   `write_underlay` reads the chapter theme as default + accepts per-call overrides. MCP picks the
   per-day theme; on-device renders one quiet/matched style. Template *style* and underlay *theme*
   stay independent axes. Underlay gold stays the single `#9C7C1A` (no fill/text split). (§0, §6)
8. **Washi-tape schedule blocks:** MCP-only, drawn via `time`+`endTime`/`durationMin`; tint
   defaults to `theme.accent`, `fill-opacity` default 0.22, `rx 6` reusing §5's corner radius;
   overflow clamps and warns rather than distorting the grid. (§7)
