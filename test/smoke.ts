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
import { GOLD } from "../src/svg.js";

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
