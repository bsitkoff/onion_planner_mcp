/**
 * Colour helpers for adaptive palette **harmony** — deriving the day's underlay
 * palette from a template's sampled colours (`template.palette`) per the chapter
 * theme's `harmony` strategy. Pure functions, no deps.
 *
 * Gold is retired (design decisions, 2026-07-09) — there is no fixed seed colour any
 * more. The default palette derives from a chapter's own **palette character**
 * (`PALETTE_CHARACTERS` below), same catalogue as the app's `InkPalette.swift`.
 *
 * The underlay-palette rules (design/INK-PALETTE.md, mirrored from the sibling app
 * repo's contract) are enforced here, not in a runtime checker:
 *  - **Rule 1 — contrast floor**: any underlay TEXT colour clears ≥4.5:1 WCAG
 *    contrast against `PAPER_COLOR` (`floorTextHex`/`floorAccentHex`, now real WCAG
 *    math via `contrastRatio`, replacing the old hand-tuned lightness bands).
 *  - **Rule 2 — pre-lightened underlay**: `liftForUnderlay` lifts an ink colour
 *    lighter by a fixed offset in **OKLCH lightness** (perceptual — confirmed
 *    `liftForUnderlay = 0.14`, 2026-07-10), clamped so the lift never drops contrast
 *    below the floor — one rule, two guarantees.
 *  - **Rule 3 — no reserved colours**: the underlay may use any colour from its
 *    derived (lightened) palette.
 *
 * See `docs/SHARED-VISUAL-SPEC.md` §0/§6.
 */

export interface Hsl {
  /** Hue, 0–360. */ h: number;
  /** Saturation, 0–1. */ s: number;
  /** Lightness, 0–1. */ l: number;
}

/** The Onionskin sticker palette — the fallback base when a template exposes no colour. */
export const STICKER_PALETTE = ["#D8638C", "#E2825E", "#8FA98A", "#88B0D4", "#A99BC6", "#EBC559"];

/**
 * A named starting point for a chapter's 5 derived ink colours — mirrors the app's
 * `PaletteCharacter` (`Onionskin/DesignSystem/InkPalette.swift`). These six characters
 * + 30 ink hexes are **confirmed shipping tokens** (signed off 2026-07-10); kept in
 * sync by hand with the Swift catalogue. See design/INK-PALETTE.md.
 */
export const PALETTE_CHARACTERS: Record<string, string[]> = {
  // Sunbaked's 5th ink is mahogany #6E3320 (confirmed 2026-07-10) — was umber
  // #6F4A33, which duplicated Field notes; mahogany gives the warm set a deeper
  // anchor (~9.7:1 on paper) and dedupes.
  sunbaked: ["#B0492E", "#C4623F", "#8F6A16", "#A8506A", "#6E3320"],
  tidewater: ["#4A6FA5", "#2E7C82", "#4E5F82", "#2F6E57", "#45508C"],
  fieldNotes: ["#6B761F", "#4F7A4A", "#9A5A32", "#8A6A1E", "#6F4A33"],
  orchard: ["#7A3F73", "#93304C", "#226E6A", "#2F7A4E", "#6E4A8C"],
  dusk: ["#A2586A", "#6F5F9E", "#566B93", "#5E7A5C", "#855A78"],
  highlighter: ["#C2266E", "#1F5FD0", "#12855C", "#C85E18", "#6A34C4"],
};

/** The default palette character for a chapter with none set — pen-blue family. */
export const DEFAULT_PALETTE_CHARACTER = "tidewater";

/** A chapter's ink palette resolved to 5 hexes, honouring `paletteCharacter`/month. */
export function resolvePaletteCharacterInks(id: string | undefined): string[] {
  return (id && PALETTE_CHARACTERS[id]) || PALETTE_CHARACTERS[DEFAULT_PALETTE_CHARACTER];
}

/**
 * The 12 monthly ink palettes (confirmed 2026-07-10) — 5 AA-on-paper inks per month,
 * **distinct per month** (not 4 seasonal sets shared by lookup), so adjacent months
 * drift. Each month's inks are steered *away* from that month's sticker-set dominant
 * hues so handwriting/underlay never blends into a sticker, and carry no black/muddy
 * near-neutrals — saturated colours that show up on cream. A monthly (calendar)
 * chapter derives its 5 inks from here and **skips the palette-character picker**;
 * see `docs/AUTHORING.md` and the app's `design/INK-PALETTE.md`.
 *
 * Raw hexes are FILL seeds; any ink drawn as *text* still derives an auto-darkened
 * on-paper variant (Rule 1) and the underlay lift (Rule 2) applies identically.
 */
const MONTHLY_INKS: Record<number, string[]> = {
  1: ["#3E6FA0", "#2F6E57", "#5B5F9E", "#B23052", "#45508C"], // deep winter · cool
  2: ["#B0325F", "#7A3F73", "#6A4F9E", "#45508C", "#2E7C82"], // valentine · warm-cool
  3: ["#3E6FA0", "#2E7C82", "#7A3F73", "#8F6A16", "#BD5237"], // early spring · fresh
  4: ["#4A6FA5", "#4F7A4A", "#B84E74", "#6A4F9E", "#C0533F"], // mid spring · bright
  5: ["#B83A6A", "#6A4F9E", "#4F7A4A", "#4A6FA5", "#BD4032"], // late spring · floral
  6: ["#2E6FA0", "#2E7C82", "#C0374F", "#2F7A4E", "#8F6A16"], // early summer · bright
  7: ["#3E6FA0", "#1F7A6E", "#C0374F", "#B85221", "#7A3F73"], // high summer · hot
  8: ["#2E6FA0", "#2E7C82", "#B0492E", "#7A3F73", "#45508C"], // late summer · sea
  9: ["#A8442A", "#8A6A1E", "#4F7A4A", "#2E7C82", "#7A3F5E"], // early autumn · warm
  10: ["#B0492E", "#8F6A16", "#4F7A4A", "#6E3A6E", "#2E7C82"], // deep autumn · spooky
  11: ["#B0324A", "#B0492E", "#8F6A16", "#2F6E57", "#7A3F73"], // harvest · warm
  12: ["#A8324C", "#285F4E", "#8F6A16", "#7A3F73", "#3E6FA0"], // holiday · festive
};

/**
 * A monthly (calendar) chapter's 5 ink hexes for a given month (1–12) — the confirmed
 * per-month palette. An out-of-range month wraps into 1–12 (defensive; callers pass a
 * real `.folder.json → month`).
 */
export function monthlyInks(month: number): string[] {
  const m = ((Math.trunc(month) - 1) % 12 + 12) % 12 + 1;
  return MONTHLY_INKS[m];
}

// Legibility floors (lightness, 0–1) — retained ONLY for banner fills, which sit
// behind white pill text (a different contrast pair than Rule 1's "text on paper").
// Body/serif/accent text now go through the real WCAG floor (`floorTextHex`/
// `floorAccentHex`) instead of these bands.
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

/** Pull a colour into a lightness band (for banner pills behind white text). */
function bandLightness(hsl: Hsl, min: number, max: number): Hsl {
  return { ...hsl, l: Math.max(min, Math.min(max, hsl.l)) };
}

// MARK: - WCAG contrast (Rule 1) + the pre-lightened underlay (Rule 2)

const PAPER_HSL: Hsl = hexToHslLazy();
function hexToHslLazy(): Hsl {
  // `PAPER_COLOR` lives in template.ts; avoided importing it here to keep this module
  // dependency-free (per its header doc) — the literal is the same constant.
  return hexToHsl("#FFFEFB");
}

// MARK: - OKLab / OKLCH (perceptual lightness for the underlay lift, Rule 2)
//
// The underlay lift (`liftForUnderlay`) steps lightness in **OKLCH L**, not HSL:
// HSL lightness isn't perceptually uniform, so a fixed HSL step lifts yellow inks far
// more than blue and the darkness ladder looks inconsistent per ink. OKLab keeps "one
// step lighter" visually equal across all inks (confirmed 2026-07-10 — `liftForUnderlay
// = 0.14` in OKLCH L). Only the L axis is touched, so OKLab and OKLCH are the same here.
// Björn Ottosson's sRGB↔OKLab, self-contained (no deps).

/** sRGB channel (0–1, gamma) → linear-light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light channel → sRGB (0–1, gamma). */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** `#rrggbb`/`#rgb` → OKLab `{ L, a, b }` (L is 0–1 perceptual lightness). */
export function hexToOklab(hex: string): { L: number; a: number; b: number } {
  // Reuse hexToHsl's parsing indirectly via hslToHex round-trip? No — parse directly.
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: "${hex}"`);
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = srgbToLinear(parseInt(h.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(h.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(h.slice(4, 6), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m_ - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m_ + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m_ - 0.808675766 * s,
  };
}

/** OKLab `{ L, a, b }` → `#rrggbb` (sRGB channels clamped to gamut). */
export function oklabToHex({ L, a, b }: { L: number; a: number; b: number }): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const to = (lin: number) =>
    Math.round(clamp01(linearToSrgb(lin)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(lr)}${to(lg)}${to(lb)}`;
}

/** WCAG relative luminance (0 black … 1 white) from HSL via its RGB. */
function relativeLuminance(hsl: Hsl): number {
  const hex = hslToHex(hsl);
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two HSL colours (always ≥ 1). */
export function contrastRatio(a: Hsl, b: Hsl): number {
  const l1 = Math.max(relativeLuminance(a), relativeLuminance(b)) + 0.05;
  const l2 = Math.min(relativeLuminance(a), relativeLuminance(b)) + 0.05;
  return l1 / l2;
}

/** WCAG contrast ratio between two hex colours (convenience over `contrastRatio`). */
export function contrastRatioHex(a: string, b: string): number {
  return contrastRatio(hexToHsl(a), hexToHsl(b));
}

/** Rule 1: the contrast floor every underlay TEXT colour must clear against paper-0. */
export const CONTRAST_FLOOR = 4.5;

/**
 * Pick the legible label colour for text sitting on a **banner pill** — a different
 * contrast pair than Rule 1's "text on paper", since the pill, not the paper, is the
 * background. Returns `preferred` (the theme's pill text) whenever it already clears
 * the floor, otherwise whichever of the two candidates reads better on `pillHex`.
 *
 * A caller's `labelFill` is an arbitrary hex with no design review behind it, and
 * lightness-banding it doesn't bound luminance (a banded pale yellow still sits at
 * ~1.4:1 under white), so the pill colour is kept VERBATIM — Rule 1's "raw hex is
 * fills-only" — and the TEXT is what moves. `clears` reports whether the winner
 * actually made the floor, so a caller can be warned when neither candidate can.
 */
export function pillTextHex(
  pillHex: string,
  preferred: string,
  alternate: string,
): { hex: string; clears: boolean } {
  const preferredRatio = contrastRatioHex(pillHex, preferred);
  if (preferredRatio >= CONTRAST_FLOOR) return { hex: preferred, clears: true };
  const alternateRatio = contrastRatioHex(pillHex, alternate);
  return alternateRatio > preferredRatio
    ? { hex: alternate, clears: alternateRatio >= CONTRAST_FLOOR }
    : { hex: preferred, clears: false };
}

/**
 * Rule 1 — darken (drop HSL lightness, keep hue/sat) until `hsl` clears `CONTRAST_FLOOR`
 * against paper. A colour already at/above the floor passes through unchanged. This
 * replaces the old hand-tuned lightness bands (`TEXT_L_MAX`/`ACCENT_L_MAX`) with real
 * WCAG math — see `docs/ROADMAP.md`'s note that the lightness-band approach was always
 * a placeholder for this.
 */
function floorForContrast(hsl: Hsl): Hsl {
  let current = hsl;
  let l = hsl.l;
  let guardN = 0;
  while (contrastRatio(current, PAPER_HSL) < CONTRAST_FLOOR && l > 0.02 && guardN < 60) {
    l = Math.max(0, l - 0.02);
    current = { ...hsl, l };
    guardN += 1;
  }
  return current;
}

/**
 * Rule 2 — lift a colour lighter by `offset` in **OKLCH lightness** (perceptual, so
 * "one step lighter" reads visually equal across every ink — confirmed 2026-07-10),
 * but stop early — never reaching the full offset — if going further would drop
 * contrast against paper below `CONTRAST_FLOOR`. The floor always wins over the offset:
 * one rule, two guarantees (the underlay is always lighter than the matching ink
 * colour, and always readable). Applies to underlay text / line marks — the middle
 * rung of the darkness ladder; the washi/wash tier is lightened separately.
 *
 * Defensively re-floors the input first (Rule 1, in HSL) rather than assuming the
 * caller already guaranteed it: a couple of the ink tokens (Sunbaked's coral,
 * Highlighter's tangerine) don't themselves clear 4.5:1 on paper — flooring first
 * makes the rule hold regardless. An ink already sitting at the lightest AA-legal
 * value collapses the
 * underlay onto the floor (no lift) — accepted per the 2026-07-10 sign-off.
 *
 * `offset` is the OKLCH-L pre-lighten amount; the confirmed default is 0.14.
 */
export function liftForUnderlay(hex: string, offset = 0.14): string {
  const floored = floorForContrast(hexToHsl(hex));
  const flooredHex = hslToHex(floored);
  const base = hexToOklab(flooredHex);
  const targetL = Math.min(1, base.L + offset);
  if (targetL <= base.L) return flooredHex;
  let currentHex = flooredHex;
  let l = base.L;
  const step = 0.005;
  while (l < targetL) {
    const candidateL = Math.min(targetL, l + step);
    const candidateHex = oklabToHex({ ...base, L: candidateL });
    if (contrastRatioHex(candidateHex, "#FFFEFB") < CONTRAST_FLOOR) break;
    currentHex = candidateHex;
    l = candidateL;
  }
  return currentHex;
}

/** The underlay palette (5 hexes) lifted from a chapter's resolved ink-character inks. */
export function liftPaletteForUnderlay(inks: string[], offset = 0.14): string[] {
  return inks.map((hex) => liftForUnderlay(hex, offset));
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
  const seed = src.length ? src : [hexToHsl(resolvePaletteCharacterInks(undefined)[0])];
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

  const accent = hslToHex(floorForContrast(family[0]));
  const text = hslToHex(floorForContrast({ ...dominant, s: Math.min(dominant.s, 0.5) }));
  // The serif (quote) leans a touch warmer/colourful than body ink but still dark.
  const serif = hslToHex(floorForContrast(family[Math.min(1, family.length - 1)]));
  return { text, serif, accent, banners };
}

/**
 * Build a legibility-shaped palette from a single explicit accent hex (a chapter's
 * `theme.accent`) — the same flooring as `derivePalette`, but from one chosen colour
 * instead of a template's swatches. Text/serif are floored dark so they read on cream;
 * the accent sits a touch lighter; one banner is banded for white pill text. Throws on
 * a non-hex string (the caller pre-validates or catches to fall back to the default).
 */
export function deriveAccentPalette(accent: string): DerivedPalette {
  const base = hexToHsl(accent);
  const text = hslToHex(floorForContrast({ ...base, s: Math.min(base.s, 0.55) }));
  const serif = hslToHex(floorForContrast(base));
  const acc = hslToHex(floorForContrast(base));
  const banner = hslToHex(bandLightness(base, BANNER_L_MIN, BANNER_L_MAX));
  return { text, serif, accent: acc, banners: [banner] };
}

/**
 * The default underlay palette — a chapter's own resolved ink colours (5 hexes: a
 * palette character's inks, or a month's `monthlyInks`), lifted per Rule 2 instead of
 * floored dark. This is the palette a chapter with no `harmony`/`accent`/preset
 * `theme` gets: NOT a fixed seed colour (gold is retired) — the underlay is always
 * the chapter's own ink identity, just lighter than the hand.
 */
export function derivePaletteFromInks(inks: string[]): DerivedPalette {
  const source = inks.length ? inks : resolvePaletteCharacterInks(undefined);
  const lifted = source.map((hex) => liftForUnderlay(hex));
  const text = lifted[0];
  const serif = lifted[1] ?? lifted[0];
  const accent = lifted[0];
  const banners = (lifted.length > 2 ? lifted.slice(2) : lifted).map((hex) =>
    hslToHex(bandLightness(hexToHsl(hex), BANNER_L_MIN, BANNER_L_MAX)),
  );
  return { text, serif, accent, banners };
}

/** Floor a hex for use as body/serif text on cream — Rule 1's real WCAG contrast floor. */
export function floorTextHex(hex: string): string {
  return hslToHex(floorForContrast(hexToHsl(hex)));
}

/** Floor a hex for accents — markers, rules, calendar day numbers — on cream (Rule 1). */
export function floorAccentHex(hex: string): string {
  return hslToHex(floorForContrast(hexToHsl(hex)));
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
