// App #144 Phase B / this repo's #13: the `Shared/` location gate retires, in lockstep with the
// app, when the app has written its migration marker (`.ink-permissions-v1.json`) at the library
// root. Before the marker: the old rules, unchanged. After it: every chapter folder (`Shared/`
// and `Private/`) is reachable, and `read_ink` is fail-closed on `permissions.inkReadable`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  INK_PERMISSIONS_MARKER,
  bookFolders,
  chapterRel,
  requireChapterRel,
  resolvePageRel,
} from '../src/paths.js';
import { listChapters, listPages } from '../src/library.js';
import { readInk, resolveInkReadable } from '../src/page.js';

const INK = `<svg viewBox="0 0 1024 1366" xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10" data-stroke="1 2 3"/></svg>`;

async function page(root: string, rel: string, folderJson?: object): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(abs, { recursive: true });
  await fs.writeFile(path.join(abs, 'manifest.json'), JSON.stringify({ size: [1024, 1366], template: 'blank' }));
  await fs.writeFile(path.join(abs, 'ink.svg'), INK);
  if (folderJson) await fs.writeFile(path.join(path.dirname(abs), '.folder.json'), JSON.stringify(folderJson));
}

async function library(migrated: boolean): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'onion-inkperm-'));
  await page(root, 'Shared/2026-07/2026-07-01', { title: 'July', year: 2026, month: 7 });
  await page(root, 'Shared/Katie/2026-11-01', { title: 'Katie', defaultTemplate: 'reflection' });
  await page(root, 'Shared/Robotics/notes', { title: 'Robotics', permissions: { inkReadable: true } });
  await page(root, 'Private/Ideas/one', { title: 'Ideas', permissions: { inkReadable: true } });
  await page(root, 'Private/Students/roster', { title: 'Students', permissions: { inkReadable: false } });
  await fs.mkdir(path.join(root, 'Templates'), { recursive: true });
  if (migrated) await fs.writeFile(path.join(root, INK_PERMISSIONS_MARKER), '{"version":"1"}');
  return root;
}

// --- before the app has migrated: nothing changes ---

test('unmigrated library: only Shared/ is reachable', async () => {
  const root = await library(false);
  assert.deepEqual(bookFolders(root), ['Shared']);
  assert.throws(() => resolvePageRel(root, 'Private/Ideas/one'), /only pages under "Shared\/"/);
  assert.deepEqual((await listChapters(root)).map((c) => c.path), ['Shared/2026-07', 'Shared/Katie', 'Shared/Robotics']);
  assert.ok((await listPages(root)).every((p) => p.startsWith('Shared/')));
});

test('unmigrated library: read_ink keeps the type-default bridge', async () => {
  const root = await library(false);
  assert.ok((await readInk(root, 'Shared/2026-07/2026-07-01')).inkSvg, 'month without a key stays readable');
  await assert.rejects(readInk(root, 'Shared/Katie/2026-11-01'), /read_ink refused/);
  assert.equal(resolveInkReadable({ theme: null }, {} as any, false), true);
});

// --- after the app has migrated: the gate retires ---

test('migrated library: Private/ chapters are listed and reachable', async () => {
  const root = await library(true);
  assert.deepEqual(bookFolders(root), ['Shared', 'Private']);
  assert.deepEqual((await listChapters(root)).map((c) => c.path), [
    'Private/Ideas',
    'Private/Students',
    'Shared/2026-07',
    'Shared/Katie',
    'Shared/Robotics',
  ]);
  assert.equal(resolvePageRel(root, 'Private/Ideas/one'), path.join(root, 'Private/Ideas/one'));
  assert.deepEqual(await listPages(root, 'Private/Students'), ['Private/Students/roster']);
});

test('migrated library: root content and traversal stay unreachable', async () => {
  const root = await library(true);
  assert.throws(() => resolvePageRel(root, 'Templates/daily.svg'), /Root content is off-limits/);
  assert.throws(() => resolvePageRel(root, 'settings.json'), /Root content is off-limits/);
  assert.throws(() => resolvePageRel(root, 'Private/../Templates'), /traversal/);
  assert.throws(() => requireChapterRel(root, 'Private'), /must name a chapter/);
  assert.throws(() => requireChapterRel(root, '  '), /must name a chapter/);
});

test('migrated library: chapter references resolve by path or bare name', async () => {
  const root = await library(true);
  assert.equal(chapterRel(root, 'Private/Ideas'), 'Private/Ideas');
  assert.equal(chapterRel(root, 'Shared/Katie/'), 'Shared/Katie');
  assert.equal(chapterRel(root, 'Ideas'), 'Private/Ideas', 'a bare name finds a Private chapter');
  assert.equal(chapterRel(root, 'Katie'), 'Shared/Katie');
  assert.equal(chapterRel(root, 'Brand New'), 'Shared/Brand New', 'new chapters go in Shared/');
});

test('migrated library: read_ink is fail-closed on permissions.inkReadable', async () => {
  const root = await library(true);
  assert.ok((await readInk(root, 'Shared/Robotics/notes')).inkSvg);
  assert.ok((await readInk(root, 'Private/Ideas/one')).inkSvg, 'an explicit true in Private/ is honoured');
  await assert.rejects(readInk(root, 'Private/Students/roster'), /read_ink refused/);
  await assert.rejects(readInk(root, 'Shared/Katie/2026-11-01'), /read_ink refused/);
  await assert.rejects(readInk(root, 'Shared/2026-07/2026-07-01'), /read_ink refused/,
    'a month with no key is NOT inferred readable from its type any more');
});

test('migrated library: a malformed value reads private', () => {
  assert.equal(resolveInkReadable({ theme: null, inkReadable: undefined, month: 7 }, {} as any, true), false);
  assert.equal(resolveInkReadable({ theme: null, inkReadable: true }, {} as any, true), true);
  assert.equal(resolveInkReadable({ theme: null, inkReadable: false }, {} as any, true), false);
});
