// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// Run: npm test — terminal size, panel limits and layout logic (public/lib.js) and the
// server's resize validation (server.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SIZE, resizeArgs } from '../server.js';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/lib.js', import.meta.url), 'utf8'), ctx);
// Copy results into this realm: objects made inside the VM have a different Object prototype.
const real = (v) => JSON.parse(JSON.stringify(v));
const L = ctx.CoordDashLib;
const termSize = (o) => real(L.termSize(o));
const restoreLayout = (s, o) => real(L.restoreLayout(s, o));
const dragSplit = (...a) => real(L.dragSplit(...a));
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('termSize: whole cells only (floor), from the panel size in px', () => {
  // 1200 px / 7.8 px = 153.8 → 153 columns; 600 px / 17 px = 35.3 → 35 rows
  assert.deepEqual(termSize({ width: 1200, height: 600, cellW: 7.8, cellH: 17 }), { cols: 153, rows: 35 });
});

test('termSize: a third of a 2560 px screen is well over 80 columns at 13 px', () => {
  const r = termSize({ width: 2560 / 3 - 40, height: 900, cellW: 7.83, cellH: 15 });
  assert.ok(r.cols > 80, `got ${r.cols}`);
});

test('termSize: clamped to 20×6 minimum and 500×200 maximum', () => {
  assert.deepEqual(termSize({ width: 50, height: 20, cellW: 8, cellH: 16 }), { cols: 20, rows: 6 });
  assert.deepEqual(termSize({ width: 1e6, height: 1e6, cellW: 8, cellH: 16 }), { cols: 500, rows: 200 });
});

test('termSize: nothing measured yet (hidden panel, zero cell) → null', () => {
  assert.equal(L.termSize({ width: 0, height: 400, cellW: 8, cellH: 16 }), null);
  assert.equal(L.termSize({ width: 400, height: 400, cellW: 0, cellH: 16 }), null);
  assert.equal(L.termSize({ width: 400, height: 400, cellW: NaN, cellH: 16 }), null);
});

test('limits: browser and server agree', () => {
  assert.deepEqual([L.MIN_COLS, L.MIN_ROWS, L.MAX_COLS, L.MAX_ROWS], [SIZE.minCols, SIZE.minRows, SIZE.maxCols, SIZE.maxRows]);
  assert.deepEqual([L.MIN_COLS, L.MIN_ROWS], [20, 6]);
});

test('minPanelPx: 20 columns × 6 rows plus the panel chrome, rounded up', () => {
  assert.deepEqual(real(L.minPanelPx({ cellW: 7.8, cellH: 15, chromeW: 16, chromeH: 120 })), { w: 172, h: 210 });
});

test('columnCount / rowCounts: panels per row and the rows they make', () => {
  assert.equal(L.columnCount(2560, 3, 480), 3);
  assert.equal(L.columnCount(1280, 3, 480), 2);
  assert.equal(L.columnCount(900, 3, 480), 1);
  assert.equal(L.columnCount(300, 2, 480), 1); // never 0 while there are panels
  assert.equal(L.columnCount(2560, 0, 480), 0);
  assert.deepEqual(real(L.rowCounts(5, 2)), [2, 2, 1]);
  assert.deepEqual(real(L.rowCounts(3, 3)), [3]);
  assert.deepEqual(real(L.rowCounts(0, 3)), []);
});

test('dragSplit: moves only the two neighbours of the divider', () => {
  const r = dragSplit([0.25, 0.25, 0.5], 0, 100, 1000, 100);
  assert.ok(close(r, [0.35, 0.15, 0.5]), JSON.stringify(r));
});

test('dragSplit: neither neighbour goes below the minimum', () => {
  assert.ok(close(dragSplit([0.5, 0.5], 0, 10000, 1000, 150), [0.85, 0.15]));
  assert.ok(close(dragSplit([0.5, 0.5], 0, -10000, 1000, 150), [0.15, 0.85]));
});

test('dragSplit: pair already below the minimum, bad index or no space → unchanged', () => {
  assert.deepEqual(dragSplit([0.1, 0.1, 0.8], 0, 50, 1000, 150), [0.1, 0.1, 0.8]);
  assert.deepEqual(dragSplit([0.5, 0.5], 1, 50, 1000, 150), [0.5, 0.5]);
  assert.deepEqual(dragSplit([0.5, 0.5], 0, 50, 0, 150), [0.5, 0.5]);
});

const screen = { counts: [3], width: 2400, height: 900, divider: 12, minW: 180, minH: 220, names: ['a', 'b', 'c'] };

test('restoreLayout: a saved layout that fits is used as saved', () => {
  const saved = { counts: [3], rows: [1], cols: [[0.5, 0.3, 0.2]], max: 'b' };
  assert.deepEqual(restoreLayout(saved, screen), saved);
});

test('restoreLayout: nothing saved or junk → equal sizes', () => {
  for (const s of [null, undefined, 'x', 42, {}, { counts: [3], rows: [1], cols: [[1, 0, 0]] }]) {
    const r = restoreLayout(s, screen);
    assert.deepEqual(r.counts, [3]);
    assert.deepEqual(r.rows, [1]);
    assert.ok(close(r.cols[0], [1 / 3, 1 / 3, 1 / 3]));
  }
});

test('restoreLayout: other shape (panel added, narrower screen) → equal sizes', () => {
  const saved = { counts: [2], rows: [1], cols: [[0.7, 0.3]], max: null };
  const r = restoreLayout(saved, { ...screen, counts: [2, 1] });
  assert.ok(close(r.rows, [0.5, 0.5]));
  assert.ok(close(r.cols[0], [0.5, 0.5]) && close(r.cols[1], [1]));
});

test('restoreLayout: a panel that would be too small on this screen → equal sizes', () => {
  const saved = { counts: [3], rows: [1], cols: [[0.8, 0.1, 0.1]], max: null };
  // 0.1 × (1000 − 2·12) = 97.6 px < 180 px minimum
  const r = restoreLayout(saved, { ...screen, width: 1000 });
  assert.ok(close(r.cols[0], [1 / 3, 1 / 3, 1 / 3]));
  // the same layout fits on the wide screen
  assert.deepEqual(restoreLayout(saved, screen).cols, [[0.8, 0.1, 0.1]]);
});

test('restoreLayout: row heights are checked against the minimum height too', () => {
  const saved = { counts: [1, 1], rows: [0.9, 0.1], cols: [[1], [1]], max: null };
  const r = restoreLayout(saved, { ...screen, counts: [1, 1], height: 900 });
  assert.ok(close(r.rows, [0.5, 0.5]));
});

test('restoreLayout: maximized panel kept only while it is open', () => {
  const saved = { counts: [3], rows: [1], cols: [[0.5, 0.3, 0.2]], max: 'gone' };
  assert.equal(restoreLayout(saved, screen).max, null);
  assert.equal(restoreLayout({ ...saved, cols: [[0.98, 0.01, 0.01]], max: 'c' }, screen).max, 'c'); // sizes fall back, max stays
});

test('resizeArgs: pins the window size with window-size manual + resize-window', () => {
  assert.deepEqual(resizeArgs('=claude:', 153, 41), [
    'set-option', '-w', '-t', '=claude:', 'window-size', 'manual', ';',
    'resize-window', '-t', '=claude:', '-x', '153', '-y', '41',
  ]);
});

test('resizeArgs: refuses sizes outside 20×6 … 500×200 and non-integers', () => {
  assert.ok(resizeArgs('=s:', 20, 6));
  assert.ok(resizeArgs('=s:', 500, 200));
  const bad = [[19, 10], [80, 5], [501, 10], [80, 201], [80.5, 24], ['80', 24], [null, 24], [80, undefined], [NaN, 24], [Infinity, 24], [-80, 24]];
  for (const [c, r] of bad) assert.equal(resizeArgs('=s:', c, r), null, `should refuse ${c}×${r}`);
});
