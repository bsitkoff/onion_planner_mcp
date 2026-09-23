/**
 * Unit tests for `unwrapNestedSvg` (#64): the app renderer has no nested-viewport
 * support, so a nested <svg> in caller svg is rewritten to an equivalent <g transform>.
 * Run: node --import tsx --test test/nested-svg.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapNestedSvg } from "../src/svg.js";

test("fragment: nested svg with viewBox + size becomes translate/scale/translate g", () => {
  const { svg, count } = unwrapNestedSvg(
    '<svg x="10" y="20" width="100" height="50" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>',
    { skipRoot: false },
  );
  assert.equal(count, 1);
  assert.equal(svg, '<g transform="translate(10,20) scale(0.5)"><rect width="200" height="100"/></g>');
});

test("fragment: viewBox origin is shifted out", () => {
  const { svg } = unwrapNestedSvg('<svg width="10" height="10" viewBox="5 5 10 10"><circle r="1"/></svg>', {
    skipRoot: false,
  });
  assert.equal(svg, '<g transform="translate(-5,-5)"><circle r="1"/></g>');
});

test("raw document: the outermost root svg is kept, nested ones rewritten", () => {
  const doc =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1366" viewBox="0 0 1024 1366">' +
    '<svg x="100" y="200" width="64" height="64" viewBox="0 0 32 32"><path d="M0 0"/></svg>' +
    "</svg>";
  const { svg, count } = unwrapNestedSvg(doc, { skipRoot: true });
  assert.equal(count, 1);
  assert.equal(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1366" viewBox="0 0 1024 1366">' +
      '<g transform="translate(100,200) scale(2)"><path d="M0 0"/></g>' +
      "</svg>",
  );
});

test("nested depth: inner svgs inside an unwrapped svg are unwrapped too, closes match", () => {
  const { svg, count } = unwrapNestedSvg('<svg x="1"><svg y="2"><g/></svg><rect/></svg>', { skipRoot: false });
  assert.equal(count, 2);
  assert.equal(svg, '<g transform="translate(1,0)"><g transform="translate(0,2)"><g/></g><rect/></g>');
});

test("meet (default preserveAspectRatio) scales uniformly and centres", () => {
  // 100×50 viewport, 10×10 viewBox → s = min(10, 5) = 5, content 50 wide → x offset 25.
  const { svg } = unwrapNestedSvg('<svg width="100" height="50" viewBox="0 0 10 10"><rect/></svg>', {
    skipRoot: false,
  });
  assert.equal(svg, '<g transform="translate(25,0) scale(5)"><rect/></g>');
});

test("preserveAspectRatio=none scales non-uniformly", () => {
  const { svg } = unwrapNestedSvg(
    '<svg width="100" height="50" viewBox="0 0 10 10" preserveAspectRatio="none"><rect/></svg>',
    { skipRoot: false },
  );
  assert.equal(svg, '<g transform="scale(10,5)"><rect/></g>');
});

test("xMinYMax meet aligns to the start/end edges", () => {
  // 50×100 viewport, 10×10 viewBox → s = 5, content 50 tall → y offset 50 (YMax).
  const { svg } = unwrapNestedSvg(
    '<svg width="50" height="100" viewBox="0 0 10 10" preserveAspectRatio="xMinYMax meet"><rect/></svg>',
    { skipRoot: false },
  );
  assert.equal(svg, '<g transform="translate(0,50) scale(5)"><rect/></g>');
});

test("self-closing svg becomes a self-closing g", () => {
  const { svg, count } = unwrapNestedSvg('<svg x="3" y="4" width="10" height="10"/>', { skipRoot: false });
  assert.equal(count, 1);
  assert.equal(svg, '<g transform="translate(3,4)"/>');
});

test("other attributes are preserved; geometry/xmlns attrs dropped; existing transform first", () => {
  const { svg } = unwrapNestedSvg(
    '<svg id="art" class="doodle" fill="#c96" data-kind="sticker" xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" transform="rotate(5)" x="8" y="0" ' +
      'width="20px" height="20px" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet"><rect/></svg>',
    { skipRoot: false },
  );
  assert.equal(
    svg,
    '<g id="art" class="doodle" fill="#c96" data-kind="sticker" transform="rotate(5) translate(8,0) scale(2)"><rect/></g>',
  );
});

test("percentage / missing size falls back to the viewBox size (scale 1)", () => {
  const { svg } = unwrapNestedSvg('<svg width="100%" viewBox="0 0 40 30"><rect/></svg>', { skipRoot: false });
  assert.equal(svg, "<g><rect/></g>");
});

test("fractional values are formatted compactly", () => {
  const { svg } = unwrapNestedSvg('<svg width="10" height="10" viewBox="0 0 3 3"><rect/></svg>', { skipRoot: false });
  assert.equal(svg, '<g transform="scale(3.3333)"><rect/></g>');
});

test("no nested svg → unchanged, count 0", () => {
  const doc = '<svg viewBox="0 0 10 10"><g><rect/></g></svg>';
  assert.deepEqual(unwrapNestedSvg(doc, { skipRoot: true }), { svg: doc, count: 0 });
  const frag = '<g><text x="1">svg</text></g>';
  assert.deepEqual(unwrapNestedSvg(frag, { skipRoot: false }), { svg: frag, count: 0 });
});

test("a '>' inside an attribute value doesn't end the tag", () => {
  const { svg } = unwrapNestedSvg('<svg data-note="a > b" x="2"><rect/></svg>', { skipRoot: false });
  assert.equal(svg, '<g data-note="a > b" transform="translate(2,0)"><rect/></g>');
});
