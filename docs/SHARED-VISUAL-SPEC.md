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

- **Gold — `#9C7C1A`, canonical.** One value, shared by the app chrome, this MCP, and the
  on-device composer (`colors.css`, `Palette.swift`, `FORMAT.md`). The former brand gold
  `#C9A227` is retired (converged 2026-06; `../onionskin/design/DECISIONS.md` #35). It is
  deepened so small AI text stays legible on the cream page.
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
- **Resolved — wrap is on for free-text regions** (`notes`, `quote`). Stacking: first-line top
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
- **Region label** (title banner): same pill at **size 15 / weight 800 / letter-spacing 0.1em**,
  drawn in the **margin above** the region (local baseline `y = −12`).
- Pill width: `round(len × size × 0.82) + 2 × 12` — deliberately generous (the app's bold,
  tracked label renders wider than the body-text width heuristic).

## 6. Themes (MCP underlay mood — the second axis)

Themes are *defaults, not law* — any banner/text color is overridable per element. Current set:
`gold` (mono, underline headings), `bright` (teal/coral/pink/grape banners, `#3A3A3A` ink),
`cozy` (rose/sage/gold/plum, `#4A4A4A` ink), `editorial` (terracotta/greige, underline).

> **Resolved — the MCP picks a per-day theme; the on-device sibling renders one quiet style**
> (the canonical gold, matched to the template). The MCP's theme is the underlay *mood* axis and
> is independent of the template's *style* (§0). The orchestrator picks the theme to fit the day
> (see `AUTHORING.md`).

## Resolved decisions (consolidated)

1. **Gold:** `#9C7C1A` is canonical everywhere; `#C9A227` retired. (§0)
2. **Schedule:** no template prints hour labels → agenda placement (`row`, or `time` via
   `startHour`/`rowsPerHour`); the 52px inset is now just a margin. (§1)
3. **To-do:** most templates print their own checkboxes → author writes **text only** there;
   draw a marker only when the template prints none. (§2)
4. **Note band:** wrap **on** for `notes`/`quote`; geometry from the region rect. (§3)
5. **Monthly:** templates print no day numbers → author draws numbers + `data-date` rects;
   marker = gold dot (+ optional label). (§4)
6. **Banners:** MCP draws them; on-device is content-only. (§5)
7. **Theme:** MCP picks a per-day theme; on-device renders one quiet/matched style. Template
   *style* and underlay *theme* are independent axes. (§6)
