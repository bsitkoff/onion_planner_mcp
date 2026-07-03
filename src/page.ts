import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolvePageRel, normalizeChapter } from "./paths.js";
import { parseRegions, parseViewBox, inspectTemplate, type Region, type TemplateInfo } from "./template.js";
import { readUnderlayVoice, type UnderlayVoice } from "./library.js";
import {
  composeAiSvg,
  mergeRegions,
  emptySvg,
  imageDims,
  scanRawSvgElements,
  type RegionInput,
  type ThemeInput,
  type WarningDetail,
} from "./svg.js";

/**
 * The underlay-relevant slice of a chapter's `.folder.json → theme` (the app's
 * `FORMAT.md §4` contract). `chromeAccent` is the app's concern (chrome only); the
 * other three are the underlay-theme axis this server honours. All optional — an
 * absent block (or key) just means "fall back to the default" (gold / region fonts).
 */
export interface ChapterTheme {
  chromeAccent?: string;
  harmony?: "match" | "complement" | "warm" | "cool" | "seasonal";
  varietyDial?: number;
  fontPersonality?: "clean" | "handwritten" | "editorial";
  /**
   * An explicit underlay accent (hex) the whole chapter inherits — tints body text /
   * markers / banners so a chapter can carry a colour the named presets don't (e.g.
   * lavender). Additive to the app's `FORMAT.md §4` theme keys; the server reads it
   * defensively (absent ⇒ the gold/preset default). Written by `set_chapter_theme`.
   */
  accent?: string;
}

/**
 * Read a page's chapter theme from the parent folder's `.folder.json → theme`.
 * Returns null when there's no folder file, no theme block, or it's unreadable —
 * the contract says an absent/garbled theme degrades gracefully to the default.
 */
async function readChapterTheme(pageAbs: string): Promise<ChapterTheme | null> {
  const raw = await readIfExists(path.join(path.dirname(pageAbs), ".folder.json"));
  if (!raw) return null;
  try {
    const t = JSON.parse(raw)?.theme;
    return t && typeof t === "object" ? (t as ChapterTheme) : null;
  } catch {
    return null;
  }
}

/**
 * Merge a theme block into a chapter's `.folder.json → theme` (the chapter's default
 * mood, applied by `write_underlay` and surfaced by `read_page`). Only the provided
 * keys are patched — an existing `order` and any other folder fields are preserved.
 * The chapter folder must already exist (theming never creates a chapter). This is the
 * one place besides `create_page` that the server writes `.folder.json`.
 */
export async function writeChapterTheme(
  root: string,
  chapter: string,
  theme: ChapterTheme,
): Promise<{ chapter: string; theme: ChapterTheme }> {
  const chapterRel = `Shared/${normalizeChapter(chapter)}`;
  const chapterAbs = resolvePageRel(root, chapterRel);
  const stat = await fs.stat(chapterAbs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Chapter "${chapterRel}" does not exist.`);
  }
  const folderFile = path.join(chapterAbs, ".folder.json");
  const existing = await readIfExists(folderFile);
  const folder = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
  const prev =
    folder.theme && typeof folder.theme === "object" ? (folder.theme as ChapterTheme) : {};
  const merged: ChapterTheme = { ...prev };
  for (const [k, v] of Object.entries(theme)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  folder.theme = merged;
  await atomicWrite(folderFile, JSON.stringify(folder, null, 2) + "\n");
  return { chapter: chapterRel, theme: merged };
}

/**
 * Build the effective theme for a write. The chapter's `.folder.json → theme` is the
 * **default**; per-call params **override** it field-by-field; the page's own template
 * colours are sampled as `templatePalette` for harmony. A per-call preset `theme` name
 * given *without* any adaptive param is an explicit override that wins outright (a
 * chapter `fontPersonality` still rides along — fonts are an orthogonal axis).
 */
async function resolveThemeInput(
  pageAbs: string,
  templateSvg: string | null,
  opts: {
    theme?: string;
    harmony?: ChapterTheme["harmony"];
    varietyDial?: number;
    fontPersonality?: ChapterTheme["fontPersonality"];
  },
): Promise<ThemeInput> {
  const chapter = await readChapterTheme(pageAbs);
  const templatePalette = templateSvg ? inspectTemplate(templateSvg).palette : undefined;
  const callAdaptive =
    opts.harmony !== undefined ||
    opts.varietyDial !== undefined ||
    opts.fontPersonality !== undefined;
  if (opts.theme && !callAdaptive) {
    return {
      name: opts.theme,
      fontPersonality: chapter?.fontPersonality,
      accent: chapter?.accent,
      templatePalette,
    };
  }
  return {
    name: opts.theme,
    harmony: opts.harmony ?? chapter?.harmony,
    varietyDial: opts.varietyDial ?? chapter?.varietyDial,
    fontPersonality: opts.fontPersonality ?? chapter?.fontPersonality,
    accent: chapter?.accent,
    chromeAccent: chapter?.chromeAccent,
    templatePalette,
  };
}

export type AiStatus = "empty" | "refreshing" | "ready";

export interface Manifest {
  title?: string;
  template?: string;
  created?: string;
  modified?: string;
  size?: [number, number];
  layers?: {
    ai?: { file: string; z?: number; status?: AiStatus; updated?: string };
    [k: string]: any;
  };
  [k: string]: any;
}

function nowIso(): string {
  return new Date().toISOString();
}

let tmpCounter = 0;

/**
 * Remove stale temp siblings from a crashed earlier write. Anything matching
 * `<file>.tmp-*` and older than a minute is a dropping (a healthy write renames its
 * temp within milliseconds) — left behind, it would sync to the iPad via iCloud.
 */
async function sweepStaleTmp(absFile: string): Promise<void> {
  const dir = path.dirname(absFile);
  const prefix = `${path.basename(absFile)}.tmp-`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60_000;
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue;
    const p = path.join(dir, e);
    try {
      if ((await fs.stat(p)).mtimeMs < cutoff) await fs.rm(p, { force: true });
    } catch {
      // best-effort hygiene only
    }
  }
}

/** Write a file atomically: temp sibling + rename, so no reader sees a partial file. */
async function atomicWrite(absFile: string, content: string | Uint8Array): Promise<void> {
  await sweepStaleTmp(absFile);
  const tmp = `${absFile}.tmp-${process.pid}-${tmpCounter++}`;
  await fs.writeFile(tmp, content); // string defaults to utf8; Uint8Array writes bytes
  await fs.rename(tmp, absFile);
}

/** AI-owned image storage, per page — only the server writes/cleans this subtree. */
const MEDIA_AI = path.join("media", "ai");
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // hard cap per image (iCloud-sync hygiene)
const WARN_IMAGE_BYTES = 512 * 1024; // soft warning threshold

/** Expand a leading `~` to the user's home dir (file paths from a caller may use it). */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Sniff PNG/JPEG from the leading magic bytes; null if neither. */
function sniffFormat(buf: Uint8Array): "png" | "jpeg" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  return null;
}

/** Filename stem safe to join under media/ai/ (no slashes, traversal, or leading dots). */
function sanitizeName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base.length ? base : "img";
}

function imageTooLargeMessage(bytes: number): string {
  return `Image too large: ${bytes} bytes (max ${MAX_IMAGE_BYTES} bytes / 2 MB).`;
}

function validateFetchedImageBuffer(
  buf: Buffer,
  expectedFormat?: "png" | "jpeg",
): "png" | "jpeg" {
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(imageTooLargeMessage(buf.byteLength));
  }
  const format = sniffFormat(buf);
  if (!format) throw new Error("Unrecognised format — only PNG and JPEG are supported.");
  if (expectedFormat && format !== expectedFormat) {
    throw new Error(`Expected ${expectedFormat} output, got ${format}.`);
  }
  imageDims(buf, format);
  return format;
}

/**
 * Remove the background of an image using rembg's Python API directly (bypasses
 * the CLI so optional server deps like aiohttp/watchdog don't need to be installed).
 */
function spawnRembg(inputPath: string, outputPath: string): Promise<void> {
  // Call the Python API inline — no CLI entry-point, no server deps required.
  const script = [
    "from rembg import remove",
    "from PIL import Image",
    "import io, sys",
    "inp = open(sys.argv[1], 'rb').read()",
    "out = remove(inp)",
    "open(sys.argv[2], 'wb').write(out)",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", script, inputPath, outputPath]);
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`rembg failed (exit ${code}): ${stderr.trim()}`));
      else resolve();
    });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(new Error("python3 not found — rembg requires Python 3."));
      } else {
        reject(e);
      }
    });
  });
}

/**
 * Fetch an image from an HTTPS URL and save it to a temp file.
 * Returns the local path (suitable for `images[].path` in write_underlay), the
 * detected format, and the byte count. The Mac MCP process has full network access;
 * this is the bridge between a CDN URL and the filesystem-only Onionskin renderer.
 */
export async function fetchImageToTemp(
  url: string,
  name?: string,
  removeBackground?: boolean,
  deps: {
    fetchImpl?: typeof fetch;
    removeBackgroundImpl?: (inputPath: string, outputPath: string) => Promise<void>;
  } = {},
): Promise<{ path: string; format: "png" | "jpeg"; bytes: number }> {
  const parsed = new URL(url); // throws on malformed URL
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs are supported.");

  const res = await (deps.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching image.`);

  const buf = Buffer.from(await res.arrayBuffer());
  const format = validateFetchedImageBuffer(buf);

  const stem = sanitizeName(name ?? (parsed.pathname.split("/").pop() ?? "img"));
  const ext = format === "jpeg" ? "jpg" : "png";
  const dir = path.join(os.tmpdir(), "onionskin-fetch");
  await fs.mkdir(dir, { recursive: true });
  // Don't clobber an earlier fetch that landed on the same stem (its path may still
  // be queued for a write_underlay call) — suffix instead.
  let dest = path.join(dir, `${stem}.${ext}`);
  for (let i = 2; await fs.access(dest).then(() => true, () => false); i++) {
    dest = path.join(dir, `${stem}-${i}.${ext}`);
  }
  await fs.writeFile(dest, buf);

  if (removeBackground) {
    const nobgPath = dest.replace(/\.(png|jpg)$/, "-nobg.png");
    await (deps.removeBackgroundImpl ?? spawnRembg)(dest, nobgPath);
    await fs.rm(dest, { force: true });
    const nobgBuf = await fs.readFile(nobgPath);
    validateFetchedImageBuffer(nobgBuf, "png");
    return { path: nobgPath, format: "png", bytes: nobgBuf.byteLength };
  }

  return { path: dest, format, bytes: buf.byteLength };
}

/**
 * Decode, validate, size, and (unless dryRun) write each region's images into the
 * page's `media/ai/` folder, mutating each `ImageInput` in place with its resolved
 * `href`/`width`/`height` so `composeAiSvg` can reference it. Returns soft warnings.
 */
async function resolveImages(
  pageAbs: string,
  regions: RegionInput[],
  dryRun: boolean,
): Promise<{ warnings: string[]; warningDetails: WarningDetail[] }> {
  const warnings: string[] = [];
  const warningDetails: WarningDetail[] = [];
  const mediaAiAbs = path.join(pageAbs, MEDIA_AI);
  // Filenames already claimed in THIS write (file → content sha) — two different
  // images sharing a `name` must not silently overwrite each other.
  const usedFiles = new Map<string, string>();
  for (const region of regions) {
    for (const img of region.images ?? []) {
      if ((img.data === undefined) === (img.path === undefined)) {
        throw new Error(`image in region "${region.region}" needs exactly one of \`data\` (base64) or \`path\`.`);
      }
      if (img.width === undefined || img.width <= 0) {
        throw new Error(`image in region "${region.region}" needs a positive \`width\`.`);
      }
      // Source the bytes: a local file (no base64 through context) or inline base64.
      let buf: Buffer;
      if (img.path !== undefined) {
        const fileSrc = expandHome(img.path);
        try {
          buf = await fs.readFile(fileSrc);
        } catch {
          throw new Error(`image in region "${region.region}": cannot read file "${img.path}".`);
        }
      } else {
        buf = Buffer.from(img.data!, "base64");
      }
      if (buf.length === 0) {
        throw new Error(`image in region "${region.region}" has empty or invalid image data.`);
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `image in region "${region.region}" is ${buf.length} bytes — over the ` +
            `${MAX_IMAGE_BYTES}-byte cap. Downscale it (≤1536px JPEG) before sending.`,
        );
      }
      if (buf.length > WARN_IMAGE_BYTES) {
        const message =
          `region "${region.region}": image is ${Math.round(buf.length / 1024)}KB — large for ` +
            `iCloud sync; consider downscaling.`;
        warnings.push(message);
        warningDetails.push({
          code: "image_large_for_sync",
          severity: "info",
          region: region.region,
          message,
        });
      }
      // Format: declared, or sniffed from the file's magic bytes when reading a path.
      const format = img.format ?? sniffFormat(buf);
      if (!format) {
        throw new Error(
          `image in region "${region.region}": could not determine format — pass \`format\` ` +
            `("png" or "jpeg"), the bytes are neither.`,
        );
      }
      const dims = imageDims(buf, format); // also validates the magic bytes
      const width = img.width;
      const height = img.height ?? Math.round((width * dims.height) / dims.width);
      const ext = format === "jpeg" ? "jpg" : "png";
      const digest = createHash("sha256").update(buf).digest("hex");
      const stem = sanitizeName(img.name ?? digest.slice(0, 16));
      // De-collide within this write: identical bytes may share a file; different
      // bytes under the same name get a numeric suffix.
      let file = `${stem}.${ext}`;
      for (let i = 2; usedFiles.has(file) && usedFiles.get(file) !== digest; i++) {
        file = `${stem}-${i}.${ext}`;
      }
      usedFiles.set(file, digest);

      img.href = `${MEDIA_AI.split(path.sep).join("/")}/${file}`; // forward-slash href
      img.width = width;
      img.height = height;

      if (!dryRun) {
        const fileAbs = path.join(mediaAiAbs, file);
        if (fileAbs !== path.join(mediaAiAbs, path.basename(fileAbs))) {
          throw new Error("resolved image path escapes media/ai.");
        }
        await fs.mkdir(mediaAiAbs, { recursive: true });
        await atomicWrite(fileAbs, buf);
      }
    }
  }
  return { warnings, warningDetails };
}

/** Delete any file in `media/ai/` not referenced by an href in the final ai.svg. */
async function gcOrphanMedia(pageAbs: string, svg: string): Promise<void> {
  const mediaAiAbs = path.join(pageAbs, MEDIA_AI);
  let entries: string[];
  try {
    entries = await fs.readdir(mediaAiAbs);
  } catch {
    return; // no media/ai folder → nothing to GC
  }
  const refs = new Set([...svg.matchAll(/href="media\/ai\/([^"]+)"/g)].map((m) => m[1]));
  for (const f of entries) {
    if (!refs.has(f)) {
      await fs.rm(path.join(mediaAiAbs, f), { force: true }).catch(() => {});
    }
  }
}

async function readJson<T>(absFile: string): Promise<T> {
  return JSON.parse(await fs.readFile(absFile, "utf8")) as T;
}

export async function readIfExists(absFile: string): Promise<string | null> {
  try {
    return await fs.readFile(absFile, "utf8");
  } catch {
    return null;
  }
}

function pageSize(manifest: Manifest, templateSvg: string | null): [number, number] {
  if (Array.isArray(manifest.size) && manifest.size.length === 2) {
    return [manifest.size[0], manifest.size[1]];
  }
  const fromVb = templateSvg ? parseViewBox(templateSvg) : null;
  return fromVb ?? [1024, 1366];
}

export interface PageRead {
  page: string;
  manifest: Manifest;
  size: [number, number];
  regions: Region[];
  aiStatus: AiStatus;
  aiSvg: string | null;
  /**
   * What the template already provides (labels/banners/stickers + its palette), so
   * the AI can match its level: fill quietly + in the template's colours when
   * `styled`, or go full (theme, banners, art) when it's a bare minimal scaffold.
   */
  template: TemplateInfo;
  /**
   * The chapter's theme (`.folder.json → theme`), or null if none. Surfaced so an
   * orchestrator can see the day's harmony/variety/font-personality + chrome accent
   * before composing — write_underlay applies it as the default, overridable per call.
   */
  theme: ChapterTheme | null;
  /**
   * The library's `settings.json → underlayVoice` (name/tone/notes), or null if
   * absent/garbled — personalizes the `ainotes` note's voice. Read-only; the server
   * never writes settings.json.
   */
  underlayVoice: UnderlayVoice | null;
  templateSvg?: string;
}

/** Read a page's manifest, region geometry, and current ai.svg. */
export async function readPage(
  root: string,
  rel: string,
  includeTemplate = false,
): Promise<PageRead> {
  const abs = resolvePageRel(root, rel);
  const manifest = await readJson<Manifest>(path.join(abs, "manifest.json"));
  const templateSvg = await readIfExists(path.join(abs, "template.svg"));
  const stickersSvg = await readIfExists(path.join(abs, "stickers.svg"));
  const aiSvg = await readIfExists(path.join(abs, "ai.svg"));
  const regions = templateSvg ? parseRegions(templateSvg, manifest.template) : [];
  const size = pageSize(manifest, templateSvg);
  const theme = await readChapterTheme(abs);
  const underlayVoice = await readUnderlayVoice(root);
  return {
    page: rel,
    manifest,
    size,
    regions,
    aiStatus: manifest.layers?.ai?.status ?? "empty",
    aiSvg,
    template: templateSvg
      ? inspectTemplate(templateSvg, stickersSvg)
      : { styled: false, hasLabels: false, hasBanners: false, stickersPresent: false, palette: [] },
    theme,
    underlayVoice,
    ...(includeTemplate && templateSvg ? { templateSvg } : {}),
  };
}

/**
 * Read a page's ink layer (the user's handwriting) without touching anything.
 *
 * Each stroke carries a `data-stroke` centerline stream (the eraser/edit source of
 * truth) that dominates the file's bytes — hundreds of KB on a heavily written page —
 * and says nothing an underlay author needs beyond the outline geometry. It's
 * stripped by default; pass `includeStrokeData` for the verbatim file.
 */
export async function readInk(
  root: string,
  rel: string,
  includeStrokeData = false,
): Promise<{ page: string; inkSvg: string | null }> {
  const abs = resolvePageRel(root, rel);
  await readJson<Manifest>(path.join(abs, "manifest.json")); // confirms it's a real page
  let inkSvg = await readIfExists(path.join(abs, "ink.svg"));
  if (inkSvg && !includeStrokeData) {
    inkSvg = inkSvg.replace(/\s+data-stroke="[^"]*"/g, "");
  }
  return { page: rel, inkSvg };
}

/**
 * Update the ai-layer status block + top-level modified, atomically.
 *
 * Read-modify-write on a file another author (the app, via iCloud) may also touch:
 * the write itself is atomic, but a manifest change landing between our read and
 * rename is overwritten with our copy (a lost update). The read happens immediately
 * before the write to keep that window at milliseconds; it's inherent to a file
 * surface with no locking, and the app's own writes bump `modified` again anyway.
 */
async function patchManifestStatus(
  abs: string,
  status: AiStatus,
): Promise<void> {
  const file = path.join(abs, "manifest.json");
  const manifest = await readJson<Manifest>(file);
  manifest.layers ??= {};
  manifest.layers.ai = {
    file: "ai.svg",
    z: 1,
    ...manifest.layers.ai,
    status,
    updated: nowIso(),
  };
  manifest.modified = nowIso();
  await atomicWrite(file, JSON.stringify(manifest, null, 2) + "\n");
}

export interface WriteResult {
  page: string;
  status: AiStatus;
  bytes: number;
  /**
   * The composed ai.svg — returned **only on a dry run** (the one case a caller wants
   * to see the result before committing). On a real write it's omitted: echoing the
   * full SVG the caller just authored back through the model is pure ingest cost and
   * the model never needs it (it has `bytes` + `warnings`).
   */
  aiSvg?: string;
  /** Non-fatal placement warnings from composing structured regions. */
  warnings: string[];
  /** Structured companion to `warnings` for unattended callers. */
  warningDetails: WarningDetail[];
  /** True when this was a dry run — nothing was written to disk. */
  dryRun: boolean;
}

function rawSvgWarnings(svg: string, size: [number, number]): {
  warnings: string[];
  warningDetails: WarningDetail[];
} {
  const warnings: string[] = [];
  const warningDetails: WarningDetail[] = [];
  const warn = (code: string, message: string) => {
    warnings.push(message);
    warningDetails.push({ code, severity: "warning", message });
  };

  const unsupported = scanRawSvgElements(svg);
  if (unsupported.length > 0) {
    warn(
      "raw_svg_unsupported_element",
      `raw svg uses unsupported element(s) for the app renderer: ${unsupported.join(", ")}.`,
    );
  }

  const vb = parseViewBox(svg);
  if (vb && (vb[0] !== size[0] || vb[1] !== size[1])) {
    warn(
      "raw_svg_viewbox_mismatch",
      `raw svg viewBox is ${vb[0]}×${vb[1]}, but this page is ${size[0]}×${size[1]}.`,
    );
  }
  return { warnings, warningDetails };
}

/**
 * Write ai.svg for a shared page (atomically) and set its status. Accepts either
 * a raw SVG document or structured region input (composed against page geometry).
 *
 * `merge` (structured input only) patches the named regions into the existing
 * ai.svg, preserving every other region. `dryRun` composes and returns the result
 * (with warnings) without touching disk.
 */
export async function writeUnderlay(
  root: string,
  rel: string,
  opts: {
    svg?: string;
    regions?: RegionInput[];
    status: AiStatus;
    merge?: boolean;
    dryRun?: boolean;
    /** Named palette preset (gold/bright/cozy/editorial). Ignored with raw `svg`. */
    theme?: string;
    /** Adaptive palette strategy vs the template's colours. Overrides the chapter default. */
    harmony?: ChapterTheme["harmony"];
    /** 0 steady … 1 surprising. Overrides the chapter default. */
    varietyDial?: number;
    /** AI-text voice (clean/handwritten/editorial). Overrides the chapter default. */
    fontPersonality?: ChapterTheme["fontPersonality"];
  },
): Promise<WriteResult> {
  const abs = resolvePageRel(root, rel);
  // Confirm it's a real page before writing.
  const manifest = await readJson<Manifest>(path.join(abs, "manifest.json"));

  let svg: string;
  let warnings: string[] = [];
  let warningDetails: WarningDetail[] = [];
  if (opts.svg !== undefined) {
    if (opts.merge) {
      throw new Error("`merge` is only supported with structured `regions`, not raw `svg`.");
    }
    const templateSvg = await readIfExists(path.join(abs, "template.svg"));
    const size = pageSize(manifest, templateSvg);
    svg = opts.svg.trim() + "\n";
    const rawWarnings = rawSvgWarnings(svg, size);
    warnings = rawWarnings.warnings;
    warningDetails = rawWarnings.warningDetails;
  } else if (opts.regions) {
    // Resolve images first (writes media/ai/ files, fills each image's href) so the
    // composed ai.svg never references a file that isn't on disk yet.
    const imageResult = await resolveImages(abs, opts.regions, opts.dryRun ?? false);
    const templateSvg = await readIfExists(path.join(abs, "template.svg"));
    const regions = templateSvg ? parseRegions(templateSvg, manifest.template) : [];
    const size = pageSize(manifest, templateSvg);
    const themeInput = await resolveThemeInput(abs, templateSvg, opts);
    const composed = composeAiSvg(size, opts.regions, regions, themeInput, manifest.template);
    warnings = [...composed.warnings, ...imageResult.warnings];
    warningDetails = [...composed.warningDetails, ...imageResult.warningDetails];
    if (opts.merge) {
      const existing = await readIfExists(path.join(abs, "ai.svg"));
      const merged = mergeRegions(existing, composed.svg, size);
      svg = merged.svg;
      if (merged.discardedExisting) {
        const message =
          "merge: the existing ai.svg has no data-region groups to preserve (a prior " +
          "raw `svg` write?) — its content was replaced by the fresh regions.";
        warnings.push(message);
        warningDetails.push({ code: "merge_discarded_raw_svg", severity: "warning", message });
      }
    } else {
      svg = composed.svg;
    }
  } else {
    throw new Error("writeUnderlay requires either `svg` or `regions`.");
  }

  const bytes = Buffer.byteLength(svg);
  if (opts.dryRun) {
    return { page: rel, status: opts.status, bytes, aiSvg: svg, warnings, warningDetails, dryRun: true };
  }

  await atomicWrite(path.join(abs, "ai.svg"), svg);
  // Drop any AI image no longer referenced by the final (possibly merged) ai.svg.
  await gcOrphanMedia(abs, svg);
  await patchManifestStatus(abs, opts.status);
  // Note: no `aiSvg` on a real write — see WriteResult. The model has bytes + warnings.
  return { page: rel, status: opts.status, bytes, warnings, warningDetails, dryRun: false };
}

/** Flip the ai-layer status without rewriting the SVG. */
export async function setStatus(
  root: string,
  rel: string,
  status: AiStatus,
): Promise<void> {
  const abs = resolvePageRel(root, rel);
  await readJson<Manifest>(path.join(abs, "manifest.json")); // existence check
  await patchManifestStatus(abs, status);
}

/** Reset ai.svg to empty and status to "empty", and drop AI-owned media. */
export async function clearUnderlay(root: string, rel: string): Promise<void> {
  const abs = resolvePageRel(root, rel);
  const manifest = await readJson<Manifest>(path.join(abs, "manifest.json"));
  const templateSvg = await readIfExists(path.join(abs, "template.svg"));
  const size = pageSize(manifest, templateSvg);
  await atomicWrite(path.join(abs, "ai.svg"), emptySvg(size));
  // Remove the AI image folder — these assets belong to the now-cleared ai layer.
  await fs.rm(path.join(abs, MEDIA_AI), { recursive: true, force: true }).catch(() => {});
  await patchManifestStatus(abs, "empty");
}

export interface CreateResult {
  page: string;
  template: string;
  size: [number, number];
  clonedFrom: string;
  /** Non-fatal problems (e.g. the page was created but the chapter order wasn't updated). */
  warnings?: string[];
}

/** The layers + geometry a new page is instantiated from. */
interface PageSource {
  templateSvg: string;
  /** Starter sticker layer (catalogue templates may ship one); else null = empty. */
  stickersSvg: string | null;
  size: [number, number];
  /** Value written to the manifest's top-level `template` field. */
  templateName: string;
  /** Provenance string returned to the caller (a sibling page or a catalogue id). */
  clonedFrom: string;
}

/** A chapter's `.folder.json`, parsed leniently; null when absent/unreadable. */
async function readFolderConfig(chapterAbs: string): Promise<Record<string, any> | null> {
  const raw = await readIfExists(path.join(chapterAbs, ".folder.json"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A month chapter's single overview page: folder `YYYY-MM` / a monthly template. */
function isMonthlyOverview(folderName: string, manifest: Manifest): boolean {
  return /^\d{4}-\d{2}$/.test(folderName) || /monthly/i.test(manifest.template ?? "");
}

const WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Resolve a per-weekday template override from the chapter's declared
 * `weekdayTemplates` (FORMAT.md §4, e.g. `{ sat: "weekend", sun: "weekend" }`). `name`
 * is only parsed as `YYYY-MM-DD`; any other shape (a slug, a duplicate-suffix sibling
 * name) returns undefined rather than throwing — this is advisory, not a contract on
 * `name`'s format.
 */
function weekdayTemplateFor(
  name: string,
  weekdayTemplates: Record<string, unknown> | undefined,
): string | undefined {
  if (!weekdayTemplates) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Guard an invalid calendar date (e.g. "2026-02-30") rolling over silently.
  if (d.getMonth() !== Number(m[2]) - 1) return undefined;
  const abbr = WEEKDAY_ABBR[d.getDay()];
  const v = weekdayTemplates[abbr];
  return typeof v === "string" ? v : undefined;
}

/**
 * Find a sibling page in the chapter to clone a template from, if any.
 *
 * Deterministic (siblings sorted by name) and calendar-aware: a month chapter always
 * contains its monthly-overview page (the app self-heals one in), which must never
 * become the template for a new *day* page — overview siblings are only used when
 * nothing else qualifies (a chapter that genuinely holds just the grid).
 */
async function findSiblingTemplate(
  chapterAbs: string,
  chapterRel: string,
  opts: { name: string; template?: string },
): Promise<{ rel: string; manifest: Manifest; templateSvg: string } | null> {
  let siblings;
  try {
    siblings = await fs.readdir(chapterAbs, { withFileTypes: true });
  } catch {
    return null; // chapter folder doesn't exist yet (brand-new chapter)
  }
  let overviewFallback: { rel: string; manifest: Manifest; templateSvg: string } | null = null;
  for (const s of [...siblings].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!s.isDirectory() || s.name.startsWith(".") || s.name === opts.name) continue;
    const sAbs = path.join(chapterAbs, s.name);
    const m = await readIfExists(path.join(sAbs, "manifest.json"));
    const t = await readIfExists(path.join(sAbs, "template.svg"));
    if (!m || !t) continue;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(m) as Manifest;
    } catch {
      continue; // a corrupt sibling manifest shouldn't block page creation
    }
    if (opts.template && manifest.template !== opts.template) continue;
    const candidate = { rel: `${chapterRel}/${s.name}`, manifest, templateSvg: t };
    if (!opts.template && isMonthlyOverview(s.name, manifest)) {
      overviewFallback ??= candidate;
      continue;
    }
    return candidate;
  }
  return overviewFallback;
}

/**
 * Refuse to recreate a day the user explicitly deleted (chapter `.folder.json →
 * deletedDays`), unless the caller opts in via `clearDeleted` — silently resurrecting
 * a tombstoned day is the more surprising default for an unattended caller. When
 * `clearDeleted` is set, splices the entry out of `deletedDays` and rewrites
 * `.folder.json` (mutate-then-rewrite, same pattern as the order-append below).
 */
async function checkNotDeleted(
  chapterAbs: string,
  folderCfg: Record<string, any> | null,
  name: string,
  clearDeleted: boolean | undefined,
): Promise<void> {
  const deletedDays = Array.isArray(folderCfg?.deletedDays) ? (folderCfg!.deletedDays as unknown[]) : [];
  if (!deletedDays.includes(name)) return;
  if (!clearDeleted) {
    throw new Error(
      `"${name}" is tombstoned in this chapter's deletedDays (the user removed it) — ` +
        `pass \`clearDeleted: true\` to recreate it anyway.`,
    );
  }
  const folderFile = path.join(chapterAbs, ".folder.json");
  const existing = await readIfExists(folderFile);
  const folder = existing ? (JSON.parse(existing) as any) : {};
  folder.deletedDays = (Array.isArray(folder.deletedDays) ? folder.deletedDays : []).filter(
    (d: unknown) => d !== name,
  );
  await atomicWrite(folderFile, JSON.stringify(folder, null, 2) + "\n");
}

/** Load a template from the top-level `Templates/<id>/` catalogue, if it exists. */
async function loadCatalogueTemplate(
  root: string,
  id: string,
): Promise<{ templateSvg: string; stickersSvg: string | null; size: [number, number] } | null> {
  const dir = path.join(root, "Templates", id);
  const templateSvg = await readIfExists(path.join(dir, "template.svg"));
  if (!templateSvg) return null;
  const stickersSvg = await readIfExists(path.join(dir, "stickers.svg"));
  const size = parseViewBox(templateSvg) ?? [1024, 1366];
  return { templateSvg, stickersSvg, size };
}

/** List catalogue template ids (folders under `Templates/` with a template.svg). */
async function listCatalogueTemplates(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, "Templates"), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (await readIfExists(path.join(root, "Templates", e.name, "template.svg"))) {
      ids.push(e.name);
    }
  }
  return ids.sort();
}

/**
 * Create a new shared page, writing manifest + layers + media/ and appending the
 * new folder to the chapter's .folder.json order. Template resolution: an explicit
 * `template` arg wins; else the chapter's declared `.folder.json → weekdayTemplates`
 * (a weekend-specific choice for a page named `YYYY-MM-DD`); else the chapter's
 * declared `.folder.json → defaultTemplate`; with a template id in hand, a matching
 * **sibling page** is cloned (keeps a chapter consistent), else the id is instantiated
 * from the top-level **`Templates/` catalogue**. With no id at all, any non-overview
 * sibling is cloned. A page named in the chapter's `.folder.json → deletedDays`
 * tombstone list is refused unless `clearDeleted` is set.
 */
export async function createPage(
  root: string,
  opts: {
    chapter: string;
    name: string;
    title?: string;
    template?: string;
    clearDeleted?: boolean;
  },
): Promise<CreateResult> {
  if (/[/\\]/.test(opts.name) || opts.name.trim() === "") {
    throw new Error(
      `Page name "${opts.name}" must be a single non-empty folder name (no slashes).`,
    );
  }
  const chapterName = normalizeChapter(opts.chapter);
  const chapterRel = `Shared/${chapterName}`;
  const chapterAbs = resolvePageRel(root, chapterRel);
  const newRel = `${chapterRel}/${opts.name}`;
  const newAbs = resolvePageRel(root, newRel); // also validates name has no traversal

  // Refuse to clobber any existing destination, even a partial/non-page folder.
  try {
    await fs.access(newAbs);
    throw new Error(`Page folder "${newRel}" already exists.`);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  // The chapter's declared default template (FORMAT.md §4) fills in when the caller
  // doesn't pass one — a calendar chapter's day pages come out right by default.
  const folderCfg = await readFolderConfig(chapterAbs);
  await checkNotDeleted(chapterAbs, folderCfg, opts.name, opts.clearDeleted);
  const weekdayTemplates =
    folderCfg?.weekdayTemplates && typeof folderCfg.weekdayTemplates === "object"
      ? (folderCfg.weekdayTemplates as Record<string, unknown>)
      : undefined;
  const effTemplate =
    opts.template ??
    weekdayTemplateFor(opts.name, weekdayTemplates) ??
    (typeof folderCfg?.defaultTemplate === "string" ? folderCfg.defaultTemplate : undefined);

  // Prefer a sibling; fall back to the Templates/ catalogue.
  const sibling = await findSiblingTemplate(chapterAbs, chapterRel, {
    name: opts.name,
    template: effTemplate,
  });
  let source: PageSource;
  if (sibling) {
    source = {
      templateSvg: sibling.templateSvg,
      stickersSvg: null,
      size: pageSize(sibling.manifest, sibling.templateSvg),
      templateName: sibling.manifest.template ?? effTemplate ?? "daily",
      clonedFrom: sibling.rel,
    };
  } else {
    const cat = effTemplate ? await loadCatalogueTemplate(root, effTemplate) : null;
    if (!cat) {
      const ids = await listCatalogueTemplates(root);
      const why = effTemplate
        ? `no catalogue template "${effTemplate}" exists under Templates/`
        : "pass `template` with a catalogue id to start from the Templates/ catalogue";
      throw new Error(
        `No sibling page in "${chapterRel}" to clone from, and ${why}. ` +
          `Available templates: ${ids.join(", ") || "(none)"}.`,
      );
    }
    source = {
      templateSvg: cat.templateSvg,
      stickersSvg: cat.stickersSvg,
      size: cat.size,
      templateName: effTemplate!,
      clonedFrom: `Templates/${effTemplate}`,
    };
  }

  const { size, templateName } = source;
  const ts = nowIso();
  const stageName = `.create-${sanitizeName(opts.name)}-${process.pid}-${tmpCounter++}`;
  const stageAbs = path.join(chapterAbs, stageName);
  let staged = false;

  try {
    await fs.mkdir(chapterAbs, { recursive: true });
    await fs.mkdir(path.join(stageAbs, "media"), { recursive: true });
    staged = true;
    await atomicWrite(path.join(stageAbs, "template.svg"), source.templateSvg);
    await atomicWrite(path.join(stageAbs, "ai.svg"), emptySvg(size));
    await atomicWrite(path.join(stageAbs, "stickers.svg"), source.stickersSvg ?? emptySvg(size));
    await atomicWrite(path.join(stageAbs, "ink.svg"), emptySvg(size));

    const manifest: Manifest = {
      title: opts.title ?? opts.name,
      template: templateName,
      created: ts,
      modified: ts,
      size,
      layers: {
        template: { file: "template.svg", z: 0 },
        ai: { file: "ai.svg", z: 1, status: "empty", updated: ts },
        stickers: { file: "stickers.svg", z: 2 },
        ink: { file: "ink.svg", z: 3 },
      },
    };
    await atomicWrite(
      path.join(stageAbs, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await fs.rename(stageAbs, newAbs);
    staged = false;
  } catch (e) {
    if (staged) {
      await fs.rm(stageAbs, { recursive: true, force: true }).catch(() => {});
    }
    throw e;
  }

  // Append to the chapter's page order. The page already exists at this point, so a
  // corrupt .folder.json downgrades to a warning — not an error for a created page.
  const warnings: string[] = [];
  try {
    const folderFile = path.join(chapterAbs, ".folder.json");
    const existing = await readIfExists(folderFile);
    const folder = existing ? (JSON.parse(existing) as any) : { title: chapterName };
    folder.order = Array.isArray(folder.order) ? folder.order : [];
    if (!folder.order.includes(opts.name)) folder.order.push(opts.name);
    await atomicWrite(folderFile, JSON.stringify(folder, null, 2) + "\n");
  } catch (e: any) {
    warnings.push(
      `Page created, but the chapter's .folder.json could not be updated ` +
        `(${e.message}) — the page may not appear in the chapter's declared order.`,
    );
  }

  return {
    page: newRel,
    template: templateName,
    size,
    clonedFrom: source.clonedFrom,
    ...(warnings.length ? { warnings } : {}),
  };
}
