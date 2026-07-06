import type { Region } from "./template.js";
import {
  derivePalette,
  deriveAccentPalette,
  floorTextHex,
  floorAccentHex,
  type Harmony,
} from "./color.js";

/**
 * The single canonical Onionskin gold, per the contract — one value shared by the
 * app chrome, this MCP, and the on-device composer (deepened so it stays legible on
 * the cream page). One constant — retune here if the brand gold shifts. (`#7E5C12`,
 * the chrome's AA-tuned *text* gold, is deliberately NOT used in the underlay — the
 * locked contract emits one gold here; see `docs/SHARED-VISUAL-SPEC.md` §0.)
 */
export const GOLD = "#9C7C1A";

/**
 * The SVG elements the app's custom renderer handles (SwiftUI `Canvas` + `XMLParser`,
 * no WebKit) — anything else is silently dropped on device. The single source of truth
 * for both raw escape hatches: the top-level `svg` param (`page.ts`) and a region's
 * verbatim `svg` fragment (`composeAiSvg` below).
 */
export const RAW_SVG_ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "rect",
  "line",
  "path",
  "text",
  "image",
  "circle",
  "ellipse",
  "polyline",
  "polygon",
]);

/** Element names used in `svg` that fall outside the renderer's set (sorted, unique). */
export function scanRawSvgElements(svg: string): string[] {
  const unsupported = new Set<string>();
  for (const m of svg.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:_-]*)\b/g)) {
    const tag = m[1].toLowerCase();
    if (!RAW_SVG_ALLOWED_ELEMENTS.has(tag)) unsupported.add(tag);
  }
  return [...unsupported].sort();
}

/**
 * True when raw svg contains an <image href="data:..."> — the app renderer resolves
 * <image href> only as a page-relative file path (never a data: URI; CLAUDE.md Gotchas),
 * so this would write fine but never render. Only `href` is checked — this codebase never
 * emits `xlink:href` for <image> (see the href emission below, in composeAiSvg).
 */
export function scanRawSvgDataUriImages(svg: string): boolean {
  return /<image\b[^>]*\bhref\s*=\s*["']\s*data:/i.test(svg);
}

/** Font roles applied when a `fontPersonality` is chosen (else region defaults stand). */
export interface ThemeFonts {
  /** Body lines (schedule, to-do, ainotes…). */
  body: string;
  /** Heading lines + region-title labels/banners. */
  heading: string;
  /** The serif register (the `ainotes` AI-voice region). */
  serif: string;
}

/**
 * A resolved page palette + fonts. Gold was only ever a *default*, not a constraint —
 * the app renderer honours any `fill`, so the AI layer can carry colour. A theme maps
 * the composer's colour roles; callers pick a named preset *or* the adaptive param
 * block (`harmony`/`varietyDial`/`fontPersonality`) via `write_underlay`.
 *
 * - `text`/`serif`: body text (serif = the `ainotes` AI-voice region).
 * - `accent`: markers (checkbox/bullet), rules, calendar day numbers.
 * - `banners` + `bannerText`: section-heading banners (a coloured pill behind a
 *   white label), cycled per heading so sections read distinctly.
 * - `headingStyle`: `banner` (coloured pill) or `underline` (label + hairline rule).
 * - `fonts`: optional family overrides from `fontPersonality`; undefined = the
 *   per-region defaults (`REGION_DEFAULTS`).
 */
export interface Theme {
  text: string;
  serif: string;
  accent: string;
  bannerText: string;
  banners: string[];
  headingStyle: "banner" | "underline";
  fonts?: ThemeFonts;
}

/**
 * Floor a preset's text/serif/accent to the same cream-legibility bounds the adaptive
 * palette derives under (the contract's AA rule applies to every path, not just the
 * derived one). Banners are untouched — they sit behind white pill text, a different
 * bound. The gold preset skips this: gold is the one canonical value, tuned by hand.
 */
function legible(t: Theme): Theme {
  return {
    ...t,
    text: floorTextHex(t.text),
    serif: floorTextHex(t.serif),
    accent: floorAccentHex(t.accent),
  };
}

export const THEMES: Record<string, Theme> = {
  // The legacy monochrome default — unchanged output when no theme is chosen.
  gold: {
    text: GOLD, serif: GOLD, accent: GOLD,
    bannerText: "#FFFFFF", banners: [GOLD], headingStyle: "underline",
  },
  // Lively, saturated — closest to a colourful planner spread.
  bright: legible({
    text: "#3A3A3A", serif: "#8E6FC9", accent: "#E86A92",
    bannerText: "#FFFFFF", banners: ["#3FB6A8", "#F2884B", "#E86A92", "#8E6FC9"],
    headingStyle: "banner",
  }),
  // Softer, hand-painted warmth.
  cozy: legible({
    text: "#4A4A4A", serif: "#7E5A78", accent: "#C56B6B",
    bannerText: "#FFFFFF", banners: ["#C56B6B", "#7C8A5A", "#9C7C1A", "#7E5A78"],
    headingStyle: "banner",
  }),
  // Restrained — one or two accents, quiet labels, lots of whitespace.
  editorial: legible({
    text: "#33312E", serif: "#B5654A", accent: "#B5654A",
    bannerText: "#FFFFFF", banners: ["#B5654A", "#9A9081"], headingStyle: "underline",
  }),
};

export const THEME_NAMES = Object.keys(THEMES);

export type FontPersonality = "clean" | "handwritten" | "editorial";

/**
 * `fontPersonality` → font families (all within the closed in-app set). `clean`
 * reproduces the historical defaults exactly (Mulish body/heading, Newsreader serif),
 * so an unset/`clean` personality is a no-op on output.
 */
const FONT_PERSONALITIES: Record<FontPersonality, ThemeFonts> = {
  clean: { body: "Mulish", heading: "Mulish", serif: "Newsreader" },
  handwritten: { body: "Caveat", heading: "Fredoka", serif: "Caveat" },
  editorial: { body: "Newsreader", heading: "Mulish", serif: "Newsreader" },
};

/**
 * The chapter theme contract (`.folder.json → theme`, per the app's `FORMAT.md §4`)
 * as this server consumes it, plus the back-compat preset `name`. `chromeAccent` is
 * the app's concern (chrome only) — accepted and ignored here. `templatePalette` is
 * what we sample from the page's own template (`read_page`'s `template.palette`); the
 * app doesn't send it (we're not its caller — an orchestrator drives us).
 */
export interface ThemeInput {
  /** Named preset (gold/bright/cozy/editorial) — quick pick / back-compat. */
  name?: string;
  /** Palette strategy vs the template's colours. */
  harmony?: Harmony;
  /** 0 steady … 1 surprising — banner count + saturation + heading style. */
  varietyDial?: number;
  /** AI-text voice. */
  fontPersonality?: FontPersonality;
  /** Template colours to harmonise to (most-saturated first). */
  templatePalette?: string[];
  /**
   * An explicit underlay accent (hex) from the chapter's `theme.accent` — tints body
   * text / markers / banners so a chapter can carry a colour (e.g. lavender) the named
   * presets don't. Applied when no adaptive `harmony` and no explicit preset `name` is
   * given (harmony/preset win); floored dark for cream via `deriveAccentPalette`.
   */
  accent?: string;
  /** App-only chrome accent; accepted for contract-completeness, not used here. */
  chromeAccent?: string;
  /** Current month (1–12) for `seasonal` harmony; defaults to the real month. */
  month?: number;
}

/**
 * True when the input asks for an adaptive (harmony-derived) *colour* palette. Only
 * the colour knobs (`harmony`/`varietyDial`) trigger this — `fontPersonality` is a
 * font axis (layered on any palette below) and the always-sampled `templatePalette`
 * is mere context, so neither one alone flips a default-gold page into a derived one.
 */
function isAdaptive(t: ThemeInput): boolean {
  return t.harmony !== undefined || t.varietyDial !== undefined;
}

/** Resolution of a ThemeInput: the Theme plus any non-fatal notes (e.g. palette fallback). */
export interface ResolvedTheme {
  theme: Theme;
  warnings: string[];
}

/**
 * Resolve a theme. Precedence: an **adaptive** param block (`harmony` and/or
 * `varietyDial` — see `isAdaptive`) derives a palette from the template's colours;
 * otherwise a named **preset**; otherwise a chapter `accent`; otherwise the gold
 * default. `fontPersonality` always layers its fonts on top of whichever palette
 * path is taken (it never selects one). A string is a bare preset name (back-compat).
 */
export function resolveTheme(input?: ThemeInput | string): ResolvedTheme {
  const t: ThemeInput = typeof input === "string" ? { name: input } : input ?? {};
  const warnings: string[] = [];

  let theme: Theme;
  if (isAdaptive(t)) {
    const harmony: Harmony = t.harmony ?? "match";
    const variety = t.varietyDial ?? 0.5;
    const month = t.month ?? new Date().getMonth() + 1;
    const base = t.templatePalette ?? [];
    if (base.length === 0) {
      warnings.push(
        `theme: no template palette to harmonise to — used the Onionskin sticker palette.`,
      );
    }
    const p = derivePalette(base, harmony, variety, month);
    theme = {
      text: p.text,
      serif: p.serif,
      accent: p.accent,
      bannerText: "#FFFFFF",
      banners: p.banners,
      // A steady day stays quiet (underline headings); past the midpoint, banner pills.
      headingStyle: variety < 0.4 ? "underline" : "banner",
    };
  } else if (t.name && THEMES[t.name]) {
    // An explicit preset name wins over a chapter accent (a per-day override).
    theme = THEMES[t.name];
  } else if (t.accent) {
    // A chapter's explicit accent tints an otherwise-default page (e.g. lavender todos).
    try {
      const p = deriveAccentPalette(t.accent);
      theme = {
        text: p.text,
        serif: p.serif,
        accent: p.accent,
        bannerText: "#FFFFFF",
        banners: p.banners,
        headingStyle: "underline",
      };
    } catch {
      warnings.push(`theme: accent "${t.accent}" is not a hex colour — used the gold default.`);
      theme = THEMES.gold;
    }
  } else {
    theme = THEMES.gold;
  }

  if (t.fontPersonality) {
    theme = { ...theme, fonts: FONT_PERSONALITIES[t.fontPersonality] };
  }
  return { theme, warnings };
}

/** Font family for a region's lines, honouring a `fontPersonality` override if set. */
function themeFontFor(theme: Theme, regionName: string, heading: boolean): string | undefined {
  if (!theme.fonts) return undefined;
  if (heading) return theme.fonts.heading;
  // `ainotes` is the serif AI-voice register; `quote`/`affirmation` are legacy aliases.
  if (regionName === "ainotes" || regionName === "quote" || regionName === "affirmation")
    return theme.fonts.serif;
  return theme.fonts.body;
}

const DEFAULT_X_PAD = 24;
/** Default text weight — heavier than regular to carry the gold on white. */
const DEFAULT_WEIGHT = 600;

/**
 * Per-region font/size/weight defaults. Keyed by the template's `data-region`
 * name — keep in sync with the shipped templates (`../onionskin/.../Templates/`).
 * The serif AI-voice region is `ainotes` (was `quote`, earlier `affirmation`); the
 * legacy names are kept so older pages still pick up the serif styling. Unknown
 * regions use FALLBACK_DEFAULT.
 */
interface RegionDefault {
  font: string;
  size: number;
  weight: number;
  /** Left inset for text when a line omits `x` (overrides DEFAULT_X_PAD). The
   *  schedule needs a wider gutter so its text clears the printed hour labels. */
  xPad?: number;
}
const REGION_DEFAULTS: Record<string, RegionDefault> = {
  ainotes: { font: "Newsreader", size: 16, weight: 500 }, // the serif AI-voice register
  header: { font: "Mulish", size: 20, weight: 700 },
  schedule: { font: "Mulish", size: 15, weight: 600, xPad: 52 },
  agenda: { font: "Mulish", size: 15, weight: 600, xPad: 52 },
  todo: { font: "Mulish", size: 15, weight: 600 },
  notes: { font: "Mulish", size: 14, weight: 600 },
  focus: { font: "Mulish", size: 15, weight: 600 },
  month: { font: "Mulish", size: 13, weight: 600 },
  // legacy region names (retired 2026-06) — kept so older pages still style correctly.
  quote: { font: "Newsreader", size: 16, weight: 500 },
  affirmation: { font: "Newsreader", size: 16, weight: 500 },
  priorities: { font: "Mulish", size: 15, weight: 600 },
  goals: { font: "Mulish", size: 15, weight: 600 },
};
const FALLBACK_DEFAULT: RegionDefault = { font: "Mulish", size: 14, weight: DEFAULT_WEIGHT };

/** A leading mark drawn before a line's text (todo lists, bulleted notes). */
export type LineMarker = "checkbox" | "bullet";

/**
 * Confirmed Phosphor codepoints, mirrored 1:1 from the app's canonical
 * `Onionskin/DesignSystem/Phosphor.swift`. ONLY names with a verified codepoint belong
 * here — a wrong guess renders tofu on device (no glyph, just a missing-character box).
 * Deliberately incomplete: umbrella/sun/cloud/check/star — the weather/decoration set
 * roadmap item 2.1 actually wanted — are NOT yet published by the app and are deferred
 * until they are (see docs/ROADMAP.md).
 */
export const PHOSPHOR_CODEPOINTS: Record<string, string> = {
  bookOpen: "",
  calendarBlank: "",
  lockSimple: "",
  circleHalf: "",
  magnifyingGlass: "",
  house: "",
  gear: "",
  pencilSimple: "",
  hand: "",
  arrowsClockwise: "",
  lightning: "",
  caretRight: "",
  files: "",
  eraser: "",
  sticker: "",
  smiley: "",
  trash: "",
  x: "",
  export: "",
  shareNetwork: "",
  plus: "",
  minus: "",
};

export interface LineInput {
  text: string;
  /** Ruled-row index to align to (0-based). Ignored if `y` is given. */
  row?: number;
  /**
   * Clock time "HH:MM" (24-hour). Resolved to a ruled row via the region's
   * `startHour`/`rowsPerHour` (nearest row). Ignored if `y` or `row` is given,
   * or if the region has no ruled rows / no `startHour`.
   */
  time?: string;
  /**
   * End of a washi-tape duration block starting at `time` — draws a rounded, tinted
   * block spanning start→end rows instead of a single baseline. Mutually exclusive
   * with `durationMin`. Ignored (with a warning) if `time` isn't also set.
   */
  endTime?: string;
  /** Duration in minutes from `time`, alternative to `endTime`. */
  durationMin?: number;
  /** Override the washi block's tint (hex). Defaults to `theme.accent`. */
  blockFill?: string;
  /** Washi block fill opacity, 0–1 (default 0.22). */
  blockOpacity?: number;
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
  /**
   * Draw a leading Phosphor icon glyph (font-rendered) before the text and shift the
   * text past it, from the confirmed-codepoint subset in `PHOSPHOR_CODEPOINTS`.
   * Mutually exclusive with `marker` (one leading mark per line).
   */
  icon?: string;
  /**
   * Wrap the text to the region width instead of overflowing. Continuation
   * segments stack just below the baseline (they do NOT consume the next ruled
   * row, so a caller's row→content mapping stays intact). **Defaults ON** for a
   * flow-placed body line in a width-bounded region (no `row`/`time`/`y`); set
   * `false` to force a single segment, or `true` to wrap a row/time-anchored line.
   */
  wrap?: boolean;
  /**
   * Render this line as a section heading rather than body text: bold, letter-
   * spaced, with a hairline gold rule beneath it spanning the region width. This
   * is how the AI layer draws *dynamic structure* into a neutral region — e.g.
   * carving the `notes` box into "Important" / "Tomorrow" / "Habits" sub-blocks
   * only on the days that need them, so the printed template can stay minimal.
   * In a box (unruled) region, a heading takes a little extra space above it and
   * the lines after it flow below; `marker`/`wrap` are ignored on a heading line.
   */
  heading?: boolean;
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

/** Where to place an image within its region's box. */
export type ImageCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

/**
 * An AI-owned image placed into a region. The caller passes `data` (base64) +
 * `format`; `page.ts` validates/sizes it, writes it to the page's `media/ai/`
 * folder, and fills in `href` + the resolved `width`/`height` before this reaches
 * `composeAiSvg`, which only reads the resolved fields.
 */
export interface ImageInput {
  /** Base64-encoded image bytes (caller-supplied). Mutually exclusive with `path`. */
  data?: string;
  /**
   * Absolute local file path to read the image bytes from, instead of inlining
   * `data`. Lets an overnight/automated caller embed a generated PNG by reference —
   * the file never passes through the model context. Leading `~` is expanded.
   * Mutually exclusive with `data`.
   */
  path?: string;
  /** Encoding. Optional when reading from `path` (sniffed from the file's magic bytes). */
  format?: "png" | "jpeg";
  /** Stable filename stem; defaults to a content hash. Sanitized in page.ts. */
  name?: string;
  /** Display width in region-local units (required). */
  width?: number;
  /** Display height; omitted = preserve aspect from the decoded image. */
  height?: number;
  /** Region-local x (overrides `corner`). */
  x?: number;
  /** Region-local y (overrides `corner`). */
  y?: number;
  /** Placement within the region box (default `center`). Ignored if x/y set. */
  corner?: ImageCorner;
  /** Inset from the region edge for corner placement (default 8). */
  margin?: number;
  /** Image opacity, 0–1. */
  opacity?: number;
  /**
   * Cut a background out of the image before placing it, resolved in
   * `page.ts:resolveImages` before the `media/ai/` write. `"subject"` runs a
   * saliency cutout (rembg) — best for a clean single subject. `"chroma"` keys a
   * solid uniform background colour to transparent — the reliable path for
   * diffuse/soft art where saliency erases the subject; requires a PNG source and
   * `chromaColor`. Default `"none"`. A knocked-out image's resolved format is
   * always `"png"` regardless of any declared `format`. See `docs/AUTHORING.md`.
   */
  knockout?: "subject" | "chroma" | "none";
  /** Background colour to key transparent (hex) — required with `knockout: "chroma"`. */
  chromaColor?: string;
  /** Per-channel colour-distance tolerance for `knockout: "chroma"` (0–255, default 30). */
  tolerance?: number;
  /** Resolved by page.ts: the `media/ai/<file>` reference written into ai.svg. */
  href?: string;
}

export interface RegionInput {
  /** Region name from read_page, e.g. "schedule", "todo", "quote". */
  region: string;
  /**
   * A region *title* banner, drawn in the margin just above the region box (so it
   * never consumes a content row). This is how the AI labels a region the template
   * left bare — e.g. "SCHEDULE" / "TOP 3" over a minimal grid. `banner` themes draw
   * a colored pill; `underline`/`gold` themes a bold label + short rule. (For
   * sub-sections *inside* a box, use a `heading` line instead.)
   */
  label?: string;
  /** Override the label banner color (defaults to the theme's cycled banner color). */
  labelFill?: string;
  /** Text lines (ruled/box regions). Mutually exclusive with `calendar`/`svg`. */
  lines?: LineInput[];
  /** Calendar grid (the month region). Mutually exclusive with `lines`/`svg`. */
  calendar?: CalendarSpec;
  /**
   * A raw SVG fragment emitted **verbatim** inside this region's `<g>` (an escape
   * hatch for hand-placed `<text>`/shapes when the structured `lines` placement isn't
   * enough). Composes and merges like any region. Mutually exclusive with
   * `lines`/`calendar`. Element names are checked against the app renderer's set
   * (`RAW_SVG_ALLOWED_ELEMENTS`); unsupported ones warn. NOTE: an `<image href>` here
   * is NOT media-resolved — use the structured `images` array for app-rendered art.
   */
  svg?: string;
  /** AI-owned images placed in this region (written to `media/ai/`). */
  images?: ImageInput[];
  /**
   * Clock hour (0–23) of ruled row 0 — anchors `line.time` to the grid. No
   * template carries hour labels, so the caller supplies this; without it, a
   * line's `time` is ignored (placed by order instead).
   */
  startHour?: number;
  /** Ruled rows per hour (default 1; 2 = a half-hour grid). Anchors `line.time`. */
  rowsPerHour?: number;
  /**
   * Stamp small hour labels ("7a"/"12p") at each whole-hour ruled row, from this
   * region's resolved `startHour`/`rowsPerHour` — for a timed grid whose template
   * prints no hour numbers. No-op (with an info warning) if there are no ruled
   * rows or no startHour resolves. Only applies to the `lines`-bearing branch.
   */
  showHours?: boolean;
}

function escapeXml(s: string): string {
  // Quotes too — escapeXml also guards attribute values (font-family, href), where
  // an unescaped `"` would end the attribute and leave malformed XML the app's
  // parser rejects wholesale (an invisible AI layer).
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
 * Width to give a banner LABEL's colored pill. Deliberately *over*-estimates: banner
 * labels are heavy (weight 700–800) and letter-spaced, so they render much wider than
 * the body-text heuristic predicts — under-sizing clips the text outside the pill.
 * Better too wide than too tight.
 */
function bannerLabelWidth(text: string, size: number): number {
  return Math.round(text.length * size * 0.82);
}
const BANNER_PAD_X = 12;

/**
 * Map a clock time ("HH:MM", 24-hour) to a ruled-row index, given the hour at
 * row 0 and how many rows cover an hour. Rounds to the nearest row. Throws on a
 * malformed time string. The caller clamps/validates the resulting row range.
 */
function rowForTime(time: string, startHour: number, rowsPerHour: number): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) throw new Error(`time must be "HH:MM" (24-hour), got "${time}".`);
  const minutesFromStart = (Number(m[1]) * 60 + Number(m[2])) - startHour * 60;
  return Math.round((minutesFromStart / 60) * rowsPerHour);
}

/**
 * "HH:MM" + minutes -> "HH:MM", for a washi block's `durationMin`. Clock-wrap past
 * midnight is out of scope — no template's grid spans a day boundary — so an
 * out-of-range result is left as-is for `rowForTime` to reject downstream with its
 * own clear error.
 */
function addMinutes(time: string, minutes: number): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) return time;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** A 24h hour (0-23, wrapped) as compact "7a"/"12p" shorthand — for `showHours`. */
function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? "a" : "p";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}${period}`;
}

/**
 * Greedily break `text` into segments that each fit within `maxWidth` (per the
 * width heuristic). A single over-long word is hard-broken at the character
 * level so one token can't overflow. Returns `[text]` unchanged when it already
 * fits or `maxWidth <= 0`.
 */
function wrapText(text: string, font: string, size: number, maxWidth: number): string[] {
  if (maxWidth <= 0 || estimateTextWidth(text, font, size) <= maxWidth) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  let cur = "";
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (estimateTextWidth(candidate, font, size) <= maxWidth) {
      cur = candidate;
      continue;
    }
    if (cur) out.push(cur);
    if (estimateTextWidth(word, font, size) > maxWidth) {
      // Hard-break a word longer than the whole width.
      let chunk = "";
      for (const ch of word) {
        if (chunk && estimateTextWidth(chunk + ch, font, size) > maxWidth) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      cur = chunk;
    } else {
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [text];
}

/** How far a `marker` (checkbox/bullet) pushes the text x past it. Shared by
 *  `markerFragment` (drawing) and `flowLineAdvance` (box-region wrap width). */
function markerAdvance(marker: LineMarker, size: number): number {
  if (marker === "checkbox") {
    return Math.round(size * 0.85) + Math.round(size * 0.4);
  }
  return 2 * Math.max(2, Math.round(size * 0.16)) + Math.round(size * 0.4);
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
  const advance = markerAdvance(marker, size);
  if (marker === "checkbox") {
    const box = Math.round(size * 0.85);
    const top = baseline - box; // sit the box just above the baseline
    const sw = Math.max(1, Math.round(size / 12));
    return {
      svg: `<rect x="${x}" y="${top}" width="${box}" height="${box}" rx="2" fill="none" stroke="${fill}" stroke-width="${sw}"/>`,
      advance,
    };
  }
  // bullet
  const r = Math.max(2, Math.round(size * 0.16));
  const cx = x + r;
  const cy = baseline - Math.round(size * 0.32);
  return {
    svg: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`,
    advance,
  };
}

/** How far an `icon` (Phosphor glyph) pushes the text x past it — `0` for an
 *  unrecognized name. Shared by `iconFragment` (drawing) and `flowLineAdvance`. */
function iconAdvance(name: string, size: number): number {
  if (!PHOSPHOR_CODEPOINTS[name]) return 0;
  return Math.round(size * CHAR_WIDTH_RATIO.Phosphor) + Math.round(size * 0.3);
}

/**
 * A leading Phosphor icon glyph drawn at local (x, baseline), parallel to
 * `markerFragment` but font-rendered instead of a drawn shape. Returns an empty
 * fragment for an unrecognized name — schema validation already guarantees a known
 * key, so this is a defensive fallback only, not the primary error path.
 */
function iconFragment(
  name: string,
  x: number,
  baseline: number,
  size: number,
  fill: string,
): { svg: string; advance: number } {
  const codepoint = PHOSPHOR_CODEPOINTS[name];
  if (!codepoint) return { svg: "", advance: 0 };
  return {
    svg: `<text x="${x}" y="${baseline}" font-family="Phosphor" font-size="${size}" fill="${fill}">${escapeXml(codepoint)}</text>`,
    advance: iconAdvance(name, size),
  };
}

const WASHI_RX = 6; // reuses the one corner-radius convention (SHARED-VISUAL-SPEC §5)
const WASHI_DEFAULT_OPACITY = 0.22;

/**
 * A washi-tape-style duration block: a rounded, translucent-tint rect spanning
 * [y1, y2) (region-local), with the label text vertically centred inside — the same
 * centring ratio used for the printed label-slot banner text, so a block's label
 * sits consistently with every other "text inside a box" convention in this file.
 *
 * A label too long to fit the block's width on one line wraps into multiple lines
 * (reusing `wrapText`, the same greedy wrapper used for `ainotes`/`todo`), stacked and
 * vertically centred in the block — using the tape's own height rather than letting
 * the text run past the right edge. The single-line case renders byte-identical to
 * before (same baseline formula) so existing pages are unaffected. `overflow` comes
 * back true when even the wrapped lines don't fit the block's height, so the caller
 * can warn — today that case is silently drawn with no signal at all.
 */
function washiBlockFragment(
  x: number,
  y1: number,
  y2: number,
  width: number,
  text: string,
  font: string,
  size: number,
  weight: number,
  textFill: string,
  blockFill: string,
  opacity: number,
): { svg: string; overflow: boolean } {
  const h = y2 - y1;
  const rect =
    `<rect x="${x}" y="${y1}" width="${width}" height="${h}" rx="${WASHI_RX}" ` +
    `fill="${blockFill}" fill-opacity="${opacity}"/>`;
  const innerWidth = width - BANNER_PAD_X * 2;
  const segments = wrapText(text, font, size, innerWidth);
  const labelX = x + BANNER_PAD_X;
  let labels: string;
  let overflow: boolean;
  if (segments.length <= 1) {
    // Unchanged from before wrapping was added: single baseline, centred by the same ratio.
    const labelY = y1 + h - Math.round(h * 0.28);
    labels =
      `<text x="${labelX}" y="${labelY}" font-family="${escapeXml(font)}" ` +
      `font-size="${size}" font-weight="${weight}" fill="${textFill}">${escapeXml(text)}</text>`;
    overflow = false;
  } else {
    const pitch = Math.round(size * 1.3);
    const blockHeight = segments.length * pitch;
    overflow = blockHeight > h;
    const startY = y1 + h / 2 - blockHeight / 2 + pitch * 0.78; // first baseline, block vertically centred
    labels = segments
      .map((seg, i) => {
        const segY = Math.round(startY + i * pitch);
        return `<text x="${labelX}" y="${segY}" font-family="${escapeXml(font)}" ` +
          `font-size="${size}" font-weight="${weight}" fill="${textFill}">${escapeXml(seg)}</text>`;
      })
      .join("\n    ");
  }
  return { svg: `${rect}\n    ${labels}`, overflow };
}

/** Intrinsic pixel dimensions of an encoded image. */
export interface ImageDims {
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read an image's intrinsic dimensions from its header, validating the magic
 * bytes against the declared `format` along the way (so a mislabeled or corrupt
 * buffer is rejected before it's written). PNG reads the IHDR; JPEG scans for the
 * first SOF marker. Throws on an invalid/unsupported buffer.
 */
export function imageDims(buf: Uint8Array, format: "png" | "jpeg"): ImageDims {
  if (format === "png") {
    if (buf.length < 24 || !PNG_SIG.every((b, i) => buf[i] === b)) {
      throw new Error("image data is not a valid PNG (bad signature).");
    }
    const rd = (o: number) =>
      ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
    return { width: rd(16), height: rd(20) }; // IHDR width/height, big-endian
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error("image data is not a valid JPEG (bad SOI marker).");
  }
  let o = 2;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = buf[o + 1];
    const len = (buf[o + 2] << 8) | buf[o + 3];
    // SOF0–SOF15 carry dimensions, except the non-frame markers C4/C8/CC.
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { width: (buf[o + 7] << 8) | buf[o + 8], height: (buf[o + 5] << 8) | buf[o + 6] };
    }
    o += 2 + len;
  }
  throw new Error("could not read JPEG dimensions.");
}

/** An axis-aligned rectangle, for overlap tests. */
interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True when two rectangles overlap by more than a shared edge (touching is OK). */
function bboxesOverlap(a: Bbox, b: Bbox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Region-local placement of an image from its corner/margin (or explicit x/y). */
function placeImage(region: Region, img: ImageInput): { x: number; y: number } {
  if (img.x !== undefined || img.y !== undefined) {
    return { x: Math.round(img.x ?? 0), y: Math.round(img.y ?? 0) };
  }
  const margin = img.margin ?? 8;
  const W = region.width;
  const H = region.height;
  const w = img.width ?? 0;
  const h = img.height ?? 0;
  if (W === null || H === null) return { x: margin, y: margin }; // no box → top-left inset
  switch (img.corner ?? "center") {
    case "top-left":
      return { x: margin, y: margin };
    case "top-right":
      return { x: Math.round(W - w - margin), y: margin };
    case "bottom-left":
      return { x: margin, y: Math.round(H - h - margin) };
    case "bottom-right":
      return { x: Math.round(W - w - margin), y: Math.round(H - h - margin) };
    case "center":
    default:
      return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2) };
  }
}

/** Pixels below a ruled line to drop the text baseline, from the row pitch. */
function rowOffset(region: Region): number {
  const r = region.ruledLines;
  const pitch = r.length >= 2 ? r[1] - r[0] : 40;
  return Math.round(pitch * 0.4);
}

/**
 * How much vertical space a flow-placed (non-heading) line needs, so the cursor
 * that fixes the *next* line's baseline reserves enough room — including when
 * this line wraps into multiple continuation segments. Mirrors the render loop's
 * own wrap predicate/width math (composeAiSvg, the `effWrap`/`segments` block) so
 * the two never disagree about whether/how much a line wraps. Returns the plain
 * `lineH` for a non-wrapping line, so the common case is unchanged.
 */
function flowLineAdvance(
  region: Region,
  line: LineInput,
  sz: number,
  lineH: number,
  def: RegionDefault,
  theme: Theme,
): number {
  const effWrap = line.wrap ?? (region.width !== null && line.time === undefined);
  if (!effWrap || region.width === null) return lineH;
  const font = line.font ?? themeFontFor(theme, region.name, false) ?? def.font;
  let x = line.x ?? def.xPad ?? DEFAULT_X_PAD;
  if (line.marker) x += markerAdvance(line.marker, sz);
  else if (line.icon) x += iconAdvance(line.icon, sz);
  const maxWidth = region.width - x;
  if (maxWidth <= 0) return lineH;
  const segments = wrapText(line.text, font, sz, maxWidth);
  const subPitch = Math.round(sz * 1.3);
  return Math.max(lineH, segments.length * subPitch);
}

/**
 * Vertical baselines for an *unruled* (box) region, laid out as a top-down flow:
 * a running cursor that gives each line its height, plus extra breathing room
 * above a `heading`. This is what lets the AI stack dynamic sections (heading +
 * items, a habit list) inside a neutral box without the template pre-printing
 * them. Honours explicit `y` (kept verbatim) and legacy box `row` (an absolute
 * slot). A single plain line is vertically centred (nice for the quote).
 */
function flowBaselines(
  region: Region,
  lines: LineInput[],
  def: RegionDefault,
  theme: Theme,
): number[] {
  const first = lines.length ? (lines[0].size ?? def.size) : def.size;
  if (
    lines.length === 1 &&
    !lines[0].heading &&
    lines[0].row === undefined &&
    lines[0].y === undefined &&
    region.height
  ) {
    return [Math.round(region.height / 2 + first / 3)];
  }
  const out: number[] = [];
  let cursor = Math.round(first * 1.2); // top padding
  lines.forEach((line, i) => {
    const sz = line.size ?? def.size;
    const lineH = Math.round(sz * 1.5);
    if (line.y !== undefined) {
      out[i] = line.y; // explicit baseline — don't disturb the cursor
      return;
    }
    if (line.row !== undefined) {
      const b = Math.round(sz * 1.2) + Math.max(0, Math.floor(line.row)) * lineH;
      out[i] = b;
      cursor = b + lineH;
      return;
    }
    if (line.heading && i > 0) cursor += Math.round(sz * 0.6); // gap before a new section
    out[i] = cursor;
    // Headings reserve room for their rule; other lines reserve enough for
    // however many segments they wrap into, so the next line's baseline never
    // lands inside this line's own wrapped continuations.
    cursor += line.heading ? lineH + 10 : flowLineAdvance(region, line, sz, lineH, def, theme);
  });
  return out;
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
function composeCalendar(
  region: Region,
  spec: CalendarSpec,
  theme: Theme,
  onDroppedDays?: (days: number[]) => void,
): string[] {
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
  const fill = spec.fill ?? theme.accent;
  const byDay = new Map((spec.days ?? []).map((d) => [d.day, d]));

  const parts: string[] = [];
  const droppedDays: number[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const index = firstDow + day - 1;
    const col = index % 7;
    const row = Math.floor(index / 7);
    if (col >= nCols || row >= nRows) {
      // Outside the printed grid (e.g. a 5-row grid on a 6-week month) — skip, but
      // tell the caller which days went missing rather than losing them silently.
      droppedDays.push(day);
      continue;
    }

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
  if (droppedDays.length > 0) onDroppedDays?.(droppedDays);
  return parts;
}

/** Result of composing an ai.svg: the document plus any non-fatal fit warnings. */
export type WarningSeverity = "info" | "warning";

export interface WarningDetail {
  code: string;
  severity: WarningSeverity;
  message: string;
  region?: string;
}

export interface ComposeResult {
  svg: string;
  /** Heuristic placement warnings (overflow, too many lines) — never fatal. */
  warnings: string[];
  /** Structured companion to `warnings` for unattended callers. */
  warningDetails: WarningDetail[];
}

/**
 * Templates that print their own to-do checkboxes (the locked visual rule in
 * `docs/SHARED-VISUAL-SPEC.md` §2): on these, an authored `marker: "checkbox"`
 * draws a second box beside the printed one. Matched on the template id — a
 * heuristic until printed-box detection reads the geometry itself.
 */
const PRINTS_OWN_CHECKBOXES_RE = /^todo-|^daily(-weekend)?-(cozy|colorful)$/;

/**
 * Compose a complete ai.svg document from structured region input, positioning
 * each line using the parsed region geometry. Throws if a region name is unknown.
 * Returns the SVG plus non-fatal `warnings` (estimated overflow, more lines than
 * ruled rows) so an unattended caller can catch a bad layout before shipping it.
 * `templateName` (the page's `manifest.template`) is advisory — it powers
 * template-specific warnings like the printed-checkbox rule.
 */
export function composeAiSvg(
  size: [number, number],
  inputs: RegionInput[],
  regions: Region[],
  themeInput?: ThemeInput | string,
  templateName?: string,
): ComposeResult {
  const { theme, warnings: themeWarnings } = resolveTheme(themeInput);
  const byName = new Map(regions.map((r) => [r.name, r]));
  const [w, h] = size;
  const parts: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`,
  ];
  const warnings: string[] = [...themeWarnings];
  const warningDetails: WarningDetail[] = themeWarnings.map((message) => ({
    code: "theme_palette_fallback",
    severity: "info",
    message,
  }));
  const warn = (
    code: string,
    message: string,
    severity: WarningSeverity = "warning",
    region?: string,
  ) => {
    warnings.push(message);
    warningDetails.push({ code, severity, message, ...(region ? { region } : {}) });
  };
  // Banner heading colours cycle across the whole page so sections read distinctly.
  let bannerIdx = 0;

  for (const input of inputs) {
    const region = byName.get(input.region);
    if (!region) {
      const valid = [...byName.keys()].join(", ");
      throw new Error(
        `Unknown region "${input.region}". This page exposes: ${valid || "(none)"}.`,
      );
    }
    const bodyKinds = [
      input.lines !== undefined ? "lines" : null,
      input.calendar !== undefined ? "calendar" : null,
      input.svg !== undefined ? "svg" : null,
    ].filter(Boolean);
    if (bodyKinds.length > 1) {
      throw new Error(
        `Region "${input.region}": provide only one of \`lines\`, \`calendar\`, or ` +
          `\`svg\` (got ${bodyKinds.join(" + ")}).`,
      );
    }
    parts.push(
      `  <g transform="translate(${region.x},${region.y})" data-region="${region.name}">`,
    );
    // Region title banner, in the margin just above the box (never consumes a row).
    // When the template prints a dashed label slot (region.labelSlot), aim the banner
    // at it instead of the default margin position — banner style fills the slot's box
    // exactly; underline style just anchors its text off the slot's origin (it draws no
    // box of its own, so there's nothing to stretch).
    if (input.label) {
      const lsize = 15;
      const slot = region.labelSlot;
      const lw = bannerLabelWidth(input.label, lsize);
      const labelFont = themeFontFor(theme, region.name, true) ?? "Mulish";
      // A printed slot sits inside the region's authored space, so it can't be
      // off-page by construction — only check the fallback margin placement.
      if (!slot && region.y - 12 - lsize < 0) {
        warn(
          "label_above_page",
          `region "${region.name}": label "${truncate(input.label)}" may sit above the page top.`,
          "warning",
          region.name,
        );
      }
      const lx = slot ? slot.x : DEFAULT_X_PAD;
      const ly = slot ? slot.y + slot.height - Math.round(slot.height * 0.28) : -12;
      if (theme.headingStyle === "banner") {
        const padX = BANNER_PAD_X;
        const bh = slot ? slot.height : Math.round(lsize * 1.15) + 6;
        const by = slot ? slot.y : ly - Math.round(lsize * 0.82) - 3;
        const bw = slot ? slot.width : lw + padX * 2;
        const color = input.labelFill ?? theme.banners[bannerIdx % theme.banners.length];
        bannerIdx++;
        parts.push(
          `    <rect x="${lx}" y="${by}" width="${bw}" height="${bh}" rx="6" fill="${color}"/>`,
        );
        parts.push(
          `    <text x="${lx + padX}" y="${ly}" font-family="${escapeXml(labelFont)}" font-size="${lsize}" ` +
            `font-weight="800" letter-spacing="0.1em" fill="${theme.bannerText}">${escapeXml(input.label)}</text>`,
        );
      } else {
        const lfill = input.labelFill ?? theme.text;
        parts.push(
          `    <text x="${lx}" y="${ly}" font-family="${escapeXml(labelFont)}" font-size="${lsize}" ` +
            `font-weight="800" letter-spacing="0.1em" fill="${lfill}">${escapeXml(input.label)}</text>`,
        );
        parts.push(
          `    <line x1="${lx}" y1="${ly + 4}" x2="${lx + lw + 18}" y2="${ly + 4}" ` +
            `stroke="${lfill}" stroke-width="1.5" opacity="0.5"/>`,
        );
      }
    }
    // Images paint first (background); text/calendar lands on top.
    for (const img of input.images ?? []) {
      if (!img.href || !img.width || !img.height) continue;
      const { x, y } = placeImage(region, img);
      const op = img.opacity !== undefined ? ` opacity="${img.opacity}"` : "";
      parts.push(
        `    <image href="${escapeXml(img.href)}" x="${x}" y="${y}" ` +
          `width="${img.width}" height="${img.height}"${op}/>`,
      );
      if (
        region.width !== null &&
        region.height !== null &&
        (x < 0 || y < 0 || x + img.width > region.width || y + img.height > region.height)
      ) {
        warn(
          "image_overflow",
          `region "${region.name}": image (${img.width}×${img.height}) may extend past ` +
            `the ${region.width}×${region.height} region box.`,
          "warning",
          region.name,
        );
      }
      // The inverse failure: a sticker shrunk so far into a big box it stops working
      // (a habits tracker the user can't pencil-check, a banner floating lost in its
      // slot). Only for center/default placement — an explicit corner or x/y reads
      // as a deliberate small accent and stays quiet.
      const centered =
        img.x === undefined && img.y === undefined && (img.corner === undefined || img.corner === "center");
      if (
        centered &&
        region.width !== null &&
        region.height !== null &&
        img.width < region.width * 0.35 &&
        img.height < region.height * 0.35
      ) {
        warn(
          "image_small_for_region",
          `region "${region.name}": image (${img.width}×${img.height}) floats small in the ` +
            `middle of the ${region.width}×${region.height} box — size it toward the box, or ` +
            `corner-place it if it's meant as a small accent. Content the user interacts with ` +
            `(a habits tracker) needs real size (~245px tall to pencil-check).`,
          "info",
          region.name,
        );
      }
      // Absolute placement (region origin + local offset) for page/cross-region checks.
      const absX = region.x + x;
      const absY = region.y + y;
      const iw = img.width;
      const ih = img.height;
      // Off the page: catches a negative-y sticker pushed up into the date/chrome band.
      const off: string[] = [];
      if (absX < 0) off.push(`left (x=${Math.round(absX)})`);
      if (absY < 0) off.push(`top (y=${Math.round(absY)})`);
      if (absX + iw > w) off.push(`right (x=${Math.round(absX + iw)} > ${w})`);
      if (absY + ih > h) off.push(`bottom (y=${Math.round(absY + ih)} > ${h})`);
      if (off.length > 0) {
        warn(
          "image_off_page",
          `region "${region.name}": image (${iw}×${ih}) extends past the page ` +
            `${w}×${h} — ${off.join(", ")}.`,
          "warning",
          region.name,
        );
      }
      // Cross-region overlap: catches a sticker dropped on top of another region's
      // content (e.g. the habit sticker over the schedule, or over the date header).
      // Names the overlapped region + its fill so an unattended caller can react.
      const imgBox: Bbox = { x: absX, y: absY, w: iw, h: ih };
      for (const other of regions) {
        if (other.name === region.name) continue;
        if (other.width === null || other.height === null) continue;
        if (bboxesOverlap(imgBox, { x: other.x, y: other.y, w: other.width, h: other.height })) {
          warn(
            "image_overlaps_region",
            `region "${region.name}": image (${iw}×${ih}) overlaps region ` +
              `"${other.name}" (${other.fill}) — a sticker should not cover another region.`,
            "warning",
            region.name,
          );
        }
      }
    }
    if (input.svg !== undefined) {
      // Raw fragment, emitted verbatim inside the region group (escape hatch).
      const frag = input.svg.trim();
      if (frag) {
        const unsupported = scanRawSvgElements(frag);
        if (unsupported.length > 0) {
          warn(
            "raw_svg_unsupported_element",
            `region "${region.name}": raw svg uses unsupported element(s) for the app ` +
              `renderer: ${unsupported.join(", ")}.`,
            "warning",
            region.name,
          );
        }
        parts.push(`    ${frag}`);
      }
    } else if (input.calendar) {
      parts.push(
        ...composeCalendar(region, input.calendar, theme, (days) => {
          warn(
            "calendar_days_outside_grid",
            `region "${region.name}": day(s) ${days.join(", ")} fall outside the printed ` +
              `${region.cols ?? "?"}×${region.rows ?? "?"} grid and were not drawn.`,
            "warning",
            region.name,
          );
        }),
      );
    } else {
      const def = REGION_DEFAULTS[region.name] ?? FALLBACK_DEFAULT;
      const lines = input.lines ?? [];
      // A handwriting region wants the AI to scaffold (a heading/prompt, corner art),
      // not fill its writing area. Headings are scaffolding; any other line is body.
      if (region.fill === "ink") {
        const body = lines.filter((l) => !l.heading).length;
        if (body > 0) {
          warn(
            "ink_region_filled",
            `region "${region.name}" is a handwriting surface (fill=ink) — expected ` +
              `scaffolding (a heading/prompt or corner art) only, not ${body} body line(s).`,
            "warning",
            region.name,
          );
        }
      }
      // The locked visual rule: where the template prints its own checkboxes, the
      // author writes text only — a `marker: "checkbox"` would draw a second box.
      if (
        templateName &&
        PRINTS_OWN_CHECKBOXES_RE.test(templateName) &&
        (region.name === "todo" || region.name.startsWith("list")) &&
        lines.some((l) => l.marker === "checkbox")
      ) {
        warn(
          "printed_checkboxes",
          `region "${region.name}": template "${templateName}" prints its own ` +
            `checkboxes — write text only (drop \`marker: "checkbox"\`) to avoid ` +
            `double boxes.`,
          "warning",
          region.name,
        );
      }
      // Body text uses the theme's ink; the ainotes box uses its serif colour
      // (quote/affirmation are legacy aliases for it).
      const baseFill =
        region.name === "ainotes" || region.name === "quote" || region.name === "affirmation"
          ? theme.serif
          : theme.text;
      // Schedule anchoring falls back to the template's own grid (`data-start-hour` /
      // `data-rows-per-hour`, parsed onto the region) when the caller omits them, so a
      // `time` write needs no caller startHour; an explicit per-call value still wins.
      const effStartHour = input.startHour ?? region.startHour ?? undefined;
      const rowsPerHour =
        input.rowsPerHour && input.rowsPerHour > 0
          ? input.rowsPerHour
          : region.rowsPerHour && region.rowsPerHour > 0
            ? region.rowsPerHour
            : 1;
      // Optional server-stamped hour gutter for a timed grid whose template prints
      // no hour numbers (an agenda-style schedule) — a no-op info warning, not a
      // dropped-content warning, since it never touches authored lines.
      if (input.showHours) {
        if (region.ruledLines.length === 0) {
          warn(
            "time_unruled_region",
            `region "${region.name}": showHours requested but the region has no ruled rows.`,
            "info",
            region.name,
          );
        } else if (effStartHour === undefined) {
          warn(
            "time_missing_start_hour",
            `region "${region.name}": showHours requested but no startHour was set ` +
              `(neither the call nor the template's data-start-hour).`,
            "info",
            region.name,
          );
        } else {
          region.ruledLines.forEach((lineY, idx) => {
            if (idx % rowsPerHour !== 0) return; // only whole-hour rows on a half-hour+ grid
            const hour = Math.floor(effStartHour + idx / rowsPerHour);
            const ly = Math.round(lineY - region.y + rowOffset(region));
            parts.push(
              `    <text x="4" y="${ly}" font-family="Mulish" font-size="11" font-weight="700" ` +
                `fill="${theme.text}" opacity="0.55">${formatHour(hour)}</text>`,
            );
          });
        }
      }
      // All regions default to top-down flow so AI content sits in the white space
      // above/between the ruled lines, leaving the lines free for the user's ink.
      // A line with an explicit `row` or `time` still snaps to the ruled grid.
      const flowBases = flowBaselines(region, lines, def, theme);
      lines.forEach((line, i) => {
        const size = line.size ?? def.size;
        const font = line.font ?? themeFontFor(theme, region.name, !!line.heading) ?? def.font;
        const weight = line.weight ?? def.weight;
        const fill = line.fill ?? baseFill;
        let x = line.x ?? def.xPad ?? DEFAULT_X_PAD;

        // A washi-tape duration block: `time` + (`endTime`/`durationMin`) draws a
        // rounded, tinted rect spanning start->end rows instead of a single baseline —
        // a fundamentally different draw (a span + centred label, not a baseline text
        // run), so it's resolved and drawn here, then returns early for this line.
        if (
          line.time !== undefined &&
          line.y === undefined &&
          line.row === undefined &&
          (line.endTime !== undefined || line.durationMin !== undefined)
        ) {
          if (region.ruledLines.length === 0 || region.width === null) {
            warn(
              "time_unruled_region",
              `region "${region.name}": block "${truncate(line.text)}" has a time but the ` +
                `region has no ruled rows or usable width — block not drawn.`,
              "warning",
              region.name,
            );
            return;
          }
          if (effStartHour === undefined) {
            warn(
              "time_missing_start_hour",
              `region "${region.name}": block "${truncate(line.text)}" has time "${line.time}" ` +
                `but no startHour was set (neither the call nor the template's ` +
                `data-start-hour) — block not drawn.`,
              "warning",
              region.name,
            );
            return;
          }
          const endTimeStr = line.endTime ?? addMinutes(line.time, line.durationMin!);
          let r1 = rowForTime(line.time, effStartHour, rowsPerHour);
          let r2 = rowForTime(endTimeStr, effStartHour, rowsPerHour);
          const maxIdx = region.ruledLines.length - 1;
          if (r1 < 0 || r1 > maxIdx || r2 < 0 || r2 > maxIdx) {
            warn(
              "washi_block_clamped",
              `region "${region.name}": block "${truncate(line.text)}" (${line.time}–${endTimeStr}) ` +
                `extends past the ${region.ruledLines.length}-row grid — clamped to fit.`,
              "warning",
              region.name,
            );
            r1 = Math.min(Math.max(0, r1), maxIdx);
            r2 = Math.min(Math.max(0, r2), maxIdx);
          }
          if (r2 <= r1) {
            // Too short to span rows on this grid (e.g. a 20-min meeting on a
            // 1-row-per-hour grid: both ends snap to the same row). The event must
            // still appear — fall through to the normal time-anchored text line.
            warn(
              "washi_block_zero_duration",
              `region "${region.name}": block "${truncate(line.text)}" (${line.time}–${endTimeStr}) ` +
                `is too short to span rows on this grid — drawn as a plain time line instead.`,
              "info",
              region.name,
            );
          } else {
            const y1 = Math.round(region.ruledLines[r1] - region.y);
            const y2 = Math.round(region.ruledLines[r2] - region.y);
            const bx = line.x ?? def.xPad ?? DEFAULT_X_PAD;
            // Right inset is the standard margin, not a second helping of the schedule's
            // wide LEFT gutter (reserved for the printed hour labels) — re-subtracting it
            // on the right left the tape ~half its column narrower than it needed to be.
            const bw = region.width - bx - DEFAULT_X_PAD;
            const block = washiBlockFragment(
              bx,
              y1,
              y2,
              bw,
              line.text,
              font,
              size,
              weight,
              fill,
              line.blockFill ?? theme.accent,
              line.blockOpacity ?? WASHI_DEFAULT_OPACITY,
            );
            parts.push(`    ${block.svg}`);
            if (block.overflow) {
              warn(
                "washi_block_label_overflow",
                `region "${region.name}": block "${truncate(line.text)}" (${line.time}–${endTimeStr}) ` +
                  `label is too long for the block even wrapped — may overrun.`,
                "warning",
                region.name,
              );
            }
            return;
          }
        }
        if (
          line.time === undefined &&
          (line.endTime !== undefined || line.durationMin !== undefined)
        ) {
          warn(
            "washi_block_missing_start",
            `region "${region.name}": line "${truncate(line.text)}" has \`endTime\`/` +
              `\`durationMin\` but no \`time\` start — ignored.`,
            "warning",
            region.name,
          );
        }

        // Resolve a clock time to a ruled row (precedence: y > row > time).
        let effLine = line;
        if (line.time !== undefined && line.y === undefined && line.row === undefined) {
          if (region.ruledLines.length === 0) {
            warn(
              "time_unruled_region",
              `region "${region.name}": line "${truncate(line.text)}" has a time but the ` +
                `region has no ruled rows — time ignored.`,
              "warning",
              region.name,
            );
          } else if (effStartHour === undefined) {
            warn(
              "time_missing_start_hour",
              `region "${region.name}": line "${truncate(line.text)}" has time "${line.time}" ` +
                `but no startHour was set (neither the call nor the template's ` +
                `data-start-hour) — placed by order instead.`,
              "warning",
              region.name,
            );
          } else {
            const r = rowForTime(line.time, effStartHour, rowsPerHour);
            if (r < 0 || r > region.ruledLines.length - 1) {
              warn(
                "time_outside_grid",
                `region "${region.name}": time "${line.time}" falls outside the ` +
                  `${region.ruledLines.length}-row grid — pinned to the nearest edge.`,
                "warning",
                region.name,
              );
            }
            effLine = { ...line, row: r };
          }
        }

        // Baseline: explicit y > ruled snap (when `row`/`time` set) > flow default.
        let y: number;
        if (effLine.y !== undefined) {
          y = effLine.y;
        } else if (effLine.row !== undefined && region.ruledLines.length > 0) {
          const idx = Math.min(Math.max(0, Math.floor(effLine.row)), region.ruledLines.length - 1);
          const localRuled = region.ruledLines[idx] - region.y;
          y = Math.round(localRuled + rowOffset(region));
        } else {
          y = Math.round(flowBases[i]);
        }

        // A section heading. `banner` themes draw a coloured pill + white label
        // (cycling banner colours so sections read distinctly); `underline` themes
        // draw a coloured label + hairline rule (quieter). No marker/wrap — a label.
        if (line.heading) {
          const hWeight = line.weight ?? 700;
          if (theme.headingStyle === "banner") {
            const labelW = bannerLabelWidth(line.text, size);
            const padX = BANNER_PAD_X;
            const bh = Math.round(size * 1.15) + 6;
            const by = y - Math.round(size * 0.82) - 3;
            const color = line.fill ?? theme.banners[bannerIdx % theme.banners.length];
            bannerIdx++;
            parts.push(
              `    <rect x="${x}" y="${by}" width="${labelW + padX * 2}" height="${bh}" ` +
                `rx="6" fill="${color}"/>`,
            );
            parts.push(
              `    <text x="${x + padX}" y="${y}" font-family="${escapeXml(font)}" ` +
                `font-size="${size}" font-weight="${hWeight}" letter-spacing="0.08em" ` +
                `fill="${theme.bannerText}">${escapeXml(line.text)}</text>`,
            );
          } else {
            const hfill = line.fill ?? theme.text;
            parts.push(
              `    <text x="${x}" y="${y}" font-family="${escapeXml(font)}" ` +
                `font-size="${size}" font-weight="${hWeight}" letter-spacing="0.08em" ` +
                `fill="${hfill}">${escapeXml(line.text)}</text>`,
            );
            if (region.width !== null) {
              const rx2 = region.width - (def.xPad ?? DEFAULT_X_PAD);
              const ry = y + Math.round(size * 0.45);
              if (rx2 > x) {
                parts.push(
                  `    <line x1="${x}" y1="${ry}" x2="${rx2}" y2="${ry}" ` +
                    `stroke="${hfill}" stroke-width="1" opacity="0.4"/>`,
                );
              }
            }
          }
          return;
        }

        if (line.marker) {
          const m = markerFragment(line.marker, x, y, size, line.fill ?? theme.accent);
          parts.push(`    ${m.svg}`);
          x += m.advance;
        } else if (line.icon) {
          const ic = iconFragment(line.icon, x, y, size, line.fill ?? theme.accent);
          parts.push(`    ${ic.svg}`);
          x += ic.advance;
        }

        // Wrap defaults ON for flow-placed body text in a width-bounded region (so a
        // long to-do/note doesn't run off the panel); an explicit `wrap` still wins,
        // and a row/time/y-anchored line keeps today's single-segment placement.
        const effWrap =
          line.wrap ??
          (region.width !== null &&
            effLine.row === undefined &&
            effLine.y === undefined &&
            line.time === undefined);
        const maxWidth = region.width !== null ? region.width - x : null;
        const segments =
          effWrap && maxWidth !== null && maxWidth > 0
            ? wrapText(line.text, font, size, maxWidth)
            : [line.text];
        const subPitch = Math.round(size * 1.3);
        segments.forEach((seg, si) => {
          const sy = y + si * subPitch;
          parts.push(
            `    <text x="${x}" y="${sy}" font-family="${escapeXml(font)}" ` +
              `font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(seg)}</text>`,
          );
        });

        if (region.width !== null) {
          if (!effWrap) {
            // Warn if the (unwrapped) text likely runs past the right edge.
            const end = x + estimateTextWidth(line.text, font, size);
            if (end > region.width) {
              warn(
                "text_overflow",
                `region "${region.name}": line "${truncate(line.text)}" ` +
                  `(~${end}px) may overflow the ${region.width}px region width.`,
                "warning",
                region.name,
              );
            }
          } else if (segments.length > 1) {
            // Wrapping handled the width; warn instead if the stacked block
            // collides with the next ruled row or runs past the region box.
            const dropped = (segments.length - 1) * subPitch;
            const pitch =
              region.ruledLines.length >= 2 ? region.ruledLines[1] - region.ruledLines[0] : null;
            const collidesRow = pitch !== null && dropped > pitch;
            const pastBox =
              region.height !== null && y + dropped + Math.round(size * 0.3) > region.height;
            // A box region (no ruled pitch to check against) can still have its
            // wrapped block run into the *next* flow-placed line — flowLineAdvance
            // (E) already reserves the right gap, but check the actual next
            // baseline too as a backstop (e.g. an explicit-y next line placed too
            // close to a wrapping flow line above it).
            const usedFlowBaseline = effLine.row === undefined && effLine.y === undefined;
            const nextFlowY =
              region.ruledLines.length === 0 && usedFlowBaseline && i + 1 < lines.length
                ? flowBases[i + 1]
                : null;
            const collidesNextFlowLine =
              nextFlowY !== null && y + dropped + Math.round(size * 0.3) > nextFlowY;
            if (collidesRow || collidesNextFlowLine || pastBox) {
              warn(
                "wrapped_text_vertical_overflow",
                `region "${region.name}": wrapped line "${truncate(line.text)}" ` +
                  `(${segments.length} rows) may overlap the next row or run past the region.`,
                "warning",
                region.name,
              );
            }
          }
        }
      });
    }
    // Backstop: a region the caller named but gave nothing to draw. Catches the whole
    // "content silently dropped" class (a stray/typo'd key, `lines: []`, an empty svg)
    // — and in merge mode an empty group REPLACES (clears) the prior region, so flag it.
    const drewNothing =
      !input.label &&
      (input.images?.length ?? 0) === 0 &&
      input.calendar === undefined &&
      (input.svg === undefined || input.svg.trim() === "") &&
      (input.lines?.length ?? 0) === 0;
    if (drewNothing) {
      warn(
        "empty_region",
        `region "${region.name}": no svg/lines/calendar/images/label — nothing was ` +
          `drawn (in merge mode this clears the region).`,
        "warning",
        region.name,
      );
    }
    parts.push(`  </g>`);
  }

  parts.push(`</svg>`);
  return { svg: parts.join("\n") + "\n", warnings, warningDetails };
}

/** Shorten a string for use inside a warning message. */
function truncate(s: string, max = 32): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** mergeRegions output: the merged document + whether unmergeable content was lost. */
export interface MergeResult {
  svg: string;
  /**
   * True when the existing ai.svg had content but no `data-region` groups to carry
   * over (e.g. a prior raw-`svg` write) — the merge silently starts from just the
   * fresh regions, so the caller should surface a warning.
   */
  discardedExisting: boolean;
}

/**
 * Merge freshly composed region groups into an existing ai.svg: groups whose
 * `data-region` matches are replaced, every other group is preserved **verbatim**,
 * and genuinely new regions are appended. This is write_underlay's `merge` mode —
 * an update to one region (e.g. the schedule) leaves the rest of the page intact.
 *
 * Only top-level `<g data-region="…">` groups are merge units; content outside them
 * (a raw hand-authored document with no region groups) can't be carried over —
 * that case is reported via `discardedExisting`.
 */
export function mergeRegions(
  existingSvg: string | null,
  composed: string,
  size: [number, number],
): MergeResult {
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

  // Existing content with no region groups (a prior raw write) can't be merged —
  // detect it so the caller can warn instead of dropping it silently.
  const inner = (existingSvg ?? "")
    .replace(/<svg\b[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim();
  const discardedExisting = inner.length > 0 && existing.byName.size === 0;

  return { svg: parts.join("\n") + "\n", discardedExisting };
}

// Opening tag of a region group. The group's extent is found by walking <g> nesting
// depth from here — a region's raw `svg` fragment may legitimately nest <g> elements,
// so "first </g>" is NOT a safe close (it corrupts the document; see extractRegionGroups).
const REGION_OPEN_RE = /<g\b[^>]*\bdata-region="([^"]+)"[^>]*>/g;

/**
 * Split a composed/existing ai.svg into its top-level `<g data-region="…">` groups.
 * Depth-aware (a region's raw `svg` fragment may legitimately nest `<g>` elements —
 * "first `</g>`" is not a safe close). Exported for `page.ts:readPage`'s `labelFilled`
 * detection (H), which scans a region's own group for a rendered label banner,
 * in addition to its original use in `mergeRegions`.
 */
export function extractRegionGroups(svg: string): {
  order: string[];
  byName: Map<string, string>;
} {
  const byName = new Map<string, string>();
  const order: string[] = [];
  REGION_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_OPEN_RE.exec(svg)) !== null) {
    const name = m[1];
    let end: number;
    if (m[0].endsWith("/>")) {
      end = REGION_OPEN_RE.lastIndex; // self-closing region group (empty)
    } else {
      // Depth-aware scan for the matching </g>: nested <g> opens (from raw fragments)
      // increment, self-closing <g/> don't, </g> decrements.
      const tagRe = /<g\b[^>]*?(\/?)>|<\/g\s*>/g;
      tagRe.lastIndex = REGION_OPEN_RE.lastIndex;
      let depth = 1;
      end = -1;
      let t: RegExpExecArray | null;
      while ((t = tagRe.exec(svg)) !== null) {
        if (t[0].startsWith("</")) depth--;
        else if (t[1] !== "/") depth++;
        if (depth === 0) {
          end = tagRe.lastIndex;
          break;
        }
      }
      if (end === -1) continue; // unbalanced group — skip it rather than corrupt the merge
    }
    if (!byName.has(name)) order.push(name);
    byName.set(name, svg.slice(m.index, end)); // last write wins for a duplicated name
    REGION_OPEN_RE.lastIndex = end; // don't re-match a nested data-region inside this group
  }
  return { order, byName };
}

/** An empty (but well-formed) layer document on the given page size. */
export function emptySvg(size: [number, number]): string {
  const [w, h] = size;
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"></svg>\n`;
}
