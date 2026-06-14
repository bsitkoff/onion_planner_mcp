import { XMLParser } from "fast-xml-parser";

/** Geometry of one addressable region, in absolute page coordinates. */
export interface Region {
  /** SVG element id, e.g. "region-schedule". */
  id: string;
  /** Logical name from data-region, e.g. "schedule" — the key callers use. */
  name: string;
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

/** viewBox -> [width, height], or null if unparseable. */
export function parseViewBox(templateSvg: string): [number, number] | null {
  const m = templateSvg.match(
    /viewBox\s*=\s*"\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*"/,
  );
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * Parse a template.svg into its addressable regions. Reads every
 * <g id="region-*"> and reports its transform, box, row/col hints, and the
 * absolute positions of its ruled lines — everything a writer needs to place
 * text without hard-coding coordinates.
 */
export function parseRegions(templateSvg: string): Region[] {
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

    regions.push({
      id,
      name,
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
