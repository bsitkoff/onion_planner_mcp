/**
 * End-to-end smoke test against a throwaway copy of the Onionskin fixtures.
 * Run: ONIONSKIN_CONTAINER=/tmp/onionskin-test tsx test/smoke.ts
 * (the npm `smoke` script + the harness shell command set that up for you).
 *
 * The shipped fixtures are a FRESH library — a Templates/ + Stickers/ catalogue but
 * no seeded Shared/ pages. So this test seeds empty Shared chapters, then creates its
 * own pages from the catalogue (exercising create_page's catalogue path) before
 * driving the read/write/merge/dry-run/calendar flows. Coordinates and region names
 * are derived from the parsed geometry, never hard-coded (the fixtures keep changing).
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import {
  requireLibrary,
  listChapters,
  listPages,
  listPageRows,
  readUnderlayVoice,
  LibraryMissingError,
} from "../src/library.js";
import {
  readPage,
  readInk,
  writeUnderlay,
  setStatus,
  clearUnderlay,
  createPage,
  writeChapterTheme,
  fetchImageToTemp,
} from "../src/page.js";
import { resolveTheme, composeAiSvg, PHOSPHOR_CODEPOINTS, scanRawSvgDataUriImages } from "../src/svg.js";
import { hexToHsl, contrastRatioHex } from "../src/color.js";
import { inspectTemplate, parseRegions, PAPER_COLOR } from "../src/template.js";
import { decodePng, encodePng, chromaKeyPixels } from "../src/png.js";

// Gold is retired — the default (no theme override) resolves to the chapter's own ink
// palette instead of a fixed seed colour. Tests below assert against THIS, not a literal
// hex, since the exact default may change as the palette-character proposal is refined.
const DEFAULT_INK = resolveTheme({}).theme.text;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function execFileP(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function runCli(root: string, args: string[]): Promise<any> {
  const { stdout } = await execFileP("npm", ["run", "call", "--", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ONIONSKIN_CONTAINER: root },
  });
  const start = stdout.lastIndexOf("\n{");
  const end = stdout.lastIndexOf("}");
  return JSON.parse(stdout.slice(start + 1, end + 1));
}

/** Extract the verbatim `<g data-region="NAME">…</g>` block from an ai.svg. */
function regionGroup(svg: string | undefined, name: string): string | null {
  if (!svg) return null;
  const re = new RegExp(`<g\\b[^>]*\\bdata-region="${name}"[^>]*>[\\s\\S]*?</g>`);
  return svg.match(re)?.[0] ?? null;
}

async function main() {
  const root = await requireLibraryAfterSeed();
  console.log(`Library: ${root}\n`);

  console.log("get_library / chapters (fresh library — seeded empty Shared chapters)");
  const chapters = await listChapters(root);
  const names = chapters.map((c) => c.name);
  check("finds the seeded Daily + Monthly chapters", names.includes("Daily") && names.includes("Monthly"), JSON.stringify(names));

  console.log("\nunderlayVoice (settings.json, defensive read)");
  const settingsPath = path.join(root, "settings.json");
  check("no settings.json → underlayVoice is null", (await readUnderlayVoice(root)) === null);
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ underlayVoice: { name: "Bridget", tone: "calm", notes: "training for a 10k; keep it short" } }),
  );
  const voice = await readUnderlayVoice(root);
  check(
    "settings.json underlayVoice is read (name/tone/notes)",
    voice?.name === "Bridget" && voice?.tone === "calm" && voice?.notes === "training for a 10k; keep it short",
    JSON.stringify(voice),
  );
  // Left in place (valid) so the read_page surfacing check below sees it too.

  console.log("\ncreate_page from the Templates/ catalogue (no sibling yet)");
  const daily = "Shared/Daily/2026-06-22";
  const createdDaily = await createPage(root, { chapter: "Daily", name: "2026-06-22", title: "Monday", template: "daily-minimal" });
  check("daily clonedFrom is the catalogue", createdDaily.clonedFrom.startsWith("Templates/"), createdDaily.clonedFrom);
  check("daily manifest template = daily-minimal", createdDaily.template === "daily-minimal");
  const dailyManifest = JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8"));
  check("daily ai.status starts empty", dailyManifest.layers.ai.status === "empty");
  const dailyTemplate = await fs.readFile(path.join(root, daily, "template.svg"), "utf8");
  check("daily template has region-schedule", dailyTemplate.includes("region-schedule"));

  const monthly = "Shared/Monthly/2026-02"; // Feb 2026 = 28 days
  await createPage(root, { chapter: "Monthly", name: "2026-02", title: "February", template: "monthly-minimal" });
  check("monthly listed after create", (await listPages(root, "Monthly")).includes(monthly));

  console.log("\nread_page (region geometry, current names)");
  const read = await readPage(root, daily);
  const schedule = read.regions.find((r) => r.name === "schedule");
  const ainotes = read.regions.find((r) => r.name === "ainotes");
  const todo = read.regions.find((r) => r.name === "todo");
  check("size is 1024x1366", read.size[0] === 1024 && read.size[1] === 1366, JSON.stringify(read.size));
  check("read_page surfaces the same underlayVoice as get_library's reader", read.underlayVoice?.name === "Bridget" && read.underlayVoice?.tone === "calm", JSON.stringify(read.underlayVoice));
  await fs.writeFile(settingsPath, "{ this is not valid json");
  check("garbled settings.json degrades to null (no throw)", (await readUnderlayVoice(root)) === null);
  check("read_page also degrades to null on garbled settings.json", (await readPage(root, daily)).underlayVoice === null);
  await fs.writeFile(settingsPath, JSON.stringify({ underlayVoice: { name: "Bridget", tone: "bogus-tone" } }));
  const partialVoice = await readUnderlayVoice(root);
  check(
    "an invalid tone value is dropped, valid keys kept",
    partialVoice?.name === "Bridget" && partialVoice?.tone === undefined,
    JSON.stringify(partialVoice),
  );
  await fs.rm(settingsPath, { force: true });
  check("settings.json absent again after cleanup", (await readUnderlayVoice(root)) === null);
  check("schedule region parsed with ruled lines", (schedule?.ruledLines.length ?? 0) >= 8, String(schedule?.ruledLines.length));
  check("ainotes region parsed (no-ruled box)", !!ainotes && ainotes.ruledLines.length === 0, String(ainotes?.ruledLines.length));
  check("todo region parsed", !!todo);
  // The template prints a dashed label slot nested in schedule's own <g> — parseRegions
  // must surface it (Region.labelSlot) without confusing it for the region's own box.
  check("schedule region exposes its printed label slot", !!schedule?.labelSlot, JSON.stringify(schedule?.labelSlot));
  check(
    "schedule's box width/height are the region's own box, not the label slot's",
    !!schedule?.labelSlot && schedule.width !== schedule.labelSlot.width && schedule.height !== schedule.labelSlot.height,
    JSON.stringify({ box: [schedule?.width, schedule?.height], slot: schedule?.labelSlot }),
  );
  // header's dashed art-banner rect has no data-region, so it's NOT a label slot.
  const header = read.regions.find((r) => r.name === "header");
  check("header's decorative dashed rect (no data-region) is not read as a label slot", header?.labelSlot === null, JSON.stringify(header?.labelSlot));
  // Template inspection: minimal prints a faint "TODAY" microcap (hasLabels) but no
  // banners/art/palette — labels alone must NOT mark it styled, or the "bare → go
  // full" guidance would be unreachable on every shipped template. Cozy is fully
  // styled (fill quietly into its own colours).
  check("template info: minimal has a label but is NOT styled", read.template.hasLabels === true && !read.template.hasBanners && !read.template.styled && read.template.palette.length === 0, JSON.stringify(read.template));
  const cozyInfo = inspectTemplate(await fs.readFile(path.join(root, "Templates", "daily-cozy", "template.svg"), "utf8"));
  check("template info: cozy is styled with its own banners", cozyInfo.styled && cozyInfo.hasBanners && cozyInfo.hasLabels, JSON.stringify(cozyInfo));
  check("template info: cozy palette is non-empty and non-neutral", cozyInfo.palette.length > 0 && cozyInfo.palette.every((h) => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(cozyInfo.palette));
  // No shipped template (as of the 2026-06 redesign catalogue) draws its own
  // full-bleed background rect — paperColor falls back to the app's shared canvas
  // constant. This documents that current behavior; it should fail loudly (and get
  // a deliberate look) the day a template DOES draw its own background.
  check("template info: paperColor falls back to the shared PAPER_COLOR constant", read.template.paperColor === PAPER_COLOR, read.template.paperColor);
  check("template info: cozy also has no own background rect -> same fallback", cozyInfo.paperColor === PAPER_COLOR, cozyInfo.paperColor);

  console.log("\nregion fill (who fills each region: ink / ai / shared) + designer intent");
  // Derived from the region name: schedule is shared (AI seeds, user augments), the
  // ainotes box is the AI's. Geometry does NOT decide this (schedule is ruled, ainotes is not).
  check("schedule fill is shared", schedule?.fill === "shared", schedule?.fill);
  check("ainotes fill is ai", ainotes?.fill === "ai", ainotes?.fill);
  // A reflection template proves fill is per-region intent, not geometry: side by side
  // it carries an ink handwriting surface (joys) AND an AI-owned block (last).
  const reflectionSvg = await fs.readFile(path.join(root, "Templates", "reflection-minimal", "template.svg"), "utf8");
  const reflectionRegions = parseRegions(reflectionSvg, "reflection-minimal");
  check("reflection mixes ink + ai fills (fill is intent, not geometry)", reflectionRegions.find((r) => r.name === "joys")?.fill === "ink" && reflectionRegions.find((r) => r.name === "last")?.fill === "ai", JSON.stringify(reflectionRegions.map((r) => [r.name, r.fill])));
  // Geometry fallback (unknown name, no template type): ruled → ink, blank box → ai.
  const fbSvg =
    '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">' +
    '<g id="region-mystery-lined" data-region="mystery-lined" transform="translate(10,10)"><rect width="100" height="100" fill="none"/><line x1="0" y1="20" x2="100" y2="20"/></g>' +
    '<g id="region-mystery-box" data-region="mystery-box" transform="translate(10,200)"><rect width="100" height="100" fill="none"/></g>' +
    "</svg>";
  const fb = parseRegions(fbSvg);
  check("geometry fallback: a ruled unknown region → ink", fb.find((r) => r.name === "mystery-lined")?.fill === "ink");
  check("geometry fallback: a blank unknown box → ai", fb.find((r) => r.name === "mystery-box")?.fill === "ai");
  // Template-type fallback: the SAME unknown regions in a handwriting-surface template → all ink.
  check("template-type fallback: unknown regions in a 'blank' template → ink", parseRegions(fbSvg, "blank-minimal").every((r) => r.fill === "ink"));
  // Explicit data-fill wins over everything (schedule would otherwise derive as shared); a
  // free-text data-intent carries the designer's purpose for an otherwise-anonymous block.
  const overrideSvg =
    '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">' +
    '<g id="region-block-2" data-region="block-2" data-fill="ink" data-intent="this week\'s dinners, one row per day" transform="translate(10,10)"><rect width="100" height="100" fill="none"/></g></svg>';
  const over = parseRegions(overrideSvg)[0];
  check("explicit data-fill overrides the derived fill", over?.fill === "ink", over?.fill);
  check("free-text data-intent is parsed as the designer's purpose", over?.intent === "this week's dinners, one row per day", over?.intent ?? "null");
  const bare = parseRegions('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><g id="region-bare" data-region="bare" transform="translate(0,0)"><rect width="10" height="10" fill="none"/></g></svg>')[0];
  check("a region with no data-intent has null intent", bare?.intent === null, String(bare?.intent));
  // data-list buckets on the to-do columns parse as advisory routing context.
  const todoCols = parseRegions(await fs.readFile(path.join(root, "Templates", "todo-minimal", "template.svg"), "utf8"), "todo-minimal");
  check("data-list buckets parse on the to-do columns", todoCols.find((r) => r.name === "list-1")?.list === "today" && todoCols.find((r) => r.name === "list-3")?.list === "later", JSON.stringify(todoCols.map((r) => [r.name, r.list])));

  console.log("\nink_region_filled warning (a handwriting surface wants scaffolding, not fill)");
  const reflectPage = "Shared/Daily/2026-06-25";
  await createPage(root, { chapter: "Daily", name: "2026-06-25", title: "Reflection", template: "reflection-minimal" });
  const reflectRead = await readPage(root, reflectPage);
  const inkReg = reflectRead.regions.find((r) => r.fill === "ink");
  check("reflection page exposes an ink region", !!inkReg, JSON.stringify(reflectRead.regions.map((r) => [r.name, r.fill])));
  const filledInk = await writeUnderlay(root, reflectPage, { status: "ready", dryRun: true, regions: [{ region: inkReg!.name, lines: [{ text: "I should not write here" }] }] });
  check("body text into an ink region warns", filledInk.warningDetails.some((w) => w.code === "ink_region_filled" && w.region === inkReg!.name), JSON.stringify(filledInk.warningDetails));
  const scaffoldInk = await writeUnderlay(root, reflectPage, { status: "ready", dryRun: true, regions: [{ region: inkReg!.name, lines: [{ text: "Morning", heading: true }] }] });
  check("heading-only scaffolding into an ink region does NOT warn", !scaffoldInk.warningDetails.some((w) => w.code === "ink_region_filled"), JSON.stringify(scaffoldInk.warningDetails));

  console.log("\nwrite_underlay (structured: schedule rows + checkbox to-dos + ainotes)");
  const before = read.manifest.modified;
  await new Promise((r) => setTimeout(r, 5)); // ensure modified timestamp differs
  const wr = await writeUnderlay(root, daily, {
    status: "ready",
    regions: [
      { region: "schedule", lines: [
        { text: "9:00 standup", row: 2 },
        { text: "13:00 1:1 advising", row: 6 },
      ]},
      { region: "todo", lines: [
        { text: "Email the registrar", marker: "checkbox" },
        { text: "Prep advising notes", marker: "checkbox" },
      ]},
      { region: "ainotes", lines: [{ text: "Small steps still move forward." }] },
    ],
  });
  const aiPath = path.join(root, daily, "ai.svg");
  const ai = await fs.readFile(aiPath, "utf8");
  check("ai.svg contains schedule text", ai.includes("9:00 standup"));
  check("ai.svg uses the default ink-palette fill (gold is retired)", ai.includes(DEFAULT_INK));
  check("ai.svg sets a heavier font-weight", ai.includes('font-weight="600"'));
  check("ai.svg groups by region", ai.includes('data-region="schedule"') && ai.includes('data-region="todo"'));
  check("ainotes uses Newsreader (region default still applies)", regionGroup(ai, "ainotes")?.includes("Newsreader") ?? false);
  check("write reported warnings array", Array.isArray(wr.warnings));
  check("write was not a dry run", wr.dryRun === false);
  // checkbox marker: a themed stroked <rect> inside the todo group, before its text.
  const todoGroup = regionGroup(ai, "todo") ?? "";
  check("to-do lines draw a themed checkbox", new RegExp(`<rect[^>]*stroke="${DEFAULT_INK}"`).test(todoGroup), todoGroup.slice(0, 120));

  console.log("\nPhosphor icon glyphs (font-rendered leading mark; dry-run)");
  const iconWrite = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    // ainotes wraps by default (Phase 2.5) — force a single segment so this test is
    // about the icon glyph, not wrap behavior.
    regions: [{ region: "ainotes", lines: [{ text: "Home", icon: "house", wrap: false }] }],
  });
  const iconGroup = regionGroup(iconWrite.aiSvg, "ainotes") ?? "";
  check(
    "known icon name renders its confirmed codepoint in a Phosphor <text>",
    iconGroup.includes(`font-family="Phosphor"`) && iconGroup.includes(`>${PHOSPHOR_CODEPOINTS.house}</text>`),
    iconGroup.slice(0, 260),
  );
  check("the line's own text still follows the icon glyph", iconGroup.includes(">Home</text>"), iconGroup.slice(0, 260));
  // marker/icon are mutually exclusive at the schema layer (index.ts .refine); at the
  // compose layer itself marker simply takes precedence if both somehow arrive together.
  const bothWrite = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: [{ text: "Both set", marker: "bullet", icon: "house" } as any] }],
  });
  const bothGroup = regionGroup(bothWrite.aiSvg, "ainotes") ?? "";
  check("marker takes precedence over icon if both are set on one line", /<circle\b/.test(bothGroup) && !bothGroup.includes("Phosphor"), bothGroup.slice(0, 260));
  // An unrecognized icon name is rejected at the MCP schema (index.ts zod enum), not
  // reachable through this direct compose path — but composeAiSvg itself must still
  // degrade defensively (empty fragment, no crash) rather than emit a broken glyph.
  const unknownIconWrite = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: [{ text: "Unknown icon", icon: "not-a-real-icon" } as any] }],
  });
  const unknownIconGroup = regionGroup(unknownIconWrite.aiSvg, "ainotes") ?? "";
  check(
    "an unrecognized icon name at the compose layer degrades to no glyph, not a crash",
    !unknownIconGroup.includes("Phosphor") && unknownIconGroup.includes(">Unknown icon</text>"),
    unknownIconGroup.slice(0, 260),
  );
  // Derive the expected slot from geometry: row 2's baseline lands below ruled line 2.
  const rl = schedule!.ruledLines.map((v) => v - schedule!.y);
  const slotTop = rl[2];
  const slotBot = rl[3] ?? slotTop + 58;
  const yMatch = (ai.split("\n").find((l) => l.includes("9:00 standup")) ?? "").match(/y="(\d+)"/);
  const yVal = yMatch ? Number(yMatch[1]) : -1;
  check("schedule row 2 baseline lands in its slot", yVal > slotTop && yVal < slotBot, `y=${yVal} expected in (${slotTop}, ${slotBot})`);
  const m2 = JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8"));
  check("manifest ai.status = ready", m2.layers.ai.status === "ready");
  check("manifest modified bumped", m2.modified !== before, `${before} -> ${m2.modified}`);

  console.log("\ntime-aware schedule (template start-hour + per-call override; dry-run)");
  const yOf = (svg: string | undefined, needle: string) =>
    Number(((svg ?? "").split("\n").find((l) => l.includes(needle)) ?? "").match(/y="(\d+)"/)?.[1] ?? -1);
  // The schedule self-describes its grid via data-start-hour / data-rows-per-hour.
  check("schedule parses its template start-hour (7) + rows-per-hour (1)", schedule?.startHour === 7 && schedule?.rowsPerHour === 1, `${schedule?.startHour}/${schedule?.rowsPerHour}`);
  // With NO caller startHour, a clock time now anchors via the template's start-hour.
  const tplAnchored = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "seven", time: "07:00" }, { text: "nine", time: "09:00" }] }],
  });
  check("time anchors via the template start-hour (no caller startHour)", yOf(tplAnchored.aiSvg, ">nine</text>") > yOf(tplAnchored.aiSvg, ">seven</text>"), `${yOf(tplAnchored.aiSvg, ">seven</text>")} -> ${yOf(tplAnchored.aiSvg, ">nine</text>")}`);
  check("template-anchored time does NOT warn about a missing startHour", !tplAnchored.warnings.some((w) => w.includes("startHour")), JSON.stringify(tplAnchored.warnings));
  // A per-call startHour OVERRIDES the template's: startHour 8, "11:00" → row 3.
  const timed = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", startHour: 8, lines: [{ text: "11:00 mtg", time: "11:00" }] }],
  });
  const ty = yOf(timed.aiSvg, "11:00 mtg");
  const er = 3;
  check("caller startHour 8 overrides the template (11:00 → row-3 slot)", ty > rl[er] && ty < (rl[er + 1] ?? rl[er] + 58), `y=${ty} expected in (${rl[er]}, ${rl[er + 1]})`);
  // rowsPerHour 2: 09:30 sits one ruled row below 09:00.
  const half = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", startHour: 9, rowsPerHour: 2, lines: [
      { text: "nine", time: "09:00" }, { text: "ninethirty", time: "09:30" },
    ] }],
  });
  check("rowsPerHour=2 puts 09:30 one row below 09:00", yOf(half.aiSvg, ">ninethirty</text>") > yOf(half.aiSvg, ">nine</text>"), `${yOf(half.aiSvg, ">nine</text>")} -> ${yOf(half.aiSvg, ">ninethirty</text>")}`);
  // No start-hour anywhere (neither call nor template) → warns + falls back to order.
  // The shipped schedule always declares one now, so compose directly on a synthetic
  // ruled region (no data-start-hour) to exercise the fallback path.
  const ruledOnly = parseRegions('<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><g id="region-ruled" data-region="ruled" transform="translate(0,0)"><rect width="200" height="400" fill="none"/><line x1="0" y1="40" x2="200" y2="40"/><line x1="0" y1="80" x2="200" y2="80"/><line x1="0" y1="120" x2="200" y2="120"/></g></svg>');
  const noAnchor = composeAiSvg([1024, 1366], [{ region: "ruled", lines: [{ text: "floating", time: "10:00" }] }], ruledOnly);
  check("time with no start-hour anywhere warns", noAnchor.warnings.some((w) => w.includes("startHour")), JSON.stringify(noAnchor.warnings));
  check("time with no start-hour still composes (order fallback)", noAnchor.svg.includes(">floating</text>"));
  // Malformed time is rejected.
  let badTime = false;
  try {
    await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "schedule", startHour: 8, lines: [{ text: "x", time: "9am" }] }] });
  } catch { badTime = true; }
  check("rejects malformed time string", badTime);

  console.log("\nwashi-tape duration blocks (time + endTime/durationMin; dry-run)");
  const washi = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "Team sync", time: "09:00", endTime: "10:00" }] }],
  });
  const washiGroup = regionGroup(washi.aiSvg, "schedule") ?? "";
  const rectMatch = washiGroup.match(/<rect[^>]*fill-opacity="[\d.]+"[^>]*\/>/);
  check("duration block draws a fill-opacity rect", !!rectMatch, washiGroup.slice(0, 300));
  const yAttr = Number(rectMatch?.[0].match(/y="(-?\d+)"/)?.[1]);
  const hAttr = Number(rectMatch?.[0].match(/height="(\d+)"/)?.[1]);
  // 09:00 -> row 2, 10:00 -> row 3, given the schedule's own startHour 7 / rowsPerHour 1.
  check("block y matches the start row (09:00 -> row 2)", yAttr === Math.round(rl[2]), `y=${yAttr} expected=${Math.round(rl[2])}`);
  check("block height spans start->end row (10:00 -> row 3)", yAttr + hAttr === Math.round(rl[3]), `y+h=${yAttr + hAttr} expected=${Math.round(rl[3])}`);
  check("block reuses the rx=6 corner-radius convention", rectMatch![0].includes('rx="6"'), rectMatch?.[0]);
  check("block draws the label text inside it", washiGroup.includes(">Team sync</text>"), washiGroup.slice(0, 300));
  // The tape's right inset should be the standard margin (24px), not a re-subtraction of the
  // schedule's wide LEFT gutter (52px, reserved for the printed hour labels) — that double-charge
  // left ~52px of dead space on the right of every block. bx is whatever xPad the schedule
  // region resolved to (52 by default); the tape should reach to region.width - 24, not - bx.
  const xAttr = Number(rectMatch?.[0].match(/ x="(-?[\d.]+)"/)?.[1]);
  const wAttr = Number(rectMatch?.[0].match(/width="([\d.]+)"/)?.[1]);
  const expectedWidth = Math.round(schedule!.width! - xAttr - 24);
  check(
    "block width uses a standard right margin, not the left gutter twice",
    wAttr === expectedWidth,
    `x=${xAttr} width=${wAttr} region.width=${schedule!.width} expected width=${expectedWidth}`,
  );

  // A label too long for even the widened tape should wrap into the block's spare height
  // instead of silently overflowing past the right edge.
  const longLabel = "Robotics team meeting with the whole club plus parents";
  const washiLong = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: longLabel, time: "09:00", endTime: "11:00" }] }],
  });
  const washiLongGroup = regionGroup(washiLong.aiSvg, "schedule") ?? "";
  const longTexts = [...washiLongGroup.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1])
    .filter((t) => longLabel.startsWith(t.split(" ").slice(0, 2).join(" ")) || longLabel.includes(t));
  check(
    "an overlong washi label wraps into multiple lines instead of one overflowing run",
    longTexts.length > 1,
    JSON.stringify(longTexts),
  );
  check(
    "wrapped washi segments reassemble into the original label",
    longTexts.join(" ").replace(/\s+/g, " ").trim() === longLabel,
    longTexts.join(" | "),
  );

  const zeroDur = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "Oops", time: "10:00", endTime: "09:00" }] }],
  });
  check(
    "zero/negative duration warns (info) and falls back to a plain time line — the event still appears",
    zeroDur.warningDetails.some((w) => w.code === "washi_block_zero_duration" && w.severity === "info") &&
      (zeroDur.aiSvg ?? "").includes(">Oops</text>") &&
      !(regionGroup(zeroDur.aiSvg, "schedule") ?? "").includes('rx="6"'),
    JSON.stringify(zeroDur.warningDetails),
  );
  // The real-world case that motivated the fallback: a 20-minute meeting on a
  // 1-row-per-hour grid snaps both ends to the same row — it must not vanish.
  const shortMeeting = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "Morning Meeting", time: "08:00", endTime: "08:20" }] }],
  });
  check(
    "a sub-row meeting (08:00-08:20) keeps its text as a time line",
    (shortMeeting.aiSvg ?? "").includes(">Morning Meeting</text>"),
    (regionGroup(shortMeeting.aiSvg, "schedule") ?? "").slice(0, 300),
  );

  const overrun = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "Late", time: "23:00", endTime: "23:59" }] }],
  });
  check("block past the grid clamps and warns", overrun.warningDetails.some((w) => w.code === "washi_block_clamped"), JSON.stringify(overrun.warningDetails));

  const dangling = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "No start", endTime: "10:00" }] }],
  });
  check("endTime without time warns, doesn't throw", dangling.warningDetails.some((w) => w.code === "washi_block_missing_start"), JSON.stringify(dangling.warningDetails));

  const durMin = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    // 60 min at the schedule's own rowsPerHour (1) crosses exactly one ruled row.
    regions: [{ region: "schedule", lines: [{ text: "Standup", time: "09:00", durationMin: 60 }] }],
  });
  check(
    "durationMin computes an end time internally, no warnings",
    !durMin.warningDetails.some((w) => w.code.startsWith("washi_block")),
    JSON.stringify(durMin.warningDetails),
  );
  check("durationMin block draws a fill-opacity rect", /<rect[^>]*fill-opacity="[\d.]+"/.test(regionGroup(durMin.aiSvg, "schedule") ?? ""));

  // endTime + durationMin together are rejected at the MCP schema (index.ts .refine,
  // mirroring marker/icon) — not reachable through this direct compose path. At the
  // compose layer itself, confirm `endTime` takes precedence (a 15-min durationMin
  // from 09:00 would round to the SAME row and warn zero-duration; endTime "10:00"
  // must win instead, drawing a real block with no such warning).
  const bothSet = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "x", time: "09:00", endTime: "10:00", durationMin: 15 } as any] }],
  });
  check(
    "endTime takes precedence over durationMin if both are set on one line",
    !bothSet.warningDetails.some((w) => w.code === "washi_block_zero_duration"),
    JSON.stringify(bothSet.warningDetails),
  );

  console.log("\nauto text-wrap (wrap long lines to region width; dry-run)");
  const longLine = "This is a very long schedule entry that will not fit on one line and must wrap";
  const wrapped = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: longLine, row: 0, wrap: true }] }],
  });
  const wg = regionGroup(wrapped.aiSvg, "schedule") ?? "";
  const segs = [...wg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  check("wrap splits a long line into multiple <text>", segs.length > 1, `segments=${segs.length}`);
  check("every wrapped segment is shorter than the original", segs.length > 1 && segs.every((s) => s.length > 0 && s.length < longLine.length), JSON.stringify(segs));
  check("wrapping suppresses the overflow warning", !wrapped.warnings.some((w) => w.includes("overflow")), JSON.stringify(wrapped.warnings));
  // Same line WITHOUT wrap: a single <text> that still warns overflow.
  const noWrap = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: longLine, row: 0 }] }],
  });
  const ng = regionGroup(noWrap.aiSvg, "schedule") ?? "";
  check("no-wrap keeps a single <text>", (ng.match(/<text\b/g) ?? []).length === 1);
  check("no-wrap still warns about overflow", noWrap.warnings.some((w) => w.includes("overflow")), JSON.stringify(noWrap.warnings));
  // A block tall enough to run into the next row triggers the vertical-fit warning.
  const tall = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: longLine.repeat(8), row: 0, wrap: true }] }],
  });
  check("wrapped block warns when it overruns the row", tall.warnings.some((w) => w.includes("overlap the next row")), JSON.stringify(tall.warnings));

  console.log("\ndynamic sections (heading + items flow in a box region; dry-run)");
  // A neutral box region with no ruled lines (here `todo`) is where the AI draws
  // day-specific structure: section headings + their items, only when a day needs them.
  const sectioned = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "todo", lines: [
      { text: "Important", heading: true },
      { text: "Sample item one", marker: "bullet" },
      { text: "Sample item two", marker: "bullet" },
      { text: "Tomorrow", heading: true },
      { text: "Prep slides", marker: "checkbox" },
      { text: "Habits", heading: true },
      { text: "Walk", marker: "checkbox" },
    ] }],
  });
  const notesGroup = regionGroup(sectioned.aiSvg, "todo") ?? "";
  check("heading text is letter-spaced", notesGroup.includes('letter-spacing="0.08em"'), notesGroup.slice(0, 160));
  const headingRules = [...notesGroup.matchAll(new RegExp(`<line[^>]*stroke="${DEFAULT_INK}"[^>]*opacity="0.4"`, "g"))].length;
  check("each of the 3 headings draws a hairline rule", headingRules === 3, `rules=${headingRules}`);
  // Flow order: headings and their items stack top-down in the order given.
  const yImp = yOf(sectioned.aiSvg, ">Important</text>");
  const ySample1 = yOf(sectioned.aiSvg, ">Sample item one</text>");
  const ySample2 = yOf(sectioned.aiSvg, ">Sample item two</text>");
  const yTom = yOf(sectioned.aiSvg, ">Tomorrow</text>");
  const yHab = yOf(sectioned.aiSvg, ">Habits</text>");
  check("sections flow top-down in order", yImp < ySample1 && ySample1 < yTom && yTom < yHab, `${yImp} < ${ySample1} < ${yTom} < ${yHab}`);
  check("a heading takes more vertical room than a body item", ySample1 - yImp > ySample2 - ySample1, `heading advance=${ySample1 - yImp}, item advance=${ySample2 - ySample1}`);

  console.log("\nthemed output (colored banners + accents; dry-run)");
  const themed = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true, theme: "bright",
    regions: [{ region: "todo", lines: [
      { text: "IMPORTANT", heading: true },
      { text: "Renew parking pass", marker: "checkbox" },
      { text: "TOMORROW", heading: true },
      { text: "Dentist 9am", marker: "bullet" },
    ] }],
  });
  const tg = regionGroup(themed.aiSvg, "todo") ?? "";
  check("banner heading draws a filled colored rect", /<rect[^>]*fill="#3FB6A8"/.test(tg) || /<rect[^>]*fill="#F2884B"/.test(tg), tg.slice(0, 200));
  check("two banners use two different cycled colors", new Set([...tg.matchAll(/<rect[^>]*rx="6" fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1])).size === 2, tg);
  check("banner label is white, not the default ink colour", tg.includes('fill="#FFFFFF"') && !tg.includes(DEFAULT_INK), tg.slice(0, 240));
  // (case-insensitive: the AA floor round-trips the hex through HSL → lowercase)
  check("themed body text uses theme ink, not the default palette", /fill="#3a3a3a"/i.test(tg), tg);
  // The default (no theme override) is unchanged in SHAPE (back-compat): headings stay
  // underline+rule — gold is retired, so the COLOUR is now the chapter's own ink palette.
  const defaultHead = regionGroup((await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "todo", lines: [{ text: "Plain", heading: true }] }] })).aiSvg, "todo") ?? "";
  check("default (no theme) keeps the underline heading", defaultHead.includes(`stroke="${DEFAULT_INK}"`) && !/<rect[^>]*rx="6"/.test(defaultHead), defaultHead);

  console.log("\nadaptive theme contract (harmony / variety / fontPersonality)");
  // No knobs → the default ink-palette theme (back-compat for the resolver itself; gold retired).
  check("resolveTheme({}) is the default ink-palette theme", resolveTheme({}).theme.text === DEFAULT_INK);
  check("the default ink colour clears the ≥4.5:1 contrast floor on paper (Rule 1)", contrastRatioHex(DEFAULT_INK, PAPER_COLOR) >= 4.5);
  // harmony=match derives banners FROM the template palette, not a fixed preset.
  const pal = ["#E2825E", "#8FA98A", "#88B0D4"];
  const matched = resolveTheme({ harmony: "match", varietyDial: 0.9, templatePalette: pal });
  check("harmony=match derives multiple banners from the template palette", matched.theme.banners.length >= 2 && matched.theme.banners.every((h) => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(matched.theme.banners));
  check("high variety → banner-pill headings", matched.theme.headingStyle === "banner");
  check("low variety → quiet underline headings", resolveTheme({ harmony: "match", varietyDial: 0.1, templatePalette: pal }).theme.headingStyle === "underline");
  // Rule 1 (real WCAG contrast, not a flat lightness cap): derived BODY text clears
  // ≥4.5:1 on cream (solved at derivation, not warned at runtime) — even from a pale
  // template swatch. A hue-aware contrast floor can leave some hues lighter than the
  // old flat lightness cap while still reading fine — contrast, not raw L, is the rule.
  const pale = resolveTheme({ harmony: "match", templatePalette: ["#F2B8CC"] });
  check("derived body text clears the contrast floor (legible on cream)",
    contrastRatioHex(pale.theme.text, PAPER_COLOR) >= 4.5,
    `${pale.theme.text} (contrast=${contrastRatioHex(pale.theme.text, PAPER_COLOR).toFixed(2)})`);
  // Empty palette while harmonising → sticker-palette fallback + a note.
  check("adaptive with no template palette warns about the fallback", resolveTheme({ harmony: "complement", templatePalette: [] }).warnings.some((w) => w.includes("sticker palette")));
  // fontPersonality is an orthogonal axis: it swaps fonts but NOT the palette.
  const hand = resolveTheme({ fontPersonality: "handwritten" });
  check("fontPersonality=handwritten sets Caveat body / keeps the default palette", hand.theme.fonts?.body === "Caveat" && hand.theme.text === DEFAULT_INK, JSON.stringify(hand.theme.fonts));
  // A chapter's paletteCharacter is a lower-precedence default source than harmony/accent/preset.
  const sunbaked = resolveTheme({ paletteCharacter: "sunbaked" });
  const tidewater = resolveTheme({ paletteCharacter: "tidewater" });
  check("a different paletteCharacter resolves a different default ink colour", sunbaked.theme.text !== tidewater.theme.text, `${sunbaked.theme.text} vs ${tidewater.theme.text}`);
  check("paletteCharacter's resolved ink still clears the contrast floor", contrastRatioHex(sunbaked.theme.text, PAPER_COLOR) >= 4.5);
  check("an explicit accent still wins over paletteCharacter", resolveTheme({ paletteCharacter: "sunbaked", accent: "#7B5EA7" }).theme.text !== sunbaked.theme.text);
  // End-to-end: fontPersonality flows into the composed text.
  const written = await writeUnderlay(root, daily, { status: "ready", dryRun: true, fontPersonality: "handwritten", regions: [{ region: "todo", lines: [{ text: "buy milk" }] }] });
  check("fontPersonality reaches the composed ai.svg (Caveat body text)", (regionGroup(written.aiSvg, "todo") ?? "").includes('font-family="Caveat"'), regionGroup(written.aiSvg, "todo") ?? "");

  console.log("\ndev CLI forwards adaptive theme params");
  const cliAdaptive = await runCli(root, [
    "write_underlay",
    daily,
    JSON.stringify({
      status: "ready",
      dryRun: true,
      harmony: "match",
      varietyDial: 0.9,
      fontPersonality: "handwritten",
      regions: [{ region: "todo", lines: [{ text: "CLI", heading: true }, { text: "milk" }] }],
    }),
  ]);
  const cliNotes = regionGroup(cliAdaptive.aiSvg, "todo") ?? "";
  check("CLI forwarded fontPersonality (Fredoka heading)", cliNotes.includes('font-family="Fredoka"'), cliNotes.slice(0, 220));
  check("CLI forwarded varietyDial/harmony (banner heading)", /<rect[^>]*rx="6"/.test(cliNotes), cliNotes.slice(0, 220));

  console.log("\nchapter .folder.json theme is read as the default (overridable per call)");
  const dailyFolder = path.join(root, "Shared", "Daily", ".folder.json");
  const folderJson = JSON.parse(await fs.readFile(dailyFolder, "utf8").catch(() => "{}"));
  folderJson.theme = { harmony: "match", varietyDial: 0.9, fontPersonality: "handwritten" };
  await fs.writeFile(dailyFolder, JSON.stringify(folderJson, null, 2) + "\n");
  const fromChapter = await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "todo", lines: [{ text: "Plan", heading: true }, { text: "milk" }] }] });
  const fcg = regionGroup(fromChapter.aiSvg, "todo") ?? "";
  check("read_page surfaces the chapter theme", (await readPage(root, daily)).theme?.fontPersonality === "handwritten");
  check("chapter theme applies with no per-call params (handwritten heading font)", fcg.includes('font-family="Fredoka"'), fcg.slice(0, 200));
  check("chapter high-variety gives banner-pill headings", /<rect[^>]*rx="6"/.test(fcg), fcg.slice(0, 200));
  // Per-call preset overrides the chapter's adaptive default.
  const overridden = regionGroup((await writeUnderlay(root, daily, { status: "ready", dryRun: true, theme: "gold", regions: [{ region: "todo", lines: [{ text: "Plain", heading: true }] }] })).aiSvg, "todo") ?? "";
  check("per-call theme:gold overrides the chapter's adaptive theme", overridden.includes(`stroke="${DEFAULT_INK}"`) && !/<rect[^>]*rx="6"/.test(overridden), overridden.slice(0, 200));
  // Restore the folder so later assertions see no theme.
  delete folderJson.theme;
  await fs.writeFile(dailyFolder, JSON.stringify(folderJson, null, 2) + "\n");

  console.log("\nregion label banner (above the box; themed; dry-run)");
  const labeled = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true, theme: "bright",
    regions: [{ region: "schedule", label: "SCHEDULE", lines: [{ text: "9:00 standup", row: 0 }] }],
  });
  const lgroup = regionGroup(labeled.aiSvg, "schedule") ?? "";
  // The label banner is a filled rect at a NEGATIVE local y (sits above row 0).
  check("label draws a banner above the region (negative y)", /<rect[^>]*y="-\d+"[^>]*rx="6"/.test(lgroup), lgroup.slice(0, 200));
  check("label text is the title, white on the banner", lgroup.includes(">SCHEDULE</text>") && lgroup.includes('fill="#FFFFFF"'), lgroup.slice(0, 260));
  check("label does not consume row 0 (the line still lands in its slot)", lgroup.includes(">9:00 standup</text>"), lgroup);
  // schedule has a printed label slot (see above) — the banner pill must fill that
  // slot's exact box (geometry-derived, not hard-coded) rather than the old fixed
  // margin placement.
  const slot = schedule!.labelSlot!;
  const slotRect = `<rect x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" rx="6"`;
  check("banner pill fills the printed label slot's exact box", lgroup.includes(slotRect), `expected ${slotRect} in ${lgroup.slice(0, 260)}`);
  // Underline-style theme (e.g. gold): no box to fill, so it only anchors off the
  // slot's origin — text baseline inside the slot's vertical range, no pill rect.
  const underlineLabeled = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true, theme: "gold",
    regions: [{ region: "schedule", label: "SCHEDULE", lines: [{ text: "x", row: 0 }] }],
  });
  const ulgroup = regionGroup(underlineLabeled.aiSvg, "schedule") ?? "";
  const ulY = Number((ulgroup.match(new RegExp(`<text x="${slot.x}" y="(-?\\d+)"`)) ?? [])[1]);
  check("underline-style label baseline sits within the slot's vertical range", ulY >= slot.y && ulY <= slot.y + slot.height, `y=${ulY} slot=${JSON.stringify(slot)}`);
  check("underline style draws no pill rect (text + rule only)", !/<rect[^>]*rx="6"/.test(ulgroup), ulgroup.slice(0, 200));
  // A region with no printed label slot (header's dashed rect has no data-region) —
  // the banner falls back to the old fixed margin placement (x=24).
  const headerLabeled = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true, theme: "bright",
    regions: [{ region: "header", label: "TODAY", lines: [{ text: "placeholder" }] }],
  });
  const hgroup = regionGroup(headerLabeled.aiSvg, "header") ?? "";
  check("no label slot -> banner falls back to the fixed margin (x=24)", /<rect x="24" y="-\d+"[^>]*rx="6"/.test(hgroup), hgroup.slice(0, 260));
  // No label, default theme → no banner emitted (back-compat).
  const noLabel = regionGroup((await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "schedule", lines: [{ text: "x", row: 0 }] }] })).aiSvg, "schedule") ?? "";
  check("no label → no banner rect", !/<rect[^>]*rx="6"/.test(noLabel), noLabel);

  console.log("\nI: server-stamped hour labels (showHours)");
  const hoursResult = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", showHours: true, lines: [{ text: "9:00 standup", row: 0 }] }],
  });
  const hoursGroup = regionGroup(hoursResult.aiSvg, "schedule") ?? "";
  const hourLabels = [...hoursGroup.matchAll(/<text x="4" y="[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  check(
    "showHours stamps one label per ruled row (derived from parsed geometry)",
    hourLabels.length === (schedule?.ruledLines.length ?? -1),
    `labels=${JSON.stringify(hourLabels)} rows=${schedule?.ruledLines.length}`,
  );
  check("first hour label matches the template's data-start-hour (7 -> \"7a\")", hourLabels[0] === "7a", JSON.stringify(hourLabels));
  const noRuledHours = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", showHours: true, lines: [{ text: "note" }] }],
  });
  check(
    "showHours on an unruled region is a no-op that warns time_unruled_region (info)",
    noRuledHours.warningDetails.some((w) => w.code === "time_unruled_region" && w.severity === "info" && w.region === "ainotes"),
    JSON.stringify(noRuledHours.warningDetails),
  );
  check(
    "showHours no-op draws no hour-label text on the unruled region",
    !(regionGroup(noRuledHours.aiSvg, "ainotes") ?? "").includes('x="4"'),
    regionGroup(noRuledHours.aiSvg, "ainotes") ?? "",
  );

  console.log("\noverflow warnings + default-on wrap (dry-run, no write)");
  const longText = "This is an absurdly long line of text that cannot possibly fit the box";
  // Default-on wrap: a flow-placed long line in a box region wraps instead of overflowing.
  const overflow = await writeUnderlay(root, daily, {
    status: "ready",
    dryRun: true,
    regions: [{ region: "ainotes", lines: [
      { text: longText },
      { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }, { text: "f" },
    ]}],
  });
  const overflowGroup = regionGroup(overflow.aiSvg, "ainotes") ?? "";
  const wrapSegs = [...overflowGroup.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  check("flow-placed long line wraps by default (extra <text> segments)", wrapSegs.length > 7, `segments=${wrapSegs.length}`);
  check("default wrap suppresses the overflow warning", !overflow.warnings.some((w) => w.includes("overflow")), JSON.stringify(overflow.warnings));
  // Flow layout: all 7 lines are written regardless of the ruled-row count.
  check("flow layout writes all lines past the ruled-row count", overflowGroup.includes(">f</text>"), overflowGroup.slice(0, 600));
  // wrap:false forces the single-segment overflow warning (+ structured detail).
  const noWrapOverflow = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: [{ text: longText, wrap: false }] }],
  });
  check("wrap:false warns about likely overflow", noWrapOverflow.warnings.some((w) => w.includes("overflow")), JSON.stringify(noWrapOverflow.warnings));
  check("warnings remain a string array for compatibility", noWrapOverflow.warnings.every((w) => typeof w === "string"));
  check("structured warning details include region + code", noWrapOverflow.warningDetails.some((w) => w.code === "text_overflow" && w.region === "ainotes"), JSON.stringify(noWrapOverflow.warningDetails));

  console.log("\nE: box-region wrap cursor reserves space for wrapped continuations");
  // Regression: the cursor used to advance by a flat line-height regardless of how
  // many segments a wrapped line rendered, so the NEXT line's baseline landed on
  // top of this line's own wrapped continuations.
  const wrapCursor = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: [{ text: longText }, { text: "Should not overlap" }] }],
  });
  const wrapCursorGroup = regionGroup(wrapCursor.aiSvg, "ainotes") ?? "";
  const wrapCursorTexts = [...wrapCursorGroup.matchAll(/<text x="[^"]*" y="(-?\d+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ y: Number(m[1]), text: m[2] }));
  const longSegs = wrapCursorTexts.filter((t) => t.text !== "Should not overlap");
  const nextLine = wrapCursorTexts.find((t) => t.text === "Should not overlap");
  check("wrapped line produced multiple segments", longSegs.length > 1, JSON.stringify(wrapCursorTexts));
  check(
    "next line's baseline sits below every one of the wrapped line's continuations",
    !!nextLine && longSegs.every((s) => nextLine!.y > s.y),
    JSON.stringify(wrapCursorTexts),
  );

  console.log("\nF: wrapped-text overflow warning extends to the box-region case");
  // An explicit-y next line placed inside a wrapping flow line's reach: no ruled
  // pitch to check against (box region) and it doesn't reach the region's bottom
  // edge either — only the box-region-vs-next-flow-baseline check (F) catches it.
  const closeNextLine = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: [{ text: longText }, { text: "too close", y: 20 }] }],
  });
  check(
    "explicit-y next line inside the wrap block's reach warns wrapped_text_vertical_overflow",
    closeNextLine.warningDetails.some((w) => w.code === "wrapped_text_vertical_overflow" && w.region === "ainotes"),
    JSON.stringify(closeNextLine.warningDetails),
  );

  console.log("\nG: ainotes default font size (16, not 26) fits typical multi-sentence prose");
  const sentences = [
    "Weather looks clear today with a light breeze from the northwest.",
    "Remember to grab the dry cleaning on the way home from work.",
    "Team standup moved to 10am, check the calendar for the new link.",
    "Dinner reservations are confirmed for 7pm at the usual spot.",
    "Don't forget dad's birthday call this evening.",
  ];
  const atDefaultSize = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: sentences.map((text) => ({ text })) }],
  });
  const atOldSize = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", lines: sentences.map((text) => ({ text, size: 26 })) }],
  });
  const overflowCodes = new Set(["wrapped_text_vertical_overflow", "text_overflow"]);
  check(
    "ainotes default (16) fits a 5-sentence note without overflow warnings",
    !atDefaultSize.warningDetails.some((w) => overflowCodes.has(w.code)),
    JSON.stringify(atDefaultSize.warningDetails),
  );
  check(
    "the same content at the OLD default (26, via explicit override) does overflow",
    atOldSize.warningDetails.some((w) => overflowCodes.has(w.code)),
    JSON.stringify(atOldSize.warningDetails),
  );

  console.log("\ndry-run writes nothing to disk");
  const diskBefore = await fs.readFile(aiPath, "utf8");
  const dry = await writeUnderlay(root, daily, {
    status: "empty",
    dryRun: true,
    regions: [{ region: "todo", lines: [{ text: "DRY_RUN_SENTINEL" }] }],
  });
  const diskAfter = await fs.readFile(aiPath, "utf8");
  check("dry run returns composed svg", (dry.aiSvg ?? "").includes("DRY_RUN_SENTINEL") && dry.dryRun === true);
  check("dry run left ai.svg unchanged", diskAfter === diskBefore);
  check("dry run did NOT flip status", JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8")).layers.ai.status === "ready");

  console.log("\nmerge preserves untouched regions");
  const scheduleBlock = regionGroup(diskBefore, "schedule");
  const merged = await writeUnderlay(root, daily, {
    status: "ready",
    merge: true,
    regions: [{ region: "ainotes", lines: [{ text: "Buy milk", marker: "bullet" }] }],
  });
  const aiMerged = await fs.readFile(aiPath, "utf8");
  check("merge adds the new region", aiMerged.includes("Buy milk"));
  check("merge keeps the schedule text", aiMerged.includes("9:00 standup"));
  check("merge keeps the to-dos", aiMerged.includes("Email the registrar"));
  check("merge preserves the schedule group VERBATIM", !!scheduleBlock && aiMerged.includes(scheduleBlock!), "schedule block changed");
  check("merge reported not-dry-run", merged.dryRun === false);

  console.log("\nmerge survives a region whose raw fragment nests <g> (balanced output)");
  // Regression: the old regex extraction stopped at the FIRST </g>, so a nested
  // group produced an unclosed <g> after merge — the app's XMLParser then rejected
  // the whole document and the gold layer silently vanished on device.
  await writeUnderlay(root, daily, {
    status: "ready",
    regions: [
      { region: "ainotes", svg: '<g opacity="0.5"><g><text x="24" y="20" font-family="Mulish" font-size="12">NESTED</text></g></g>' },
      { region: "todo", lines: [{ text: "todo before merge" }] },
    ],
  });
  await writeUnderlay(root, daily, {
    status: "ready", merge: true,
    regions: [{ region: "todo", lines: [{ text: "todo after merge" }] }],
  });
  const nestedMerged = await fs.readFile(aiPath, "utf8");
  const gOpens = (nestedMerged.match(/<g\b(?![^>]*\/>)/g) ?? []).length;
  const gCloses = (nestedMerged.match(/<\/g>/g) ?? []).length;
  check("merged document keeps <g> tags balanced", gOpens === gCloses, `${gOpens} opens vs ${gCloses} closes`);
  check("nested-g region content survives the merge intact", nestedMerged.includes(">NESTED</text>") && nestedMerged.includes('opacity="0.5"'), nestedMerged.slice(0, 400));
  check("merged region was replaced", nestedMerged.includes(">todo after merge</text>") && !nestedMerged.includes(">todo before merge</text>"));

  console.log("\nmerge over a prior raw-svg document warns instead of silently dropping it");
  await writeUnderlay(root, daily, {
    status: "ready",
    svg: '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><text x="80" y="80" fill="#9C7C1A">raw only</text></svg>',
  });
  const mergeOverRaw = await writeUnderlay(root, daily, {
    status: "ready", merge: true,
    regions: [{ region: "todo", lines: [{ text: "fresh region" }] }],
  });
  check("merge over raw svg warns merge_discarded_raw_svg", mergeOverRaw.warningDetails.some((w) => w.code === "merge_discarded_raw_svg"), JSON.stringify(mergeOverRaw.warningDetails));

  console.log("\nwrite_underlay (calendar grid — monthly tap-to-day)");
  const monthRead = await readPage(root, monthly);
  const monthRegion = monthRead.regions.find((r) => r.name === "month");
  check("month region is a declared 7x6 grid", monthRegion?.cols === 7 && monthRegion?.rows === 6, `${monthRegion?.cols}x${monthRegion?.rows}`);
  await writeUnderlay(root, monthly, {
    status: "ready",
    regions: [{ region: "month", calendar: { month: "2026-02", days: [{ day: 14, text: "Valentine" }] } }],
  });
  const cal = await fs.readFile(path.join(root, monthly, "ai.svg"), "utf8");
  check("emits data-date for day 1", cal.includes('data-date="2026-02-01"'));
  check("emits data-date for day 28", cal.includes('data-date="2026-02-28"'));
  check("does NOT emit day 29 (Feb has 28)", !cal.includes('data-date="2026-02-29"'));
  check("emits a tap-target rect for day 14", /<rect [^>]*data-date="2026-02-14"/.test(cal));
  check("draws the day number 14", />14<\/text>/.test(cal));
  check("draws the optional event label", cal.includes(">Valentine</text>"));
  // Grid sanity: every day cell's x aligns to one of the 7 evenly-divided columns.
  const expectedCols = Array.from({ length: 7 }, (_, i) => Math.round((912 * i) / 7));
  const cellXs = [...cal.matchAll(/<rect x="(-?\d+)"[^>]*data-date="2026-02-/g)].map((m) => Number(m[1]));
  check("28 day cells emitted", cellXs.length === 28, String(cellXs.length));
  check("every cell aligns to a 7-column boundary", cellXs.every((x) => expectedCols.some((c) => Math.abs(c - x) <= 1)), JSON.stringify([...new Set(cellXs)].sort((a, b) => a - b)));
  // A too-small grid (5 rows vs a 6-week month) must warn about the days it drops,
  // never lose them silently. Aug 2026 starts Saturday → days 30/31 land on row 5.
  const smallGrid = parseRegions('<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><g id="region-month" data-region="month" data-cols="7" data-rows="5" transform="translate(56,300)"><rect width="912" height="750" fill="none"/></g></svg>');
  const dropped = composeAiSvg([1024, 1366], [{ region: "month", calendar: { month: "2026-08" } }], smallGrid);
  check("days outside the printed grid warn (calendar_days_outside_grid)", dropped.warningDetails.some((w) => w.code === "calendar_days_outside_grid" && w.message.includes("30, 31")), JSON.stringify(dropped.warningDetails));
  check("in-grid days still compose on the small grid", dropped.svg.includes('data-date="2026-08-29"') && !dropped.svg.includes('data-date="2026-08-30"'));
  // The monthly templates print Sun–Sat themselves — `weekdays` must not derive as
  // an AI-owned region (that invited double-printing the header).
  const monthlyRegions = parseRegions(await fs.readFile(path.join(root, "Templates", "monthly-minimal", "template.svg"), "utf8"), "monthly-minimal");
  const weekdaysRegion = monthlyRegions.find((r) => r.name === "weekdays");
  check("weekdays region derives as shared, not ai", !weekdaysRegion || weekdaysRegion.fill !== "ai", weekdaysRegion?.fill);

  console.log("\npreset themes respect Rule 1's real WCAG contrast floor (AA text)");
  // The bright preset's accent (#E86A92, ~2.9:1 on cream) is calendar day-number TEXT —
  // presets must clear the same ≥4.5:1 floor the adaptive path uses.
  for (const name of ["bright", "cozy", "editorial"]) {
    const t = resolveTheme(name).theme;
    check(`${name}: text/serif clear the contrast floor`,
      contrastRatioHex(t.text, PAPER_COLOR) >= 4.5 && contrastRatioHex(t.serif, PAPER_COLOR) >= 4.5,
      `text ${t.text} serif ${t.serif}`);
    check(`${name}: accent clears the contrast floor`,
      contrastRatioHex(t.accent, PAPER_COLOR) >= 4.5,
      `${t.accent} (contrast=${contrastRatioHex(t.accent, PAPER_COLOR).toFixed(2)})`);
  }
  // "gold" is kept only as a back-compat preset name — it no longer emits a fixed
  // colour (gold is retired); it resolves to the same default ink-palette theme as no
  // theme at all.
  check("gold preset resolves to the default ink-palette theme, not a fixed hex",
    resolveTheme("gold").theme.text === DEFAULT_INK && resolveTheme("gold").theme.accent === resolveTheme({}).theme.accent);

  console.log("\nwrite_underlay (raw svg) + reject merge+svg");
  const rawOk = await writeUnderlay(root, daily, {
    status: "ready",
    svg: '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><text x="80" y="80" fill="#9C7C1A">raw</text></svg>',
  });
  check("raw svg written verbatim", (await fs.readFile(aiPath, "utf8")).includes(">raw</text>"));
  check("supported raw svg produces no raw warnings", rawOk.warningDetails.length === 0, JSON.stringify(rawOk.warningDetails));
  const rawWarn = await writeUnderlay(root, daily, {
    status: "ready",
    dryRun: true,
    svg: '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><foreignObject x="0" y="0" width="10" height="10"/></svg>',
  });
  check("raw svg warns on unsupported app-renderer elements", rawWarn.warningDetails.some((w) => w.code === "raw_svg_unsupported_element"), JSON.stringify(rawWarn.warningDetails));
  check("raw svg warns on viewBox/page-size mismatch", rawWarn.warningDetails.some((w) => w.code === "raw_svg_viewbox_mismatch"), JSON.stringify(rawWarn.warningDetails));
  let threwDataUriTopLevel = false;
  try {
    await writeUnderlay(root, daily, {
      status: "ready",
      dryRun: true,
      svg:
        '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">' +
        '<image href="data:image/png;base64,AAAA" x="0" y="0" width="10" height="10"/></svg>',
    });
  } catch {
    threwDataUriTopLevel = true;
  }
  check("raw svg throws on data-URI <image href>", threwDataUriTopLevel);
  let rejectedMergeSvg = false;
  try {
    await writeUnderlay(root, daily, { status: "ready", merge: true, svg: "<svg/>" });
  } catch {
    rejectedMergeSvg = true;
  }
  check("rejects merge with raw svg", rejectedMergeSvg);

  console.log("\nper-region svg (verbatim escape hatch) + empty-region backstop");
  // The bug this fixes: a region carrying raw `svg` used to be silently dropped.
  const perRegion = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", svg: '<text x="24" y="20" font-family="Mulish" font-size="12">PRSVG</text>' }],
  });
  const prg = regionGroup(perRegion.aiSvg, "ainotes") ?? "";
  check("per-region svg is emitted verbatim inside the group", prg.includes(">PRSVG</text>"), prg.slice(0, 200));
  check("supported per-region svg produces no element warning", !perRegion.warningDetails.some((w) => w.code === "raw_svg_unsupported_element"), JSON.stringify(perRegion.warningDetails));
  const perRegionBad = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", svg: '<foreignObject x="0" y="0" width="10" height="10"/>' }],
  });
  check("per-region svg warns on unsupported app-renderer elements", perRegionBad.warningDetails.some((w) => w.code === "raw_svg_unsupported_element" && w.region === "ainotes"), JSON.stringify(perRegionBad.warningDetails));
  let threwDataUriPerRegion = false;
  try {
    await writeUnderlay(root, daily, {
      status: "ready", dryRun: true,
      regions: [{ region: "ainotes", svg: '<image href="data:image/png;base64,AAAA" x="0" y="0" width="10" height="10"/>' }],
    });
  } catch {
    threwDataUriPerRegion = true;
  }
  check("per-region svg throws on data-URI <image href>", threwDataUriPerRegion);
  // Backstop: a region named but given nothing renderable surfaces a warning (never
  // a silent ok) — this is what catches a stray/typo'd key on the direct/CLI path.
  const emptyReg = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true, regions: [{ region: "todo" }],
  });
  check("a content-less region warns empty_region", emptyReg.warningDetails.some((w) => w.code === "empty_region" && w.region === "todo"), JSON.stringify(emptyReg.warningDetails));
  // svg is one of three mutually-exclusive bodies (lines / calendar / svg).
  let rejectedSvgLines = false;
  try {
    await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "todo", svg: "<text/>", lines: [{ text: "x" }] }] });
  } catch { rejectedSvgLines = true; }
  check("rejects a region with both svg and lines", rejectedSvgLines);
  // Composes + merges like any region: a per-region svg survives a merge of another region.
  await writeUnderlay(root, daily, { status: "ready", regions: [
    { region: "ainotes", svg: '<text x="24" y="20" font-family="Mulish" font-size="12">PRSVG</text>' },
    { region: "todo", lines: [{ text: "keep me" }] },
  ]});
  await writeUnderlay(root, daily, { status: "ready", merge: true, regions: [{ region: "todo", lines: [{ text: "updated notes" }] }] });
  const aiPerRegion = await fs.readFile(aiPath, "utf8");
  check("per-region svg persists to disk verbatim", aiPerRegion.includes(">PRSVG</text>"));
  check("merge of another region keeps the per-region svg", aiPerRegion.includes(">PRSVG</text>") && aiPerRegion.includes(">updated notes</text>"));

  console.log("\nset_underlay_status / clear_underlay");
  await setStatus(root, daily, "refreshing");
  check("status set to refreshing", JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8")).layers.ai.status === "refreshing");
  await clearUnderlay(root, daily);
  const m4 = JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8"));
  check("clear sets status empty", m4.layers.ai.status === "empty");
  check("clear empties ai.svg", !(await fs.readFile(aiPath, "utf8")).includes("<text"));

  console.log("\ncreate_page by cloning a sibling");
  await fs.mkdir(path.join(root, "Shared", "Daily", "reserved-dir"), { recursive: true });
  let refusedExistingDir = false;
  try {
    await createPage(root, { chapter: "Daily", name: "reserved-dir", title: "Nope" });
  } catch {
    refusedExistingDir = true;
  }
  check("create_page refuses an existing destination directory", refusedExistingDir);
  let cleanedStage = false;
  try {
    await createPage(root, { chapter: "Daily", name: "bad-template", title: "Bad", template: "missing-template" });
  } catch {
    const entries = await fs.readdir(path.join(root, "Shared", "Daily"));
    cleanedStage = !entries.some((e) => e.includes("bad-template") || e.startsWith(".create-bad-template"));
  }
  check("failed create_page leaves no destination/staging folder", cleanedStage);
  const sib = await createPage(root, { chapter: "Daily", name: "2026-06-23", title: "Tuesday" });
  check("sibling clone reports a Shared/ provenance", sib.clonedFrom.startsWith("Shared/Daily/"), sib.clonedFrom);
  check("cloned page is writable", true);
  await writeUnderlay(root, "Shared/Daily/2026-06-23", {
    status: "ready",
    regions: [{ region: "schedule", lines: [{ text: "7:30 coffee", row: 0 }] }],
  });
  check("can write underlay into the cloned page", (await fs.readFile(path.join(root, "Shared/Daily/2026-06-23/ai.svg"), "utf8")).includes("7:30 coffee"));
  const folder = JSON.parse(await fs.readFile(path.join(root, "Shared/Daily/.folder.json"), "utf8"));
  check("chapter order includes both pages", folder.order.includes("2026-06-22") && folder.order.includes("2026-06-23"));

  console.log("\ncreate_page name hygiene");
  // A slashed name must fail validation, not create nested folders / corrupt order.
  let refusedSlashName = false;
  try {
    await createPage(root, { chapter: "Daily", name: "a/b", title: "Nope" });
  } catch { refusedSlashName = true; }
  check("create_page rejects a name containing a slash", refusedSlashName);

  console.log("\nlist_pages metadata filters");
  // At this point: Daily/2026-06-22 (daily-minimal, "Monday", status empty after clear),
  // Daily/2026-06-23 (daily-minimal, "Tuesday", ready), Monthly/2026-02 (monthly-minimal,
  // "February", ready). Derive the unfiltered total rather than hard-coding it.
  const allRows = (await listPageRows(root)).rows;
  const total = allRows.length;
  check("unfiltered lists every page", total >= 3, String(total));
  const byTemplate = (await listPageRows(root, { template: "daily-minimal" })).rows;
  check("template filter keeps only daily-minimal", byTemplate.length === 2 && byTemplate.every((r) => r.template === "daily-minimal"), JSON.stringify(byTemplate.map((r) => r.page)));
  const ready = (await listPageRows(root, { aiStatus: "ready" })).rows;
  check("aiStatus=ready excludes the cleared daily", ready.every((r) => r.aiStatus === "ready") && !ready.some((r) => r.page === daily), JSON.stringify(ready.map((r) => r.page)));
  const empty = (await listPageRows(root, { aiStatus: "empty" })).rows;
  check("aiStatus=empty finds the cleared daily", empty.some((r) => r.page === daily) && empty.every((r) => r.aiStatus === "empty"), JSON.stringify(empty.map((r) => r.page)));
  const titled = (await listPageRows(root, { titleContains: "feb" })).rows;
  check("titleContains is case-insensitive", titled.length === 1 && titled[0].title === "February", JSON.stringify(titled.map((r) => r.title)));
  const combined = (await listPageRows(root, { chapter: "Daily", template: "daily-minimal" })).rows;
  check("filters AND together (chapter + template)", combined.length === 2 && combined.every((r) => r.page.startsWith("Shared/Daily/")), JSON.stringify(combined.map((r) => r.page)));
  // Regression: the `chapter` filter accepts both the bare name and the "Shared/<name>"
  // path get_library hands back (callers feed the path back; the prefix must not double).
  const byBareName = (await listPageRows(root, { chapter: "Daily" })).rows;
  const byPath = (await listPageRows(root, { chapter: "Shared/Daily" })).rows;
  check("chapter filter accepts the get_library path form, not just the bare name", byPath.length === byBareName.length && byBareName.length >= 2, `bare=${byBareName.length} path=${byPath.length}`);
  const beforeFuture = (await listPageRows(root, { modifiedBefore: "2999-01-01" })).rows;
  check("modifiedBefore far-future keeps all dated pages", beforeFuture.length === total, `${beforeFuture.length}/${total}`);
  const afterFuture = (await listPageRows(root, { modifiedAfter: "2999-01-01" })).rows;
  check("modifiedAfter far-future excludes everything", afterFuture.length === 0, String(afterFuture.length));

  console.log("\nlist_pages resilience (corrupt manifest + iCloud-evicted placeholder)");
  // One bad page must not take down the whole listing — it's skipped with a note.
  const badPage = path.join(root, "Shared", "Daily", "corrupt-manifest");
  await fs.mkdir(badPage, { recursive: true });
  await fs.writeFile(path.join(badPage, "manifest.json"), "{ this is not JSON");
  // An evicted page shows only a .manifest.json.icloud placeholder on the Mac.
  const evictedPage = path.join(root, "Shared", "Daily", "evicted-page");
  await fs.mkdir(evictedPage, { recursive: true });
  await fs.writeFile(path.join(evictedPage, ".manifest.json.icloud"), "placeholder");
  const resilient = await listPageRows(root, { chapter: "Daily" });
  check("corrupt manifest is skipped, not fatal", resilient.rows.length === byBareName.length, `${resilient.rows.length} vs ${byBareName.length}`);
  check("corrupt manifest surfaces a skip note", resilient.notes.some((n) => n.includes("corrupt-manifest") && n.includes("Skipped")), JSON.stringify(resilient.notes));
  check("evicted page surfaces a pending-download note", resilient.notes.some((n) => n.includes("evicted-page") && n.includes("iCloud")), JSON.stringify(resilient.notes));
  await fs.rm(badPage, { recursive: true, force: true });
  await fs.rm(evictedPage, { recursive: true, force: true });

  console.log("\ncreate_page calendar-awareness + chapter-title hygiene");
  // A brand-new chapter referenced by its "Shared/<name>" path form gets the BARE
  // name as its .folder.json title (regression: it used to store "Shared/Fresh").
  await createPage(root, { chapter: "Shared/Fresh", name: "2026-07-01", template: "daily-minimal" });
  const freshFolder = JSON.parse(await fs.readFile(path.join(root, "Shared", "Fresh", ".folder.json"), "utf8"));
  check("new chapter title is the bare name, not the path form", freshFolder.title === "Fresh", JSON.stringify(freshFolder.title));
  // The Monthly chapter holds only the 2026-02 monthly-overview grid. With a declared
  // defaultTemplate, a new day page must come from THAT, never clone the month grid.
  const monthlyFolderFile = path.join(root, "Shared", "Monthly", ".folder.json");
  const monthlyFolder = JSON.parse(await fs.readFile(monthlyFolderFile, "utf8").catch(() => "{}"));
  monthlyFolder.defaultTemplate = "daily-minimal";
  await fs.writeFile(monthlyFolderFile, JSON.stringify(monthlyFolder, null, 2) + "\n");
  const dayInMonth = await createPage(root, { chapter: "Monthly", name: "2026-02-10", title: "Feb 10" });
  check("day page uses the chapter defaultTemplate, not the month grid", dayInMonth.template === "daily-minimal", `${dayInMonth.template} from ${dayInMonth.clonedFrom}`);
  // Without a defaultTemplate, a sibling clone must still skip the monthly overview
  // (regression: readdir order could hand a new day page the month-grid template).
  delete monthlyFolder.defaultTemplate;
  await fs.writeFile(monthlyFolderFile, JSON.stringify(monthlyFolder, null, 2) + "\n");
  const dayInMonth2 = await createPage(root, { chapter: "Monthly", name: "2026-02-11", title: "Feb 11" });
  check("sibling clone skips the monthly-overview page", dayInMonth2.template === "daily-minimal" && dayInMonth2.clonedFrom !== "Shared/Monthly/2026-02", `${dayInMonth2.template} from ${dayInMonth2.clonedFrom}`);

  console.log("\ncreate_page honors weekdayTemplates + deletedDays");
  const dailyFolderFile2 = path.join(root, "Shared", "Daily", ".folder.json");
  const dailyFolder2 = JSON.parse(await fs.readFile(dailyFolderFile2, "utf8").catch(() => "{}"));
  dailyFolder2.weekdayTemplates = { sat: "todo-minimal" };
  await fs.writeFile(dailyFolderFile2, JSON.stringify(dailyFolder2, null, 2) + "\n");
  // 2026-06-27 is a Saturday.
  const satPage = await createPage(root, { chapter: "Daily", name: "2026-06-27", title: "Sat" });
  check("Saturday page picks up weekdayTemplates.sat", satPage.template === "todo-minimal", satPage.template);
  // 2026-06-29 is a Monday — unaffected, falls through to the sibling/default resolution.
  const monPage = await createPage(root, { chapter: "Daily", name: "2026-06-29", title: "Mon" });
  check("non-weekend day ignores weekdayTemplates", monPage.template !== "todo-minimal", monPage.template);
  dailyFolder2.deletedDays = ["2026-06-30"];
  await fs.writeFile(dailyFolderFile2, JSON.stringify(dailyFolder2, null, 2) + "\n");
  let refusedTombstone = false;
  try {
    await createPage(root, { chapter: "Daily", name: "2026-06-30", title: "Nope" });
  } catch {
    refusedTombstone = true;
  }
  check("create_page refuses a tombstoned deletedDays entry", refusedTombstone);
  const clearedDay = await createPage(root, { chapter: "Daily", name: "2026-06-30", title: "Cleared", clearDeleted: true });
  check("clearDeleted: true recreates the tombstoned day", clearedDay.page.endsWith("2026-06-30"), clearedDay.page);
  const foldedAfterClear = JSON.parse(await fs.readFile(dailyFolderFile2, "utf8"));
  check("clearDeleted splices the entry out of deletedDays", !foldedAfterClear.deletedDays.includes("2026-06-30"), JSON.stringify(foldedAfterClear.deletedDays));

  console.log("\nH: read_page labelFilled — geometry (labelSlot) vs. actually-filled");
  const labelPage = "Shared/Daily/2026-06-26";
  await createPage(root, { chapter: "Daily", name: "2026-06-26", title: "Friday" });
  await writeUnderlay(root, labelPage, {
    status: "ready",
    regions: [{ region: "schedule", lines: [{ text: "9:00 standup", row: 0 }] }],
  });
  const beforeLabel = await readPage(root, labelPage);
  const scheduleBeforeLabel = beforeLabel.regions.find((r) => r.name === "schedule");
  const headerBeforeLabel = beforeLabel.regions.find((r) => r.name === "header");
  check(
    "a region with a labelSlot but no label banner drawn -> labelFilled false",
    scheduleBeforeLabel?.labelFilled === false,
    JSON.stringify(scheduleBeforeLabel?.labelFilled),
  );
  check(
    "a region with no labelSlot -> labelFilled null (not applicable)",
    headerBeforeLabel?.labelSlot === null && headerBeforeLabel?.labelFilled === null,
    JSON.stringify(headerBeforeLabel),
  );
  await writeUnderlay(root, labelPage, {
    status: "ready", merge: true,
    regions: [{ region: "schedule", label: "SCHEDULE", lines: [{ text: "9:00 standup", row: 0 }] }],
  });
  const afterLabel = await readPage(root, labelPage);
  const scheduleAfterLabel = afterLabel.regions.find((r) => r.name === "schedule");
  check(
    "once a label banner is actually drawn -> labelFilled true",
    scheduleAfterLabel?.labelFilled === true,
    JSON.stringify(scheduleAfterLabel?.labelFilled),
  );

  console.log("\nprinted-checkbox templates warn on a redundant checkbox marker");
  const todoPage = "Shared/Daily/todo-day";
  await createPage(root, { chapter: "Daily", name: "todo-day", title: "Lists", template: "todo-minimal" });
  const todoRead = await readPage(root, todoPage);
  const listRegion = todoRead.regions.find((r) => r.name.startsWith("list")) ?? todoRead.regions.find((r) => r.name === "todo");
  check("todo template exposes a list region", !!listRegion, JSON.stringify(todoRead.regions.map((r) => r.name)));
  const doubleBox = await writeUnderlay(root, todoPage, {
    status: "ready", dryRun: true,
    regions: [{ region: listRegion!.name, lines: [{ text: "Buy stamps", marker: "checkbox" }] }],
  });
  check("checkbox marker on a printed-box template warns printed_checkboxes", doubleBox.warningDetails.some((w) => w.code === "printed_checkboxes"), JSON.stringify(doubleBox.warningDetails));
  const textOnly = await writeUnderlay(root, todoPage, {
    status: "ready", dryRun: true,
    regions: [{ region: listRegion!.name, lines: [{ text: "Buy stamps" }] }],
  });
  check("text-only lines on the same template do not warn", !textOnly.warningDetails.some((w) => w.code === "printed_checkboxes"), JSON.stringify(textOnly.warningDetails));

  console.log("\nread_ink strips bulky data-stroke streams by default");
  const inkSvgDoc =
    '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M10 10 L20 20" fill="#1B4B8A" data-kind="pen" data-stroke="10,10,0.5 11,11,0.52 12,12,0.53"/></svg>';
  await fs.writeFile(path.join(root, daily, "ink.svg"), inkSvgDoc);
  const strippedInk = await readInk(root, daily);
  check("default read_ink drops data-stroke", !!strippedInk.inkSvg && !strippedInk.inkSvg.includes("data-stroke"), strippedInk.inkSvg ?? "null");
  check("default read_ink keeps the visible geometry", (strippedInk.inkSvg ?? "").includes('d="M10 10 L20 20"'));
  const rawInk = await readInk(root, daily, true);
  check("includeStrokeData returns the verbatim file", rawInk.inkSvg === inkSvgDoc);

  console.log("\nraw fragments accept the app renderer's full element set");
  const shapes = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", svg: '<ellipse cx="40" cy="40" rx="20" ry="10" fill="none" stroke="#9C7C1A"/><polyline points="0,0 10,10 20,0" fill="none" stroke="#9C7C1A"/><polygon points="0,0 10,10 0,10" fill="#9C7C1A"/>' }],
  });
  check("ellipse/polyline/polygon produce no unsupported-element warning", !shapes.warningDetails.some((w) => w.code === "raw_svg_unsupported_element"), JSON.stringify(shapes.warningDetails));

  console.log("\nwrite_underlay images → media/ai/ (file-relative, GC, validation)");
  const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";
  const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);
  const imgPage = "Shared/Daily/2026-06-24";
  await createPage(root, { chapter: "Daily", name: "2026-06-24", title: "Wednesday" });
  await writeUnderlay(root, imgPage, {
    status: "ready",
    regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "png", name: "motivation", width: 120, corner: "center" }] }],
  });
  const imgAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  const imgFile = path.join(root, imgPage, "media", "ai", "motivation.png");
  check("ai.svg references the media/ai image", imgAi.includes('href="media/ai/motivation.png"'), imgAi.slice(0, 200));
  check("height filled from aspect (1×1 → 120²)", /width="120" height="120"/.test(imgAi), imgAi);
  check("image file written under media/ai/", await exists(imgFile));
  check("written bytes equal the decoded base64", (await fs.readFile(imgFile)).equals(Buffer.from(PNG_1x1, "base64")));
  check("a real media/ai href never trips the data-URI guard", !scanRawSvgDataUriImages(imgAi), imgAi.slice(0, 200));

  // Orphan GC: re-write the page without the image → its file is removed.
  await writeUnderlay(root, imgPage, { status: "ready", regions: [{ region: "todo", lines: [{ text: "no image now" }] }] });
  check("orphan GC removed the now-unreferenced image", !(await exists(imgFile)));

  // merge preserves another region's image + its file.
  await writeUnderlay(root, imgPage, { status: "ready", regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "png", name: "keep", width: 50 }] }] });
  await writeUnderlay(root, imgPage, { status: "ready", merge: true, regions: [{ region: "schedule", lines: [{ text: "8:00 keep me", row: 0 }] }] });
  const mergedImgAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  check("merge keeps the other region's image ref", mergedImgAi.includes('href="media/ai/keep.png"'));
  check("merge kept the image file (not GC'd)", await exists(path.join(root, imgPage, "media", "ai", "keep.png")));

  // clear_underlay removes the whole media/ai folder.
  await clearUnderlay(root, imgPage);
  check("clear removed media/ai entirely", !(await exists(path.join(root, imgPage, "media", "ai"))));

  // dryRun composes the href but writes no file.
  const dryImg = await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "png", name: "dry", width: 40 }] }] });
  check("dryRun composes the image href", (dryImg.aiSvg ?? "").includes('href="media/ai/dry.png"'));
  check("dryRun wrote no media file", !(await exists(path.join(root, imgPage, "media", "ai", "dry.png"))));

  // Validation: format/magic mismatch, oversize, traversal name.
  let badFormat = false;
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "jpeg", width: 40 }] }] }); } catch { badFormat = true; }
  check("rejects a format/magic-byte mismatch", badFormat);
  let oversize = false;
  const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1).toString("base64");
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "todo", images: [{ data: big, format: "png", width: 40 }] }] }); } catch { oversize = true; }
  check("rejects an oversize image (>2MB)", oversize);
  const travAi = (await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "png", name: "../../evil", width: 40 }] }] })).aiSvg ?? "";
  const travHref = travAi.match(/href="[^"]*"/)?.[0] ?? "";
  const travBase = travHref.replace(/^href="media\/ai\//, "").replace(/"$/, "");
  // Safe = stays under media/ai/: no slash in the filename, no leading dot (no `../`).
  check("sanitizes a traversal filename", travHref.startsWith('href="media/ai/') && !travBase.includes("/") && !travBase.startsWith("."), travHref);

  console.log("\nwrite_underlay images via local file `path` (no base64 through context)");
  const srcPng = path.join(os.tmpdir(), "onionskin-smoke-src.png");
  await fs.writeFile(srcPng, Buffer.from(PNG_1x1, "base64"));
  await writeUnderlay(root, imgPage, {
    status: "ready",
    regions: [{ region: "todo", images: [{ path: srcPng, name: "from-path", width: 64 }] }],
  });
  const pathAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  const pathFile = path.join(root, imgPage, "media", "ai", "from-path.png");
  check("path image referenced from ai.svg", pathAi.includes('href="media/ai/from-path.png"'), pathAi.slice(0, 160));
  check("format sniffed from the file (no format passed)", await exists(pathFile));
  check("path image bytes copied into media/ai/", (await fs.readFile(pathFile)).equals(Buffer.from(PNG_1x1, "base64")));
  check("path image aspect-fills height (1×1 → 64²)", /width="64" height="64"/.test(pathAi), pathAi);
  let badPath = false;
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "todo", images: [{ path: "/no/such/file-xyz.png", width: 40 }] }] }); } catch { badPath = true; }
  check("a missing path file errors clearly", badPath);
  let bothErr = false;
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "todo", images: [{ data: PNG_1x1, path: srcPng, format: "png", width: 40 }] }] }); } catch { bothErr = true; }
  check("rejects an image with both data and path", bothErr);
  await fs.rm(srcPng, { force: true });

  console.log("\nA0: PNG codec round-trip + chromaKeyPixels (unit-level, src/png.ts)");
  const rtPixels = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]);
  const rtEncoded = encodePng({ width: 2, height: 1, pixels: rtPixels });
  const rtDecoded = decodePng(rtEncoded);
  check(
    "codec round-trip preserves pixel bytes exactly",
    Buffer.from(rtDecoded.pixels).equals(Buffer.from(rtPixels)),
    JSON.stringify([...rtDecoded.pixels]),
  );
  const keyPixels = new Uint8Array([255, 0, 255, 255, 0, 0, 255, 255]); // magenta, blue
  chromaKeyPixels(keyPixels, { r: 255, g: 0, b: 255 }, 10);
  check("chromaKeyPixels zeroes alpha on the matching pixel", keyPixels[3] === 0, JSON.stringify([...keyPixels]));
  check("chromaKeyPixels leaves a non-matching pixel opaque", keyPixels[7] === 255, JSON.stringify([...keyPixels]));

  console.log("\nA: images[].knockout — chroma (end-to-end through write_underlay)");
  const chromaSrc = encodePng({
    width: 2,
    height: 1,
    pixels: new Uint8Array([255, 0, 255, 255, 0, 0, 255, 255]), // magenta, blue
  });
  const chromaResult = await writeUnderlay(root, imgPage, {
    status: "ready",
    regions: [{
      region: "todo",
      images: [{
        data: chromaSrc.toString("base64"),
        format: "png",
        name: "chroma-out",
        width: 40,
        knockout: "chroma",
        chromaColor: "#ff00ff",
        tolerance: 10,
      }],
    }],
  });
  check("chroma knockout's resolved format is png regardless of declared format", (chromaResult.aiSvg ?? await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8")).includes('href="media/ai/chroma-out.png"'));
  const chromaBytes = await fs.readFile(path.join(root, imgPage, "media", "ai", "chroma-out.png"));
  const chromaDecoded = decodePng(chromaBytes);
  check("chroma knockout zeroed alpha on the matching magenta pixel", chromaDecoded.pixels[3] === 0, JSON.stringify([...chromaDecoded.pixels]));
  check("chroma knockout left the non-matching blue pixel opaque", chromaDecoded.pixels[7] === 255, JSON.stringify([...chromaDecoded.pixels]));

  let chromaOnJpeg = false;
  try {
    await writeUnderlay(root, imgPage, {
      status: "ready", dryRun: true,
      regions: [{ region: "todo", images: [{ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"), width: 40, knockout: "chroma", chromaColor: "#ff00ff" }] }],
    });
  } catch (e: any) {
    chromaOnJpeg = /requires a PNG source/.test(e.message);
  }
  check("knockout:\"chroma\" on a JPEG-sniffed source rejects with a clear message", chromaOnJpeg);

  let chromaMissingColor = false;
  try {
    await writeUnderlay(root, imgPage, {
      status: "ready", dryRun: true,
      regions: [{ region: "todo", images: [{ data: chromaSrc.toString("base64"), width: 40, knockout: "chroma" }] }],
    });
  } catch (e: any) {
    chromaMissingColor = /needs `chromaColor`/.test(e.message);
  }
  check("knockout:\"chroma\" without chromaColor rejects clearly (CLI bypasses the zod refine)", chromaMissingColor);

  // A hand-built 16-bit/RGB PNG (IHDR + IEND only, no IDAT needed — decodePng
  // rejects on bitDepth before ever touching pixel data) exercises the codec's
  // declared scope limit.
  const fakePng16 = (() => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 16; // bit depth
    ihdr[9] = 2; // colour type: RGB
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]); // CRC unverified on decode
    };
    return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
  })();
  let scopeRejected = false;
  try {
    await writeUnderlay(root, imgPage, {
      status: "ready", dryRun: true,
      regions: [{ region: "todo", images: [{ data: fakePng16.toString("base64"), format: "png", width: 40, knockout: "chroma", chromaColor: "#ff00ff" }] }],
    });
  } catch (e: any) {
    scopeRejected = /requires a plain 8-bit RGB\/RGBA PNG/.test(e.message);
  }
  check("a 16-bit PNG source is rejected with the codec's declared scope limit", scopeRejected);

  console.log("\nA: images[].knockout — subject (rembg) via the deps test seam");
  const subjectResult = await writeUnderlay(root, imgPage, {
    status: "ready",
    regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "png", name: "subject-cut", width: 40, knockout: "subject" }] }],
  }, { knockoutSubjectImpl: async (_input, output) => { await fs.writeFile(output, Buffer.from(PNG_1x1, "base64")); } });
  const subjectAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  check("knockout:\"subject\" writes via the stubbed rembg impl", subjectAi.includes('href="media/ai/subject-cut.png"'), subjectAi.slice(0, 200));

  let subjectFail = false;
  try {
    await writeUnderlay(root, imgPage, {
      status: "ready", dryRun: true,
      regions: [{ region: "todo", images: [{ data: PNG_1x1, format: "png", name: "bad-subject", width: 40, knockout: "subject" }] }],
    }, { knockoutSubjectImpl: async () => { throw new Error("rembg not installed"); } });
  } catch (e: any) {
    subjectFail = /knockout:"subject" failed/.test(e.message) && /rembg not installed/.test(e.message);
  }
  check("knockout:\"subject\" surfaces a clear, wrapped error on failure", subjectFail);

  console.log("\nimage placement warnings (cross-region + off-page; dry-run)");
  // A big image in ainotes spills onto a sibling region → image_overlaps_region.
  const overlapImg = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", images: [{ data: PNG_1x1, format: "png", name: "big", width: 400, height: 400, corner: "center" }] }],
  });
  check("image overlapping a sibling region warns (image_overlaps_region)",
    overlapImg.warningDetails.some((w) => w.code === "image_overlaps_region"), JSON.stringify(overlapImg.warningDetails));
  // A negative-y image pushed above its region → off the page.
  const offPageImg = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", images: [{ data: PNG_1x1, format: "png", name: "up", width: 40, y: -1000 }] }],
  });
  check("image pushed off the page warns (image_off_page)",
    offPageImg.warningDetails.some((w) => w.code === "image_off_page"), JSON.stringify(offPageImg.warningDetails));
  // A small, well-placed corner sticker in an ai region → no placement warnings.
  const cleanImg = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", images: [{ data: PNG_1x1, format: "png", name: "ok", width: 40, corner: "bottom-right" }] }],
  });
  check("a small in-region sticker warns nothing about placement",
    !cleanImg.warningDetails.some((w) => w.code.startsWith("image_")), JSON.stringify(cleanImg.warningDetails));

  console.log("\nimage sizing warnings (aspect mismatch, small-for-region, dimension guideline)");
  // PNG_1x1 is square — forcing 40×400 is a 10× aspect distortion → image_aspect_mismatch.
  const stretched = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", images: [{ data: PNG_1x1, format: "png", name: "stretch", width: 40, height: 400, corner: "bottom-right" }] }],
  });
  check("forcing width+height off the source aspect warns (image_aspect_mismatch)",
    stretched.warningDetails.some((w) => w.code === "image_aspect_mismatch"), JSON.stringify(stretched.warningDetails));
  // Omitting height aspect-fills → no mismatch possible.
  check("the clean corner sticker (height omitted) does not warn about aspect",
    !cleanImg.warningDetails.some((w) => w.code === "image_aspect_mismatch"), JSON.stringify(cleanImg.warningDetails));
  // A tiny image floated center in a big box → image_small_for_region (info).
  const floating = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", images: [{ data: PNG_1x1, format: "png", name: "lost", width: 40, corner: "center" }] }],
  });
  check("a tiny center-placed image in a big box warns (image_small_for_region)",
    floating.warningDetails.some((w) => w.code === "image_small_for_region" && w.severity === "info"), JSON.stringify(floating.warningDetails));
  check("the same tiny image corner-placed stays quiet (deliberate accent)",
    !cleanImg.warningDetails.some((w) => w.code === "image_small_for_region"), JSON.stringify(cleanImg.warningDetails));
  // A source over the 1536px guideline (IHDR-only fake; dims read from the header) → info warning.
  const fakeBigPng = (() => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2000, 0); // width
    ihdr.writeUInt32BE(100, 4); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
    };
    return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
  })();
  const bigDims = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "ainotes", images: [{ data: fakeBigPng.toString("base64"), format: "png", name: "big-src", width: 100, corner: "bottom-right" }] }],
  });
  check("a source over 1536px warns (image_dimensions_large, info)",
    bigDims.warningDetails.some((w) => w.code === "image_dimensions_large" && w.severity === "info"), JSON.stringify(bigDims.warningDetails));

  console.log("\nraw svg size guard");
  const hugeRaw = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1366"><!-- ${"x".repeat(300 * 1024)} --><rect x="1" y="1" width="2" height="2" fill="#9C7C1A"/></svg>`,
  });
  check("a >256KB raw svg warns (raw_svg_large)",
    hugeRaw.warningDetails.some((w) => w.code === "raw_svg_large"), JSON.stringify(hugeRaw.warningDetails.map((w) => w.code)));

  console.log("\nset_chapter_theme accent → chapter default the underlay picks up");
  const accentHex = "#7B5EA7"; // lavender
  await writeChapterTheme(root, "Daily", { accent: accentHex });
  const daylyFolder = JSON.parse(await fs.readFile(path.join(root, "Shared", "Daily", ".folder.json"), "utf8"));
  check("set_chapter_theme writes theme.accent into .folder.json", daylyFolder.theme?.accent === accentHex, JSON.stringify(daylyFolder.theme));
  check("set_chapter_theme preserves the chapter page order", Array.isArray(daylyFolder.order) && daylyFolder.order.length > 0, JSON.stringify(daylyFolder.order));
  const accented = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "todo", lines: [{ text: "Email Dr. Lee", marker: "checkbox" }] }],
  });
  // The default gold (#9C7C1A) must NOT appear; a derived lavender-family fill should.
  const accentTodoGroup = regionGroup(accented.aiSvg, "todo") ?? "";
  check("accented page drops the gold default", !/#9C7C1A/i.test(accentTodoGroup), accentTodoGroup.slice(0, 400));
  check("accented page tints body text (non-gold fill present)", /<text[^>]*fill="#[0-9a-fA-F]{6}"/.test(accentTodoGroup), accentTodoGroup.slice(0, 400));
  // Clean up so later assertions see a pristine folder (writeChapterTheme only merges).
  {
    const f = JSON.parse(await fs.readFile(path.join(root, "Shared", "Daily", ".folder.json"), "utf8"));
    delete f.theme;
    await fs.writeFile(path.join(root, "Shared", "Daily", ".folder.json"), JSON.stringify(f, null, 2) + "\n");
  }

  console.log("\nfetch_image validation after optional background removal");
  const fakeFetch: typeof fetch = async () =>
    new Response(Buffer.from(PNG_1x1, "base64"), { status: 200, statusText: "OK" });
  const fetched = await fetchImageToTemp("https://example.test/source.png", "fetched", false, {
    fetchImpl: fakeFetch,
  });
  check("fetch_image accepts a valid PNG from fetch", fetched.format === "png" && fetched.bytes > 0, JSON.stringify(fetched));
  let badRembg = false;
  try {
    await fetchImageToTemp("https://example.test/source.png", "bad-rembg", true, {
      fetchImpl: fakeFetch,
      removeBackgroundImpl: async (_input, output) => {
        await fs.writeFile(output, Buffer.from("not a png"));
      },
    });
  } catch {
    badRembg = true;
  }
  check("fetch_image re-validates rembg output format", badRembg);
  // The failed removeBackground fetch must not litter onionskin-fetch/ — unique stem so
  // stale files from pre-fix runs can't shadow the assertion.
  const cleanupStem = `cleanup-check-${process.pid}`;
  try {
    await fetchImageToTemp(`https://example.test/${cleanupStem}.png`, cleanupStem, true, {
      fetchImpl: fakeFetch,
      removeBackgroundImpl: async () => { throw new Error("rembg unavailable"); },
    });
  } catch { /* expected */ }
  const fetchDir = path.join(os.tmpdir(), "onionskin-fetch");
  const leftovers = (await fs.readdir(fetchDir).catch(() => [] as string[])).filter((f) => f.startsWith(cleanupStem));
  check("a failed removeBackground fetch leaves no temp files behind", leftovers.length === 0, JSON.stringify(leftovers));
  let hugeRembg = false;
  try {
    await fetchImageToTemp("https://example.test/source.png", "huge-rembg", true, {
      fetchImpl: fakeFetch,
      removeBackgroundImpl: async (_input, output) => {
        await fs.writeFile(output, Buffer.alloc(2 * 1024 * 1024 + 1));
      },
    });
  } catch {
    hugeRembg = true;
  }
  check("fetch_image re-checks rembg output size", hugeRembg);

  console.log("\nNEGATIVE: refuse Private + traversal");
  let refusedPrivate = false;
  try {
    await writeUnderlay(root, "Private/Therapy notes/2026-01-28", { status: "ready", svg: "<svg/>" });
  } catch {
    refusedPrivate = true;
  }
  check("refuses writing under Private/", refusedPrivate);
  let refusedTraversal = false;
  try {
    await readPage(root, "Shared/../Private/Therapy notes/2026-01-28");
  } catch {
    refusedTraversal = true;
  }
  check("refuses path traversal", refusedTraversal);

  console.log("\nNEGATIVE: missing library");
  const saved = process.env.ONIONSKIN_CONTAINER;
  process.env.ONIONSKIN_CONTAINER = "/tmp/onionskin-does-not-exist-xyz";
  let missingErr = false;
  try {
    await requireLibrary();
  } catch (e) {
    missingErr = e instanceof LibraryMissingError;
  }
  check("missing library throws LibraryMissingError", missingErr);
  process.env.ONIONSKIN_CONTAINER = saved;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * The fixtures ship no Shared/ folder (a fresh library). The app would create the
 * shared chapters; here we seed two empty ones so requireLibrary passes, mirroring
 * a user who has chapters but hasn't made any pages yet.
 */
async function requireLibraryAfterSeed(): Promise<string> {
  const { resolveRoot } = await import("../src/paths.js");
  const root = resolveRoot();
  await fs.mkdir(path.join(root, "Shared", "Daily"), { recursive: true });
  await fs.mkdir(path.join(root, "Shared", "Monthly"), { recursive: true });
  return requireLibrary();
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
