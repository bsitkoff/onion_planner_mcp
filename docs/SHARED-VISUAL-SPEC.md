# Shared visual spec — DRAFT for `FORMAT.md`

> The contract between the two underlay authors (this MCP + the on-device sibling) is *visual
> parity*, not a shared engine. This draft pins the MCP's **current** values and flags every
> cross-author decision as **Q:**. It is **not locked** — the banner/label/theme values are
> from this session and the widened banners aren't confirmed on device yet. Resolve the Q's,
> lock, then move the agreed parts into `../onionskin/design/FORMAT.md` and port the on-device
> composer to match on the regions it fills.
>
> Scope = the on-device author's subset: **schedule (hourly), to-do list, note band, monthly
> event markers.** §5–6 (banners/themes) are MCP reference, included only to settle whether
> the device touches them.

## 0. Global tokens

- **Gold.** MCP default `#9C7C1A` (deepened for legibility on white). App/brand authoritative
  `#C9A227` (`colors.css`, `Palette.swift`, `FORMAT.md`).
  **Q: which is canonical for parity** — converge both authors on one value, or keep `#9C7C1A`
  as the shared "ink" default and reserve `#C9A227` for brand chrome?
- **Fonts (closed set):** `Mulish` (sans), `Newsreader` (serif), `IBM Plex Mono` (mono),
  `Caveat`, `Fredoka`, `Phosphor` (icons). Unknown families fall back to the serif.
- **Defaults:** body weight `600`; left inset `24px` from a region's left edge.
- **Solid fills only** (the renderer has no gradient support).

## 1. Schedule (hourly)

- Text: **Mulish 15 / weight 600 / gold**.
- **Left inset 52px** (clears printed hour numbers in the gutter).
- Baseline: drop to `ruledLine + 0.40 × row-pitch` below the ruled line it lands on.
- **Q: do the on-device daily templates print hour labels in a left gutter** (forcing the
  52px inset), and over what range? (MCP's live daily grid = **7→21**, i.e. 7a–9p, 1 row/hr.)
- **Q: does the device place items by clock time (snap to nearest hour row) or as a sequential
  agenda list?** (Templates *without* printed hours read better as an agenda.)

## 2. To-do list

- Text: **Mulish 15 / 600 / gold**.
- Checkbox marker (when author-drawn): square, side `round(0.85 × size)`, stroke
  `max(1, round(size/12))`, corner `rx 2`, `fill none`, gold stroke; box top = `baseline −
  side`; text starts at `box + round(0.4 × size)` past the left inset.
- **Q: does the device draw its own checkboxes, or do the to-do templates already print
  checkbox squares** (so the device writes only the text, aligned to rows)? (MCP's cozy/minimal
  templates print their own; the legacy daily did not — drawing both = double boxes.)

## 3. Note band

- Text: **Mulish 14 / 600 / gold**.
- Stacking: first-line top pad `≈ 1.2 × size`; line leading `≈ 1.5 × size`; wrapped
  continuations `≈ 1.3 × size` below the baseline (don't consume the next row).
- **Q: does the device wrap long notes to the band width, and what is the band geometry**
  (a single open band vs ruled lines)?

## 4. Monthly event markers

- Day number: **Mulish 18 / 600 / accent (gold)**, at cell top-left — `x = cellLeft + 8`,
  `baseline = cellTop + 18 + 4`.
- Event label: **Mulish 12 / 500 / accent**, under the number (`baseline + 12 + 6`).
- Tap target: `<rect data-date="YYYY-MM-DD" fill="none">` covering the cell (the app's
  tap-to-day). **Both authors must emit this identically** if either writes the month grid.
- **Q: do monthly templates already print the day numbers?** If so the device (and the MCP)
  should add only the event label + `data-date` rect, not re-draw the number (same double-up
  risk as banners-on-a-styled-template).
- **Q: event marker style — text label, colored dot, or both; and what color** (gold, or by
  event type)?

## 5. Banners / labels / headings — MCP region system (reference)

- **Heading banner** (themed "banner" style): pill `<rect rx="6">` in the banner color,
  height `round(1.15 × size) + 6`, top `baseline − round(0.82 × size) − 3`; label **weight 700**,
  **letter-spacing 0.08em**, color `#FFFFFF`, inset `12px`. "Underline" style instead: bold
  label + hairline rule (`stroke = ink`, `opacity 0.4`) at `baseline + round(0.45 × size)`.
- **Region label** (title banner): same pill at **size 15 / weight 800 / letter-spacing 0.1em**,
  drawn in the **margin above** the region (local baseline `y = −12`).
- Pill width: `round(len × size × 0.82) + 2 × 12` — deliberately generous (the app's bold,
  tracked label renders wider than the body-text width heuristic).
- **Q: does the on-device author draw any banners/labels at all, or only fill content**
  (relying on template-printed labels)? If content-only, §5 is MCP-only and parity is just
  §0–4 + markers.

## 6. Themes (MCP)

Themes are *defaults, not law* — any banner/text color is overridable per element. Current set:
`gold` (mono, underline headings), `bright` (teal/coral/pink/grape banners, `#3A3A3A` ink),
`cozy` (rose/sage/gold/plum, `#4A4A4A` ink), `editorial` (terracotta/greige, underline).
- **Q: does the device pick a theme/mood per day like the MCP, or render one quiet style**
  (gold, or matched to the template's own palette)?

## Open questions (consolidated)

1. Canonical **gold** for parity (`#9C7C1A` vs `#C9A227`)? (§0)
2. Do daily templates print **hour labels**; clock-snap vs agenda for the schedule? (§1)
3. Do to-do templates print **checkboxes** (author draws text only)? (§2)
4. Note band: **wrap** + geometry? (§3)
5. Do monthly templates print **day numbers**; event marker style/color? (§4)
6. Does the device draw **banners/labels** at all, or content-only? (§5)
7. Does the device pick a **theme**, or one quiet/matched style? (§6)
