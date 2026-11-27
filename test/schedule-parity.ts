/**
 * Cross-writer schedule-block parity: checks this server's block placement against the
 * shared fixture owned by the app repo (https://github.com/bsitkoff/onionskin/pull/304 / onionskin#245). Skips when the sibling app
 * checkout (or the fixture) is absent, like test/parity.ts.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRegions } from "../src/template.js";
import { composeAiSvg } from "../src/svg.js";

const APP = process.env.ONIONSKIN_APP_REPO ?? path.resolve(process.cwd(), "..", "onionskin");
const FIXTURE = path.join(APP, "Onionskin", "Tests", "Fixtures", "schedule-parity.json");

// App formula, UnderlaySVGComposer.swift ~455-523.
const APP_LEFT = 48; // block/timed-line left inset
const APP_RIGHT = 20; // right inset
const APP_LANE_GAP_MAX = 6; // gap = min(6, avail / (2 * columns)) when columns > 1
const APP_LABEL_PAD = 8; // label x = block x + 8 (width - 16 inner)

interface Ev {
  id: string;
  title: string;
  start: string;
  end: string;
  expect: { y1: number; y2: number; column: number; columns: number; labelY: number | null; labelOverflow: boolean | null };
}

test("schedule blocks match the shared cross-writer fixture", (t) => {
  if (!fs.existsSync(FIXTURE)) {
    console.log(`schedule-parity: fixture not found at ${FIXTURE} - skipping (set ONIONSKIN_APP_REPO).`);
    t.skip("fixture absent");
    return;
  }
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const events: Ev[] = fx.events;
  const tolEdge: number = fx.tolerance.edge;
  const tolLabel: number = fx.tolerance.labelY;
  // The fixture's <g> carries only data-region (the app keys by that); this server's parser
  // keys regions off id="region-*", so add the id the shipped templates carry.
  const regions = parseRegions((fx.template as string).replace(/<g data-region="([^"]+)"/g, '<g id="region-$1" data-region="$1"'));
  const sched = regions.find((r) => r.name === "schedule")!;
  const result = composeAiSvg(
    [1024, 1366],
    [{ region: "schedule", lines: events.map((e) => ({ text: e.title, time: e.start, endTime: e.end, size: fx.labelSize })) }],
    regions,
  );
  const rects = [...result.svg.matchAll(/<rect\b[^>]*fill-opacity="[^"]+"[^>]*\/>/g)].map((m) => {
    const n = (k: string) => Number(new RegExp(`\\b${k}="([^"]+)"`).exec(m[0])?.[1]);
    return { x: n("x"), y: n("y"), w: n("width"), h: n("height") };
  });
  assert.equal(rects.length, events.length, "one block rect per fixture event, in order");
  const near = (a: number, b: number, tol: number, msg: string) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (tol ${tol})`);

  events.forEach((e, i) => {
    const r = rects[i];
    const { y1, y2, column, columns, labelY, labelOverflow } = e.expect;
    near(r.y, y1, tolEdge, `${e.id} y1`);
    near(r.y + r.h, y2, tolEdge, `${e.id} y2`);
    const avail = sched.width! - APP_LEFT - APP_RIGHT;
    const gap = columns > 1 ? Math.min(APP_LANE_GAP_MAX, avail / (2 * columns)) : 0;
    const bw = (avail - gap * (columns - 1)) / columns;
    near(r.x, APP_LEFT + column * (bw + gap), tolEdge, `${e.id} x`);
    near(r.w, bw, tolEdge, `${e.id} width`);

    // Label: the app's label is "h:mm  Title" while ours is the caller's text, so a nest's
    // labels wrap only in the app (labelY null there) - only check single-line cases.
    const lm = new RegExp(`<text\\b([^>]*)>${e.title}</text>`).exec(result.svg);
    assert.ok(lm, `${e.id} label present`);
    const lx = Number(/\bx="([^"]+)"/.exec(lm[1])![1]);
    const ly = Number(/\by="([^"]+)"/.exec(lm[1])![1]);
    near(lx, r.x + APP_LABEL_PAD, tolEdge, `${e.id} label x`);
    if (labelY !== null) near(ly, labelY, tolLabel, `${e.id} labelY`);
    if (labelOverflow !== null) {
      const flagged = result.warningDetails.some(
        (w) => w.code === "washi_block_label_overflow" && w.message.includes(`block "${e.title}" (`),
      );
      assert.equal(flagged, labelOverflow, `${e.id} labelOverflow`);
    }
  });
});
