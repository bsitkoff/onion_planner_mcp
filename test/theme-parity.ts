// Regression (#63): the MCP and the app's on-device composer must resolve a chapter's
// underlay theme by the same rule (app: Features/OnDeviceAI/UnderlayTheme.swift).
//  - Only `harmony: "seasonal"` on a month chapter is dropped (its per-month ink table already
//    IS the seasonal identity). A paletteCharacter chapter keeps its explicit harmony.
//  - The default varietyDial is 0.6, not 0.5.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveThemeInput } from '../src/page.js';
import { resolveTheme } from '../src/svg.js';

async function chapter(folder: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'onion-theme-'));
  const ch = path.join(root, 'Shared', 'Ch');
  await fs.mkdir(path.join(ch, 'p'), { recursive: true });
  await fs.writeFile(path.join(ch, '.folder.json'), JSON.stringify(folder));
  return path.join(ch, 'p');
}

test('paletteCharacter chapter keeps its harmony + varietyDial (PT Home Program case)', async () => {
  const page = await chapter({ theme: { paletteCharacter: 'orchard', harmony: 'seasonal', varietyDial: 0.9 } });
  const t = await resolveThemeInput(page, null, {});
  assert.equal(t.harmony, 'seasonal');
  assert.equal(t.varietyDial, 0.9);
});

test('month chapter drops only harmony "seasonal" (and stays on its month inks)', async () => {
  const page = await chapter({ month: 7, year: 2026, theme: { harmony: 'seasonal', varietyDial: 0.9 } });
  const t = await resolveThemeInput(page, null, {});
  assert.equal(t.harmony, undefined);
  assert.equal(t.varietyDial, undefined);
  assert.equal(t.monthlyMonth, 7);
});

test('month chapter keeps a non-seasonal harmony', async () => {
  const page = await chapter({ month: 7, year: 2026, theme: { harmony: 'warm', varietyDial: 0.2 } });
  const t = await resolveThemeInput(page, null, {});
  assert.equal(t.harmony, 'warm');
  assert.equal(t.varietyDial, 0.2);
});

test('default varietyDial is 0.6, matching the app', () => {
  const pal = ['#C8553D', '#2E7C82', '#F2B8CC'];
  assert.deepEqual(
    resolveTheme({ harmony: 'match', templatePalette: pal, month: 3 }).theme,
    resolveTheme({ harmony: 'match', varietyDial: 0.6, templatePalette: pal, month: 3 }).theme,
  );
});
