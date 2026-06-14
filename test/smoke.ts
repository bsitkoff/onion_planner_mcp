/**
 * End-to-end smoke test against a throwaway copy of the Onionskin fixtures.
 * Run: ONIONSKIN_CONTAINER=/tmp/onionskin-test tsx test/smoke.ts
 * (the npm `smoke` script + the harness shell command set that up for you).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { requireLibrary, listChapters, listPages, LibraryMissingError } from "../src/library.js";
import {
  readPage,
  writeUnderlay,
  setStatus,
  clearUnderlay,
  createPage,
} from "../src/page.js";

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

async function main() {
  const root = await requireLibrary();
  console.log(`Library: ${root}\n`);

  console.log("get_library / chapters");
  const chapters = await listChapters(root);
  const names = chapters.map((c) => c.name);
  check("finds Daily + Monthly chapters", names.includes("Daily") && names.includes("Monthly"), JSON.stringify(names));
  check("Daily has pages", (chapters.find((c) => c.name === "Daily")?.pageCount ?? 0) > 0);

  console.log("\nlist_pages");
  const pages = await listPages(root);
  const target = "Shared/Daily/2026-02-06";
  check("lists the daily target page", pages.includes(target), JSON.stringify(pages));
  check("does NOT list any Private page", !pages.some((p) => p.includes("Private")));

  console.log("\nread_page (region geometry)");
  const read = await readPage(root, target);
  const schedule = read.regions.find((r) => r.name === "schedule");
  const affirmation = read.regions.find((r) => r.name === "affirmation");
  check("size is 1024x1366 from manifest", read.size[0] === 1024 && read.size[1] === 1366, JSON.stringify(read.size));
  check("schedule region parsed", !!schedule);
  check("schedule has ruled lines", (schedule?.ruledLines.length ?? 0) >= 10, String(schedule?.ruledLines.length));
  check("schedule origin is (56,250)", schedule?.x === 56 && schedule?.y === 250, `${schedule?.x},${schedule?.y}`);
  check("affirmation region parsed", !!affirmation);

  console.log("\nwrite_underlay (structured)");
  const before = read.manifest.modified;
  await new Promise((r) => setTimeout(r, 5)); // ensure modified timestamp differs
  const wr = await writeUnderlay(root, target, {
    status: "ready",
    regions: [
      { region: "schedule", lines: [
        { text: "9:00 standup", row: 2 },
        { text: "13:00 1:1 advising", row: 6 },
      ]},
      { region: "affirmation", lines: [{ text: "Small steps still move forward." }] },
    ],
  });
  const aiPath = path.join(root, target, "ai.svg");
  const ai = await fs.readFile(aiPath, "utf8");
  check("ai.svg contains schedule text", ai.includes("9:00 standup"));
  check("ai.svg uses gold fill", ai.includes("#C9A227"));
  check("ai.svg groups by region", ai.includes('data-region="schedule"') && ai.includes('data-region="affirmation"'));
  // Derive the expected slot from the parsed geometry (fixtures may change):
  // row 2's baseline must land between ruled line 2 and ruled line 3 (its slot).
  const rl = schedule!.ruledLines.map((v) => v - schedule!.y);
  const slotTop = rl[2];
  const slotBot = rl[3] ?? slotTop + 58;
  const yMatch = (ai.split("\n").find((l) => l.includes("9:00 standup")) ?? "").match(/y="(\d+)"/);
  const yVal = yMatch ? Number(yMatch[1]) : -1;
  check(
    "schedule row 2 baseline lands in its slot",
    yVal > slotTop && yVal < slotBot,
    `y=${yVal} expected in (${slotTop}, ${slotBot})`,
  );
  check("affirmation uses Newsreader", ai.includes("Newsreader"));
  const m2 = JSON.parse(await fs.readFile(path.join(root, target, "manifest.json"), "utf8"));
  check("manifest ai.status = ready", m2.layers.ai.status === "ready");
  check("manifest modified bumped", m2.modified !== before, `${before} -> ${m2.modified}`);
  check("write reported bytes", wr.bytes > 0);

  console.log("\nwrite_underlay (raw svg)");
  await writeUnderlay(root, target, {
    status: "ready",
    svg: '<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><text x="80" y="80" fill="#C9A227">raw</text></svg>',
  });
  const aiRaw = await fs.readFile(aiPath, "utf8");
  check("raw svg written verbatim", aiRaw.includes(">raw</text>"));

  console.log("\nset_underlay_status / clear_underlay");
  await setStatus(root, target, "refreshing");
  const m3 = JSON.parse(await fs.readFile(path.join(root, target, "manifest.json"), "utf8"));
  check("status set to refreshing", m3.layers.ai.status === "refreshing");
  await clearUnderlay(root, target);
  const m4 = JSON.parse(await fs.readFile(path.join(root, target, "manifest.json"), "utf8"));
  const aiCleared = await fs.readFile(aiPath, "utf8");
  check("clear sets status empty", m4.layers.ai.status === "empty");
  check("clear empties ai.svg", !aiCleared.includes("<text"));

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

  console.log("\ncreate_page");
  const created = await createPage(root, { chapter: "Daily", name: "2026-02-07", title: "Saturday" });
  check("create returns cloned-from", !!created.clonedFrom);
  const newManifest = JSON.parse(await fs.readFile(path.join(root, "Shared/Daily/2026-02-07/manifest.json"), "utf8"));
  check("new page manifest template = daily", newManifest.template === "daily");
  check("new page ai.status empty", newManifest.layers.ai.status === "empty");
  const newTemplate = await fs.readFile(path.join(root, "Shared/Daily/2026-02-07/template.svg"), "utf8");
  check("new page has cloned template", newTemplate.includes("region-schedule"));
  const folder = JSON.parse(await fs.readFile(path.join(root, "Shared/Daily/.folder.json"), "utf8"));
  check("chapter order includes new page", folder.order.includes("2026-02-07"));
  // The new page is now writable end-to-end.
  await writeUnderlay(root, "Shared/Daily/2026-02-07", {
    status: "ready",
    regions: [{ region: "schedule", lines: [{ text: "7:30 coffee", row: 0 }] }],
  });
  check("can write underlay into created page", (await fs.readFile(path.join(root, "Shared/Daily/2026-02-07/ai.svg"), "utf8")).includes("7:30 coffee"));

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

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
