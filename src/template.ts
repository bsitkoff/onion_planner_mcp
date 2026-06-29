import { XMLParser } from "fast-xml-parser";

/**
 * Who fills a region — the ownership/behavior axis, orthogonal to its geometry (a
 * ruled region may be the user's or the AI's). `ink` = the user's handwriting surface
 * (AI does light scaffolding only); `ai` = the AI owns it; `shared` = the AI seeds it
 * and the user augments by hand on top (read the ink first, place around it). Set by
 * the template's `data-fill`, else derived (see `deriveFill`).
 */
export type RegionFill = "ink" | "ai" | "shared";

/** Geometry of one addressable region, in absolute page coordinates. */
export interface Region {
  /** SVG element id, e.g. "region-schedule". */
  id: string;
  /** Logical name from data-region, e.g. "schedule" — the key callers use. */
  name: string;
  /** Who fills this region (data-fill, else derived) — the behavior axis. */
  fill: RegionFill;
  /**
   * The designer's free-text intent for this region (`data-intent`), e.g. "this
   * week's dinners, one row per day" — what the block is imagined for. Advisory: the
   * filler reads it for context but is free to repurpose. null if the template set none.
   */
  intent: string | null;
  /** Absolute top-left of the region group (from its transform). */
  x: number;
  y: number;
  /** Box size from the region's child <rect>, if present. */
  width: number | null;
  height: number | null;
  /** data-rows / data-cols hints, if present. */
  rows: number | null;
  cols: number | null;
  /**
   * Absolute y of each horizontal ruled line (group y + line y1), ascending.
   * These are the writable "rows" — schedule hour lines, notes rules, etc.
   */
  ruledLines: number[];
  /** Absolute x of each vertical ruled line (for grid templates like month). */
  colLines: number[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["g", "line", "rect", "text", "path"].includes(name),
});

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTranslate(transform: unknown): { x: number; y: number } {
  if (typeof transform !== "string") return { x: 0, y: 0 };
  const m = transform.match(/translate\(\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*\)/);
  if (!m) return { x: 0, y: 0 };
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** What a template already provides — so the AI can match its level (see AUTHORING). */
export interface TemplateInfo {
  /**
   * True if the template already decorates itself (its own labels, banners, or a
   * starter sticker layer). On a styled template the AI should fill *quietly* into
   * the existing slots; only a bare/minimal template (false) invites full decoration.
   */
  styled: boolean;
  /** The template prints its own section labels (any `<text>` in template.svg). */
  hasLabels: boolean;
  /** The template draws its own filled banners/decoration (a non-"none" filled rect). */
  hasBanners: boolean;
  /** The page ships a non-empty stickers layer. */
  stickersPresent: boolean;
  /**
   * Non-neutral colours the template itself uses (hex, most-saturated first) — the
   * palette to MATCH when filling a styled template, instead of defaulting to gold.
   */
  palette: string[];
}

/** Expand #abc → #aabbcc, lowercased; null if not a hex colour. */
function normalizeHex(s: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return "#" + h.toLowerCase();
}

/** A near-grey, near-white, or near-black colour — template chrome, not an accent. */
function isNeutral(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 28 || min > 225 || max < 30;
}

/**
 * Inspect a template.svg (and optional stickers.svg) for what it already provides:
 * its own labels/banners/stickers and the accent palette it uses. Derived entirely
 * from the SVG — no dependence on template ids — so a user-authored template (a
 * future template editor) is read the same way as the shipped catalogue.
 */
export function inspectTemplate(templateSvg: string, stickersSvg?: string | null): TemplateInfo {
  const scored = new Map<string, number>(); // hex -> saturation (max-min)
  for (const m of templateSvg.matchAll(/(?:fill|stroke)\s*=\s*"(#[0-9a-fA-F]{3,6})"/g)) {
    const hex = normalizeHex(m[1]);
    if (!hex || isNeutral(hex)) continue;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    scored.set(hex, Math.max(r, g, b) - Math.min(r, g, b));
  }
  const palette = [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h).slice(0, 6);
  // A real section *label* has letters ("Schedule", "TODAY") — not the schedule's
  // hour numbers or a month grid's day numbers, which are functional, not decoration.
  const hasLabels = /<text\b[^>]*>[^<]*[A-Za-z][^<]*<\/text>/.test(templateSvg);
  const hasBanners = /<rect\b[^>]*\bfill\s*=\s*"#[0-9a-fA-F]{3,6}"/.test(templateSvg);
  const stickersPresent = !!stickersSvg && /<(rect|path|image|text|circle|line|g)\b/.test(stickersSvg);
  return {
    styled: hasLabels || hasBanners || stickersPresent,
    hasLabels,
    hasBanners,
    stickersPresent,
    palette,
  };
}

/** viewBox -> [width, height], or null if unparseable. */
export function parseViewBox(templateSvg: string): [number, number] | null {
  const m = templateSvg.match(
    /viewBox\s*=\s*"\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*"/,
  );
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * Region name → fill, a convenience default for the conventional vocabulary — NOT
 * the contract (an explicit `data-fill` always wins). A region's geometry does NOT
 * predict who fills it (reflection regions are ruled yet the user's; schedule is
 * ruled yet AI-seeded), so the default is keyed on the name. Keep in sync with the
 * shipped templates (`../onionskin/.../Templates/`). Unknown names fall through to
 * template-type, then geometry (see deriveFill).
 */
const FILL_BY_NAME: Record<string, RegionFill> = {
  // shared — AI seeds (calendar/tasks), the user augments by hand on top.
  schedule: "shared",
  agenda: "shared",
  todo: "shared",
  priorities: "shared",
  "list-1": "shared",
  "list-2": "shared",
  "list-3": "shared",
  month: "shared",
  notes: "shared",
  goals: "shared",
  summary: "shared",
  // ai — the AI owns it (a daily message, a title, structure).
  quote: "ai",
  affirmation: "ai", // legacy name for quote
  header: "ai",
  weekdays: "ai",
  // ink — the user's handwriting surface; AI does light scaffolding only.
  joys: "ink",
  concerns: "ink",
  last: "ink",
  morning: "ink",
  afternoon: "ink",
  evening: "ink",
  memories: "ink",
  page: "ink",
  photos: "ink",
};

/** Template ids whose whole surface is for handwriting — unknown regions → ink. */
const INK_TEMPLATE_RE = /reflection|lined|dotted|blank/i;

/**
 * Derive who fills a region when it carries no explicit `data-fill`. Precedence:
 * region-name default → template-type (a handwriting-surface template) → geometry
 * (the original instinct: a writable surface — ruled lines or a dot grid — is the
 * user's; a blank box is the AI's). Always yields an answer.
 */
function deriveFill(name: string, hasRules: boolean, templateName?: string): RegionFill {
  const byName = FILL_BY_NAME[name];
  if (byName) return byName;
  if (templateName && INK_TEMPLATE_RE.test(templateName)) return "ink";
  return hasRules ? "ink" : "ai";
}

/** Validate a raw `data-fill` value; undefined if absent/unrecognized. */
function explicitFill(v: unknown): RegionFill | undefined {
  return v === "ink" || v === "ai" || v === "shared" ? v : undefined;
}

/** A non-empty `data-intent` free-text purpose, trimmed; null otherwise. */
function readIntent(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Parse a template.svg into its addressable regions. Reads every
 * <g id="region-*"> and reports its transform, box, row/col hints, the absolute
 * positions of its ruled lines, who fills it (`fill`), and the designer's free-text
 * `intent` — everything a writer needs to place text (without hard-coding
 * coordinates) and to understand what a region is for. `templateName` (the page's
 * `manifest.template`) sharpens `fill` derivation for unknown region names; optional.
 */
export function parseRegions(templateSvg: string, templateName?: string): Region[] {
  const doc = parser.parse(templateSvg);
  const svg = doc?.svg;
  if (!svg) return [];
  const groups: any[] = Array.isArray(svg.g) ? svg.g : svg.g ? [svg.g] : [];
  const regions: Region[] = [];

  for (const g of groups) {
    const id: string = g["@_id"] ?? "";
    if (!id.startsWith("region-")) continue;
    const { x, y } = parseTranslate(g["@_transform"]);
    const name: string = g["@_data-region"] ?? id.replace(/^region-/, "");

    const rect = Array.isArray(g.rect) ? g.rect[0] : g.rect;
    const width = rect ? num(rect["@_width"]) : null;
    const height = rect ? num(rect["@_height"]) : null;

    const lines: any[] = Array.isArray(g.line) ? g.line : g.line ? [g.line] : [];
    const ruledLines: number[] = [];
    const colLines: number[] = [];
    for (const ln of lines) {
      const x1 = num(ln["@_x1"]);
      const y1 = num(ln["@_y1"]);
      const x2 = num(ln["@_x2"]);
      const y2 = num(ln["@_y2"]);
      if (y1 !== null && y2 !== null && Math.abs(y1 - y2) < 0.5) {
        ruledLines.push(y + y1); // horizontal rule -> absolute y
      } else if (x1 !== null && x2 !== null && Math.abs(x1 - x2) < 0.5) {
        colLines.push(x + x1); // vertical rule -> absolute x
      }
    }
    ruledLines.sort((a, b) => a - b);
    colLines.sort((a, b) => a - b);

    // A dot grid (dotted/notes paper) is drawn as <path> dots — also a writable
    // surface for the fill geometry fallback.
    const hasDots = Array.isArray(g.path) ? g.path.length > 0 : !!g.path;
    const fill =
      explicitFill(g["@_data-fill"]) ??
      deriveFill(name, ruledLines.length > 0 || hasDots, templateName);
    const intent = readIntent(g["@_data-intent"]);

    regions.push({
      id,
      name,
      fill,
      intent,
      x,
      y,
      width,
      height,
      rows: num(g["@_data-rows"]),
      cols: num(g["@_data-cols"]),
      ruledLines,
      colLines,
    });
  }
  return regions;
}
