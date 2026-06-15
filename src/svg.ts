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

/** Fonts that render in-app; anything else falls back to the serif. */
const REGION_DEFAULTS: Record<string, { font: string; size: number; weight: number }> = {
  affirmation: { font: "Newsreader", size: 26, weight: 500 },
  schedule: { font: "Mulish", size: 14, weight: 600 },
  priorities: { font: "Mulish", size: 15, weight: 600 },
  todo: { font: "Mulish", size: 15, weight: 600 },
  notes: { font: "Mulish", size: 14, weight: 600 },
  month: { font: "Mulish", size: 13, weight: 600 },
};
const FALLBACK_DEFAULT = { font: "Mulish", size: 14, weight: DEFAULT_WEIGHT };

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
  /** SVG font-weight (100–900). Defaults per region (600; 500 for affirmation). */
  weight?: number;
  fill?: string;
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
  /** Region name from read_page, e.g. "schedule", "todo", "affirmation". */
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

  // No ruled lines (e.g. todo, affirmation): stack by line height...
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
 * Lay a month's day cells onto a gridded region, using its parsed column/row
 * lines. Per day: a `<rect data-date="YYYY-MM-DD" fill="none">` covering the cell
 * (the app's tap-to-day target) + a gold day number, plus an optional event label.
 * Returns SVG fragments in LOCAL coordinates (the caller wraps them in the region's
 * translate group, so we subtract the region origin from the absolute grid lines).
 */
function composeCalendar(region: Region, spec: CalendarSpec): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(spec.month.trim());
  if (!m) throw new Error(`calendar.month must be "YYYY-MM", got "${spec.month}".`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) {
    throw new Error(`calendar.month has an invalid month: "${spec.month}".`);
  }

  const cols = region.colLines;
  const rows = region.ruledLines;
  if (cols.length < 2 || rows.length < 2) {
    throw new Error(
      `Region "${region.name}" is not a grid (needs colLines + ruledLines). ` +
        `Calendar layout requires a gridded month template.`,
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

/**
 * Compose a complete ai.svg document from structured region input, positioning
 * each line using the parsed region geometry. Throws if a region name is unknown.
 */
export function composeAiSvg(
  size: [number, number],
  inputs: RegionInput[],
  regions: Region[],
): string {
  const byName = new Map(regions.map((r) => [r.name, r]));
  const [w, h] = size;
  const parts: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`,
  ];

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
      lines.forEach((line, i) => {
        const size = line.size ?? def.size;
        const font = line.font ?? def.font;
        const weight = line.weight ?? def.weight;
        const fill = line.fill ?? GOLD;
        const x = line.x ?? DEFAULT_X_PAD;
        const y = Math.round(baselineFor(region, line, i, size, lines.length));
        parts.push(
          `    <text x="${x}" y="${y}" font-family="${escapeXml(font)}" ` +
            `font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line.text)}</text>`,
        );
      });
    }
    parts.push(`  </g>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

/** An empty (but well-formed) layer document on the given page size. */
export function emptySvg(size: [number, number]): string {
  const [w, h] = size;
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"></svg>\n`;
}
