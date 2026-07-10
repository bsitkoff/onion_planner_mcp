import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveRoot } from "./paths.js";
import {
  requireLibrary,
  listChapters,
  listPageRows,
  readUnderlayVoice,
  LibraryMissingError,
} from "./library.js";
import {
  readPage,
  readInk,
  writeUnderlay,
  setStatus,
  clearUnderlay,
  createPage,
  writeChapterTheme,
  fetchImageToTemp,
} from "./page.js";
import { PHOSPHOR_CODEPOINTS } from "./svg.js";
import { PALETTE_CHARACTERS } from "./color.js";

const PALETTE_CHARACTER_IDS = Object.keys(PALETTE_CHARACTERS) as [string, ...string[]];

const server = new McpServer(
  {
    name: "onionskin",
    version: "1.0.0",
  },
  {
    instructions:
      "Onionskin is a planner whose pages are folders of SVG layers in an iCloud " +
      "folder. You write the 'ai.svg' AI underlay (schedule, to-dos, focus, and the " +
      "ainotes AI-voice block) into pages under Shared/, then mark it ready — the app " +
      "composites it on next foreground. Always call get_library first, then read_page " +
      "to learn a page's regions before write_underlay (region names vary by template). " +
      "You can ONLY touch Shared/ pages; Private/ is invisible, and you never write the " +
      "user's ink or sticker layers. Prefer write_underlay's structured `regions` input " +
      "(the server positions text from template geometry); use `merge` to update only " +
      "some regions, `dryRun` to preview. Use raw `svg` only when you need full control.",
  },
);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

// --- get_library ---
server.tool(
  "get_library",
  "Resolve and validate the Onionskin iCloud library. Returns the library root path, " +
    "whether it exists, the chapters under Shared/ with page counts, and the global " +
    "underlayVoice setting (name/tone/notes for personalizing the ainotes note), if set. " +
    "Call this FIRST. If the library is missing, its error explains how to fix it (run the " +
    "app once, or set ONIONSKIN_CONTAINER).",
  {},
  { readOnlyHint: true },
  async () => {
    try {
      const root = await requireLibrary();
      const chapters = await listChapters(root);
      const underlayVoice = await readUnderlayVoice(root);
      return json({ root, exists: true, sharedChapters: chapters, underlayVoice });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return {
          ...json({ root: e.root, exists: false, problem: e.message }),
          isError: true as const,
        };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- list_pages ---
server.tool(
  "list_pages",
  "List shared pages with metadata and current AI-layer status, optionally filtered. " +
    "Each result's `page` is the relative path used by all other tools (e.g. " +
    "\"Shared/Daily/2026-02-06\"). Does NOT return layer contents — call read_page for a " +
    "page's regions and current ai.svg. Filters combine with AND.",
  {
    chapter: z
      .string()
      .optional()
      .describe(
        'Optional chapter to filter by. Either the bare name ("2026-06") or the path ' +
          'get_library returns ("Shared/2026-06") works. Omit for all chapters.',
      ),
    template: z
      .string()
      .optional()
      .describe('Keep only pages with this template id, e.g. "daily-minimal".'),
    aiStatus: z
      .enum(["empty", "refreshing", "ready"])
      .optional()
      .describe('Keep only pages whose ai-layer is in this state. "empty" = not yet authored.'),
    titleContains: z
      .string()
      .optional()
      .describe("Case-insensitive substring match on the page title."),
    modifiedAfter: z
      .string()
      .optional()
      .describe('ISO date/datetime; keep pages whose manifest.modified is on/after this.'),
    modifiedBefore: z
      .string()
      .optional()
      .describe('ISO date/datetime; keep pages whose manifest.modified is strictly before this.'),
  },
  { readOnlyHint: true },
  async ({ chapter, template, aiStatus, titleContains, modifiedAfter, modifiedBefore }) => {
    try {
      const root = await requireLibrary();
      const { rows, notes } = await listPageRows(root, {
        chapter,
        template,
        aiStatus,
        titleContains,
        modifiedAfter,
        modifiedBefore,
      });
      return json({
        count: rows.length,
        pages: rows,
        ...(notes.length ? { notes } : {}),
      });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- read_page ---
server.tool(
  "read_page",
  "Read one shared page: its manifest, parsed regions (name, x, y, width, height, rows, " +
    "cols, startHour/rowsPerHour for timed grids, a `list` bucket, absolute ruled-line " +
    "positions, a `fill`, a free-text `intent`, `printedText` — the template's own <text> " +
    "content already drawn inside this region (a section label, chrome like \"TODAY\"/\"DATE\", " +
    "a weekday header, hour-line numbers), in document order, empty if the template prints " +
    "nothing here; check it before writing a line so you don't double-write content the " +
    "template already shows (e.g. the date under a template that already prints \"TODAY\"), " +
    "`imageFloor` — the {width,height} a centered image below trips `image_small_for_region` " +
    "in this region (245×245 when `intent` marks it interactive, e.g. a habit tracker the " +
    "user pencil-checks; else 35% of the box), so you can size an image right the first time " +
    "instead of iterating on the warning — and `labelFilled` — whether a region's " +
    "printed label slot, if it has one, actually has a label banner drawn into it yet " +
    "(null if the region has no slot; false means the template prints a slot but nothing's " +
    "there — don't assume a slot means content exists, pass `label` to fill it)), current ai.svg, " +
    "and a `template` summary, and optionally template.svg. Use the regions to target " +
    "write_underlay — never hard-code coordinates. Each region's `fill` says who fills it: " +
    "`ai` (you own it — fill it), `shared` (you seed it — calendar/tasks — but read_ink first " +
    "and place around the user's handwriting), or `ink` (the user's handwriting surface — " +
    "leave it; do light scaffolding only, a heading/prompt or a corner sticker, never body " +
    "text). `intent` is the designer's free-text note on what the region is for (e.g. \"this " +
    "week's dinners, one row per day\") — read it to fill the region as imagined, but you're " +
    "free to repurpose; it's null when the template set none. Honour each region by its `fill` " +
    "+ `intent` rather than expecting specific names (not every template has ainotes/todo). " +
    "`template` reports whether the template already decorates itself " +
    "(`styled`/`hasLabels`/`hasBanners`/`stickersPresent`), its own `palette`, and its " +
    "`paperColor` (the page's paper/background colour — generate soft-edged art on this to " +
    "place it opaque with no knockout/halo; see docs/AUTHORING.md): if styled, fill quietly " +
    "in those colours; if bare, go full (theme + banners + art). Also returns " +
    "the chapter's `theme` (paletteCharacter/customInk1/customInk2/harmony/varietyDial/" +
    "fontPersonality + an explicit `accent` + chromeAccent + displayName), which " +
    "write_underlay applies as the default palette/fonts unless you override it per call " +
    "(set it with set_chapter_theme), and `underlay` — the RESOLVED palette a default " +
    "write will use (lifted + contrast-floored hexes: text/serif/accent/banners/" +
    "headingStyle + the chromeAccent-derived washiTint). Pick per-line `fill`s from " +
    "`underlay` so your colours stay in the chapter's family.",
  {
    page: z
      .string()
      .describe('Relative page path from list_pages, e.g. "Shared/Daily/2026-02-06".'),
    includeTemplate: z
      .boolean()
      .default(false)
      .describe("Include the raw template.svg in the response. Usually unnecessary."),
  },
  { readOnlyHint: true },
  async ({ page, includeTemplate }) => {
    try {
      const root = await requireLibrary();
      return json(await readPage(root, page, includeTemplate));
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- read_ink ---
server.tool(
  "read_ink",
  "Read a shared page's ink.svg — the user's handwritten layer. Use this to see what the " +
    "user has already written before composing the AI underlay, or to pick up handwritten " +
    "notes and annotations. By default the bulky per-stroke `data-stroke` centerline " +
    "streams are stripped (the visible outline geometry remains); set `includeStrokeData` " +
    "for the verbatim file. Returns null if no ink file exists. Read-only; never modifies " +
    "any layer. Refuses any page outside Shared/. Also refuses when the chapter marks its " +
    "ink private (`permissions.inkReadable: false` in its .folder.json; reflection chapters " +
    "default private) — the underlay can still be written, just not composed from handwriting.",
  {
    page: z
      .string()
      .describe('Relative page path, e.g. "Shared/2026-06/2026-06-26".'),
    includeStrokeData: z
      .boolean()
      .default(false)
      .describe(
        "Include each stroke's raw data-stroke centerline stream (large; only needed " +
          "for stroke-level analysis, not for seeing what was written where).",
      ),
  },
  { readOnlyHint: true },
  async ({ page, includeStrokeData }) => {
    try {
      const root = await requireLibrary();
      return json(await readInk(root, page, includeStrokeData));
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- write_underlay ---
// Any colour that lands in an SVG attribute must be a hex value: it keeps output
// legible to the app renderer and means a stray quote/expression can't produce
// malformed XML (which would blank the whole AI layer on device).
const HEX_COLOR = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour like #7B5EA7");

// The closed set of fonts that render in-app (see svg.ts REGION_DEFAULTS).
const FONT_ENUM = z.enum([
  "Mulish",
  "Newsreader",
  "IBM Plex Mono",
  "Caveat",
  "Fredoka",
  "Phosphor",
]);

// The confirmed-codepoint subset (see svg.ts PHOSPHOR_CODEPOINTS) — an icon name
// outside this set is rejected here rather than silently rendering nothing.
const PHOSPHOR_ICON_NAMES = Object.keys(PHOSPHOR_CODEPOINTS) as [string, ...string[]];

const lineSchema = z.object({
  text: z.string().describe("The text to draw."),
  row: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Ruled-row index to align to (0-based), from the region's ruledLines. " +
        "For the schedule, row 0 is the first hour. Ignored if `y` is set.",
    ),
  time: z
    .string()
    .optional()
    .describe(
      'Clock time "HH:MM" (24-hour) for schedule lines — the server snaps it to the ' +
        "nearest ruled row using the region's `startHour`/`rowsPerHour`, so you needn't " +
        "compute row indices. Ignored if `y` or `row` is set, or if the region has no " +
        "`startHour`. PREFER pairing with `endTime`/`durationMin` for any event with a " +
        "real start and end — it draws a washi-tape duration block that fills the hours " +
        "and keeps the column from looking sparse; reserve a bare `time` line for " +
        "point-in-time notes (a reminder, a deadline).",
    ),
  endTime: z
    .string()
    .optional()
    .describe(
      'Clock time "HH:MM" marking the END of a duration block that started at `time` — ' +
        "draws a rounded, tinted washi-tape-style block spanning start→end rows instead " +
        "of a single baseline. Mutually exclusive with `durationMin`. Ignored (with a " +
        "warning) if `time` is not also set.",
    ),
  durationMin: z
    .number()
    .positive()
    .optional()
    .describe(
      "Alternative to `endTime`: block length in minutes from `time` (e.g. 45 for a " +
        "45-minute meeting). Mutually exclusive with `endTime`. Ignored (with a warning) " +
        "if `time` is not also set.",
    ),
  blockFill: HEX_COLOR.optional().describe(
    "Override the washi block's tint (hex). Defaults to the chapter's chromeAccent " +
      "(the chapter accent tints duration blocks), else the theme's accent colour. " +
      "A no-text fill — used raw, never auto-darkened.",
  ),
  blockOpacity: z
    .number()
    .min(0.05)
    .max(1)
    .optional()
    .describe("Washi block fill opacity, 0–1 (default 0.16 — a translucent 'tape' tint)."),
  y: z
    .number()
    .optional()
    .describe("Explicit baseline y, local to the region's top-left. Overrides `row`."),
  x: z.number().optional().describe("Local x offset from the region's left edge. Default 24."),
  font: FONT_ENUM.optional().describe(
    "Font family. Defaults per region (Mulish; Newsreader for the serif ainotes block).",
  ),
  size: z.number().optional().describe("Font size in px. Sensible per-region default."),
  weight: z
    .number()
    .int()
    .optional()
    .describe("SVG font-weight (100–900). Defaults per region (600; 500 for the serif ainotes)."),
  fill: HEX_COLOR.optional().describe(
    "Override colour (hex). Defaults to the resolved theme colour (gold is retired). " +
      "Auto-darkened to the ≥4.5:1 contrast floor when drawn as text — pick from " +
      "read_page's `underlay` palette to stay in the chapter's colours.",
  ),
  marker: z
    .enum(["checkbox", "bullet"])
    .optional()
    .describe(
      "Leading mark before the text (drawn, no font dependency): 'checkbox' for " +
        "to-do items, 'bullet' for bulleted notes. The text is shifted past it.",
    ),
  icon: z
    .enum(PHOSPHOR_ICON_NAMES)
    .optional()
    .describe(
      "Leading Phosphor icon glyph before the text (font-rendered), from a small " +
        "confirmed-codepoint set — an unrecognized name is rejected. Mutually " +
        "exclusive with `marker`.",
    ),
  wrap: z
    .boolean()
    .optional()
    .describe(
      "Wrap long text to the region width instead of overflowing. Continuation " +
        "lines stack just below the baseline (they don't consume the next ruled row).",
    ),
  heading: z
    .boolean()
    .optional()
    .describe(
      "Render this line as a SECTION HEADING (bold, letter-spaced, with a hairline " +
        "rule beneath) instead of body text. Use it to draw dynamic structure into a " +
        "neutral box region — e.g. carve `notes` into 'Important' / 'Tomorrow' / " +
        "'Habits' sub-blocks on the days that need them, with the items below. In a box " +
        "region the lines flow top-down, so a heading + its items stack naturally. " +
        "`marker`/`wrap` are ignored on a heading.",
    ),
})
  .strict()
  .refine((l) => !(l.marker && l.icon), {
    message: "A line may carry `marker` OR `icon`, not both.",
  })
  .refine((l) => !(l.endTime && l.durationMin), {
    message: "A line may carry `endTime` OR `durationMin`, not both.",
  });

// Calendar grid for the month region — the server computes each day's cell from
// the template's column/row lines and emits day numbers + data-date tap targets.
const calendarSchema = z.object({
  month: z.string().describe('Month to lay out, "YYYY-MM" (e.g. "2026-02").'),
  days: z
    .array(
      z.object({
        day: z.number().int().min(1).max(31).describe("Day of month (1-based)."),
        text: z.string().optional().describe("Optional event label under the day number."),
        font: FONT_ENUM.optional(),
        size: z.number().optional(),
        weight: z.number().int().optional(),
        fill: HEX_COLOR.optional(),
      }).strict(),
    )
    .optional()
    .describe("Optional per-day event labels / styling."),
  numberSize: z.number().optional().describe("Day-number font size (default 18)."),
  numberWeight: z.number().int().optional().describe("Day-number weight (default 600)."),
  fill: HEX_COLOR.optional().describe(
    "Override the resolved theme colour for the day numbers (hex). Auto-darkened to " +
      "the ≥4.5:1 contrast floor (day numbers are text).",
  ),
}).strict();

// An AI-owned image placed in a region — the caller supplies the bytes (base64);
// the server writes them to the page's media/ai/ folder and references them by href.
const imageSchema = z.object({
  data: z
    .string()
    .optional()
    .describe(
      "Base64-encoded image bytes (the art — this server generates " +
        "nothing). Keep it small (≤1536px); there is a 2MB cap. Give EITHER `data` or `path`.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Absolute local file path to read the image from instead of inlining `data` — so a " +
        "generated PNG never passes through the model context (right for overnight/automated " +
        "writes). Leading `~` is expanded. Give EITHER `data` or `path`, not both.",
    ),
  format: z
    .enum(["png", "jpeg"])
    .optional()
    .describe("Encoding (png keeps alpha; jpeg for photos). Optional with `path` — sniffed from the file."),
  name: z
    .string()
    .optional()
    .describe("Stable filename stem — re-writing the same name replaces the image. Defaults to a content hash."),
  width: z
    .number()
    .positive()
    .optional()
    .describe(
      "Display width in region-local units. Required unless `fit: \"region\"` computes it " +
        "from the region's own box.",
    ),
  height: z
    .number()
    .positive()
    .optional()
    .describe(
      "Display height. OMIT to aspect-fill from the source (recommended) — a height off " +
        "the source aspect renders visibly stretched and trips `image_aspect_mismatch`. Not " +
        "allowed with `fit: \"region\"` (it computes both dimensions).",
    ),
  x: z.number().optional().describe("Region-local x. Overrides `corner`."),
  y: z.number().optional().describe("Region-local y. Overrides `corner`."),
  corner: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
    .optional()
    .describe("Placement within the region box (default center). Ignored if x/y are set."),
  margin: z
    .number()
    .optional()
    .describe(
      "Inset from the region edge for corner placement (default 8). Also the box inset " +
        "`fit: \"region\"` sizes inside.",
    ),
  fit: z
    .literal("region")
    .optional()
    .describe(
      "Size the display box to fit inside the region's own box (aspect-preserving contain, " +
        "inset by `margin`) instead of computing `width`/`height` yourself from read_page " +
        "geometry. Mutually exclusive with `width`/`height` — omit both when set.",
    ),
  maxDimension: z
    .number()
    .positive()
    .optional()
    .describe(
      "Downscale the source so neither dimension exceeds this, before sizing/hashing/writing " +
        "— use instead of resizing a source image by hand to clear the 1536px guideline or " +
        "2MB cap. PNG sources only today (re-encodes pixels); a JPEG over the limit still throws.",
    ),
  opacity: z.number().min(0).max(1).optional().describe("Image opacity, 0–1."),
  knockout: z
    .enum(["subject", "chroma", "none"])
    .optional()
    .describe(
      "Cut a background out of the image before placing it. \"subject\" runs a saliency " +
        "cutout (rembg) — best for a clean single subject; requires the same optional local " +
        "deps as fetch_image's removeBackground (python3 + `pip install rembg[cpu]`) and " +
        "fails clearly if missing. \"chroma\" keys a solid uniform background colour to " +
        "transparent — requires PNG input + `chromaColor`; use for diffuse/soft art where " +
        "saliency cutout erases the subject. A knocked-out image's resolved format is always " +
        "\"png\". Default \"none\". See docs/AUTHORING.md for when to use which.",
    ),
  chromaColor: HEX_COLOR.optional().describe(
    "Background colour to key transparent (hex) — required with knockout:\"chroma\". " +
      "Generate the art on this solid colour; pick one absent from the subject (e.g. magenta).",
  ),
  tolerance: z
    .number()
    .min(0)
    .max(255)
    .optional()
    .describe(
      "Per-channel colour-distance tolerance for knockout:\"chroma\" (0–255, default 30). " +
        "Raise it if anti-aliased edges leave a colour fringe; lower it if the subject " +
        "shares the background hue.",
    ),
}).strict().refine((i) => (i.data === undefined) !== (i.path === undefined), {
  message: "Provide exactly one of `data` or `path` for an image.",
}).refine((i) => i.knockout !== "chroma" || i.chromaColor !== undefined, {
  message: '`chromaColor` is required when knockout is "chroma".',
}).refine((i) => i.knockout === "chroma" || (i.chromaColor === undefined && i.tolerance === undefined), {
  message: '`chromaColor`/`tolerance` only apply when knockout is "chroma".',
}).refine((i) => i.fit !== "region" || (i.width === undefined && i.height === undefined), {
  message: '`fit: "region"` computes width/height itself — omit both.',
}).refine((i) => i.fit === "region" || i.width !== undefined, {
  message: "`width` is required unless `fit` is \"region\".",
});

server.tool(
  "write_underlay",
  "Write a shared page's ai.svg (atomically) and set its status. Provide EITHER " +
    "`regions` (structured — the server positions each line from the page's geometry; " +
    "preferred) OR `svg` (a full <svg> document you composed yourself). A region may also " +
    "carry `images` (base64/path art the server writes to the page's media/ai/ folder and " +
    "references from ai.svg, optionally cut out via `knockout` — see docs/AUTHORING.md for " +
    "the recipe). Sets status to 'ready' by default so the app will composite " +
    "it. Use `merge` to update only the named regions and keep the rest of the page; use " +
    "`dryRun` to preview the result + fit warnings without writing. Returns non-fatal " +
    "`warnings` plus structured `warningDetails` for likely overflow. Refuses any page outside Shared/.",
  {
    page: z.string().describe('Relative page path, e.g. "Shared/Daily/2026-02-06".'),
    regions: z
      .array(
        z.object({
          region: z
            .string()
            .describe('Region name from read_page, e.g. "schedule", "todo", "ainotes".'),
          label: z
            .string()
            .optional()
            .describe(
              "A region TITLE banner drawn in the margin above the region (doesn't consume a " +
                "row) — use to label a region a minimal template left bare (e.g. \"SCHEDULE\", " +
                "\"TOP 3\"). Themed like headings (colored pill, or label+rule). For a sub-section " +
                "INSIDE a box region, use a line with `heading` instead.",
            ),
          labelFill: HEX_COLOR.optional().describe("Override the label banner color (hex; default: theme)."),
          lines: z
            .array(lineSchema)
            .optional()
            .describe("Text lines to place in this region. Mutually exclusive with `calendar`/`svg`."),
          calendar: calendarSchema
            .optional()
            .describe(
              "Calendar grid for the month region — emits day numbers + data-date tap " +
                "targets from the template grid. Mutually exclusive with `lines`/`svg`.",
            ),
          svg: z
            .string()
            .optional()
            .describe(
              "Raw SVG fragment emitted VERBATIM inside this region's <g> — an escape " +
                "hatch for hand-placed <text>/shapes when `lines` placement isn't enough. " +
                "Composes and merges like any region. Mutually exclusive with " +
                "`lines`/`calendar`. Stay within the renderer's elements (svg/g/rect/line/" +
                "path/text/image/circle/ellipse/polyline/polygon); others warn. NOTE: an " +
                "<image href> here is NOT media-resolved — use the `images` array for " +
                "app-rendered art.",
            ),
          images: z
            .array(imageSchema)
            .optional()
            .describe(
              "AI-owned images to place in this region. Written to the page's media/ai/ " +
                "folder and referenced from ai.svg; the app renders them under stickers + ink.",
            ),
          startHour: z
            .number()
            .int()
            .min(0)
            .max(23)
            .optional()
            .describe(
              "Clock hour (0–23) of ruled row 0 in this region — anchors each line's " +
                "`time` to the grid. Defaults to the template's `data-start-hour` when the " +
                "region declares one (so you can omit it); pass it to override. Without " +
                "either, a `time` line falls back to order with a warning.",
            ),
          rowsPerHour: z
            .number()
            .positive()
            .optional()
            .describe(
              "Ruled rows per hour (2 = a half-hour grid). Defaults to the template's " +
                "`data-rows-per-hour`, else 1. Anchors `time`.",
            ),
          showHours: z
            .boolean()
            .optional()
            .describe(
              "Stamp small hour labels (e.g. \"7a\", \"12p\") at each whole-hour ruled row, " +
                "using this region's startHour/rowsPerHour — for a timed grid whose template " +
                "prints no hour numbers. No-op (with an info warning) if the region has no " +
                "ruled rows or no startHour is resolvable.",
            ),
        }).strict(),
      )
      .optional()
      .describe("Structured content. Mutually exclusive with `svg`."),
    svg: z
      .string()
      .optional()
      .describe("Raw full <svg> document (escape hatch). Mutually exclusive with `regions`."),
    status: z
      .enum(["empty", "refreshing", "ready"])
      .default("ready")
      .describe("AI-layer status to set after writing. 'ready' makes the app show it."),
    merge: z
      .boolean()
      .default(false)
      .describe(
        "Patch only the named regions into the existing ai.svg, preserving every other " +
          "region (e.g. slide a new meeting into the schedule without clearing the to-dos). " +
          "Structured `regions` only — not valid with raw `svg`.",
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Compose and return the result + warnings WITHOUT writing or changing status."),
    theme: z
      .enum(["gold", "bright", "cozy", "editorial"])
      .optional()
      .describe(
        "Named palette PRESET — colours the section banners, body text, and accents. PICK " +
          "IT TO FIT THE DAY: 'bright' (lively, saturated — a fun/light day), 'cozy' (warm, " +
          "hand-painted — a calm or rainy day), 'editorial' (restrained, few accents — a " +
          "heads-down work day), 'gold' (kept for back-compat; gold is RETIRED as a colour — " +
          "this now resolves to the chapter's own palette character, a calm blue-family " +
          "default if none is set). For an adaptive palette that harmonises to the template " +
          "instead, use `harmony`/`varietyDial`; for the chapter's own ink-palette identity, " +
          "set `paletteCharacter` via `set_chapter_theme` and leave `theme` unset. Ignored " +
          "with raw `svg`.",
      ),
    harmony: z
      .enum(["match", "complement", "warm", "cool", "seasonal"])
      .optional()
      .describe(
        "Adaptive palette strategy vs the template's own colours (sampled server-side): " +
          "'match' (use the template's swatches), 'complement', 'warm'/'cool' bias, " +
          "'seasonal'. Overrides the chapter's theme default. Takes precedence over a " +
          "preset `theme` name. Ignored with raw `svg`.",
      ),
    varietyDial: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "How much the underlay rotates day-to-day: 0 steady (one quiet accent, underline " +
          "headings) … 1 surprising (fuller palette, banner pills). Overrides the chapter " +
          "default; selects an adaptive palette. Ignored with raw `svg`.",
      ),
    fontPersonality: z
      .enum(["clean", "handwritten", "editorial"])
      .optional()
      .describe(
        "AI-text voice: 'clean' (Mulish/Newsreader — the default look), 'handwritten' " +
          "(Caveat/Fredoka), 'editorial' (Newsreader-led). Independent of the palette. " +
          "Overrides the chapter default. Ignored with raw `svg`.",
      ),
  },
  { idempotentHint: true },
  async ({ page, regions, svg, status, merge, dryRun, theme, harmony, varietyDial, fontPersonality }) => {
    try {
      if ((regions && svg) || (!regions && !svg)) {
        return {
          ...text("Provide exactly one of `regions` or `svg`."),
          isError: true as const,
        };
      }
      if (merge && svg) {
        return {
          ...text("`merge` is only supported with structured `regions`, not raw `svg`."),
          isError: true as const,
        };
      }
      const root = await requireLibrary();
      const res = await writeUnderlay(root, page, {
        regions,
        svg,
        status,
        merge,
        dryRun,
        theme,
        harmony,
        varietyDial,
        fontPersonality,
      });
      return json({ ok: true, ...res });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- set_underlay_status ---
server.tool(
  "set_underlay_status",
  "Set a page's AI-layer status (empty/refreshing/ready) without rewriting ai.svg. Use " +
    "'refreshing' before a long edit and 'ready' when done.",
  {
    page: z.string().describe("Relative page path."),
    status: z.enum(["empty", "refreshing", "ready"]).describe("New AI-layer status."),
  },
  { idempotentHint: true },
  async ({ page, status }) => {
    try {
      const root = await requireLibrary();
      await setStatus(root, page, status);
      return json({ ok: true, page, status });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- clear_underlay ---
server.tool(
  "clear_underlay",
  "Reset a page's ai.svg to empty and set status to 'empty'. The undo for write_underlay.",
  {
    page: z.string().describe("Relative page path."),
  },
  { idempotentHint: true },
  async ({ page }) => {
    try {
      const root = await requireLibrary();
      await clearUnderlay(root, page);
      return json({ ok: true, page, status: "empty" });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- create_page ---
server.tool(
  "create_page",
  "Create a new shared page (e.g. tomorrow's daily). Template resolution: an explicit " +
    "`template` wins; else the chapter's `.folder.json → weekdayTemplates` (a weekend-specific " +
    "choice for a page named YYYY-MM-DD); else the chapter's `.folder.json → defaultTemplate`; " +
    "a matching sibling page is cloned when one exists (a month chapter's monthly-overview " +
    "grid is never used for a new day page), else the id is instantiated from the top-level " +
    "Templates/ catalogue — so a brand-new/empty chapter can still be seeded. A page named in " +
    "the chapter's `.folder.json → deletedDays` tombstone list is refused unless `clearDeleted` " +
    "is set. Writes manifest + layers + media/ and adds it to the chapter order. Prefer " +
    "letting the user create pages in the app; use this only when asked.",
  {
    chapter: z
      .string()
      .describe(
        'Chapter under Shared/. Either the bare name ("2026-06") or the path ' +
          'get_library returns ("Shared/2026-06") works.',
      ),
    name: z
      .string()
      .regex(
        /^[^/\\]+$/,
        "page name must be a single folder name (no slashes)",
      )
      .describe('New page folder name — a human date/slug, e.g. "2026-06-14". No slashes.'),
    title: z.string().optional().describe("Display title. Defaults to the folder name."),
    template: z
      .string()
      .optional()
      .describe(
        'Catalogue template id, e.g. "daily-minimal". Used to seed an empty chapter from the ' +
          "Templates/ catalogue, and to require a matching template when cloning a sibling.",
      ),
    clearDeleted: z
      .boolean()
      .optional()
      .describe(
        "Recreate a day the chapter's `.folder.json → deletedDays` marks as tombstoned. " +
          "Without this, create_page refuses (the user explicitly removed that day).",
      ),
  },
  async ({ chapter, name, title, template, clearDeleted }) => {
    try {
      const root = await requireLibrary();
      const res = await createPage(root, { chapter, name, title, template, clearDeleted });
      return json({ ok: true, ...res });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- set_chapter_theme ---
server.tool(
  "set_chapter_theme",
  "Set a chapter's default theme (its `.folder.json → theme` block) so every page in the " +
    "chapter inherits one mood — write_underlay applies it as the default (overridable per " +
    "call) and read_page surfaces it. Use `accent` to give the chapter an explicit colour " +
    "the named presets don't cover (e.g. lavender to-dos): it tints body text, markers, and " +
    "banners, floored dark to stay legible on cream. `paletteCharacter` sets the chapter's " +
    "ink-tray identity (the app's per-chapter handwriting colours, design/INK-PALETTE.md) — " +
    "when no `harmony`/`accent`/preset `theme` is given, the underlay derives its default " +
    "palette from this instead of a fixed colour (gold is retired). `harmony`/`varietyDial`/" +
    "`fontPersonality` set the adaptive mood. Only the fields you pass are changed; the rest " +
    "of the theme (and the chapter's page order) is preserved. The chapter must already exist.",
  {
    chapter: z
      .string()
      .describe(
        'Chapter under Shared/. Either the bare name ("2026-06") or the path ' +
          'get_library returns ("Shared/2026-06") works.',
      ),
    accent: z
      .string()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accent must be a hex colour like #7B5EA7")
      .optional()
      .describe(
        "Explicit underlay accent (hex) the whole chapter inherits — tints body text / " +
          "markers / banners. The way to make e.g. to-dos lavender by default; per-day exact " +
          "colour is still available via a line's `fill`.",
      ),
    paletteCharacter: z
      .enum(PALETTE_CHARACTER_IDS)
      .optional()
      .describe(
        "The chapter's ink-tray identity — one of the app's named palette characters " +
          "(design/INK-PALETTE.md; confirmed shipping tokens). When set and no " +
          "`accent`/`harmony`/preset `theme` overrides it, the underlay's default palette " +
          "derives from this chapter's own ink colours (lifted lighter, still legible) " +
          "instead of a fixed seed. Additive alongside the app's `chromeAccent`/`harmony`/" +
          "`varietyDial`/`fontPersonality` keys — never overwrites them.",
      ),
    customInk1: z
      .string()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "customInk1 must be a hex colour like #7B5EA7")
      .optional()
      .describe(
        "Extra user ink slot (hex), appended to the palette character's 5-ink pool — the " +
          "app's tray is 7 (5 derived + 2 custom). Widens the underlay's banner/fill choices.",
      ),
    customInk2: z
      .string()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "customInk2 must be a hex colour like #7B5EA7")
      .optional()
      .describe("Second extra user ink slot (hex) — see customInk1."),
    displayName: z
      .string()
      .optional()
      .describe(
        'Friendly chapter identity (e.g. "lavender to-dos") — advisory only; surfaced by ' +
          "read_page, never used to derive colours.",
      ),
    harmony: z
      .enum(["match", "complement", "warm", "cool", "seasonal"])
      .optional()
      .describe("Adaptive palette strategy vs the template's own colours (see write_underlay)."),
    varietyDial: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("0 steady … 1 surprising — banner count + heading style."),
    fontPersonality: z
      .enum(["clean", "handwritten", "editorial"])
      .optional()
      .describe("AI-text voice: clean / handwritten / editorial."),
  },
  { idempotentHint: true },
  async ({
    chapter,
    accent,
    paletteCharacter,
    customInk1,
    customInk2,
    displayName,
    harmony,
    varietyDial,
    fontPersonality,
  }) => {
    try {
      const root = await requireLibrary();
      const res = await writeChapterTheme(root, chapter, {
        accent,
        paletteCharacter,
        customInk1,
        customInk2,
        displayName,
        harmony,
        varietyDial,
        fontPersonality,
      });
      return json({ ok: true, ...res });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

// --- fetch_image ---
server.tool(
  "fetch_image",
  "Download an image from an HTTPS URL and save it to a local temp file. Returns the path " +
    "to pass as `images[].path` in write_underlay — keeps image bytes off the model context " +
    "and bridges CDN URLs to the filesystem-only Onionskin renderer. Validates PNG/JPEG " +
    "format and the 2 MB size cap. The file lands in an `onionskin-fetch/` folder under " +
    "the OS temp dir (cleaned up by the OS); repeated fetches never overwrite each other.",
  {
    url: z.string().describe("HTTPS URL of the image to download."),
    name: z
      .string()
      .optional()
      .describe("Filename stem for the saved file (defaults to the last URL path segment)."),
    removeBackground: z
      .boolean()
      .optional()
      .describe(
        "Run rembg to strip the image background, outputting a transparent PNG. " +
          "Requires rembg installed: pip3 install rembg[cpu]. The output is re-validated " +
          "and may exceed the 2 MB cap.",
      ),
  },
  async ({ url, name, removeBackground }) => {
    try {
      const result = await fetchImageToTemp(url, name, removeBackground);
      return json({ ok: true, ...result });
    } catch (e: any) {
      return { ...text(`Error: ${e.message}`), isError: true as const };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`onionskin MCP server ready (library: ${resolveRoot()})`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
