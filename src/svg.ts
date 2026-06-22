import type { Region } from "./template.js";

/**
 * The gold layer colour, per the Onionskin contract. Deepened from the original
 * #C9A227 for legibility on white paper (the brand gold read too light/thin on
 * device). One constant — retune here if the brand gold shifts.
 */
export const GOLD = "#9C7C1A";

const DEFAULT_X_PAD = 24;
/** Default text weight — heavier than regular to carry the gold on white. */
const DEFAULT_WEIGHT = 600;

/**
 * Per-region font/size/weight defaults. Keyed by the template's `data-region`
 * name — keep in sync with the shipped templates (`../onionskin/.../Templates/`).
 * The serif "quote" region was historically named "affirmation"; both are kept so
 * older pages still pick up the serif styling. Unknown regions use FALLBACK_DEFAULT.
 */
const REGION_DEFAULTS: Record<string, { font: string; size: number; weight: number }> = {
  quote: { font: "Newsreader", size: 26, weight: 500 },
  affirmation: { font: "Newsreader", size: 26, weight: 500 }, // legacy region name
  header: { font: "Mulish", size: 20, weight: 700 },
  schedule: { font: "Mulish", size: 14, weight: 600 },
  priorities: { font: "Mulish", size: 15, weight: 600 },
  todo: { font: "Mulish", size: 15, weight: 600 },
  notes: { font: "Mulish", size: 14, weight: 600 },
  goals: { font: "Mulish", size: 15, weight: 600 },
  month: { font: "Mulish", size: 13, weight: 600 },
};
const FALLBACK_DEFAULT = { font: "Mulish", size: 14, weight: DEFAULT_WEIGHT };

/** A leading mark drawn before a line's text (todo lists, bulleted notes). */
export type LineMarker = "checkbox" | "bullet";

export interface LineInput {
  text: string;
  /** Ruled-row index to align to (0-based). Ignored if `y` is given. */
  row?: number;
  /** Explicit baseline y, local to the region's top-left. Overrides `row`. */
  y?: number;
  /** Local x offset from the region's left edge. Defaults to 24. */
  x?: number;
  font?: string;
  size?: number;
  /** SVG font-weight (100–900). Defaults per region (600; 500 for the quote). */
  weight?: number;
  fill?: string;
  /**
   * Draw a leading mark before the text and shift the text past it. "checkbox"
   * is an empty square (to-do items); "bullet" is a filled dot. Both are drawn
   * shapes (no font dependency).
   */
  marker?: LineMarker;
}

/** One day's optional event label + styling on a calendar grid. */
export interface CalendarDay {
  /** Day of month, 1-based. */
  day: number;
  /** Optional event label drawn under the day number. */
  text?: string;
  font?: string;
  size?: number;
  weight?: number;
  fill?: string;
}

/** A month to lay out onto a gridded region (the month template). */
export interface CalendarSpec {
  /** Month to render, "YYYY-MM". */
  month: string;
  /** Optional per-day event labels / styling. */
  days?: CalendarDay[];
  /** Day-number styling (defaults: Mulish 18 / weight 600 / gold). */
  numberFont?: string;
  numberSize?: number;
  numberWeight?: number;
  fill?: string;
}

export interface RegionInput {
  /** Region name from read_page, e.g. "schedule", "todo", "quote". */
  region: string;
  /** Text lines (ruled/box regions). Mutually exclusive with `calendar`. */
  lines?: LineInput[];
  /** Calendar grid (the month region). Mutually exclusive with `lines`. */
  calendar?: CalendarSpec;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Rough average glyph-width / font-size ratios by family, for overflow estimates
 * only — we don't have real font metrics here, so these are deliberate
 * approximations used to *warn*, never to lay out.
 */
const CHAR_WIDTH_RATIO: Record<string, number> = {
  "IBM Plex Mono": 0.6,
  Mulish: 0.52,
  Newsreader: 0.5,
  Caveat: 0.4,
  Fredoka: 0.56,
  Phosphor: 1.0,
};
const DEFAULT_CHAR_RATIO = 0.55;

/** Estimated rendered width of `text` in px (heuristic — see CHAR_WIDTH_RATIO). */
function estimateTextWidth(text: string, font: string, size: number): number {
  const ratio = CHAR_WIDTH_RATIO[font] ?? DEFAULT_CHAR_RATIO;
  return Math.round(text.length * size * ratio);
}

/**
 * A leading marker drawn at local (x, baseline). Returns the SVG fragment and how
 * far to advance the text x past it. Pure shapes — no font dependency.
 */
function markerFragment(
  marker: LineMarker,
  x: number,
  baseline: number,
  size: number,
  fill: string,
): { svg: string; advance: number } {
  if (marker === "checkbox") {
    const box = Math.round(size * 0.85);
    const top = baseline - box; // sit the box just above the baseline
    const sw = Math.max(1, Math.round(size / 12));
    return {
      svg: `<rect x="${x}" y="${top}" width="${box}" height="${box}" rx="2" fill="none" stroke="${fill}" stroke-width="${sw}"/>`,
      advance: box + Math.round(size * 0.4),
    };
  }
  // bullet
  const r = Math.max(2, Math.round(size * 0.16));
  const cx = x + r;
  const cy = baseline - Math.round(size * 0.32);
  return {
    svg: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`,
    advance: 2 * r + Math.round(size * 0.4),
  };
}

/** Pixels below a ruled line to drop the text baseline, from the row pitch. */
function rowOffset(region: Region): number {
  const r = region.ruledLines;
  const pitch = r.length >= 2 ? r[1] - r[0] : 40;
  return Math.round(pitch * 0.4);
}

function baselineFor(
  region: Region,
  line: LineInput,
  autoIndex: number,
  size: number,
  lineCount: number,
): number {
  if (line.y !== undefined) return line.y;

  const row = line.row !== undefined ? Math.max(0, Math.floor(line.row)) : autoIndex;

  if (region.ruledLines.length > 0) {
    const idx = Math.min(row, region.ruledLines.length - 1);
    const localRuled = region.ruledLines[idx] - region.y;
    return localRuled + rowOffset(region);
  }

  // No ruled lines (e.g. quote, notes): stack by line height...
  const lineHeight = Math.round(size * 1.5);
  const topPad = Math.round(size * 1.2);
  // ...but center a region's single auto-placed line vertically (nice for
  // affirmations). Only when it's truly the sole line — otherwise a multi-line
  // todo would center line 0 and stack the rest from the top, overlapping it.
  if (line.row === undefined && lineCount === 1 && region.height) {
    return Math.round(region.height / 2 + size / 3);
  }
  return topPad + row * lineHeight;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Absolute grid boundary positions for one axis. Prefers an even division of the
 * region's box (rect `span` ÷ declared `data-cols`/`data-rows` `count`) — the
 * authoritative grid — because templates may draw only the *interior* dividers as
 * `<line>`s and leave the outer edges to the box `<rect>`. Falls back to bracketing
 * the parsed interior lines with the box edges, then to the raw lines alone.
 */
function gridBounds(
  start: number,
  span: number | null,
  count: number | null,
  interior: number[],
): number[] {
  if (span !== null && count !== null && count >= 1) {
    const out: number[] = [];
    for (let i = 0; i <= count; i++) out.push(Math.round(start + (span * i) / count));
    return out;
  }
  const pts = [...interior];
  if (span !== null) pts.push(start, start + span);
  // Dedupe near-coincident points (a template that drew edges *and* a rect).
  const uniq: number[] = [];
  for (const v of [...new Set(pts.map((p) => Math.round(p)))].sort((a, b) => a - b)) {
    if (uniq.length === 0 || v - uniq[uniq.length - 1] > 1) uniq.push(v);
  }
  return uniq;
}

/**
 * Lay a month's day cells onto a gridded region. Per day: a `<rect
 * data-date="YYYY-MM-DD" fill="none">` covering the cell (the app's tap-to-day
 * target) + a gold day number, plus an optional event label. Returns SVG fragments
 * in LOCAL coordinates (the caller wraps them in the region's translate group, so
 * we subtract the region origin from the absolute grid boundaries).
 */
function composeCalendar(region: Region, spec: CalendarSpec): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(spec.month.trim());
  if (!m) throw new Error(`calendar.month must be "YYYY-MM", got "${spec.month}".`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) {
    throw new Error(`calendar.month has an invalid month: "${spec.month}".`);
  }

  // Derive the full cell grid from the box + declared rows/cols (robust to
  // templates that only draw interior divider lines — see gridBounds).
  const cols = gridBounds(region.x, region.width, region.cols, region.colLines);
  const rows = gridBounds(region.y, region.height, region.rows, region.ruledLines);
  if (cols.length < 2 || rows.length < 2) {
    throw new Error(
      `Region "${region.name}" is not a grid (needs a box with data-cols/data-rows, ` +
        `or column + row lines). Calendar layout requires a gridded month template.`,
    );
  }
  const nCols = cols.length - 1; // expected 7 (Sun–Sat)
  const nRows = rows.length - 1; // expected 6 week bands

  // Sunday-start grid (the template headers are SUN…SAT).
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const numFont = spec.numberFont ?? "Mulish";
  const numSize = spec.numberSize ?? 18;
  const numWeight = spec.numberWeight ?? 600;
  const fill = spec.fill ?? GOLD;
  const byDay = new Map((spec.days ?? []).map((d) => [d.day, d]));

  const parts: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const index = firstDow + day - 1;
    const col = index % 7;
    const row = Math.floor(index / 7);
    if (col >= nCols || row >= nRows) continue; // outside the printed grid; skip defensively

    const left = Math.round(cols[col] - region.x);
    const top = Math.round(rows[row] - region.y);
    const cellW = Math.round(cols[col + 1] - cols[col]);
    const cellH = Math.round(rows[row + 1] - rows[row]);
    const date = `${year}-${pad2(month)}-${pad2(day)}`;

    // Tap target: a transparent rect the app maps to that day's page.
    parts.push(
      `    <rect x="${left}" y="${top}" width="${cellW}" height="${cellH}" ` +
        `fill="none" data-date="${date}"/>`,
    );
    // Day number, top-left of the cell.
    const nx = left + 8;
    const ny = top + numSize + 4;
    parts.push(
      `    <text x="${nx}" y="${ny}" font-family="${escapeXml(numFont)}" ` +
        `font-size="${numSize}" font-weight="${numWeight}" fill="${fill}">${day}</text>`,
    );
    // Optional event label under the number.
    const entry = byDay.get(day);
    if (entry?.text) {
      const efont = entry.font ?? "Mulish";
      const esize = entry.size ?? 12;
      const eweight = entry.weight ?? 500;
      const efill = entry.fill ?? fill;
      parts.push(
        `    <text x="${nx}" y="${ny + esize + 6}" font-family="${escapeXml(efont)}" ` +
          `font-size="${esize}" font-weight="${eweight}" fill="${efill}">${escapeXml(entry.text)}</text>`,
      );
    }
  }
  return parts;
}

/** Result of composing an ai.svg: the document plus any non-fatal fit warnings. */
export interface ComposeResult {
  svg: string;
  /** Heuristic placement warnings (overflow, too many lines) — never fatal. */
  warnings: string[];
}

/**
 * Compose a complete ai.svg document from structured region input, positioning
 * each line using the parsed region geometry. Throws if a region name is unknown.
 * Returns the SVG plus non-fatal `warnings` (estimated overflow, more lines than
 * ruled rows) so an unattended caller can catch a bad layout before shipping it.
 */
export function composeAiSvg(
  size: [number, number],
  inputs: RegionInput[],
  regions: Region[],
): ComposeResult {
  const byName = new Map(regions.map((r) => [r.name, r]));
  const [w, h] = size;
  const parts: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`,
  ];
  const warnings: string[] = [];

  for (const input of inputs) {
    const region = byName.get(input.region);
    if (!region) {
      const valid = [...byName.keys()].join(", ");
      throw new Error(
        `Unknown region "${input.region}". This page exposes: ${valid || "(none)"}.`,
      );
    }
    if (input.lines && input.calendar) {
      throw new Error(
        `Region "${input.region}": provide either \`lines\` or \`calendar\`, not both.`,
      );
    }
    parts.push(
      `  <g transform="translate(${region.x},${region.y})" data-region="${region.name}">`,
    );
    if (input.calendar) {
      parts.push(...composeCalendar(region, input.calendar));
    } else {
      const def = REGION_DEFAULTS[region.name] ?? FALLBACK_DEFAULT;
      const lines = input.lines ?? [];
      // Warn if there are more lines than ruled rows to land them on.
      if (region.ruledLines.length > 0 && lines.length > region.ruledLines.length) {
        warnings.push(
          `region "${region.name}": ${lines.length} lines but only ` +
            `${region.ruledLines.length} ruled rows — extra lines may overflow.`,
        );
      }
      lines.forEach((line, i) => {
        const size = line.size ?? def.size;
        const font = line.font ?? def.font;
        const weight = line.weight ?? def.weight;
        const fill = line.fill ?? GOLD;
        let x = line.x ?? DEFAULT_X_PAD;
        const y = Math.round(baselineFor(region, line, i, size, lines.length));
        if (line.marker) {
          const m = markerFragment(line.marker, x, y, size, fill);
          parts.push(`    ${m.svg}`);
          x += m.advance;
        }
        parts.push(
          `    <text x="${x}" y="${y}" font-family="${escapeXml(font)}" ` +
            `font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line.text)}</text>`,
        );
        // Warn if the text likely runs past the region's right edge.
        if (region.width !== null) {
          const end = x + estimateTextWidth(line.text, font, size);
          if (end > region.width) {
            warnings.push(
              `region "${region.name}": line "${truncate(line.text)}" ` +
                `(~${end}px) may overflow the ${region.width}px region width.`,
            );
          }
        }
      });
    }
    parts.push(`  </g>`);
  }

  parts.push(`</svg>`);
  return { svg: parts.join("\n") + "\n", warnings };
}

/** Shorten a string for use inside a warning message. */
function truncate(s: string, max = 32): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Merge freshly composed region groups into an existing ai.svg: groups whose
 * `data-region` matches are replaced, every other group is preserved **verbatim**,
 * and genuinely new regions are appended. This is write_underlay's `merge` mode —
 * an update to one region (e.g. the schedule) leaves the rest of the page intact.
 *
 * Relies on the flat structure composeAiSvg emits (one non-nested
 * `<g data-region="…">` per region); raw hand-authored ai.svg with nested groups
 * inside a region is not a supported merge input.
 */
export function mergeRegions(
  existingSvg: string | null,
  composed: string,
  size: [number, number],
): string {
  const [w, h] = size;
  const existing = extractRegionGroups(existingSvg ?? "");
  const fresh = extractRegionGroups(composed);

  const order = [...existing.order];
  for (const name of fresh.order) {
    if (!order.includes(name)) order.push(name);
  }

  const parts = [`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`];
  for (const name of order) {
    const group = fresh.byName.get(name) ?? existing.byName.get(name);
    if (group) parts.push("  " + group.trim());
  }
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

// One non-nested `<g … data-region="NAME"> … </g>` block. Region groups never
// nest other <g>, so the first </g> is the correct close (non-greedy is safe).
const REGION_GROUP_RE = /<g\b[^>]*\bdata-region="([^"]+)"[^>]*>[\s\S]*?<\/g>/g;

function extractRegionGroups(svg: string): {
  order: string[];
  byName: Map<string, string>;
} {
  const byName = new Map<string, string>();
  const order: string[] = [];
  REGION_GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_GROUP_RE.exec(svg)) !== null) {
    const name = m[1];
    if (!byName.has(name)) order.push(name);
    byName.set(name, m[0]); // last write wins for a duplicated name
  }
  return { order, byName };
}

/** An empty (but well-formed) layer document on the given page size. */
export function emptySvg(size: [number, number]): string {
  const [w, h] = size;
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"></svg>\n`;
}
