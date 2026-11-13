// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// Regenerates docs/screenshot-*.png: neutral fake sessions, isolated tmux server + coord-dash.
// Run: node scripts/screenshots.mjs   (needs the same setup as npm run test:browser)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfgFile = path.join(ROOT, 'test/browser.config.json'); // same machine settings as the browser test
const cfgLocal = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const { chromium } = await import(cfgLocal.playwrightCore || 'playwright-core');
const OUT = path.join(ROOT, 'docs');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-shot-'));
const sock = path.join(tmp, 'tmux.sock');
const tmux = (...a) => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' });

const E = '\x1b';
const coord = [
  `${E}[1;35m✻ coordinator${E}[0m  ·  demo session`,
  '',
  `${E}[36m>${E}[0m Run the test suite and fix anything that fails.`,
  '',
  `${E}[32m●${E}[0m Running the tests…`,
  `  ${E}[90m└  42 passed, 1 failed (test_parser.py::test_empty_input)${E}[0m`,
  '',
  `${E}[32m●${E}[0m The parser returns None for empty input; the test expects [].`,
  '  Fixing parse() to return an empty list.',
  '',
  `${E}[32m●${E}[0m Update(src/parser.py)`,
  `  ${E}[90m└  Updated src/parser.py with 2 additions and 1 removal${E}[0m`,
  '',
  `${E}[32m●${E}[0m Re-running the tests…`,
  `  ${E}[90m└  43 passed${E}[0m`,
  '',
  `${E}[32m●${E}[0m All tests pass. Ready for review.`,
  '',
  `${E}[90m────────────────────────────────────────────────────────────────────────${E}[0m`,
  `${E}[36m>${E}[0m `,
].join('\r\n');
const worker = [
  `${E}[1;34m✻ worker${E}[0m  ·  demo session`,
  '',
  `${E}[36m>${E}[0m Draft the changelog entry for this week.`,
  '',
  `${E}[32m●${E}[0m Reading the merged changes…`,
  `  ${E}[90m└  12 commits since last release${E}[0m`,
  '',
  `${E}[32m●${E}[0m Draft:`,
  '  ## 0.4.0',
  '  - Parser: empty input returns an empty list',
  '  - CLI: new --dry-run flag',
  '  - Docs: install guide updated',
  '',
  `${E}[33m?${E}[0m Add the draft to CHANGELOG.md?`,
  `  ${E}[1m❯ 1. Yes${E}[0m`,
  '    2. No, keep editing',
].join('\r\n');
fs.writeFileSync(path.join(tmp, 'a.txt'), coord);
fs.writeFileSync(path.join(tmp, 'b.txt'), worker);
tmux('new-session', '-d', '-s', 'coordinator', '-x', '96', '-y', '28', `printf '%s' "$(cat ${tmp}/a.txt)"; exec sleep 100000`);
tmux('new-session', '-d', '-s', 'worker', '-x', '96', '-y', '28', `printf '%s' "$(cat ${tmp}/b.txt)"; exec sleep 100000`);

const PASSWORD = 'screenshot-password';
const salt = crypto.randomBytes(16);
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  host: '127.0.0.1', port: 7698, sessions: ['coordinator', 'worker'], pollMs: 200, tmuxSocket: sock, secureCookie: false,
  passwordHash: `scrypt$${salt.toString('base64')}$${crypto.scryptSync(PASSWORD, salt, 32).toString('base64')}`,
  cookieSecret: crypto.randomBytes(32).toString('base64url'),
}), { mode: 0o600 });
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, COORD_DASH_CONFIG: cfgPath } });
await new Promise((ok) => server.stdout.on('data', (d) => /listening/.test(d) && ok()));
const env = { ...process.env };
if (cfgLocal.libDir) env.LD_LIBRARY_PATH = [cfgLocal.libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
if (cfgLocal.fontsConf) env.FONTCONFIG_FILE = cfgLocal.fontsConf;
const browser = await chromium.launch({ executablePath: cfgLocal.chrome || undefined, env });
try {
  for (const [name, w, h, opts] of [['screenshot-desktop', 1280, 720, {}], ['screenshot-phone', 390, 760, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:7698/login');
    await page.fill('#pw', PASSWORD);
    await page.click('#login button');
    await page.waitForURL('http://127.0.0.1:7698/');
    // every visible panel (a phone shows one at a time) has its demo text
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 2 &&
      [...document.querySelectorAll('.panel')].filter((p) => p.offsetParent !== null)
        .every((p) => /demo session/.test(p.querySelector('.xterm-rows')?.textContent || '')));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
  tmux('kill-server');
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('ok');
