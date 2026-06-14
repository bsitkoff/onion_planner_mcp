import fs from "node:fs/promises";
import path from "node:path";
import { resolveRoot, sharedDir } from "./paths.js";

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
  const base = chapter ? path.join("Shared", chapter) : "Shared";
  const pages = await findPages(root, base);
  pages.sort();
  return pages;
}
