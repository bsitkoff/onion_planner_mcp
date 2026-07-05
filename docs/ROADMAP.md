# onion-planner-mcp — Roadmap

This server is the **placement/rendering engine**, not the orchestrator. It is
filesystem-first: the planner contract is plain files in iCloud, and the data (calendar
events, weather, email-derived to-dos, generated art) comes from *other* MCPs that an
orchestrator (e.g. Claude CoWork) gathers. The one network-capable helper, `fetch_image`,
only downloads HTTPS PNG/JPEG files to local temp paths for filesystem embedding. Our job is
to render everything beautifully and safely into `ai.svg`. The north-star scenario:

> Overnight, the planner is set: the schedule is filled from the calendar, a weather note +
> umbrella mark sit in a corner, email-derived to-dos appear next to checkboxes, a
> motivational image tucks into the notes. Midmorning, "update my planner" slides new
> meetings into place without disturbing any of it.

**This file holds planned feature development only.** Shipped history lives in
[`CHANGELOG.md`](CHANGELOG.md); bugs, polish, and discussion live on the
[issue tracker](https://github.com/bsitkoff/onion_planner_mcp/issues). Every planned item
below links its issue — detail, sketches, and open decisions live there, not here.

### Locked design decisions

1. **All AI-authored decoration lives in `ai.svg`** — weather/umbrella as drawn marks or
   Phosphor glyphs, generated art as an embedded `<image>`. Never `stickers.svg` (the
   user's layer). "Sticker" is the user's mental model, not a literal write.
2. **Incremental updates are region-level merges** — `write_underlay` patches named regions
   and preserves the rest, so "slide a meeting in" doesn't clobber the day's other content.

### Invariants every item must respect

- Only ever write `ai.svg` + the manifest's `layers.ai` block (+ `modified`) + the page's
  **`media/ai/`** subfolder (AI-owned art); on create, the new page's own files + chapter
  `.folder.json`; via `set_chapter_theme`, the chapter `.folder.json → theme` block. Never
  touch ink/stickers/template, the rest of `media/`, or Private.
- All writes through `resolvePageRel` (Shared/ containment) + `atomicWrite`.
- No app/network API for planner state. Re-read `manifest.size` per page; geometry comes from
  each page's template.
- Closed font set (`Mulish, Newsreader, IBM Plex Mono, Caveat, Fredoka, Phosphor`).

---

## Planned — near-term (friction from the 2026-07-05 morning-run audit)

Ordered by leverage for the unattended nightly/morning runs:

1. **Page preview render** — rasterize the composed page to a PNG temp path so an unattended
   run can *see* what it wrote (every recent failure a human caught by eye would have been
   visible); day-end wants the same composite for ink cross-checks. Rasterizer-dependency
   decision lives in the issue. [#7](https://github.com/bsitkoff/onion_planner_mcp/issues/7)
2. **Server-side image downscale / fit-to-region sizing** — absorb the "resize it yourself
   with Python" chore the same way the server absorbed background knockout; `fit: "region"`
   ends hand-computed widths. [#8](https://github.com/bsitkoff/onion_planner_mcp/issues/8)
3. **Expose the template's printed text via `read_page`** — so an orchestrator can see that
   the template already prints the date/labels instead of memorizing "don't double-write the
   date" in skill prose. [#9](https://github.com/bsitkoff/onion_planner_mcp/issues/9)
4. **Region recommended-image-size signal** — replace the 35%-of-box heuristic behind
   `image_small_for_region` with a declared floor (template `data-*` key or per-intent
   default). [#10](https://github.com/bsitkoff/onion_planner_mcp/issues/10)

## Planned — blocked on the app

- **Phosphor weather/decoration glyphs** (`umbrella`, `sun`, `cloud`, `check`, `star`) —
  plumbing shipped; waiting on the app's `Phosphor.swift` to publish the codepoints.
  [#11](https://github.com/bsitkoff/onion_planner_mcp/issues/11)
- **Full-text / handwriting search** (`textContains` on `list_pages`) — needs the app-side
  OCR data source; the where-does-recognized-text-live decision is recorded in the issue.
  [#12](https://github.com/bsitkoff/onion_planner_mcp/issues/12)
- **`resolvePageRel` change when the app retires the Shared/ gate (app C7/E2)** — standing
  cross-repo coupling, same-release change, nothing to do until the app's E2 lock ships.
  [#13](https://github.com/bsitkoff/onion_planner_mcp/issues/13)

## Parked

Revisit only on a real pain point: **bulk authoring**
[#14](https://github.com/bsitkoff/onion_planner_mcp/issues/14) · **MCPB bundling**
[#15](https://github.com/bsitkoff/onion_planner_mcp/issues/15) · **`ai.svg` history/undo**
[#16](https://github.com/bsitkoff/onion_planner_mcp/issues/16). New template types/regions
are owned by the app (the server follows once templates ship); a live `Shared/` watcher and
the on-device underlay author are app-side (the latter **shipped** — see
[`ON-DEVICE-UNDERLAY.md`](ON-DEVICE-UNDERLAY.md)).

## Verification

`npm run smoke` (self-seeding e2e; the run prints its own pass/fail count — don't pin the
number here, it grows every pass) · `npm run call -- <tool> [args]` (drive a tool in a fresh
process) · `npx tsc --noEmit`. Keep the smoke test deriving coordinates and region names from
parsed geometry — the fixtures keep changing.
