/**
 * Parity guard (#41, #51): this server hand-mirrors several tables the app owns — region
 * names + fills, the closed font set, the Phosphor codepoints, the renderer's element set.
 * Nothing in the runtime can notice when they drift (a wrong codepoint renders tofu on
 * device, a renamed region silently falls to fallback typography). This diffs each mirror
 * against its source of truth in the sibling `../onionskin` checkout and fails loudly.
 *
 * Run by `npm run smoke` after the e2e suite. Skips cleanly (exit 0, with a notice) when
 * the sibling checkout is absent — the same dependency the smoke copy already has.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PHOSPHOR_CODEPOINTS, RAW_SVG_ALLOWED_ELEMENTS, REGION_DEFAULTS, FONT_FAMILIES } from "../src/svg.js";
import { FILL_BY_NAME } from "../src/template.js";

const APP = process.env.ONIONSKIN_APP_REPO ?? path.resolve(process.cwd(), "..", "onionskin");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

async function main() {
  if (!(await exists(path.join(APP, "Onionskin")))) {
    console.log(`parity: sibling app checkout not found at ${APP} — skipping (set ONIONSKIN_APP_REPO).`);
    return;
  }
  console.log(`Parity against ${APP}\n`);

  // 1. Phosphor codepoints vs the app's private `legacyScalar` switch.
  console.log("PHOSPHOR_CODEPOINTS ↔ DesignSystem/Phosphor.swift legacyScalar");
  const phosphor = await fs.readFile(path.join(APP, "Onionskin", "DesignSystem", "Phosphor.swift"), "utf8");
  const scalarBlock = phosphor.slice(phosphor.indexOf("var legacyScalar"));
  const appCodepoints = new Map<string, string>();
  for (const m of scalarBlock.matchAll(/case \.(\w+):\s+return "\\u\{([0-9a-fA-F]+)\}"/g)) {
    appCodepoints.set(m[1], String.fromCodePoint(parseInt(m[2], 16)));
  }
  check("parsed the app's legacyScalar table", appCodepoints.size >= 20, `${appCodepoints.size} entries`);
  for (const [name, ch] of Object.entries(PHOSPHOR_CODEPOINTS)) {
    const app = appCodepoints.get(name);
    check(
      `icon "${name}" exists in the app with the same codepoint`,
      app !== undefined && app === ch,
      app === undefined
        ? "not in the app's enum"
        : `ours U+${ch.codePointAt(0)!.toString(16)} vs app U+${app.codePointAt(0)!.toString(16)}`,
    );
  }
  const unmirrored = [...appCodepoints.keys()].filter((n) => !(n in PHOSPHOR_CODEPOINTS));
  if (unmirrored.length) console.log(`  (info) app glyphs not mirrored here: ${unmirrored.join(", ")}`);

  // 2. Region vocabulary vs the shipped catalogue.
  console.log("\nFILL_BY_NAME / REGION_DEFAULTS ↔ Fixtures/Library/Templates/*/template.svg");
  const templatesDir = path.join(APP, "Onionskin", "Fixtures", "Library", "Templates");
  const ids = (await fs.readdir(templatesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  check("catalogue has templates", ids.length >= 20, `${ids.length}`);
  const seen = new Map<string, { fill: string | null; templates: Set<string> }>();
  for (const id of ids) {
    const svg = await fs.readFile(path.join(templatesDir, id, "template.svg"), "utf8");
    for (const tag of svg.matchAll(/<(?:g|rect)\b[^>]*\bdata-region="([^"]+)"[^>]*>/g)) {
      const name = tag[1];
      if (name.startsWith("label-") || name.startsWith("art-")) continue; // sub-boxes, not regions
      const fill = /\bdata-fill="([^"]+)"/.exec(tag[0])?.[1] ?? null;
      const e = seen.get(name) ?? { fill, templates: new Set() };
      if (e.fill !== fill && fill !== null) e.fill = fill;
      e.templates.add(id);
      seen.set(name, e);
    }
  }
  for (const [name, e] of [...seen.entries()].sort()) {
    const known = name in FILL_BY_NAME;
    const styled = name in REGION_DEFAULTS;
    check(`region "${name}" (${e.templates.size} templates) is known to FILL_BY_NAME + REGION_DEFAULTS`, known && styled, `FILL_BY_NAME:${known} REGION_DEFAULTS:${styled}`);
    if (known && e.fill) {
      check(`region "${name}" fill default (${FILL_BY_NAME[name]}) matches the catalogue's data-fill (${e.fill})`, FILL_BY_NAME[name] === e.fill);
    }
  }
  const legacyOnly = Object.keys(FILL_BY_NAME).filter((n) => !seen.has(n));
  if (legacyOnly.length) console.log(`  (info) MCP-only / legacy region names (no shipped template): ${legacyOnly.join(", ")}`);

  // 3. Raw-svg element allowlist ⊆ the app parser's element switch.
  console.log("\nRAW_SVG_ALLOWED_ELEMENTS ⊆ SVG/SVGParser.swift element cases");
  const parser = await fs.readFile(path.join(APP, "Onionskin", "SVG", "SVGParser.swift"), "utf8");
  const parserCases = new Set([...parser.matchAll(/case "([a-zA-Z]+)"/g)].map((m) => m[1]));
  for (const el of RAW_SVG_ALLOWED_ELEMENTS) {
    check(`element <${el}> is parsed by the app`, parserCases.has(el), `app parser cases: ${[...parserCases].join(", ")}`);
  }

  // 4. Closed font set ⊆ the app's bundled font files (Phosphor is the retired icon face,
  //    repainted as SF Symbols — no file by design).
  console.log("\nFONT_FAMILIES ⊆ DesignSystem/Fonts/*.ttf");
  const fontFiles = (await fs.readdir(path.join(APP, "Onionskin", "DesignSystem", "Fonts"))).map((f) => f.toLowerCase());
  for (const family of FONT_FAMILIES) {
    if (family === "Phosphor") continue;
    const stem = family.replace(/\s+/g, "").toLowerCase();
    check(`font "${family}" is bundled by the app`, fontFiles.some((f) => f.startsWith(stem)), `files: ${fontFiles.join(", ")}`);
  }

  console.log(`\nparity: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Parity check crashed:", e);
  process.exit(1);
});
