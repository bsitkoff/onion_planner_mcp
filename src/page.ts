import fs from "node:fs/promises";
import path from "node:path";
import { resolvePageRel } from "./paths.js";
import { parseRegions, parseViewBox, type Region } from "./template.js";
import { composeAiSvg, mergeRegions, emptySvg, type RegionInput } from "./svg.js";

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
/** Write a file atomically: temp sibling + rename, so no reader sees a partial file. */
async function atomicWrite(absFile: string, content: string): Promise<void> {
  const tmp = `${absFile}.tmp-${process.pid}-${tmpCounter++}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, absFile);
}

async function readJson<T>(absFile: string): Promise<T> {
  return JSON.parse(await fs.readFile(absFile, "utf8")) as T;
}

async function readIfExists(absFile: string): Promise<string | null> {
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
  const aiSvg = await readIfExists(path.join(abs, "ai.svg"));
  const regions = templateSvg ? parseRegions(templateSvg) : [];
  const size = pageSize(manifest, templateSvg);
  return {
    page: rel,
    manifest,
    size,
    regions,
    aiStatus: manifest.layers?.ai?.status ?? "empty",
    aiSvg,
    ...(includeTemplate && templateSvg ? { templateSvg } : {}),
  };
}

/** Update the ai-layer status block + top-level modified, atomically. */
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
  aiSvg: string;
  /** Non-fatal placement warnings from composing structured regions. */
  warnings: string[];
  /** True when this was a dry run — nothing was written to disk. */
  dryRun: boolean;
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
  },
): Promise<WriteResult> {
  const abs = resolvePageRel(root, rel);
  // Confirm it's a real page before writing.
  const manifest = await readJson<Manifest>(path.join(abs, "manifest.json"));

  let svg: string;
  let warnings: string[] = [];
  if (opts.svg !== undefined) {
    if (opts.merge) {
      throw new Error("`merge` is only supported with structured `regions`, not raw `svg`.");
    }
    svg = opts.svg.trim() + "\n";
  } else if (opts.regions) {
    const templateSvg = await readIfExists(path.join(abs, "template.svg"));
    const regions = templateSvg ? parseRegions(templateSvg) : [];
    const size = pageSize(manifest, templateSvg);
    const composed = composeAiSvg(size, opts.regions, regions);
    warnings = composed.warnings;
    if (opts.merge) {
      const existing = await readIfExists(path.join(abs, "ai.svg"));
      svg = mergeRegions(existing, composed.svg, size);
    } else {
      svg = composed.svg;
    }
  } else {
    throw new Error("writeUnderlay requires either `svg` or `regions`.");
  }

  const bytes = Buffer.byteLength(svg);
  if (opts.dryRun) {
    return { page: rel, status: opts.status, bytes, aiSvg: svg, warnings, dryRun: true };
  }

  await atomicWrite(path.join(abs, "ai.svg"), svg);
  await patchManifestStatus(abs, opts.status);
  return { page: rel, status: opts.status, bytes, aiSvg: svg, warnings, dryRun: false };
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

/** Reset ai.svg to empty and status to "empty". */
export async function clearUnderlay(root: string, rel: string): Promise<void> {
  const abs = resolvePageRel(root, rel);
  const manifest = await readJson<Manifest>(path.join(abs, "manifest.json"));
  const templateSvg = await readIfExists(path.join(abs, "template.svg"));
  const size = pageSize(manifest, templateSvg);
  await atomicWrite(path.join(abs, "ai.svg"), emptySvg(size));
  await patchManifestStatus(abs, "empty");
}

export interface CreateResult {
  page: string;
  template: string;
  size: [number, number];
  clonedFrom: string;
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

/** Find a sibling page in the chapter to clone a template from, if any. */
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
  for (const s of siblings) {
    if (!s.isDirectory() || s.name.startsWith(".") || s.name === opts.name) continue;
    const sAbs = path.join(chapterAbs, s.name);
    const m = await readIfExists(path.join(sAbs, "manifest.json"));
    const t = await readIfExists(path.join(sAbs, "template.svg"));
    if (!m || !t) continue;
    const manifest = JSON.parse(m) as Manifest;
    if (opts.template && manifest.template !== opts.template) continue;
    return { rel: `${chapterRel}/${s.name}`, manifest, templateSvg: t };
  }
  return null;
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
 * new folder to the chapter's .folder.json order. The template comes from a
 * **sibling page** in the same chapter when one exists (keeps a chapter
 * consistent); otherwise it is instantiated from the top-level **`Templates/`
 * catalogue** by id (`template`), so a brand-new/empty chapter can still be seeded.
 */
export async function createPage(
  root: string,
  opts: { chapter: string; name: string; title?: string; template?: string },
): Promise<CreateResult> {
  const chapterRel = `Shared/${opts.chapter}`;
  const chapterAbs = resolvePageRel(root, chapterRel);
  const newRel = `${chapterRel}/${opts.name}`;
  const newAbs = resolvePageRel(root, newRel); // also validates name has no traversal

  // Refuse to clobber an existing page.
  try {
    await fs.access(path.join(newAbs, "manifest.json"));
    throw new Error(`Page "${newRel}" already exists.`);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  // Prefer a sibling; fall back to the Templates/ catalogue.
  const sibling = await findSiblingTemplate(chapterAbs, chapterRel, opts);
  let source: PageSource;
  if (sibling) {
    source = {
      templateSvg: sibling.templateSvg,
      stickersSvg: null,
      size: pageSize(sibling.manifest, sibling.templateSvg),
      templateName: sibling.manifest.template ?? opts.template ?? "daily",
      clonedFrom: sibling.rel,
    };
  } else {
    const cat = opts.template ? await loadCatalogueTemplate(root, opts.template) : null;
    if (!cat) {
      const ids = await listCatalogueTemplates(root);
      const why = opts.template
        ? `no catalogue template "${opts.template}" exists under Templates/`
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
      templateName: opts.template!,
      clonedFrom: `Templates/${opts.template}`,
    };
  }

  const { size, templateName } = source;
  const ts = nowIso();

  await fs.mkdir(path.join(newAbs, "media"), { recursive: true });
  await atomicWrite(path.join(newAbs, "template.svg"), source.templateSvg);
  await atomicWrite(path.join(newAbs, "ai.svg"), emptySvg(size));
  await atomicWrite(path.join(newAbs, "stickers.svg"), source.stickersSvg ?? emptySvg(size));
  await atomicWrite(path.join(newAbs, "ink.svg"), emptySvg(size));

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
    path.join(newAbs, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // Append to the chapter's page order.
  const folderFile = path.join(chapterAbs, ".folder.json");
  const existing = await readIfExists(folderFile);
  const folder = existing ? (JSON.parse(existing) as any) : { title: opts.chapter };
  folder.order = Array.isArray(folder.order) ? folder.order : [];
  if (!folder.order.includes(opts.name)) folder.order.push(opts.name);
  await atomicWrite(folderFile, JSON.stringify(folder, null, 2) + "\n");

  return { page: newRel, template: templateName, size, clonedFrom: source.clonedFrom };
}
