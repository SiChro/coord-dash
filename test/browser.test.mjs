// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// End-to-end browser test: real server, isolated tmux server, headless Chromium.
// Run: npm run test:browser   (needs playwright-core + a Chromium; see README "Tests")
//
// Each tmux pane runs test/fixtures/tui.cjs: like Claude Code it redraws the whole screen for
// the window size on every resize, here as a grid of tokens like "r007c14" (row 7, token 14)
// with "size COLSxROWS" on the last row. So a mouse selection can be checked exactly (drag
// over one token, press Copy, read the clipboard), and so can the size of each terminal and
// whether the program's screen wraps after a resize.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Machine-specific settings live in test/browser.config.json (gitignored; copy
// test/browser.config.example.json). Environment variables override the file.
const CONFIG_FILE = new URL('./browser.config.json', import.meta.url);
const local = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
const PW_CORE = process.env.PW_CORE || local.playwrightCore || 'playwright-core';
const CHROME = process.env.CHROME || local.chrome || undefined; // undefined: Playwright's own Chromium
const LIB_DIR = process.env.CHROME_LIB_DIR || local.libDir || null; // extra shared libraries for Chromium
const FONTS_CONF = process.env.FONTCONFIG_FILE || local.fontsConf || null;
const PORT = Number(process.env.TEST_PORT || local.port || 7699);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'browser-test-password';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TUI = path.join(ROOT, 'test', 'fixtures', 'tui.cjs');
const DIVIDER = 12; // px, as in public/app.js

let tmp, sock, server, browser, chromium;
const tmux = (...a) => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' });
const tmuxSize = (s) => tmux('display-message', '-p', '-t', `=${s}:`, '#{window_width}x#{window_height} #{window-size}').trim();

before(async () => {
  ({ chromium } = await import(PW_CORE));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-browser-'));
  sock = path.join(tmp, 'tmux.sock');
  tmux('start-server', ';', 'set-option', '-g', 'history-limit', '5000');
  // Started in the background, so tmux gives them its default 80×24 (the case this fixes).
  for (const s of ['left', 'right', 'third']) {
    tmux('new-session', '-d', '-s', s, `'${process.execPath}' '${TUI}'`);
  }
  const salt = crypto.randomBytes(16);
  const cfg = {
    host: '127.0.0.1', port: PORT, sessions: ['left', 'right'], pollMs: 200, tmuxSocket: sock, secureCookie: false,
    passwordHash: `scrypt$${salt.toString('base64')}$${crypto.scryptSync(PASSWORD, salt, 32).toString('base64')}`,
    cookieSecret: crypto.randomBytes(32).toString('base64url'),
  };
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, COORD_DASH_CONFIG: cfgPath }, stdio: 'pipe' });
  await new Promise((ok, fail) => {
    server.stdout.on('data', (d) => /listening/.test(d) && ok());
    server.on('exit', (c) => fail(new Error(`server exited ${c}`)));
  });
  const env = { ...process.env };
  if (LIB_DIR) env.LD_LIBRARY_PATH = [LIB_DIR, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  if (FONTS_CONF) env.FONTCONFIG_FILE = FONTS_CONF;
  browser = await chromium.launch({ executablePath: CHROME, env });
});

after(async () => {
  await browser?.close();
  server?.kill();
  try { tmux('kill-server'); } catch { /* already gone */ }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// Every visible panel: tmux has the size the panel wants, the label shows it, and the program
// has redrawn for it. Returns [{ name, cols, rows }] of the visible panels.
async function settled(page, n) {
  try {
    await page.waitForFunction((count) => {
      const ps = [...document.querySelectorAll('.panel')];
      if (ps.length !== count) return false;
      const vis = ps.filter((p) => p.offsetParent !== null);
      return vis.length > 0 && vis.every((p) => {
        const m = p.querySelector('.state').textContent.match(/^(\d+)×(\d+)$/);
        if (!m || p.dataset.want !== `${m[1]}x${m[2]}`) return false;
        return [...p.querySelectorAll('.xterm-rows > div')].some((d) => d.textContent.includes(`size ${m[1]}x${m[2]}`));
      });
    }, n, { timeout: 15000 });
  } catch (e) {
    const state = await page.evaluate(() => [...document.querySelectorAll('.panel')].map((p) =>
      `${p.dataset.name} label=${p.querySelector('.state').textContent} want=${p.dataset.want} visible=${p.offsetParent !== null} ` +
      `last rows: ${[...p.querySelectorAll('.xterm-rows > div')].slice(-2).map((d) => JSON.stringify(d.textContent.trim().slice(-40))).join(' / ')}`));
    throw new Error(`panels never settled: ${state.join(' | ')}`, { cause: e });
  }
  await page.waitForTimeout(300); // let fit settle
  return page.evaluate(() => [...document.querySelectorAll('.panel')].filter((p) => p.offsetParent !== null).map((p) => {
    const [cols, rows] = p.querySelector('.state').textContent.split('×').map(Number);
    return { name: p.dataset.name, cols, rows };
  }));
}

// names: open these panels instead of the configured ones (as if chosen earlier in this browser).
async function open(width, height, opts = {}, { names, layout } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  if (names || layout) {
    await ctx.addInitScript(([n, l]) => {
      if (sessionStorage.getItem('seeded')) return; // only before the first load: reloads keep what the page saved
      sessionStorage.setItem('seeded', '1');
      if (n) localStorage.setItem('coord-dash.panels', JSON.stringify(n));
      if (l) localStorage.setItem('coord-dash.layout', JSON.stringify(l));
    }, [names, layout]);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.errors = errors;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/login`);
  await page.fill('#pw', PASSWORD);
  await page.click('#login button');
  await page.waitForURL(`${BASE}/`);
  await settled(page, (names || ['left', 'right']).length);
  return { ctx, page };
}

const rectOf = (page, sel, i = 0) => page.evaluate(([s, n]) => {
  const r = document.querySelectorAll(s)[n].getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
}, [sel, i]);
const panelRects = (page) => page.evaluate(() => [...document.querySelectorAll('.panel')].map((p) => {
  const r = p.getBoundingClientRect();
  return { name: p.dataset.name, visible: p.offsetParent !== null, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
}));
const visibleIdx = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.panel')].map((p, i) => (p.offsetParent !== null ? i : -1)).filter((i) => i >= 0));

// Geometry of panel i's terminal: screen rect, rows' text, cell size from the rendered DOM.
async function termInfo(page, i) {
  return page.evaluate((n) => {
    const p = document.querySelectorAll('.panel')[n];
    const scr = p.querySelector('.xterm-screen');
    const rows = [...scr.querySelectorAll('.xterm-rows > div')];
    const cols = Number(p.querySelector('.state').textContent.split('×')[0]);
    const r = scr.getBoundingClientRect();
    return { left: r.left, top: r.top, cols, cw: r.width / cols, ch: r.height / rows.length, rows: rows.map((d) => d.textContent.replace(/ /g, ' ')) };
  }, i);
}

// Drag over the token starting at column `col` of visible row `row` in panel i; return what Copy put on the clipboard.
async function selectAndCopy(page, i, row, col) {
  const t = await termInfo(page, i);
  const y = t.top + (row + 0.5) * t.ch;
  const x0 = t.left + (col + 0.5) * t.cw;
  const x1 = t.left + (col + 6.95) * t.cw; // right edge of the last character
  const expected = t.rows[row].slice(col, col + 7);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, y, { steps: 3 });
  await page.mouse.move(x1, y, { steps: 3 });
  await page.mouse.up();
  await page.click('#copy');
  const got = await page.evaluate(() => navigator.clipboard.readText());
  return { got, expected };
}

async function checkSelection(page, label) {
  for (const i of await visibleIdx(page)) {
    await page.evaluate((n) => document.querySelectorAll('.panel')[n].querySelector('.screen').scrollIntoView({ block: 'nearest' }), i);
    // the part of the terminal that is actually on screen (panel area and sideways panning)
    const vis = await page.evaluate((n) => {
      const r = document.querySelectorAll('.panel')[n].querySelector('.xterm-screen').getBoundingClientRect();
      const s = document.querySelectorAll('.panel')[n].querySelector('.screen').getBoundingClientRect();
      const g = document.getElementById('grid').getBoundingClientRect();
      return { top: Math.max(r.top, g.top, s.top), bottom: Math.min(r.bottom, g.bottom, s.bottom), left: Math.max(r.left, s.left), right: Math.min(r.right, s.right) };
    }, i);
    const t = await termInfo(page, i);
    // a visible row near the middle, the first and the last fully visible token on it
    const row = Math.floor(((vis.top + vis.bottom) / 2 - t.top) / t.ch);
    const toks = [...t.rows[row].matchAll(/r\d{3}c\d{2}/g)].map((m) => m.index)
      .filter((c) => t.left + c * t.cw >= vis.left - 0.5 && t.left + (c + 7) * t.cw <= vis.right + 0.5);
    assert.ok(toks.length >= 2, `${label} panel ${i}: at least two tokens visible on row ${row} ("${t.rows[row]}")`);
    for (const col of [toks[0], toks[toks.length - 1]]) {
      const { got, expected } = await selectAndCopy(page, i, row, col);
      assert.match(expected, /^r\d{3}c\d{2}$/, `${label} panel ${i}: test setup, row ${row} col ${col} is "${expected}"`);
      assert.equal(got, expected, `${label} panel ${i}: selection of row ${row} col ${col}`);
    }
  }
}

// The terminal uses the whole panel: tmux has the panel's size, less than one cell is left over,
// and the program's screen is drawn for exactly that size without wrapping.
async function checkTerminals(page, label) {
  for (const i of await visibleIdx(page)) {
    const info = await page.evaluate((n) => {
      const p = document.querySelectorAll('.panel')[n];
      const s = p.querySelector('.screen');
      const x = p.querySelector('.xterm-screen').getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      return { name: p.dataset.name, label: p.querySelector('.state').textContent, want: p.dataset.want,
        spareW: s.clientWidth - 14 - x.width, spareH: s.clientHeight - x.height, xBottom: x.bottom, sBottom: sr.bottom };
    }, i);
    const t = await termInfo(page, i);
    const [cols, rows] = info.label.split('×').map(Number);
    assert.equal(tmuxSize(info.name), `${cols}x${rows} manual`, `${label}: ${info.name} tmux size = label, window-size manual`);
    assert.equal(info.want, `${cols}x${rows}`, `${label}: ${info.name} tmux size = what the panel wants`);
    assert.ok(info.spareW >= -0.5 && info.spareW < t.cw + 0.5, `${label}: ${info.name} uses the width (${info.spareW.toFixed(1)} px spare, cell ${t.cw.toFixed(1)})`);
    assert.ok(info.spareH >= -0.5 && info.spareH < t.ch + 0.5, `${label}: ${info.name} uses the height (${info.spareH.toFixed(1)} px spare, cell ${t.ch.toFixed(1)})`);
    assert.equal(t.rows.length, rows, `${label}: ${info.name} xterm rows = tmux rows`);
    const n = Math.floor((cols + 1) / 8);
    t.rows.slice(0, rows - 1).forEach((r, y) => {
      const want = Array.from({ length: n }, (_, c) => `r${String(y).padStart(3, '0')}c${String(c).padStart(2, '0')}`).join(' ');
      assert.equal(r.replace(/\s+$/, ''), want, `${label}: ${info.name} row ${y} redrawn for ${cols} columns, no wrapping`);
    });
    assert.equal(t.rows[rows - 1].trim(), `size ${cols}x${rows}`, `${label}: ${info.name} last row`);
  }
}

async function checkLayout(page, label) {
  if (!label.includes('short')) {
    // panels fill the area down to the key bar: no scrolling, no empty space below
    const g = await page.evaluate(() => { const e = document.getElementById('grid'); e.scrollTop = 0; return { sh: e.scrollHeight, ch: e.clientHeight }; });
    assert.ok(g.sh <= g.ch + 1, `${label}: panels fit the height without scrolling (${g.sh} > ${g.ch})`);
    const grid = await page.evaluate(() => {
      const e = document.getElementById('grid');
      const r = e.getBoundingClientRect();
      return r.bottom - parseFloat(getComputedStyle(e).paddingBottom);
    });
    const lowest = Math.max(...(await panelRects(page)).filter((p) => p.visible).map((p) => p.bottom));
    assert.ok(grid - lowest < 1.5, `${label}: panels reach down to the key bar (${(grid - lowest).toFixed(1)} px empty)`);
  }
  const wide = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1 && e.closest('.screen, .probe') === null);
    return { w, over: over.slice(0, 5).map((e) => `${e.tagName}#${e.id}.${e.className} right=${Math.round(e.getBoundingClientRect().right)}`) };
  });
  assert.deepEqual(wide.over, [], `${label}: elements wider than the page (${wide.w}px)`);
  const bar = await rectOf(page, '#keybar');
  const vh = await page.evaluate(() => window.innerHeight);
  const vw = await page.evaluate(() => window.innerWidth);
  assert.ok(Math.abs(bar.bottom - vh) < 1.5, `${label}: bar at the bottom (${bar.bottom} vs ${vh})`);
  const grid = await rectOf(page, '#grid');
  assert.ok(grid.bottom <= bar.top + 0.5, `${label}: panel area ends above the bar (${grid.bottom} > ${bar.top})`);
  const doc = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
  assert.ok(doc.h <= vh + 1, `${label}: page itself does not scroll (${doc.h} > ${vh})`);
  assert.ok(doc.w <= vw + 1, `${label}: no sideways page scroll (${doc.w} > ${vw})`);
  for (const i of await visibleIdx(page)) {
    await page.evaluate((n) => document.querySelectorAll('.panel form textarea')[n].scrollIntoView({ block: 'nearest' }), i);
    const ta = await rectOf(page, '.panel form textarea', i);
    const b = await rectOf(page, '#keybar');
    assert.ok(ta.bottom <= b.top + 0.5, `${label}: panel ${i} message box above the bar (${ta.bottom} > ${b.top})`);
    assert.ok(ta.top >= 0 && ta.height >= 40, `${label}: panel ${i} message box visible (top ${ta.top}, height ${ta.height})`);
    // nothing on top of it: the box itself is what a tap at its corners and centre hits
    const hits = await page.evaluate(([n, r]) => {
      const box = document.querySelectorAll('.panel form textarea')[n];
      return [[r.left + 4, r.top + 4], [r.right - 4, r.bottom - 4], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]]
        .map(([x, y]) => document.elementFromPoint(x, y) === box);
    }, [i, ta]);
    assert.deepEqual(hits, [true, true, true], `${label}: panel ${i} message box not covered by anything`);
  }
  // panels never overlap, and each panel contains its own message box
  const boxes = (await panelRects(page)).filter((p) => p.visible);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5 || a.right <= b.left + 0.5 || b.right <= a.left + 0.5;
      assert.ok(apart, `${label}: panels ${a.name} and ${b.name} overlap`);
    }
  }
  const target = await page.textContent('#keybar .ktarget');
  assert.match(target, /left|right/, `${label}: bar shows its target`);
}

// Drag from (x0, y0) by (dx, dy) with the mouse, in steps; `during` runs before the release.
async function mouseDrag(page, x0, y0, dx, dy, during) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(x0 + (dx * k) / 10, y0 + (dy * k) / 10);
  if (during) await during();
  await page.mouse.up();
}
const center = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

for (const [label, w, h, opts] of [
  ['desktop 1280', 1280, 800, {}],
  ['phone 375', 375, 740, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  test(`${label}: layout — panels fill the area, bar in its own space, message boxes above it`, async () => {
    const { ctx, page } = await open(w, h, opts);
    try {
      await checkLayout(page, label);
      await checkTerminals(page, label);
      // optional visual check: SHOT_DIR=/some/dir npm run test:browser
      if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${label.replace(/\W+/g, '-')}.png`) });
      assert.deepEqual(page.errors, []);
    } finally { await ctx.close(); }
  });

  // Simulates a keyboard that resizes the page (Android Chrome, interactive-widget=resizes-content).
  // It does NOT cover iOS, which pans the visual viewport instead; that path is untested here.
  test(`${label}: short viewport (360 px high, Android-style keyboard resize)`, async () => {
    const { ctx, page } = await open(w, h, opts);
    try {
      await page.setViewportSize({ width: w, height: 360 });
      await settled(page, 2);
      await checkLayout(page, `${label} short`);
      await page.focus('.panel.active form textarea');
      const ta = await rectOf(page, '.panel.active form textarea');
      const bar = await rectOf(page, '#keybar');
      assert.ok(ta.bottom <= bar.top + 0.5 && ta.top >= 0, `${label} short: focused box visible above the bar`);
    } finally { await ctx.close(); }
  });

  test(`${label}: mouse selection hits the character under the pointer, before and after scrolling`, async () => {
    const { ctx, page } = await open(w, h, opts);
    try {
      await checkSelection(page, `${label} initial`);
      // scroll the terminal's own scrollback up
      const [i] = await visibleIdx(page);
      const t = await termInfo(page, i);
      await page.mouse.move(t.left + 4 * t.cw, t.top + 3 * t.ch);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(300);
      const t2 = await termInfo(page, i);
      assert.notEqual(t2.rows[0], t.rows[0], `${label}: the wheel scrolled the terminal's scrollback`);
      await checkSelection(page, `${label} scrollback scrolled`);
      // the terminal fits its panel, so nothing needs panning sideways any more
      assert.equal(await page.locator('.screen.pan').count(), 0, `${label}: no sideways panning`);
    } finally { await ctx.close(); }
  });

  test(`${label}: Copy with nothing selected copies the targeted panel's visible screen, shows a toast`, async () => {
    const { ctx, page } = await open(w, h, opts);
    try {
      if (opts.isMobile) await page.click('#tabs button[data-name="right"]');
      await settled(page, 2);
      const t = await termInfo(page, 1);
      await page.mouse.click(t.left + 5, t.top + 5); // targets panel 1, clears any selection
      await page.click('#copy');
      const got = await page.evaluate(() => navigator.clipboard.readText());
      const want = (await termInfo(page, 1)).rows.map((r) => r.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
      assert.equal(got, want);
      assert.match(await page.textContent('#toast'), /Copied/);
      assert.equal(await page.isVisible('#toast'), true);
    } finally { await ctx.close(); }
  });
}

test('wide 2560: three panels side by side, each terminal wider than 80 columns, redrawn without wrapping', async () => {
  const { ctx, page } = await open(2560, 1300, {}, { names: ['left', 'right', 'third'] });
  try {
    const sizes = await settled(page, 3);
    const rects = await panelRects(page);
    assert.ok(rects.every((r) => Math.abs(r.top - rects[0].top) < 1), 'all three in one row');
    assert.ok(rects[0].right <= rects[1].left && rects[1].right <= rects[2].left, 'left to right, no overlap');
    for (const s of sizes) assert.ok(s.cols > 80, `${s.name}: ${s.cols} columns (more than 80)`);
    await checkLayout(page, 'wide 2560');
    await checkTerminals(page, 'wide 2560');
    assert.equal(await page.locator('.divider.v').count(), 2, 'a divider between each pair');
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('wide 2560: drag a divider — terminals follow while dragging and on release, minimum 20×6, double-click resets', async () => {
  const { ctx, page } = await open(2560, 1300, {}, { names: ['left', 'right', 'third'] });
  try {
    const before = await settled(page, 3);
    const r0 = await panelRects(page);
    const d = center(await rectOf(page, '.divider.v', 0));
    let during;
    await mouseDrag(page, d.x, d.y, 300, 0, async () => {
      await page.waitForTimeout(600);
      during = tmuxSize('left');
    });
    const cols = (s) => Number(s.split('x')[0]);
    assert.ok(cols(during) > before[0].cols + 20, `tmux follows while dragging (${during} vs ${before[0].cols} columns before)`);
    const after1 = await settled(page, 3);
    const r1 = await panelRects(page);
    assert.ok(Math.abs(r1[0].width - (r0[0].width + 300)) < 2, `left panel 300 px wider (${r0[0].width} → ${r1[0].width})`);
    assert.ok(Math.abs(r1[1].width - (r0[1].width - 300)) < 2, 'right panel 300 px narrower');
    assert.ok(Math.abs(r1[2].width - r0[2].width) < 1, 'third panel unchanged');
    assert.ok(after1[0].cols > before[0].cols + 30 && after1[1].cols < before[1].cols - 30, 'columns follow the widths');
    await checkTerminals(page, 'after drag');
    await checkSelection(page, 'after drag'); // selection still hits the right character after a resize

    // minimum: drag the second divider onto the left edge of the right panel
    const d2 = center(await rectOf(page, '.divider.v', 1));
    await mouseDrag(page, d2.x, d2.y, r1[1].left + 5 - d2.x, 0);
    const mins = await settled(page, 3);
    assert.ok(mins[1].cols >= 20 && mins[1].cols <= 22, `right panel stops at about 20 columns (${mins[1].cols})`);
    await checkTerminals(page, 'at minimum');

    // double-click resets the row to equal sizes
    const d1 = center(await rectOf(page, '.divider.v', 0));
    await page.mouse.dblclick(d1.x, d1.y);
    await settled(page, 3);
    const r2 = await panelRects(page);
    assert.ok(Math.max(...r2.map((r) => r.width)) - Math.min(...r2.map((r) => r.width)) < 2, `equal widths again (${r2.map((r) => r.width.toFixed(1))})`);
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('wide 2560: maximize fills the area, click again restores the previous sizes; layout survives a reload', async () => {
  const { ctx, page } = await open(2560, 1300, {}, { names: ['left', 'right', 'third'] });
  try {
    const d = center(await rectOf(page, '.divider.v', 0));
    await mouseDrag(page, d.x, d.y, 200, 0);
    const sized = await settled(page, 3);
    const r0 = await panelRects(page);
    await page.click('.panel[data-name="right"] .max');
    const maxed = await settled(page, 3);
    const rm = await panelRects(page);
    const grid = await page.evaluate(() => { const e = document.getElementById('grid'); const cs = getComputedStyle(e); return e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); });
    assert.deepEqual(rm.filter((r) => r.visible).map((r) => r.name), ['right'], 'only the maximized panel is shown');
    assert.ok(Math.abs(rm[1].width - grid) < 1, `it fills the width (${rm[1].width} of ${grid})`);
    assert.ok(maxed[0].cols > 250, `and its terminal follows (${maxed[0].cols} columns)`);
    assert.equal(await page.getAttribute('.panel[data-name="right"] .max', 'aria-pressed'), 'true');
    await checkTerminals(page, 'maximized');

    await page.reload();
    await settled(page, 3);
    assert.deepEqual((await panelRects(page)).filter((r) => r.visible).map((r) => r.name), ['right'], 'still maximized after a reload');

    await page.click('.panel[data-name="right"] .max');
    const restored = await settled(page, 3);
    const r1 = await panelRects(page);
    r0.forEach((r, i) => assert.ok(Math.abs(r1[i].width - r.width) < 1, `${r.name}: previous width restored (${r.width} → ${r1[i].width})`));
    assert.deepEqual(restored.map((s) => s.cols), sized.map((s) => s.cols), 'and the previous terminal sizes');

    // a saved layout that doesn't fit this screen falls back to equal sizes
    await page.evaluate(() => localStorage.setItem('coord-dash.layout', JSON.stringify({ counts: [3], rows: [1], cols: [[0.98, 0.01, 0.01]], max: null })));
    await page.reload();
    await settled(page, 3);
    const r2 = await panelRects(page);
    assert.ok(Math.max(...r2.map((r) => r.width)) - Math.min(...r2.map((r) => r.width)) < 2, 'too-small saved sizes → equal sizes');
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

// Touch drag and double-tap through Chrome's own touch input (CDP), which produces pointer events
// with pointerType "touch" just like a finger on a tablet.
test('stacked 900 (tablet, touch): drag the divider between rows, double-tap resets', async () => {
  const { ctx, page } = await open(900, 1300, { hasTouch: true });
  try {
    const before = await settled(page, 2);
    const r0 = await panelRects(page);
    assert.ok(r0[0].bottom <= r0[1].top && Math.abs(r0[0].left - r0[1].left) < 1, 'panels stacked');
    assert.equal(await page.locator('.divider.h').count(), 1);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const d = center(await rectOf(page, '.divider.h'));
    await touch('touchStart', d.x, d.y);
    for (let k = 1; k <= 10; k++) await touch('touchMove', d.x, d.y + 15 * k);
    await touch('touchEnd');
    const after = await settled(page, 2);
    const r1 = await panelRects(page);
    assert.ok(Math.abs(r1[0].height - (r0[0].height + 150)) < 2, `top panel 150 px taller (${r0[0].height} → ${r1[0].height})`);
    assert.ok(after[0].rows > before[0].rows + 5 && after[1].rows < before[1].rows - 5, 'rows follow the heights');
    await checkTerminals(page, 'stacked after touch drag');
    const d2 = center(await rectOf(page, '.divider.h'));
    for (let k = 0; k < 2; k++) { await touch('touchStart', d2.x, d2.y); await touch('touchEnd'); }
    await settled(page, 2);
    const r2 = await panelRects(page);
    assert.ok(Math.abs(r2[0].height - r2[1].height) < 2, `double-tap: equal heights (${r2[0].height}, ${r2[1].height})`);
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('phone 375: one panel at a time with tabs, no dividers, the key bar serves the visible panel', async () => {
  const { ctx, page } = await open(375, 740, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    assert.equal(await page.locator('.divider').count(), 0, 'no dividers');
    assert.equal(await page.isVisible('#tabs'), true, 'tabs shown');
    assert.deepEqual((await panelRects(page)).filter((r) => r.visible).map((r) => r.name), ['left']);
    await page.tap('#tabs button[data-name="right"]');
    const [right] = await settled(page, 2);
    assert.equal(right.name, 'right');
    assert.deepEqual((await panelRects(page)).filter((r) => r.visible).map((r) => r.name), ['right'], 'tab switches the panel');
    assert.match(await page.textContent('#keybar .ktarget'), /right/, 'key bar targets the visible panel');
    assert.equal(await page.getAttribute('#tabs button[data-name="right"]', 'aria-selected'), 'true');
    assert.ok(right.cols >= 20 && right.cols < 60, `terminal fits the phone (${right.cols} columns)`);
    await checkTerminals(page, 'phone tab');
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('same session in two browsers: tapping the panel re-claims the size, the other browser does not take it back', async () => {
  const a = await open(1280, 800);
  const [aLeft] = await settled(a.page, 2);
  const b = await open(2560, 1300);
  try {
    const [bLeft, bRight] = await settled(b.page, 2); // b loaded last: its size is in tmux now
    assert.notEqual(aLeft.cols, bLeft.cols, 'test setup: different panel sizes');
    assert.equal(tmuxSize('left'), `${bLeft.cols}x${bLeft.rows} manual`);
    await a.page.waitForTimeout(1000); // a sees b's size: it shrinks its font, but must not resize tmux by itself
    assert.equal(tmuxSize('left'), `${bLeft.cols}x${bLeft.rows} manual`, 'an idle browser does not take the size back');
    // tap the panel a already targets: its size wins again
    const t = await termInfo(a.page, 0);
    await a.page.mouse.click(t.left + 5, t.top + 5);
    // only the tapped panel re-claims its session; "right" keeps b's size until tapped in a
    await a.page.waitForFunction((want) => {
      const p = document.querySelector('.panel[data-name="left"]');
      return p.querySelector('.state').textContent === want.replace('x', '×') &&
        [...p.querySelectorAll('.xterm-rows > div')].some((d) => d.textContent.includes(`size ${want}`));
    }, `${aLeft.cols}x${aLeft.rows}`, { timeout: 10000 });
    assert.equal(tmuxSize('left'), `${aLeft.cols}x${aLeft.rows} manual`, 'tapping the targeted panel re-claims the session');
    assert.equal(tmuxSize('right'), `${bRight.cols}x${bRight.rows} manual`, 'right keeps the size b gave it');
  } finally { await a.ctx.close(); await b.ctx.close(); }
});

test('POST /api/resize: login, same-origin header, session name and size are checked', async () => {
  const { ctx, page } = await open(1280, 800);
  try {
    const post = (body, headers = { 'Content-Type': 'application/json', 'X-Coord-Dash': '1' }, credentials = 'same-origin') =>
      page.evaluate(async ([b, h, c]) => (await fetch('/api/resize', { method: 'POST', headers: h, body: b, credentials: c })).status, [body, headers, credentials]);
    assert.equal(await post(JSON.stringify({ s: 'left', cols: 100, rows: 30 }), undefined, 'omit'), 401, 'no cookie → 401');
    assert.equal(await post(JSON.stringify({ s: 'left', cols: 100, rows: 30 }), { 'Content-Type': 'application/json' }), 403, 'no X-Coord-Dash → 403');
    assert.equal(await post(JSON.stringify({ s: 'left;kill-server', cols: 100, rows: 30 })), 400, 'bad name → 400');
    // allowed characters, but tmux only ever sees the exact target "=-t:", never an option
    assert.equal(await post(JSON.stringify({ s: '-t', cols: 100, rows: 30 })), 404, 'option-like name → no such session');
    assert.equal(await post(JSON.stringify({ s: 'left', cols: 19, rows: 30 })), 400, 'too narrow → 400');
    assert.equal(await post(JSON.stringify({ s: 'left', cols: '100', rows: 30 })), 400, 'string size → 400');
    assert.equal(await post('null'), 400, 'JSON null → 400');
    assert.equal(await post(JSON.stringify({ s: 'nosuch', cols: 100, rows: 30 })), 404, 'unknown session → 404');
    assert.equal(await post(JSON.stringify({ s: 'left', cols: 100, rows: 30 })), 200);
    assert.equal(tmuxSize('left'), '100x30 manual');
  } finally { await ctx.close(); }
});
