import fs from "node:fs/promises";
import path from "node:path";
import { resolvePageRel } from "./paths.js";
import { parseRegions, parseViewBox, type Region } from "./template.js";
import { composeAiSvg, emptySvg, type RegionInput } from "./svg.js";

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
}

/**
 * Write ai.svg for a shared page (atomically) and set its status. Accepts either
 * a raw SVG document or structured region input (composed against page geometry).
 */
export async function writeUnderlay(
  root: string,
  rel: string,
  opts: { svg?: string; regions?: RegionInput[]; status: AiStatus },
): Promise<WriteResult> {
  const abs = resolvePageRel(root, rel);
  // Confirm it's a real page before writing.
  const manifest = await readJson<Manifest>(path.join(abs, "manifest.json"));

  let svg: string;
  if (opts.svg !== undefined) {
    svg = opts.svg.trim() + "\n";
  } else if (opts.regions) {
    const templateSvg = await readIfExists(path.join(abs, "template.svg"));
    const regions = templateSvg ? parseRegions(templateSvg) : [];
    const size = pageSize(manifest, templateSvg);
    svg = composeAiSvg(size, opts.regions, regions);
  } else {
    throw new Error("writeUnderlay requires either `svg` or `regions`.");
  }

  await atomicWrite(path.join(abs, "ai.svg"), svg);
  await patchManifestStatus(abs, opts.status);
  return { page: rel, status: opts.status, bytes: Buffer.byteLength(svg), aiSvg: svg };
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

/**
 * Create a new shared page by cloning template.svg from a sibling page in the
 * same chapter, writing manifest + empty layers + media/, and appending the new
 * folder to the chapter's .folder.json order.
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

  // Find a sibling page to clone the template from.
  const siblings = await fs.readdir(chapterAbs, { withFileTypes: true });
  let cloneFrom: { rel: string; manifest: Manifest; templateSvg: string } | null = null;
  for (const s of siblings) {
    if (!s.isDirectory() || s.name.startsWith(".") || s.name === opts.name) continue;
    const sAbs = path.join(chapterAbs, s.name);
    const m = await readIfExists(path.join(sAbs, "manifest.json"));
    const t = await readIfExists(path.join(sAbs, "template.svg"));
    if (!m || !t) continue;
    const manifest = JSON.parse(m) as Manifest;
    if (opts.template && manifest.template !== opts.template) continue;
    cloneFrom = { rel: `${chapterRel}/${s.name}`, manifest, templateSvg: t };
    break;
  }
  if (!cloneFrom) {
    throw new Error(
      `No sibling page in "${chapterRel}"${opts.template ? ` with template "${opts.template}"` : ""} ` +
        `to clone a template from. Create one in the app first.`,
    );
  }

  const size = pageSize(cloneFrom.manifest, cloneFrom.templateSvg);
  const templateName = cloneFrom.manifest.template ?? "daily";
  const ts = nowIso();

  await fs.mkdir(path.join(newAbs, "media"), { recursive: true });
  await atomicWrite(path.join(newAbs, "template.svg"), cloneFrom.templateSvg);
  await atomicWrite(path.join(newAbs, "ai.svg"), emptySvg(size));
  await atomicWrite(path.join(newAbs, "stickers.svg"), emptySvg(size));
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

  return { page: newRel, template: templateName, size, clonedFrom: cloneFrom.rel };
}
