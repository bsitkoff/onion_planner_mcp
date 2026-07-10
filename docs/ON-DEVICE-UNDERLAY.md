# The on-device underlay author (Apple Intelligence) — how it relates to this MCP

> Status: **shipped** in the Onionskin app (`main`). This documents how it coexists with this
> MCP and where the two collaborate. (Supersedes an earlier draft that wrongly framed it as a
> replacement/port of the MCP.)

## It's an additive sibling, not a replacement

The MCP stays **as-is, the rich primary authority**. The app also has a **smaller, opt-in,
on-device author** built on Apple Intelligence — a fallback for when there's no Mac/MCP at all
(the real use case: a **non-technical user's iPad**). Nothing in this MCP changed to enable
it; the two coexist.

## Coexistence

`Settings.underlay = off · mcpOnly (default) · deviceOnly · auto`. In `auto`, the device is a
"polite junior partner": it tags its own `ai.svg` output with an invisible
`<g data-author="onionskin-device">` group, and per page it **defers to a fresh MCP drop,
backfills empty/stale pages, and refreshes only its own**. Both authors write the same
`ai.svg` slot on different pages/times; they share **bytes on disk**, not a pipeline.

## What the on-device author deliberately does NOT do

It is intentionally much simpler than this MCP — and pushes the "never ask the model for
SVG/coordinates" principle further: the model doesn't orchestrate or call tools either.

- Deterministic **Swift** does all geometry **and** content selection (EventKit
  calendar→schedule, reminders→to-dos), read directly — not as model tools.
- The on-device **model's only job is the short prose note**, grounded in the day's real
  events/to-dos. Image Playground writes **one decorative PNG**.
- **No** Foundation Models tool-calling, **no** `@Generable` region schemas, **no** ported MCP
  tools (writing the underlay is a direct Swift call into the app's own page model), and **no**
  reproduction of this MCP's composition engine — no `label`/`heading` banners, markers, wrap,
  overflow warnings, or box flow. It fills a **fixed small set**: schedule-by-hour, to-do list,
  note band, monthly event markers, via the app's existing SVG writer.

So the rich region/theme model stays this MCP's domain. The **shared contract is the file
format** (`FORMAT.md`), not the engine — do not aim for engine-identical output.

## Write boundary differs by author (intentional)

The MCP stays **Shared-only** (Shared/Private exists to gate an *external* party). The
on-device author writes **any monthly calendar chapter, Shared or Private** — a user's own
device filling their own pages shouldn't need that gate. The boundary is now author-dependent
on purpose.

## Built vs. future

**Future / unbuilt:** WeatherKit note, habits/tomorrow data, App Intents / Siri / Shortcuts
invocation, `BGTaskScheduler` overnight runs, and a Vision / Core Image grey-knockout
**transparent-sticker** pipeline. (Today's on-device image is a decoration drop, not a
cut-out — the grey-background knockout currently lives only in the MCP-side image pipeline.)

## The collaboration point — visual parity

The on-device path doesn't need this MCP's engine; it needs to **look consistent** with MCP
output on the regions it fills — the resolved palette, fonts, `label`/`heading` style, spacing, region
layout. That visual spec, not a shared codebase, is the contract between the two authors.

**The spec is now locked** in [`SHARED-VISUAL-SPEC.md`](SHARED-VISUAL-SPEC.md) (parity decisions
resolved 2026-06) and its agreed parts (§0–4 + markers) are mirrored into
`../onionskin/design/FORMAT.md`. The on-device composer matches it on its subset (schedule
agenda, to-do text, note band, monthly markers) and draws **no banners** (§5 is MCP-only). Key
resolved points for this author: the chapter's own ink palette, lifted for the underlay (gold is retired); schedule is agenda-style (no
printed hour labels); write to-do **text only** where the template prints its own checkboxes;
render **one quiet default style**, not a per-day theme.
