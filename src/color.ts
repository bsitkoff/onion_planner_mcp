/**
 * Colour helpers for adaptive palette **harmony** — deriving the day's underlay
 * palette from a template's sampled colours (`template.palette`) per the chapter
 * theme's `harmony` strategy. Pure functions, no deps.
 *
 * The one hard rule lives here, not in a runtime checker: **derived *text* colours
 * are floored dark** (`TEXT_L_MAX`) so they always read on the cream page. We don't
 * draw the paper — the template does — so legibility is solved once, at derivation,
 * rather than warned about per-write. Fills/banners get a different, lighter bound
 * (they sit behind white pill text). See `docs/SHARED-VISUAL-SPEC.md` §0/§6.
 */

export interface Hsl {
  /** Hue, 0–360. */ h: number;
  /** Saturation, 0–1. */ s: number;
  /** Lightness, 0–1. */ l: number;
}

/** The Onionskin sticker palette — the fallback base when a template exposes no colour. */
export const STICKER_PALETTE = ["#D8638C", "#E2825E", "#8FA98A", "#88B0D4", "#A99BC6", "#EBC559"];

// Legibility floors (lightness, 0–1). Text must be dark on cream; banner pills hold
// white text so they stay mid-dark; accents (markers/rules/numbers) sit in between.
const TEXT_L_MAX = 0.34;
const ACCENT_L_MAX = 0.46;
const BANNER_L_MIN = 0.4;
const BANNER_L_MAX = 0.6;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Parse `#rgb`/`#rrggbb` → HSL. Throws on a non-hex string (caller pre-validates). */
export function hexToHsl(hex: string): Hsl {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: "${hex}"`);
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
    }
    hue *= 60;
  }
  return { h: hue, s, l };
}

/** HSL → `#rrggbb` (hue wrapped to 0–360, s/l clamped). */
export function hslToHex({ h, s, l }: Hsl): string {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n: number) =>
    Math.round((n + mm) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Move a colour's lightness no higher than `max` (keeps it legible), keeping hue/sat. */
function darkenTo(hsl: Hsl, max: number): Hsl {
  return { ...hsl, l: Math.min(hsl.l, max) };
}

/** Pull a colour into a lightness band (for banner pills behind white text). */
function bandLightness(hsl: Hsl, min: number, max: number): Hsl {
  return { ...hsl, l: Math.max(min, Math.min(max, hsl.l)) };
}

export type Harmony = "match" | "complement" | "warm" | "cool" | "seasonal";

/** A palette derived for the underlay: legibility-floored text/serif/accent + banner fills. */
export interface DerivedPalette {
  text: string;
  serif: string;
  accent: string;
  banners: string[];
}

/** Seasonal anchor hue by month (1–12): winter cool → spring green → summer teal → autumn amber. */
function seasonalHue(month: number): number {
  if (month === 12 || month <= 2) return 250; // winter — cool indigo
  if (month <= 5) return 120; // spring — green
  if (month <= 8) return 190; // summer — teal
  return 32; // autumn — amber
}

/**
 * Derive the day's underlay palette from a template's sampled colours. `base` is
 * `template.palette` (most-saturated first); empty → the sticker palette. `variety`
 * (0–1) widens the banner set and lifts saturation; `month` (1–12) anchors `seasonal`.
 *
 * Strategy:
 *  - **match** — use the template's own swatches directly.
 *  - **complement** — the dominant hue's complement (+180°) plus two analogous accents.
 *  - **warm** / **cool** — bias every hue toward amber (~35°) / indigo (~215°).
 *  - **seasonal** — blend the dominant hue toward the season's anchor hue.
 *
 * Text/serif/accent are always floored dark (cream-legible); banners are banded so
 * white pill text reads. The result is deterministic for a given (base, harmony,
 * variety, month) — variety changes *how many* banners and their punch, not RNG.
 */
export function derivePalette(
  base: string[],
  harmony: Harmony,
  variety: number,
  month: number,
): DerivedPalette {
  const v = clamp01(variety);
  const src = (base.length ? base : STICKER_PALETTE)
    .map((h) => {
      try {
        return hexToHsl(h);
      } catch {
        return null;
      }
    })
    .filter((x): x is Hsl => x !== null);
  const seed = src.length ? src : [hexToHsl("#9C7C1A")];
  const dominant = seed[0];

  // Build the family of accent hues this harmony implies (before lightness shaping).
  let family: Hsl[];
  switch (harmony) {
    case "complement":
      family = [
        dominant,
        { ...dominant, h: dominant.h + 180 },
        { ...dominant, h: dominant.h + 150 },
        { ...dominant, h: dominant.h + 210 },
      ];
      break;
    case "warm":
      family = seed.map((c) => biasHue(c, 35));
      break;
    case "cool":
      family = seed.map((c) => biasHue(c, 215));
      break;
    case "seasonal": {
      const target = seasonalHue(month);
      family = seed.map((c) => ({ ...c, h: blendHue(c.h, target, 0.5) }));
      break;
    }
    case "match":
    default:
      family = seed;
      break;
  }
  // Saturation gets a gentle lift with variety so a "surprising" day reads bolder.
  family = family.map((c) => ({ ...c, s: clamp01(c.s * (0.85 + 0.35 * v)) }));

  // Banner count scales with the variety dial: steady = 1 quiet accent, surprising = up to 4.
  const bannerCount = Math.max(1, Math.min(family.length, 1 + Math.round(v * 3)));
  const banners = family
    .slice(0, bannerCount)
    .map((c) => hslToHex(bandLightness(c, BANNER_L_MIN, BANNER_L_MAX)));

  const accent = hslToHex(darkenTo(family[0], ACCENT_L_MAX));
  const text = hslToHex(darkenTo({ ...dominant, s: Math.min(dominant.s, 0.5) }, TEXT_L_MAX));
  // The serif (quote) leans a touch warmer/colourful than body ink but still dark.
  const serif = hslToHex(darkenTo(family[Math.min(1, family.length - 1)], TEXT_L_MAX));
  return { text, serif, accent, banners };
}

/** Nudge a hue toward `target` by `amount` (0–1) along the shorter arc. */
function blendHue(h: number, target: number, amount: number): number {
  let diff = ((target - h + 540) % 360) - 180; // shortest signed delta
  return h + diff * amount;
}

/** Bias a colour toward a warm/cool anchor hue (half-way), nudging saturation up slightly. */
function biasHue(c: Hsl, anchor: number): Hsl {
  return { h: blendHue(c.h, anchor, 0.4), s: clamp01(c.s * 1.05 + 0.05), l: c.l };
}
