import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveRoot } from "./paths.js";
import {
  requireLibrary,
  listChapters,
  listPageRows,
  LibraryMissingError,
} from "./library.js";
import {
  readPage,
  writeUnderlay,
  setStatus,
  clearUnderlay,
  createPage,
} from "./page.js";

const server = new McpServer(
  {
    name: "onionskin",
    version: "1.0.0",
  },
  {
    instructions:
      "Onionskin is a planner whose pages are folders of SVG layers in an iCloud " +
      "folder. You write the gold 'ai.svg' underlay (schedule, to-dos, priorities, " +
      "notes, quote) into pages under Shared/, then mark it ready — the app " +
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
    "whether it exists, and the chapters under Shared/ with page counts. Call this FIRST. " +
    "If the library is missing, its error explains how to fix it (run the app once, or set " +
    "ONIONSKIN_CONTAINER).",
  {},
  { readOnlyHint: true },
  async () => {
    try {
      const root = await requireLibrary();
      const chapters = await listChapters(root);
      return json({ root, exists: true, sharedChapters: chapters });
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
      .describe('Optional chapter name to filter by, e.g. "Daily". Omit for all chapters.'),
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
      const rows = await listPageRows(root, {
        chapter,
        template,
        aiStatus,
        titleContains,
        modifiedAfter,
        modifiedBefore,
      });
      return json({ count: rows.length, pages: rows });
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
    "cols, and absolute ruled-line positions), current ai.svg, and a `template` summary, and " +
    "optionally template.svg. Use the regions to target write_underlay — never hard-code " +
    "coordinates. `template` reports whether the template already decorates itself " +
    "(`styled`/`hasLabels`/`hasBanners`/`stickersPresent`) and its own `palette`: if styled, " +
    "fill quietly in those colours; if bare, go full (theme + banners + art).",
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

// --- write_underlay ---
// The closed set of fonts that render in-app (see svg.ts REGION_DEFAULTS).
const FONT_ENUM = z.enum([
  "Mulish",
  "Newsreader",
  "IBM Plex Mono",
  "Caveat",
  "Fredoka",
  "Phosphor",
]);

const lineSchema = z.object({
  text: z.string().describe("The text to draw (gold)."),
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
        "`startHour`.",
    ),
  y: z
    .number()
    .optional()
    .describe("Explicit baseline y, local to the region's top-left. Overrides `row`."),
  x: z.number().optional().describe("Local x offset from the region's left edge. Default 24."),
  font: FONT_ENUM.optional().describe(
    "Font family. Defaults per region (Mulish; Newsreader for the quote).",
  ),
  size: z.number().optional().describe("Font size in px. Sensible per-region default."),
  weight: z
    .number()
    .int()
    .optional()
    .describe("SVG font-weight (100–900). Defaults per region (600; 500 for the quote)."),
  fill: z.string().optional().describe("Override colour. Defaults to the gold default."),
  marker: z
    .enum(["checkbox", "bullet"])
    .optional()
    .describe(
      "Leading mark before the text (drawn, no font dependency): 'checkbox' for " +
        "to-do items, 'bullet' for bulleted notes. The text is shifted past it.",
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
        fill: z.string().optional(),
      }),
    )
    .optional()
    .describe("Optional per-day event labels / styling."),
  numberSize: z.number().optional().describe("Day-number font size (default 18)."),
  numberWeight: z.number().int().optional().describe("Day-number weight (default 600)."),
  fill: z.string().optional().describe("Override gold for the day numbers."),
});

// An AI-owned image placed in a region — the caller supplies the bytes (base64);
// the server writes them to the page's media/ai/ folder and references them by href.
const imageSchema = z.object({
  data: z
    .string()
    .optional()
    .describe(
      "Base64-encoded image bytes (the art — this server has no network and generates " +
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
  width: z.number().positive().describe("Display width in region-local units."),
  height: z
    .number()
    .positive()
    .optional()
    .describe("Display height; omit to preserve the image's aspect ratio."),
  x: z.number().optional().describe("Region-local x. Overrides `corner`."),
  y: z.number().optional().describe("Region-local y. Overrides `corner`."),
  corner: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
    .optional()
    .describe("Placement within the region box (default center). Ignored if x/y are set."),
  margin: z.number().optional().describe("Inset from the region edge for corner placement (default 8)."),
  opacity: z.number().min(0).max(1).optional().describe("Image opacity, 0–1."),
}).refine((i) => (i.data === undefined) !== (i.path === undefined), {
  message: "Provide exactly one of `data` or `path` for an image.",
});

server.tool(
  "write_underlay",
  "Write a shared page's gold ai.svg (atomically) and set its status. Provide EITHER " +
    "`regions` (structured — the server positions each line from the page's geometry; " +
    "preferred) OR `svg` (a full <svg> document you composed yourself). A region may also " +
    "carry `images` (base64 art the server writes to the page's media/ai/ folder and " +
    "references from ai.svg). Sets status to 'ready' by default so the app will composite " +
    "it. Use `merge` to update only the named regions and keep the rest of the page; use " +
    "`dryRun` to preview the result + fit warnings without writing. Returns non-fatal " +
    "`warnings` for likely overflow. Refuses any page outside Shared/.",
  {
    page: z.string().describe('Relative page path, e.g. "Shared/Daily/2026-02-06".'),
    regions: z
      .array(
        z.object({
          region: z
            .string()
            .describe('Region name from read_page, e.g. "schedule", "todo", "quote".'),
          label: z
            .string()
            .optional()
            .describe(
              "A region TITLE banner drawn in the margin above the region (doesn't consume a " +
                "row) — use to label a region a minimal template left bare (e.g. \"SCHEDULE\", " +
                "\"TOP 3\"). Themed like headings (colored pill, or label+rule). For a sub-section " +
                "INSIDE a box region, use a line with `heading` instead.",
            ),
          labelFill: z.string().optional().describe("Override the label banner color (default: theme)."),
          lines: z
            .array(lineSchema)
            .optional()
            .describe("Text lines to place in this region. Mutually exclusive with `calendar`."),
          calendar: calendarSchema
            .optional()
            .describe(
              "Calendar grid for the month region — emits day numbers + data-date tap " +
                "targets from the template grid. Mutually exclusive with `lines`.",
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
                "`time` to the grid. Required for `time` to take effect.",
            ),
          rowsPerHour: z
            .number()
            .positive()
            .optional()
            .describe("Ruled rows per hour (default 1; 2 = a half-hour grid). Anchors `time`."),
        }),
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
        "Page palette — colours the section banners, body text, and accents. PICK IT TO " +
          "FIT THE DAY: 'bright' (lively, saturated — a fun/light day), 'cozy' (warm, " +
          "hand-painted — a calm or rainy day), 'editorial' (restrained, few accents — a " +
          "heads-down work day), 'gold' (the quiet monochrome default). Ignored with raw `svg`.",
      ),
  },
  { idempotentHint: true },
  async ({ page, regions, svg, status, merge, dryRun, theme }) => {
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
      const res = await writeUnderlay(root, page, { regions, svg, status, merge, dryRun, theme });
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
  "Create a new shared page (e.g. tomorrow's daily). The template comes from a sibling page " +
    "in the same chapter when one exists; otherwise it's instantiated from the top-level " +
    "Templates/ catalogue by id (`template`), so a brand-new/empty chapter can still be seeded. " +
    "Writes manifest + layers + media/ and adds it to the chapter order. Prefer letting the " +
    "user create pages in the app; use this only when asked.",
  {
    chapter: z.string().describe('Chapter name under Shared/, e.g. "Daily".'),
    name: z
      .string()
      .describe('New page folder name — a human date/slug, e.g. "2026-06-14". No slashes.'),
    title: z.string().optional().describe("Display title. Defaults to the folder name."),
    template: z
      .string()
      .optional()
      .describe(
        'Catalogue template id, e.g. "daily-minimal". Used to seed an empty chapter from the ' +
          "Templates/ catalogue, and to require a matching template when cloning a sibling.",
      ),
  },
  async ({ chapter, name, title, template }) => {
    try {
      const root = await requireLibrary();
      const res = await createPage(root, { chapter, name, title, template });
      return json({ ok: true, ...res });
    } catch (e: any) {
      if (e instanceof LibraryMissingError) {
        return { ...text(e.message), isError: true as const };
      }
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
