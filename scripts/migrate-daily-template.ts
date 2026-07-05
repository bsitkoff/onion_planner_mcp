/**
 * One-off maintenance migration — NOT part of the MCP server or its tool surface.
 *
 * The user's live daily pages under `Shared/<chapter>/*` predate the 2026-06 region
 * redesign: they use an old `daily` template with no `data-fill` and no `ainotes`
 * region, so an AI-owned sticker (a habits tracker) has no legitimate home. This
 * script re-seeds those pages from the redesigned catalogue template
 * (`Templates/daily-minimal/`), which has a sticker-sized `ainotes` (289×422, ai).
 *
 * HARD SAFETY CONSTRAINT: the new grid sits at DIFFERENT coordinates than the old one,
 * so swapping the template under a page that already has handwriting would misalign the
 * printed lines with the user's ink. This script therefore migrates ONLY pages whose
 * `ink.svg` is empty (no `<path>` strokes). Ink-bearing pages are SKIPPED — those need
 * the app to re-flow ink to the new geometry (see docs/app-bugs-2026-06-30.md §1).
 *
 * Usage (dry-run by default; nothing is written without --apply):
 *   tsx scripts/migrate-daily-template.ts                 # dry-run, chapter 2026-06
 *   tsx scripts/migrate-daily-template.ts 2026-07         # dry-run, another chapter
 *   tsx scripts/migrate-daily-template.ts 2026-06 --apply # write (backs up each page first)
 *
 * Honours ONIONSKIN_CONTAINER (default: the live iCloud path), so point it at a COPY of
 * the library to rehearse:
 *   ONIONSKIN_CONTAINER=/tmp/onionskin-copy tsx scripts/migrate-daily-template.ts 2026-06 --apply
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveRoot } from "../src/paths.js";
import { parseViewBox } from "../src/template.js";
import { emptySvg } from "../src/svg.js";

const TEMPLATE_ID = "daily-minimal";
/** Only pages on an OLD daily template are migrated — never the monthly overview etc. */
const FROM_TEMPLATE_RE = /^daily/i;

/** Count ink strokes in an ink.svg (0 ⇒ empty/safe to migrate). */
function strokeCount(inkSvg: string | null): number {
  if (!inkSvg) return 0;
  return (inkSvg.match(/<path\b/g) ?? []).length;
}

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const chapter = argv.find((a) => !a.startsWith("--")) ?? "2026-06";

  const root = resolveRoot();
  const chapterAbs = path.join(root, "Shared", chapter);

  // Load the redesigned catalogue template up front.
  const catAbs = path.join(root, "Templates", TEMPLATE_ID, "template.svg");
  const catalogueTemplate = await readIfExists(catAbs);
  if (!catalogueTemplate) {
    throw new Error(`Catalogue template not found: ${catAbs}`);
  }
  const newSize = parseViewBox(catalogueTemplate) ?? [1024, 1366];

  let entries;
  try {
    entries = await fs.readdir(chapterAbs, { withFileTypes: true });
  } catch {
    throw new Error(`Chapter folder not found: ${chapterAbs}`);
  }

  // Back up OUTSIDE the iCloud container (a plain home-dir folder) so page copies
  // don't sync up to iCloud / get discovered as pages.
  const backupRoot = path.join(os.homedir(), "onionskin-migrate-backup", chapter);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const migrated: string[] = [];
  const skippedInk: string[] = [];
  const skippedOther: string[] = [];

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const pageAbs = path.join(chapterAbs, e.name);
    const manifestRaw = await readIfExists(path.join(pageAbs, "manifest.json"));
    if (!manifestRaw) continue; // not a page folder
    const manifest = JSON.parse(manifestRaw);

    if (manifest.template === TEMPLATE_ID) {
      skippedOther.push(`${e.name} (already ${TEMPLATE_ID})`);
      continue;
    }
    if (!FROM_TEMPLATE_RE.test(String(manifest.template ?? ""))) {
      skippedOther.push(`${e.name} (template "${manifest.template}" — not a daily)`);
      continue;
    }

    const ink = await readIfExists(path.join(pageAbs, "ink.svg"));
    const strokes = strokeCount(ink);
    if (strokes > 0) {
      skippedInk.push(`${e.name} (${strokes} strokes)`);
      continue;
    }

    if (!apply) {
      migrated.push(`${e.name} (would migrate: empty ink)`);
      continue;
    }

    // Back up the whole page folder, then rewrite template + manifest + reset ai.svg.
    const backupAbs = path.join(backupRoot, `${e.name}-${ts}`);
    await fs.mkdir(path.dirname(backupAbs), { recursive: true });
    await fs.cp(pageAbs, backupAbs, { recursive: true });

    await fs.writeFile(path.join(pageAbs, "template.svg"), catalogueTemplate);
    // Old ai.svg references dead regions (priorities/affirmation) — reset it to empty.
    await fs.writeFile(path.join(pageAbs, "ai.svg"), emptySvg(newSize as [number, number]));

    manifest.template = TEMPLATE_ID;
    manifest.size = newSize;
    manifest.modified = new Date().toISOString();
    manifest.layers ??= {};
    manifest.layers.ai = {
      file: "ai.svg",
      z: 1,
      ...manifest.layers.ai,
      status: "empty",
      updated: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(pageAbs, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    migrated.push(`${e.name} (migrated; backup at ${path.relative(root, backupAbs)})`);
  }

  const mode = apply ? "APPLIED" : "DRY-RUN (no changes written)";
  console.log(`\nMigrate Shared/${chapter}/* → ${TEMPLATE_ID}  —  ${mode}\n`);
  console.log(`Migrate (${migrated.length}):`);
  migrated.forEach((m) => console.log(`  ✓ ${m}`));
  console.log(`\nSkipped — ink present, needs app-side migration (${skippedInk.length}):`);
  skippedInk.forEach((m) => console.log(`  ✋ ${m}`));
  if (skippedOther.length) {
    console.log(`\nSkipped — other (${skippedOther.length}):`);
    skippedOther.forEach((m) => console.log(`  · ${m}`));
  }
  if (!apply) console.log(`\nRe-run with --apply to write (each migrated page is backed up first).`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
