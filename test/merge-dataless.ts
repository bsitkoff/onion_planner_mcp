// Regression (#60 item 1): `write_underlay` with `merge: true` must never treat an ai.svg
// it can't actually read (iCloud-dataless/evicted, a `.ai.svg.icloud` stub, or any read
// error other than ENOENT) as "no file" — that silently rewrote the page with only the
// caller's regions, dropping every other region.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeUnderlay } from '../src/page.js';

const TEMPLATE = `<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">
<g id="region-todo" data-region="todo" transform="translate(40,100)"><rect width="400" height="300"/></g>
<g id="region-ainotes" data-region="ainotes" transform="translate(40,500)"><rect width="400" height="200"/></g>
</svg>`;
const EXISTING_AI = `<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg">
  <g data-region="todo"><text>keep me</text></g>
  <g data-region="ainotes"><text>old note</text></g>
</svg>
`;
const REL = 'Shared/Test/2026-11-10';

async function makePage(): Promise<{ root: string; page: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'onion-dataless-'));
  const page = path.join(root, REL);
  await fs.mkdir(page, { recursive: true });
  await fs.writeFile(path.join(page, 'template.svg'), TEMPLATE);
  await fs.writeFile(
    path.join(page, 'manifest.json'),
    JSON.stringify({ size: [1024, 1366], layers: { ai: { file: 'ai.svg', status: 'ready' } } }),
  );
  return { root, page };
}

const MERGE = {
  status: 'ready' as const,
  merge: true,
  regions: [{ region: 'ainotes', lines: [{ text: 'new note' }] }],
};

test('merge refuses when ai.svg is unreadable for a reason other than ENOENT', async () => {
  const { root, page } = await makePage();
  // A directory where ai.svg should be → EISDIR on read, not ENOENT.
  await fs.mkdir(path.join(page, 'ai.svg'));
  await assert.rejects(writeUnderlay(root, REL, MERGE), /ai\.svg is unreadable/);
});

test('merge refuses (never drops regions) when ai.svg stays iCloud-dataless', async () => {
  const { root, page } = await makePage();
  const ai = path.join(page, 'ai.svg');
  await fs.writeFile(ai, '');  // what a dataless placeholder can read back as
  let downloads = 0;
  await assert.rejects(
    writeUnderlay(root, REL, MERGE, {
      icloud: { isDataless: async () => true, download: async () => { downloads++; }, waitMs: 50 },
    }),
    /iCloud/,
  );
  assert.ok(downloads >= 1, 'asked iCloud to download before giving up');
  assert.equal(await fs.readFile(ai, 'utf8'), '', 'ai.svg untouched');
});

test('merge downloads a dataless ai.svg first, then keeps the other regions', async () => {
  const { root, page } = await makePage();
  const ai = path.join(page, 'ai.svg');
  await fs.writeFile(ai, '');
  let dataless = true;
  const res = await writeUnderlay(root, REL, MERGE, {
    icloud: {
      isDataless: async () => dataless,
      download: async (p) => { await fs.writeFile(p, EXISTING_AI); dataless = false; },
      waitMs: 1000,
    },
  });
  const out = await fs.readFile(ai, 'utf8');
  assert.match(out, /keep me/, 'the untouched todo region survives the merge');
  assert.match(out, /new note/);
  assert.doesNotMatch(out, /old note/);
  assert.ok(res);
});

test('merge refuses when only the .ai.svg.icloud stub is present and it never downloads', async () => {
  const { root, page } = await makePage();
  await fs.writeFile(path.join(page, '.ai.svg.icloud'), 'stub');
  await assert.rejects(
    writeUnderlay(root, REL, MERGE, {
      icloud: { isDataless: async () => false, download: async () => {}, waitMs: 50 },
    }),
    /iCloud/,
  );
  await assert.rejects(fs.access(path.join(page, 'ai.svg')), 'no ai.svg written over the stub');
});

test('merge with no ai.svg at all still works (genuinely empty page)', async () => {
  const { root, page } = await makePage();
  await writeUnderlay(root, REL, MERGE, {
    icloud: { isDataless: async () => false, download: async () => {}, waitMs: 50 },
  });
  assert.match(await fs.readFile(path.join(page, 'ai.svg'), 'utf8'), /new note/);
});
