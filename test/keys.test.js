// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KEYS, keyArgs } from '../server.js';

// Every button: data-key id -> tmux keys that must be sent, in order, by one send-keys.
const EXPECTED = {
  // bottom bar
  Left: ['Left'], Right: ['Right'], Up: ['Up'], Down: ['Down'], Enter: ['Enter'],
  Escape: ['Escape'], BTab: ['BTab'], 'C-c': ['C-c'],
  // ☰ Ctrl: Run
  'C-b': ['C-b'], // once: send-keys bypasses the tmux prefix
  'C-x C-s': ['C-x', 'C-s'],
  'Escape Escape': ['Escape', 'Escape'],
  'C-x C-k C-x C-k': ['C-x', 'C-k', 'C-x', 'C-k'],
  // View
  'C-o': ['C-o'], 'C-t': ['C-t'], 'C-r': ['C-r'], 'C-l': ['C-l'],
  // Prompt
  'C-s': ['C-s'], 'C-j': ['C-j'], 'C-_': ['C-_'], 'C-w': ['C-w'], 'C-u': ['C-u'],
};
const CONFIRM = ['Escape', 'BTab', 'C-c', 'Escape Escape', 'C-x C-k C-x C-k'];

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const buttons = [...html.matchAll(/<button\b[^>]*\bdata-key="([^"]+)"[^>]*>/g)].map((m) => ({ id: m[1], tag: m[0] }));

for (const [id, seq] of Object.entries(EXPECTED)) {
  test(`${id} -> send-keys ${seq.join(' ')}`, () => {
    assert.deepEqual(keyArgs(id, 'claude:'), ['send-keys', '-t', 'claude:', ...seq]);
  });
}

test('allow-list is exactly the set of buttons (no extra keys server-side)', () => {
  assert.deepEqual([...KEYS.keys()].sort(), Object.keys(EXPECTED).sort());
});

test('every button in index.html has an expected, allow-listed key, each exactly once', () => {
  const ids = buttons.map((b) => b.id);
  assert.deepEqual([...ids].sort(), Object.keys(EXPECTED).sort());
});

test('bar layout: row 1 ← ↑ ↓ → Enter, row 2 Esc mode Stop Copy ☰ Ctrl', () => {
  const rows = [...html.matchAll(/<div class="krow[^"]*">([\s\S]*?)<\/div>/g)].map((m) =>
    [...m[1].matchAll(/<button\b([^>]*)>([^<]*)</g)].map((b) => (b[1].match(/data-key="([^"]+)"/) || [, b[2]])[1]));
  assert.deepEqual(rows, [['Left', 'Up', 'Down', 'Right', 'Enter'], ['Escape', 'BTab', 'C-c', 'Copy', '☰ Ctrl']]);
});

test('confirm only on Esc, mode, Stop, Rewind, Stop subagents', () => {
  const confirmed = buttons.filter((b) => /data-confirm=/.test(b.tag)).map((b) => b.id);
  assert.deepEqual(confirmed.sort(), [...CONFIRM].sort());
});

test('C-d and C-z are never allowed; junk is refused', () => {
  const bad = ['C-d', 'C-z', 'Tab', 'C-x', 'C-k', 'C-x C-k', 'Escape  Escape', 'C-s C-x', 'Left Right',
    'toString', '__proto__', '', null, undefined, 42, ['Left'], { k: 'Left' }];
  for (const k of bad) assert.equal(keyArgs(k, 's:'), null, `should refuse ${JSON.stringify(k)}`);
});
