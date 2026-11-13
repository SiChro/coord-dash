// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// Test fixture for test/browser.test.mjs: a tiny full-screen program that behaves like Claude
// Code on a resize. It prints 300 short history lines (they fit any width), then fills the
// screen with tokens "r007c14" (row 7, token 14), as many per row as fit, and "size COLSxROWS"
// on the last row. On every resize (SIGWINCH) it redraws for the new size.
'use strict';
const out = process.stdout;
let hist = '';
for (let i = 0; i < 300; i++) hist += `r${500 + i}c00 r${500 + i}c01\n`;
out.write(hist);

function draw() {
  const cols = out.columns;
  const rows = out.rows;
  const n = Math.floor((cols + 1) / 8);
  let s = '\x1b[H';
  for (let r = 0; r < rows - 1; r++) {
    const t = [];
    for (let c = 0; c < n; c++) t.push(`r${String(r).padStart(3, '0')}c${String(c).padStart(2, '0')}`);
    s += `${t.join(' ')}\x1b[K\r\n`;
  }
  out.write(`${s}size ${cols}x${rows}\x1b[K\x1b[J`);
}
draw();
out.on('resize', draw);
setInterval(() => {}, 1e9);
