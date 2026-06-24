import fs from "node:fs/promises";
import path from "node:path";
import { resolveRoot, sharedDir, normalizeChapter } from "./paths.js";
import { readPage, type AiStatus } from "./page.js";

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
 */
export async function findPages(root: string, relDir: string): Promise<string[]> {
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
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "media") continue;
    out.push(...(await findPages(root, path.join(relDir, e.name))));
  }
  return out;
}

/** All shared pages, optionally restricted to a single chapter name. */
export async function listPages(root: string, chapter?: string): Promise<string[]> {
  const base = chapter ? path.join("Shared", normalizeChapter(chapter)) : "Shared";
  const pages = await findPages(root, base);
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
 * Walk shared pages (optionally within a chapter), read each manifest, and return
 * the metadata rows that satisfy the filters. The manifest is read once per page —
 * the same read that produces the row also drives every filter.
 *
 * NOTE: these are *metadata* filters, all sourced from manifest.json. A future
 * content filter (e.g. `textContains` over OCR'd ink.svg handwriting) is a different
 * data source — it would slot in here as one more guard, but behind its own helper
 * (e.g. pageText(root, p)) rather than reading the manifest. Keeping that seam in mind
 * is why the filter surface is a single growable `PageFilter`, not fixed params.
 */
export async function listPageRows(root: string, filter: PageFilter = {}): Promise<PageRow[]> {
  const { chapter, template, aiStatus, titleContains } = filter;
  const after = epoch(filter.modifiedAfter);
  const before = epoch(filter.modifiedBefore);
  const needle = titleContains?.toLowerCase();

  const pages = await listPages(root, chapter);
  const rows: PageRow[] = [];
  for (const p of pages) {
    const r = await readPage(root, p);
    if (template && r.manifest.template !== template) continue;
    if (aiStatus && r.aiStatus !== aiStatus) continue;
    if (needle && !(r.manifest.title ?? "").toLowerCase().includes(needle)) continue;
    // Date filters key off manifest.modified; a page with no/invalid timestamp
    // can't satisfy a window, so it's excluded when a date bound is active.
    if (after !== null || before !== null) {
      const m = epoch(r.manifest.modified);
      if (m === null) continue;
      if (after !== null && m < after) continue;
      if (before !== null && m >= before) continue;
    }
    rows.push({
      page: p,
      title: r.manifest.title ?? null,
      template: r.manifest.template ?? null,
      size: r.size,
      modified: r.manifest.modified ?? null,
      aiStatus: r.aiStatus,
    });
  }
  return rows;
}
