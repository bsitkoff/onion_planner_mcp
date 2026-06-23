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
import {
  requireLibrary,
  listChapters,
  listPages,
  listPageRows,
  LibraryMissingError,
} from "../src/library.js";
import {
  readPage,
  writeUnderlay,
  setStatus,
  clearUnderlay,
  createPage,
} from "../src/page.js";
import { GOLD, resolveTheme } from "../src/svg.js";
import { hexToHsl } from "../src/color.js";
import { inspectTemplate } from "../src/template.js";

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

/** Extract the verbatim `<g data-region="NAME">…</g>` block from an ai.svg. */
function regionGroup(svg: string, name: string): string | null {
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
  const quote = read.regions.find((r) => r.name === "quote");
  const todo = read.regions.find((r) => r.name === "todo");
  check("size is 1024x1366", read.size[0] === 1024 && read.size[1] === 1366, JSON.stringify(read.size));
  check("schedule region parsed with ruled lines", (schedule?.ruledLines.length ?? 0) >= 8, String(schedule?.ruledLines.length));
  check("quote region parsed (no-ruled box)", !!quote && quote.ruledLines.length === 0, String(quote?.ruledLines.length));
  check("todo region parsed", !!todo);
  // Template inspection: minimal is a bare scaffold (go full); cozy is styled (fill quietly).
  check("template info: minimal is not styled", read.template.styled === false && !read.template.hasLabels && read.template.palette.length === 0, JSON.stringify(read.template));
  const cozyInfo = inspectTemplate(await fs.readFile(path.join(root, "Templates", "daily-cozy", "template.svg"), "utf8"));
  check("template info: cozy is styled with its own banners", cozyInfo.styled && cozyInfo.hasBanners && cozyInfo.hasLabels, JSON.stringify(cozyInfo));
  check("template info: cozy palette is non-empty and non-neutral", cozyInfo.palette.length > 0 && cozyInfo.palette.every((h) => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(cozyInfo.palette));

  console.log("\nwrite_underlay (structured: schedule rows + checkbox to-dos + quote)");
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
      { region: "quote", lines: [{ text: "Small steps still move forward." }] },
    ],
  });
  const aiPath = path.join(root, daily, "ai.svg");
  const ai = await fs.readFile(aiPath, "utf8");
  check("ai.svg contains schedule text", ai.includes("9:00 standup"));
  check("ai.svg uses gold fill", ai.includes(GOLD));
  check("ai.svg sets a heavier font-weight", ai.includes('font-weight="600"'));
  check("ai.svg groups by region", ai.includes('data-region="schedule"') && ai.includes('data-region="todo"'));
  check("quote uses Newsreader (region default still applies)", regionGroup(ai, "quote")?.includes("Newsreader") ?? false);
  check("write reported warnings array", Array.isArray(wr.warnings));
  check("write was not a dry run", wr.dryRun === false);
  // checkbox marker: a gold stroked <rect> inside the todo group, before its text.
  const todoGroup = regionGroup(ai, "todo") ?? "";
  check("to-do lines draw a gold checkbox", new RegExp(`<rect[^>]*stroke="${GOLD}"`).test(todoGroup), todoGroup.slice(0, 120));
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

  console.log("\ntime-aware schedule (time → nearest ruled row; dry-run)");
  const yOf = (svg: string, needle: string) =>
    Number((svg.split("\n").find((l) => l.includes(needle)) ?? "").match(/y="(\d+)"/)?.[1] ?? -1);
  // startHour 8, rowsPerHour 1: "11:00" → row 3. Reuse the geometry-derived slots (rl).
  const timed = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", startHour: 8, lines: [{ text: "11:00 mtg", time: "11:00" }] }],
  });
  const ty = yOf(timed.aiSvg, "11:00 mtg");
  const er = 3;
  check("time 11:00 (startHour 8) lands in the row-3 slot", ty > rl[er] && ty < (rl[er + 1] ?? rl[er] + 58), `y=${ty} expected in (${rl[er]}, ${rl[er + 1]})`);
  // rowsPerHour 2: 09:30 sits one ruled row below 09:00.
  const half = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", startHour: 9, rowsPerHour: 2, lines: [
      { text: "nine", time: "09:00" }, { text: "ninethirty", time: "09:30" },
    ] }],
  });
  check("rowsPerHour=2 puts 09:30 one row below 09:00", yOf(half.aiSvg, ">ninethirty</text>") > yOf(half.aiSvg, ">nine</text>"), `${yOf(half.aiSvg, ">nine</text>")} -> ${yOf(half.aiSvg, ">ninethirty</text>")}`);
  // No startHour: time is ignored (warns), but the page still composes.
  const noAnchor = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "schedule", lines: [{ text: "floating", time: "10:00" }] }],
  });
  check("time without startHour warns", noAnchor.warnings.some((w) => w.includes("startHour")), JSON.stringify(noAnchor.warnings));
  check("time without startHour still composes", noAnchor.aiSvg.includes(">floating</text>"));
  // Malformed time is rejected.
  let badTime = false;
  try {
    await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "schedule", startHour: 8, lines: [{ text: "x", time: "9am" }] }] });
  } catch { badTime = true; }
  check("rejects malformed time string", badTime);

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
  // The neutral `notes` box (no ruled lines) is where the AI draws day-specific
  // structure: section headings + their items, only when a day needs them.
  const sectioned = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true,
    regions: [{ region: "notes", lines: [
      { text: "Important", heading: true },
      { text: "Leona planner check", marker: "bullet" },
      { text: "VEX order", marker: "bullet" },
      { text: "Tomorrow", heading: true },
      { text: "Prep slides", marker: "checkbox" },
      { text: "Habits", heading: true },
      { text: "Walk", marker: "checkbox" },
    ] }],
  });
  const notesGroup = regionGroup(sectioned.aiSvg, "notes") ?? "";
  check("heading text is letter-spaced", notesGroup.includes('letter-spacing="0.08em"'), notesGroup.slice(0, 160));
  const headingRules = [...notesGroup.matchAll(new RegExp(`<line[^>]*stroke="${GOLD}"[^>]*opacity="0.4"`, "g"))].length;
  check("each of the 3 headings draws a hairline rule", headingRules === 3, `rules=${headingRules}`);
  // Flow order: headings and their items stack top-down in the order given.
  const yImp = yOf(sectioned.aiSvg, ">Important</text>");
  const yLeona = yOf(sectioned.aiSvg, ">Leona planner check</text>");
  const yVex = yOf(sectioned.aiSvg, ">VEX order</text>");
  const yTom = yOf(sectioned.aiSvg, ">Tomorrow</text>");
  const yHab = yOf(sectioned.aiSvg, ">Habits</text>");
  check("sections flow top-down in order", yImp < yLeona && yLeona < yTom && yTom < yHab, `${yImp} < ${yLeona} < ${yTom} < ${yHab}`);
  check("a heading takes more vertical room than a body item", yLeona - yImp > yVex - yLeona, `heading advance=${yLeona - yImp}, item advance=${yVex - yLeona}`);

  console.log("\nthemed output (colored banners + accents; dry-run)");
  const themed = await writeUnderlay(root, daily, {
    status: "ready", dryRun: true, theme: "bright",
    regions: [{ region: "notes", lines: [
      { text: "IMPORTANT", heading: true },
      { text: "Renew parking pass", marker: "checkbox" },
      { text: "TOMORROW", heading: true },
      { text: "Dentist 9am", marker: "bullet" },
    ] }],
  });
  const tg = regionGroup(themed.aiSvg, "notes") ?? "";
  check("banner heading draws a filled colored rect", /<rect[^>]*fill="#3FB6A8"/.test(tg) || /<rect[^>]*fill="#F2884B"/.test(tg), tg.slice(0, 200));
  check("two banners use two different cycled colors", new Set([...tg.matchAll(/<rect[^>]*rx="6" fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1])).size === 2, tg);
  check("banner label is white, not gold", tg.includes('fill="#FFFFFF"') && !tg.includes(GOLD), tg.slice(0, 240));
  check("themed body text uses theme ink, not gold", tg.includes('fill="#3A3A3A"'), tg);
  // The gold default is unchanged (back-compat): headings stay underline+rule.
  const goldHead = regionGroup((await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "notes", lines: [{ text: "Plain", heading: true }] }] })).aiSvg, "notes") ?? "";
  check("default (no theme) keeps the gold underline heading", goldHead.includes(`stroke="${GOLD}"`) && !/<rect[^>]*rx="6"/.test(goldHead), goldHead);

  console.log("\nadaptive theme contract (harmony / variety / fontPersonality)");
  // No knobs → the gold default (back-compat for the resolver itself).
  check("resolveTheme({}) is the gold default", resolveTheme({}).theme.text === GOLD);
  // harmony=match derives banners FROM the template palette, not a fixed preset.
  const pal = ["#E2825E", "#8FA98A", "#88B0D4"];
  const matched = resolveTheme({ harmony: "match", varietyDial: 0.9, templatePalette: pal });
  check("harmony=match derives multiple banners from the template palette", matched.theme.banners.length >= 2 && matched.theme.banners.every((h) => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(matched.theme.banners));
  check("high variety → banner-pill headings", matched.theme.headingStyle === "banner");
  check("low variety → quiet underline headings", resolveTheme({ harmony: "match", varietyDial: 0.1, templatePalette: pal }).theme.headingStyle === "underline");
  // Legibility floor: derived BODY text is dark enough to read on cream (solved at
  // derivation, not warned at runtime — even from a pale template swatch).
  const pale = resolveTheme({ harmony: "match", templatePalette: ["#F2B8CC"] });
  check("derived body text is floored dark (legible on cream)", hexToHsl(pale.theme.text).l <= 0.36, `${pale.theme.text} (L=${hexToHsl(pale.theme.text).l.toFixed(2)})`);
  // Empty palette while harmonising → sticker-palette fallback + a note.
  check("adaptive with no template palette warns about the fallback", resolveTheme({ harmony: "complement", templatePalette: [] }).warnings.some((w) => w.includes("sticker palette")));
  // fontPersonality is an orthogonal axis: it swaps fonts but NOT the gold palette.
  const hand = resolveTheme({ fontPersonality: "handwritten" });
  check("fontPersonality=handwritten sets Caveat body / keeps gold palette", hand.theme.fonts?.body === "Caveat" && hand.theme.text === GOLD, JSON.stringify(hand.theme.fonts));
  // End-to-end: fontPersonality flows into the composed text.
  const written = await writeUnderlay(root, daily, { status: "ready", dryRun: true, fontPersonality: "handwritten", regions: [{ region: "notes", lines: [{ text: "buy milk" }] }] });
  check("fontPersonality reaches the composed ai.svg (Caveat body text)", (regionGroup(written.aiSvg, "notes") ?? "").includes('font-family="Caveat"'), regionGroup(written.aiSvg, "notes") ?? "");

  console.log("\nchapter .folder.json theme is read as the default (overridable per call)");
  const dailyFolder = path.join(root, "Shared", "Daily", ".folder.json");
  const folderJson = JSON.parse(await fs.readFile(dailyFolder, "utf8").catch(() => "{}"));
  folderJson.theme = { harmony: "match", varietyDial: 0.9, fontPersonality: "handwritten" };
  await fs.writeFile(dailyFolder, JSON.stringify(folderJson, null, 2) + "\n");
  const fromChapter = await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "notes", lines: [{ text: "Plan", heading: true }, { text: "milk" }] }] });
  const fcg = regionGroup(fromChapter.aiSvg, "notes") ?? "";
  check("read_page surfaces the chapter theme", (await readPage(root, daily)).theme?.fontPersonality === "handwritten");
  check("chapter theme applies with no per-call params (handwritten heading font)", fcg.includes('font-family="Fredoka"'), fcg.slice(0, 200));
  check("chapter high-variety gives banner-pill headings", /<rect[^>]*rx="6"/.test(fcg), fcg.slice(0, 200));
  // Per-call preset overrides the chapter's adaptive default.
  const overridden = regionGroup((await writeUnderlay(root, daily, { status: "ready", dryRun: true, theme: "gold", regions: [{ region: "notes", lines: [{ text: "Plain", heading: true }] }] })).aiSvg, "notes") ?? "";
  check("per-call theme:gold overrides the chapter's adaptive theme", overridden.includes(`stroke="${GOLD}"`) && !/<rect[^>]*rx="6"/.test(overridden), overridden.slice(0, 200));
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
  // No label, default theme → no banner emitted (back-compat).
  const noLabel = regionGroup((await writeUnderlay(root, daily, { status: "ready", dryRun: true, regions: [{ region: "schedule", lines: [{ text: "x", row: 0 }] }] })).aiSvg, "schedule") ?? "";
  check("no label → no banner rect", !/<rect[^>]*rx="6"/.test(noLabel), noLabel);

  console.log("\noverflow warnings (dry-run, no write)");
  const longText = "This is an absurdly long line of text that cannot possibly fit the box".repeat(1);
  const overflow = await writeUnderlay(root, daily, {
    status: "ready",
    dryRun: true,
    regions: [{ region: "priorities", lines: [
      { text: longText },
      { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }, { text: "f" },
    ]}],
  });
  check("warns about likely overflow", overflow.warnings.some((w) => w.includes("overflow")), JSON.stringify(overflow.warnings));
  check("warns about more lines than ruled rows", overflow.warnings.some((w) => w.includes("ruled rows")), JSON.stringify(overflow.warnings));

  console.log("\ndry-run writes nothing to disk");
  const diskBefore = await fs.readFile(aiPath, "utf8");
  const dry = await writeUnderlay(root, daily, {
    status: "empty",
    dryRun: true,
    regions: [{ region: "notes", lines: [{ text: "DRY_RUN_SENTINEL" }] }],
  });
  const diskAfter = await fs.readFile(aiPath, "utf8");
  check("dry run returns composed svg", dry.aiSvg.includes("DRY_RUN_SENTINEL") && dry.dryRun === true);
  check("dry run left ai.svg unchanged", diskAfter === diskBefore);
  check("dry run did NOT flip status", JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8")).layers.ai.status === "ready");

  console.log("\nmerge preserves untouched regions");
  const scheduleBlock = regionGroup(diskBefore, "schedule");
  const merged = await writeUnderlay(root, daily, {
    status: "ready",
    merge: true,
    regions: [{ region: "notes", lines: [{ text: "Buy milk", marker: "bullet" }] }],
  });
  const aiMerged = await fs.readFile(aiPath, "utf8");
  check("merge adds the new region", aiMerged.includes("Buy milk"));
  check("merge keeps the schedule text", aiMerged.includes("9:00 standup"));
  check("merge keeps the to-dos", aiMerged.includes("Email the registrar"));
  check("merge preserves the schedule group VERBATIM", !!scheduleBlock && aiMerged.includes(scheduleBlock!), "schedule block changed");
  check("merge reported not-dry-run", merged.dryRun === false);

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

  console.log("\nwrite_underlay (raw svg) + reject merge+svg");
  await writeUnderlay(root, daily, {
    status: "ready",
    svg: '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><text x="80" y="80" fill="#9C7C1A">raw</text></svg>',
  });
  check("raw svg written verbatim", (await fs.readFile(aiPath, "utf8")).includes(">raw</text>"));
  let rejectedMergeSvg = false;
  try {
    await writeUnderlay(root, daily, { status: "ready", merge: true, svg: "<svg/>" });
  } catch {
    rejectedMergeSvg = true;
  }
  check("rejects merge with raw svg", rejectedMergeSvg);

  console.log("\nset_underlay_status / clear_underlay");
  await setStatus(root, daily, "refreshing");
  check("status set to refreshing", JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8")).layers.ai.status === "refreshing");
  await clearUnderlay(root, daily);
  const m4 = JSON.parse(await fs.readFile(path.join(root, daily, "manifest.json"), "utf8"));
  check("clear sets status empty", m4.layers.ai.status === "empty");
  check("clear empties ai.svg", !(await fs.readFile(aiPath, "utf8")).includes("<text"));

  console.log("\ncreate_page by cloning a sibling");
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

  console.log("\nlist_pages metadata filters");
  // At this point: Daily/2026-06-22 (daily-minimal, "Monday", status empty after clear),
  // Daily/2026-06-23 (daily-minimal, "Tuesday", ready), Monthly/2026-02 (monthly-minimal,
  // "February", ready). Derive the unfiltered total rather than hard-coding it.
  const allRows = await listPageRows(root);
  const total = allRows.length;
  check("unfiltered lists every page", total >= 3, String(total));
  const byTemplate = await listPageRows(root, { template: "daily-minimal" });
  check("template filter keeps only daily-minimal", byTemplate.length === 2 && byTemplate.every((r) => r.template === "daily-minimal"), JSON.stringify(byTemplate.map((r) => r.page)));
  const ready = await listPageRows(root, { aiStatus: "ready" });
  check("aiStatus=ready excludes the cleared daily", ready.every((r) => r.aiStatus === "ready") && !ready.some((r) => r.page === daily), JSON.stringify(ready.map((r) => r.page)));
  const empty = await listPageRows(root, { aiStatus: "empty" });
  check("aiStatus=empty finds the cleared daily", empty.some((r) => r.page === daily) && empty.every((r) => r.aiStatus === "empty"), JSON.stringify(empty.map((r) => r.page)));
  const titled = await listPageRows(root, { titleContains: "feb" });
  check("titleContains is case-insensitive", titled.length === 1 && titled[0].title === "February", JSON.stringify(titled.map((r) => r.title)));
  const combined = await listPageRows(root, { chapter: "Daily", template: "daily-minimal" });
  check("filters AND together (chapter + template)", combined.length === 2 && combined.every((r) => r.page.startsWith("Shared/Daily/")), JSON.stringify(combined.map((r) => r.page)));
  const beforeFuture = await listPageRows(root, { modifiedBefore: "2999-01-01" });
  check("modifiedBefore far-future keeps all dated pages", beforeFuture.length === total, `${beforeFuture.length}/${total}`);
  const afterFuture = await listPageRows(root, { modifiedAfter: "2999-01-01" });
  check("modifiedAfter far-future excludes everything", afterFuture.length === 0, String(afterFuture.length));

  console.log("\nwrite_underlay images → media/ai/ (file-relative, GC, validation)");
  const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";
  const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);
  const imgPage = "Shared/Daily/2026-06-24";
  await createPage(root, { chapter: "Daily", name: "2026-06-24", title: "Wednesday" });
  await writeUnderlay(root, imgPage, {
    status: "ready",
    regions: [{ region: "notes", images: [{ data: PNG_1x1, format: "png", name: "motivation", width: 120, corner: "center" }] }],
  });
  const imgAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  const imgFile = path.join(root, imgPage, "media", "ai", "motivation.png");
  check("ai.svg references the media/ai image", imgAi.includes('href="media/ai/motivation.png"'), imgAi.slice(0, 200));
  check("height filled from aspect (1×1 → 120²)", /width="120" height="120"/.test(imgAi), imgAi);
  check("image file written under media/ai/", await exists(imgFile));
  check("written bytes equal the decoded base64", (await fs.readFile(imgFile)).equals(Buffer.from(PNG_1x1, "base64")));

  // Orphan GC: re-write the page without the image → its file is removed.
  await writeUnderlay(root, imgPage, { status: "ready", regions: [{ region: "notes", lines: [{ text: "no image now" }] }] });
  check("orphan GC removed the now-unreferenced image", !(await exists(imgFile)));

  // merge preserves another region's image + its file.
  await writeUnderlay(root, imgPage, { status: "ready", regions: [{ region: "notes", images: [{ data: PNG_1x1, format: "png", name: "keep", width: 50 }] }] });
  await writeUnderlay(root, imgPage, { status: "ready", merge: true, regions: [{ region: "schedule", lines: [{ text: "8:00 keep me", row: 0 }] }] });
  const mergedImgAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  check("merge keeps the other region's image ref", mergedImgAi.includes('href="media/ai/keep.png"'));
  check("merge kept the image file (not GC'd)", await exists(path.join(root, imgPage, "media", "ai", "keep.png")));

  // clear_underlay removes the whole media/ai folder.
  await clearUnderlay(root, imgPage);
  check("clear removed media/ai entirely", !(await exists(path.join(root, imgPage, "media", "ai"))));

  // dryRun composes the href but writes no file.
  const dryImg = await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "notes", images: [{ data: PNG_1x1, format: "png", name: "dry", width: 40 }] }] });
  check("dryRun composes the image href", dryImg.aiSvg.includes('href="media/ai/dry.png"'));
  check("dryRun wrote no media file", !(await exists(path.join(root, imgPage, "media", "ai", "dry.png"))));

  // Validation: format/magic mismatch, oversize, traversal name.
  let badFormat = false;
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "notes", images: [{ data: PNG_1x1, format: "jpeg", width: 40 }] }] }); } catch { badFormat = true; }
  check("rejects a format/magic-byte mismatch", badFormat);
  let oversize = false;
  const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1).toString("base64");
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "notes", images: [{ data: big, format: "png", width: 40 }] }] }); } catch { oversize = true; }
  check("rejects an oversize image (>2MB)", oversize);
  const travAi = (await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "notes", images: [{ data: PNG_1x1, format: "png", name: "../../evil", width: 40 }] }] })).aiSvg;
  const travHref = travAi.match(/href="[^"]*"/)?.[0] ?? "";
  const travBase = travHref.replace(/^href="media\/ai\//, "").replace(/"$/, "");
  // Safe = stays under media/ai/: no slash in the filename, no leading dot (no `../`).
  check("sanitizes a traversal filename", travHref.startsWith('href="media/ai/') && !travBase.includes("/") && !travBase.startsWith("."), travHref);

  console.log("\nwrite_underlay images via local file `path` (no base64 through context)");
  const srcPng = path.join(os.tmpdir(), "onionskin-smoke-src.png");
  await fs.writeFile(srcPng, Buffer.from(PNG_1x1, "base64"));
  await writeUnderlay(root, imgPage, {
    status: "ready",
    regions: [{ region: "notes", images: [{ path: srcPng, name: "from-path", width: 64 }] }],
  });
  const pathAi = await fs.readFile(path.join(root, imgPage, "ai.svg"), "utf8");
  const pathFile = path.join(root, imgPage, "media", "ai", "from-path.png");
  check("path image referenced from ai.svg", pathAi.includes('href="media/ai/from-path.png"'), pathAi.slice(0, 160));
  check("format sniffed from the file (no format passed)", await exists(pathFile));
  check("path image bytes copied into media/ai/", (await fs.readFile(pathFile)).equals(Buffer.from(PNG_1x1, "base64")));
  check("path image aspect-fills height (1×1 → 64²)", /width="64" height="64"/.test(pathAi), pathAi);
  let badPath = false;
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "notes", images: [{ path: "/no/such/file-xyz.png", width: 40 }] }] }); } catch { badPath = true; }
  check("a missing path file errors clearly", badPath);
  let bothErr = false;
  try { await writeUnderlay(root, imgPage, { status: "ready", dryRun: true, regions: [{ region: "notes", images: [{ data: PNG_1x1, path: srcPng, format: "png", width: 40 }] }] }); } catch { bothErr = true; }
  check("rejects an image with both data and path", bothErr);
  await fs.rm(srcPng, { force: true });

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
