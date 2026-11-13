// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// Run: npm test — public/lib.js is a browser script; load it in a VM context like the page does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/lib.js', import.meta.url), 'utf8'), ctx);
const { visibleText, copyText } = ctx.CoordDashLib;
// Copy into this realm: objects made inside the VM have a different Object prototype.
const fitFontSize = (o) => ({ ...ctx.CoordDashLib.fitFontSize(o) });

// Minimal stand-in for an xterm.js Terminal: buffer lines, viewport position, selection.
function fakeTerm(lines, { rows = 3, viewportY = 0, selection = '' } = {}) {
  return {
    rows,
    hasSelection: () => selection !== '',
    getSelection: () => selection,
    buffer: {
      active: {
        viewportY,
        getLine: (y) => (y < lines.length ? { translateToString: (trim) => (trim ? lines[y].replace(/\s+$/, '') : lines[y]) } : undefined),
      },
    },
  };
}

test('copy: the selection wins when there is one', () => {
  assert.equal(copyText(fakeTerm(['a', 'b'], { selection: 'r007c02' })), 'r007c02');
});

test('copy: no selection → the visible screen, right-trimmed, no trailing blank lines', () => {
  const t = fakeTerm(['one   ', 'two', '', '  '], { rows: 4 });
  assert.equal(copyText(t), 'one\ntwo');
});

test('copy: visible screen follows the scrollback position (viewportY)', () => {
  const lines = ['h0', 'h1', 'h2', 's0', 's1', 's2'];
  assert.equal(copyText(fakeTerm(lines, { rows: 3, viewportY: 3 })), 's0\ns1\ns2');
  assert.equal(copyText(fakeTerm(lines, { rows: 3, viewportY: 1 })), 'h1\nh2\ns0');
});

test('copy: an empty selection string falls back to the screen', () => {
  const t = fakeTerm(['x'], { rows: 1 });
  t.hasSelection = () => true; // xterm can report a zero-width selection
  assert.equal(copyText(t), 'x');
});

test('copy: keeps inner blank lines and leading spaces', () => {
  assert.equal(visibleText(fakeTerm(['a', '', '  b'], { rows: 3 }).buffer.active, 3), 'a\n\n  b');
});

test('fit: width only (phone) scales the font by available/actual width', () => {
  assert.deepEqual(fitFontSize({ font: 13, width: 1300, height: 500, availW: 650, availH: 0, min: 6, max: 15 }), { size: 6.5, pan: false });
});

test('fit: desktop takes the tighter of width and height', () => {
  const r = fitFontSize({ font: 10, width: 500, height: 800, availW: 1000, availH: 400, min: 6, max: 15 });
  assert.deepEqual(r, { size: 6, pan: false }); // height-bound: 10*400/800 = 5 → clamped to min, no pan
  assert.deepEqual(fitFontSize({ font: 10, width: 1000, height: 300, availW: 800, availH: 600, min: 6, max: 15 }), { size: 8, pan: false });
});

test('fit: too narrow by width → minimum font and sideways panning', () => {
  assert.deepEqual(fitFontSize({ font: 13, width: 1300, height: 500, availW: 300, availH: 0, min: 6, max: 15 }), { size: 6, pan: true });
});

test('fit: never above max, floored to 0.25 px, and stable when already fitted', () => {
  assert.equal(fitFontSize({ font: 13, width: 100, height: 100, availW: 1000, availH: 0, min: 6, max: 15 }).size, 15);
  assert.equal(fitFontSize({ font: 10, width: 1000, height: 1, availW: 733, availH: 0, min: 6, max: 15 }).size, 7.25);
  const settled = fitFontSize({ font: 7.25, width: 725, height: 1, availW: 733, availH: 0, min: 6, max: 15 });
  assert.equal(settled.size, 7.25);
});

test('fit: unmeasured terminal (width 0) leaves the font alone', () => {
  assert.deepEqual(fitFontSize({ font: 13, width: 0, height: 0, availW: 500, availH: 0, min: 6, max: 15 }), { size: 13, pan: false });
});
