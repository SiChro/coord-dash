// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// coord-dash pure helpers: no DOM access, so they run in the browser and under `node --test`.
'use strict';
(function (root) {
  // Text of the rows currently in view (respects scrollback position), right-trimmed,
  // without trailing blank lines.
  function visibleText(buffer, rows) {
    const out = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + rows; y++) {
      const line = buffer.getLine(y);
      out.push(line ? line.translateToString(true) : '');
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  // What Copy puts on the clipboard: the selection if there is one, else the visible screen.
  function copyText(term) {
    if (term.hasSelection()) {
      const s = term.getSelection();
      if (s) return s;
    }
    return visibleText(term.buffer.active, term.rows);
  }

  // Font size that makes a terminal measured at `font` px (width × height) fit availW × availH.
  // availH 0 = fit width only. Below `min` by width, keep `min` and let the panel scroll
  // sideways (pan). Sizes are floored to 0.25 px so repeated fits settle instead of creeping.
  function fitFontSize({ font, width, height, availW, availH, min, max }) {
    if (!(width > 0) || !(availW > 0)) return { size: font, pan: false };
    const byW = (font * availW) / width;
    if (byW < min) return { size: min, pan: true };
    const byH = availH > 0 && height > 0 ? (font * availH) / height : Infinity;
    const size = Math.min(max, Math.max(min, Math.min(byW, byH)));
    return { size: Math.floor(size * 4) / 4, pan: false };
  }

  // ---- terminal size and panel layout (resizable panels)

  // Limits for a panel's terminal. The server enforces the same range (server.js SIZE).
  const MIN_COLS = 20;
  const MIN_ROWS = 6;
  const MAX_COLS = 500;
  const MAX_ROWS = 200;

  // Columns × rows that fit width × height px with cells of cellW × cellH px, clamped to the
  // limits. null while nothing is measured (hidden panel, fonts not loaded).
  function termSize({ width, height, cellW, cellH }) {
    if (!(width > 0) || !(height > 0) || !(cellW > 0) || !(cellH > 0)) return null;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return {
      cols: clamp(Math.floor(width / cellW), MIN_COLS, MAX_COLS),
      rows: clamp(Math.floor(height / cellH), MIN_ROWS, MAX_ROWS),
    };
  }

  // Smallest panel in px: the minimum terminal plus the panel's own chrome (header, message box,
  // borders, scrollbar room).
  function minPanelPx({ cellW, cellH, chromeW, chromeH }) {
    return { w: Math.ceil(MIN_COLS * cellW + chromeW), h: Math.ceil(MIN_ROWS * cellH + chromeH) };
  }

  // How many panels go side by side in one row: as many as fit at colPx each, at least 1.
  function columnCount(width, n, colPx) {
    if (n < 1) return 0;
    return Math.min(n, Math.max(1, Math.floor(width / colPx)));
  }

  // Panels per row, filled left to right: 5 panels at 2 per row → [2, 2, 1].
  function rowCounts(n, perRow) {
    const out = [];
    for (let left = n; left > 0 && perRow > 0; left -= perRow) out.push(Math.min(perRow, left));
    return out;
  }

  const equalSizes = (k) => Array.from({ length: k }, () => 1 / k);

  // Move the divider between item i and i+1 by deltaPx. fr = fractions (sum 1) of totalPx.
  // Both neighbours keep at least minPx; the others don't change. Returns new fractions.
  function dragSplit(fr, i, deltaPx, totalPx, minPx) {
    if (!(totalPx > 0) || i < 0 || i + 1 >= fr.length) return fr.slice();
    const px = fr.map((f) => f * totalPx);
    const pair = px[i] + px[i + 1];
    if (pair < 2 * minPx) return fr.slice(); // already below the minimum: don't make it worse
    const a = Math.min(pair - minPx, Math.max(minPx, px[i] + deltaPx));
    px[i] = a;
    px[i + 1] = pair - a;
    return px.map((v) => v / totalPx);
  }

  const validFr = (a, k) =>
    Array.isArray(a) && a.length === k && a.every((v) => Number.isFinite(v) && v > 0) &&
    Math.abs(a.reduce((s, v) => s + v, 0) - 1) < 1e-6;

  // Layout to use: the saved one if it has the same shape (panels per row) and every panel is
  // at least minW × minH on this screen, else equal sizes. The maximized panel is kept if it
  // is still open. Shape: { counts, rows: [fr per row], cols: [[fr per panel] per row], max }.
  // width × height = the panel area in px; each divider between panels takes `divider` px.
  function restoreLayout(saved, { counts, width, height, divider = 0, minW, minH, names }) {
    const equal = { counts: counts.slice(), rows: equalSizes(counts.length), cols: counts.map(equalSizes), max: null };
    if (!saved || typeof saved !== 'object') return equal;
    const max = typeof saved.max === 'string' && names.includes(saved.max) ? saved.max : null;
    const sameShape = Array.isArray(saved.counts) && saved.counts.length === counts.length &&
      saved.counts.every((c, i) => c === counts[i]);
    const fits = sameShape && validFr(saved.rows, counts.length) &&
      saved.rows.every((f) => f * (height - (counts.length - 1) * divider) >= minH) &&
      counts.every((c, r) => Array.isArray(saved.cols) && validFr(saved.cols[r], c) &&
        saved.cols[r].every((f) => f * (width - (c - 1) * divider) >= minW));
    if (!fits) return { ...equal, max };
    return { counts: counts.slice(), rows: saved.rows.slice(), cols: saved.cols.map((r) => r.slice()), max };
  }

  root.CoordDashLib = {
    visibleText, copyText, fitFontSize,
    MIN_COLS, MIN_ROWS, MAX_COLS, MAX_ROWS,
    termSize, minPanelPx, columnCount, rowCounts, equalSizes, dragSplit, restoreLayout,
  };
})(globalThis);
