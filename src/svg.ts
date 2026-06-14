import type { Region } from "./template.js";

/** The gold layer colour, per the Onionskin contract. */
export const GOLD = "#C9A227";

const DEFAULT_X_PAD = 24;

/** Fonts that render in-app; anything else falls back to the serif. */
const REGION_DEFAULTS: Record<string, { font: string; size: number }> = {
  affirmation: { font: "Newsreader", size: 26 },
  schedule: { font: "Mulish", size: 14 },
  priorities: { font: "Mulish", size: 15 },
  todo: { font: "Mulish", size: 15 },
  notes: { font: "Mulish", size: 14 },
  month: { font: "Mulish", size: 13 },
};
const FALLBACK_DEFAULT = { font: "Mulish", size: 14 };

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
  fill?: string;
}

export interface RegionInput {
  /** Region name from read_page, e.g. "schedule", "todo", "affirmation". */
  region: string;
  lines: LineInput[];
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
  // ...but center a lone auto-placed line vertically (nice for affirmations).
  if (line.row === undefined && autoIndex === 0 && region.height) {
    return Math.round(region.height / 2 + size / 3);
  }
  return topPad + row * lineHeight;
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
    const def = REGION_DEFAULTS[region.name] ?? FALLBACK_DEFAULT;
    parts.push(
      `  <g transform="translate(${region.x},${region.y})" data-region="${region.name}">`,
    );
    input.lines.forEach((line, i) => {
      const size = line.size ?? def.size;
      const font = line.font ?? def.font;
      const fill = line.fill ?? GOLD;
      const x = line.x ?? DEFAULT_X_PAD;
      const y = Math.round(baselineFor(region, line, i, size));
      parts.push(
        `    <text x="${x}" y="${y}" font-family="${escapeXml(font)}" ` +
          `font-size="${size}" fill="${fill}">${escapeXml(line.text)}</text>`,
      );
    });
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
