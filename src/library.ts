import fs from "node:fs/promises";
import path from "node:path";
import { resolveRoot, sharedDir, normalizeChapter, resolvePageRel } from "./paths.js";
import { type AiStatus, type Manifest, readIfExists } from "./page.js";

/**
 * The library's `settings.json → underlayVoice` (the app's `FORMAT.md §4` contract) —
 * personalizes the AI daily note. All keys optional; `tone: "none"` means no written
 * note at all. Read-only here — the server never writes settings.json.
 */
export interface UnderlayVoice {
  name?: string;
  tone?: "calm" | "warm" | "upbeat" | "dry" | "none";
  notes?: string;
}

const VALID_UNDERLAY_TONES = new Set(["calm", "warm", "upbeat", "dry", "none"]);

/**
 * Read `settings.json → underlayVoice` from the library root. Returns null when the
 * file is absent, unparseable, or has no usable `underlayVoice` block — an external
 * MCP reading this global, single-writer file must degrade gracefully rather than
 * fail a tool call over a garbled or missing settings.json.
 */
export async function readUnderlayVoice(root: string): Promise<UnderlayVoice | null> {
  const raw = await readIfExists(path.join(root, "settings.json"));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw)?.underlayVoice;
    if (!v || typeof v !== "object") return null;
    const out: UnderlayVoice = {};
    if (typeof v.name === "string") out.name = v.name;
    if (typeof v.tone === "string" && VALID_UNDERLAY_TONES.has(v.tone)) {
      out.tone = v.tone as UnderlayVoice["tone"];
    }
    if (typeof v.notes === "string") out.notes = v.notes;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Thrown when the iCloud library / Shared folder isn't present yet. */
export class LibraryMissingError extends Error {
  constructor(public root: string, detail: string) {
    super(detail);
    this.name = "LibraryMissingError";
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the root and confirm the library + Shared folder exist.
 * Throws LibraryMissingError with a setup guide if not — every tool surfaces this.
 */
export async function requireLibrary(): Promise<string> {
  const root = resolveRoot();
  const shared = sharedDir(root);
  if (!(await isDir(root))) {
    throw new LibraryMissingError(
      root,
      `Onionskin library not found at:\n  ${root}\n\n` +
        `Fix one of:\n` +
        `  • Run the Onionskin app once (with iCloud signed in) so it creates the container, or\n` +
        `  • Set ONIONSKIN_CONTAINER to your library's Documents/ directory ` +
        `(e.g. a different container id, or a test fixture copy).`,
    );
  }
  if (!(await isDir(shared))) {
    throw new LibraryMissingError(
      root,
      `Library exists at ${root} but has no "Shared/" folder yet.\n` +
        `Create a shared chapter/page in the Onionskin app first — only Shared pages are writable.`,
    );
  }
  return root;
}

export interface Chapter {
  name: string;
  path: string; // relative, e.g. "Shared/Daily"
  pageCount: number;
}

/** List chapters (immediate folders under Shared/) with page counts. */
export async function listChapters(root: string): Promise<Chapter[]> {
  const shared = sharedDir(root);
  const entries = await fs.readdir(shared, { withFileTypes: true });
  const chapters: Chapter[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const pages = await findPages(root, path.join("Shared", e.name));
    chapters.push({
      name: e.name,
      path: `Shared/${e.name}`,
      pageCount: pages.length,
    });
  }
  chapters.sort((a, b) => a.name.localeCompare(b.name));
  return chapters;
}

/**
 * Recursively find page folders (any dir containing manifest.json) beneath a
 * relative directory under the library root. Returns relative paths.
 *
 * A page whose manifest is iCloud-evicted on this Mac shows up as a
 * `.manifest.json.icloud` placeholder instead — it's a real page, just not
 * downloaded. Pass `pendingDownload` to collect those instead of silently
 * omitting them from every listing.
 */
export async function findPages(
  root: string,
  relDir: string,
  pendingDownload?: string[],
): Promise<string[]> {
  const absDir = path.join(root, relDir);
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  // A folder with a manifest.json is itself a page.
  if (await isFile(path.join(absDir, "manifest.json"))) {
    out.push(relDir.split(path.sep).join("/"));
  } else if (pendingDownload && (await isFile(path.join(absDir, ".manifest.json.icloud")))) {
    pendingDownload.push(relDir.split(path.sep).join("/"));
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "media") continue;
    out.push(...(await findPages(root, path.join(relDir, e.name), pendingDownload)));
  }
  return out;
}

/** All shared pages, optionally restricted to a single chapter name. */
export async function listPages(
  root: string,
  chapter?: string,
  pendingDownload?: string[],
): Promise<string[]> {
  const base = chapter ? path.join("Shared", normalizeChapter(chapter)) : "Shared";
  const pages = await findPages(root, base, pendingDownload);
  pages.sort();
  return pages;
}

/** One row of `list_pages` output: page path + the filterable manifest metadata. */
export interface PageRow {
  page: string;
  title: string | null;
  template: string | null;
  size: [number, number];
  modified: string | null;
  aiStatus: AiStatus;
}

/** Metadata filters for `listPageRows`. All optional; omitted fields don't constrain. */
export interface PageFilter {
  chapter?: string;
  template?: string;
  aiStatus?: AiStatus;
  titleContains?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
}

/** Parse an ISO date/datetime to epoch ms, or null if unparseable/absent. */
function epoch(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Everything a `list_pages` row needs, sourced from **manifest.json alone**. Listing
 * must not load template.svg / ai.svg / stickers.svg or parse SVG geometry (that's
 * read_page's job) — over iCloud those extra reads can each force a cold-file download,
 * so a single-file read per page is what keeps listing fast.
 */
async function readPageMeta(root: string, rel: string): Promise<PageRow> {
  const abs = resolvePageRel(root, rel);
  const raw = await fs.readFile(path.join(abs, "manifest.json"), "utf8");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch (e: any) {
    // Rethrown with the page named so the caller's skip-note is actionable.
    throw new Error(`manifest.json is not valid JSON (${e.message}).`);
  }
  const size: [number, number] =
    Array.isArray(manifest.size) && manifest.size.length === 2
      ? [manifest.size[0], manifest.size[1]]
      : [1024, 1366]; // last resort; live manifests carry size — don't load template.svg for it
  return {
    page: rel,
    title: manifest.title ?? null,
    template: manifest.template ?? null,
    size,
    modified: manifest.modified ?? null,
    aiStatus: manifest.layers?.ai?.status ?? "empty",
  };
}

/**
 * Walk shared pages (optionally within a chapter), read each manifest, and return
 * the metadata rows that satisfy the filters. Each page costs **one manifest.json read**
 * (via `readPageMeta`) and the reads run in parallel — listing never touches the SVG
 * layers or parses geometry.
 *
 * NOTE: these are *metadata* filters, all sourced from manifest.json. A future
 * content filter (e.g. `textContains` over OCR'd ink.svg handwriting) is a different
 * data source — it would slot in here as one more guard, but behind its own helper
 * (e.g. pageText(root, p)) rather than reading the manifest. Keeping that seam in mind
 * is why the filter surface is a single growable `PageFilter`, not fixed params.
 */
export async function listPageRows(
  root: string,
  filter: PageFilter = {},
): Promise<{ rows: PageRow[]; notes: string[] }> {
  const { chapter, template, aiStatus, titleContains } = filter;
  const after = epoch(filter.modifiedAfter);
  const before = epoch(filter.modifiedBefore);
  const needle = titleContains?.toLowerCase();

  const notes: string[] = [];
  const pendingDownload: string[] = [];
  const pages = await listPages(root, chapter, pendingDownload);
  for (const p of pendingDownload) {
    notes.push(
      `${p}: manifest is in iCloud but not downloaded on this Mac — the page is ` +
        `omitted until iCloud materialises it (open the folder in Finder to force it).`,
    );
  }
  // One bad page (a truncated / hand-edited / conflicted manifest) must not take
  // down the whole listing — skip it with a note naming the file instead.
  const metas = (
    await Promise.all(
      pages.map(async (p) => {
        try {
          return await readPageMeta(root, p);
        } catch (e: any) {
          notes.push(`Skipped ${p}: ${e.message}`);
          return null;
        }
      }),
    )
  ).filter((r): r is PageRow => r !== null);

  const rows: PageRow[] = [];
  for (const r of metas) {
    if (template && r.template !== template) continue;
    if (aiStatus && r.aiStatus !== aiStatus) continue;
    if (needle && !(r.title ?? "").toLowerCase().includes(needle)) continue;
    // Date filters key off manifest.modified; a page with no/invalid timestamp
    // can't satisfy a window, so it's excluded when a date bound is active.
    if (after !== null || before !== null) {
      const m = epoch(r.modified ?? undefined);
      if (m === null) continue;
      if (after !== null && m < after) continue;
      if (before !== null && m >= before) continue;
    }
    rows.push(r);
  }
  return { rows, notes };
}
