#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// coord-dash — watch and message tmux sessions from a browser.
//
// Design (see README):
// - Never attaches a tmux client. Output comes from `tmux capture-pane`, input goes
//   through `tmux send-keys` / `paste-buffer`. The only thing the browser changes about a
//   window is its size (`/api/resize`: window-size manual + resize-window), so each terminal
//   matches its panel.
// - Zero npm dependencies on the server: node:http + tmux. xterm.js is vendored for the UI.
// - Listens only on loopback (behind `tailscale serve`) or a Tailscale address.
// - Password login (scrypt) with an HMAC-signed, HttpOnly, SameSite=Strict cookie,
//   optionally restricted further to Tailscale identities.

import http from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH =
  process.env.COORD_DASH_CONFIG || path.join(os.homedir(), '.config', 'coord-dash', 'config.json');

const COOKIE = 'cd_session';
const SESSION_DAYS = 30;
const MAX_STREAMS = 24;
const MAX_TEXT = 20000;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Keys the UI may send: button id -> tmux key names, sent in order by one `send-keys`.
// A chord like 'C-x C-s' is one allow-listed id that expands to several keys.
// Exactly the keys that have a button in public/index.html (a test checks this). Never add
// C-d or C-z. C-b goes straight to the pane: send-keys bypasses the tmux prefix.
export const KEYS = new Map(
  [
    // bottom bar
    'Left', 'Right', 'Up', 'Down', 'Enter', 'Escape', 'BTab', 'C-c',
    // ☰ Ctrl sheet
    'C-b', 'C-x C-s', 'Escape Escape', 'C-x C-k C-x C-k',
    'C-o', 'C-t', 'C-r', 'C-l',
    'C-s', 'C-j', 'C-_', 'C-w', 'C-u',
  ].map((id) => [id, id.split(' ')]),
);

// tmux argv for an allow-listed key id, or null if the id is not allowed.
export function keyArgs(key, tgt) {
  const seq = typeof key === 'string' ? KEYS.get(key) : undefined;
  return seq ? ['send-keys', '-t', tgt, ...seq] : null;
}

// Terminal size a browser panel may ask for (same limits as public/lib.js).
export const SIZE = { minCols: 20, minRows: 6, maxCols: 500, maxRows: 200 };

// tmux argv that pins the window to cols × rows, or null if the size is out of range.
// window-size manual: tmux keeps this size instead of following attached clients
// (sessions started in the background would otherwise stay at default-size, 80×24).
export function resizeArgs(tgt, cols, rows) {
  const ok = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!ok(cols, SIZE.minCols, SIZE.maxCols) || !ok(rows, SIZE.minRows, SIZE.maxRows)) return null;
  return ['set-option', '-w', '-t', tgt, 'window-size', 'manual', ';',
    'resize-window', '-t', tgt, '-x', String(cols), '-y', String(rows)];
}

// ---------------------------------------------------------------- config

function die(msg) {
  console.error(`coord-dash: ${msg}`);
  process.exit(1);
}

export function isAllowedHost(h) {
  if (h === '127.0.0.1' || h === '::1' || h === 'localhost') return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127; // Tailscale CGNAT range 100.64.0.0/10
  }
  if (net.isIPv6(h)) return h.toLowerCase().startsWith('fd7a:115c:a1e0:'); // Tailscale ULA
  return false;
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    die(`cannot read ${CONFIG_PATH} (${e.message}). Run: node setup.js`);
  }
  if (fs.statSync(CONFIG_PATH).mode & 0o077) die(`${CONFIG_PATH} must not be readable by others: chmod 600 it`);
  const cfg = {
    host: '127.0.0.1',
    port: 7681,
    sessions: [],
    pollMs: 500,
    allowedTailscaleLogins: [],
    tmuxSocket: null,
    ...raw,
  };
  if (!/^scrypt\$/.test(cfg.passwordHash || '')) die('passwordHash missing. Run: node setup.js');
  if (!cfg.cookieSecret || cfg.cookieSecret.length < 32) die('cookieSecret missing. Run: node setup.js');
  if (!isAllowedHost(cfg.host))
    die(`refusing to listen on "${cfg.host}": use 127.0.0.1 (behind tailscale serve) or this machine's 100.x Tailscale IP`);
  if (cfg.secureCookie === undefined) cfg.secureCookie = cfg.host === '127.0.0.1' || cfg.host === '::1' || cfg.host === 'localhost';
  cfg.pollMs = Math.min(5000, Math.max(200, Number(cfg.pollMs) || 500));
  cfg.sessions = (cfg.sessions || []).filter((s) => NAME_RE.test(s));
  return cfg;
}

// ---------------------------------------------------------------- crypto helpers

function sign(cfg, data) {
  return crypto.createHmac('sha256', cfg.cookieSecret).update(`v1.${data}`).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function verifyPassword(stored, password) {
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

// ---------------------------------------------------------------- tmux

function tmux(cfg, args, input) {
  const full = cfg.tmuxSocket ? ['-S', cfg.tmuxSocket, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', full, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || err.message).trim();
        reject(err);
      } else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// `=name:` = exact session name, its current window's active pane.
const target = (name) => `=${name}:`;

async function listSessions(cfg) {
  try {
    const out = await tmux(cfg, ['list-sessions', '-F', '#{session_name}']);
    return out.split('\n').filter((s) => NAME_RE.test(s));
  } catch {
    return []; // no tmux server running
  }
}

const FMT = '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{history_size} #{pane_id}';
const SPLIT = '@@coord-dash-split@@';
const PEEK = 60; // history lines read on every poll to find what scrolled off since the last one
export const MAX_HISTORY = 3000; // scrollback lines kept per session and sent to new viewers

// One atomic tmux call: pane info, the last `histLines` lines of scrollback, the visible screen.
async function snapshot(cfg, name, histLines) {
  const t = target(name);
  const out = await tmux(cfg, [
    'display-message', '-p', '-t', t, FMT, ';',
    'capture-pane', '-p', '-e', '-S', `-${histLines}`, '-E', '-1', '-t', t, ';',
    'display-message', '-p', '-t', t, SPLIT, ';',
    'capture-pane', '-p', '-e', '-t', t,
  ]);
  const nl = out.indexOf('\n');
  const [cols, rows, cx, cy, cursor, hs] = out.slice(0, nl).split(' ').map(Number);
  const pane = out.slice(0, nl).split(' ')[6];
  const rest = out.slice(nl + 1);
  const cut = rest.startsWith(`${SPLIT}\n`) ? 0 : rest.indexOf(`\n${SPLIT}\n`) + 1;
  const n = Math.min(histLines, hs); // with no history tmux still prints one empty line
  const hist = n ? rest.slice(0, cut).replace(/\n$/, '').split('\n').slice(-n) : [];
  const lines = rest.slice(cut + SPLIT.length + 1).replace(/\n$/, '').split('\n');
  return { pane, hs, hist, screen: { cols, rows, cx, cy, cursor: cursor === 1, lines } };
}

// capture-pane -e only emits colour changes, so a line can depend on the lines before it.
// Prefix every line with the attributes active at its start so lines can be sent separately.
const SGR = /\x1b\[([0-9;:]*)m/g;
export function selfContained(lines) {
  let state = [];
  return lines.map((l) => {
    const out = `\x1b[0m${state.join('')}${l}`;
    for (const m of l.matchAll(SGR)) {
      if (m[1] === '' || m[1] === '0') state = [];
      else if (m[1].startsWith('0;')) state = [m[0]];
      else if (state.push(m[0]) > 24) state.shift();
    }
    return out;
  });
}
const plain = (l) => l.replace(/\x1b\[[0-9;:]*m/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendText(cfg, name, text, enter) {
  const t = target(name);
  if (text) {
    if (text.includes('\n')) {
      // Multi-line: paste as one bracketed paste so newlines don't submit early.
      const buf = `coord-dash-${process.pid}`;
      await tmux(cfg, ['load-buffer', '-b', buf, '-'], text);
      await tmux(cfg, ['paste-buffer', '-p', '-d', '-b', buf, '-t', t]);
    } else {
      await tmux(cfg, ['send-keys', '-t', t, '-l', '--', text]);
    }
  }
  if (enter) {
    if (text) await sleep(150); // let the TUI process the text before submitting
    await tmux(cfg, ['send-keys', '-t', t, 'Enter']);
  }
}

// One poller per watched session, shared by all browser tabs, stopped when nobody watches.
// It keeps the session's scrollback and sends viewers only the lines that are new since the
// last poll; a new viewer (or anything it can't line up) gets the full history ("reset").
class Watcher {
  constructor(cfg, name, onEmpty) {
    Object.assign(this, { cfg, name, onEmpty, clients: new Set(), timer: null, busy: false });
    this.clear();
  }
  clear() {
    Object.assign(this, { key: null, hs: 0, history: [], screen: null, screenJson: null, gone: null });
  }
  add(res) {
    this.clients.add(res);
    if (this.screen) sse(res, 'screen', JSON.stringify({ ...this.screen, reset: true, hist: this.history }));
    else if (this.gone) sse(res, 'gone', this.gone);
    if (!this.timer) {
      this.tick();
      this.timer = setInterval(() => this.tick(), this.cfg.pollMs);
    }
  }
  remove(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) {
      clearInterval(this.timer);
      this.onEmpty(this.name);
    }
  }
  // Which of the peeked history lines are new? Returns them, or null if they can't be lined up.
  newLines(snap) {
    const peek = snap.hist;
    const peekPlain = peek.map(plain);
    const tail = this.history.slice(-PEEK).map(plain);
    const guess = snap.hs - this.hs;
    const tries = guess >= 0 && guess <= peek.length ? [guess] : [];
    for (let d = 0; d <= peek.length; d++) if (d !== guess) tries.push(d);
    for (const d of tries) {
      const overlap = peek.length - d;
      if (overlap === 0) {
        if (this.history.length === 0 && snap.hs === peek.length) return selfContained(peek);
        continue;
      }
      const w = Math.min(overlap, 30, tail.length);
      if (w === 0) continue;
      let ok = true;
      for (let i = 1; i <= w && ok; i++) ok = peekPlain[overlap - i] === tail[tail.length - i];
      if (ok) return selfContained(peek).slice(overlap);
    }
    return null;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      let snap = await snapshot(this.cfg, this.name, PEEK);
      const key = `${snap.pane} ${snap.screen.cols}`;
      let hist = key === this.key ? this.newLines(snap) : null;
      const reset = hist === null;
      if (reset) {
        snap = await snapshot(this.cfg, this.name, MAX_HISTORY);
        hist = this.history = selfContained(snap.hist);
        this.key = `${snap.pane} ${snap.screen.cols}`;
      } else if (hist.length) {
        this.history.push(...hist);
        if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      }
      this.hs = snap.hs;
      this.gone = null;
      const screenJson = JSON.stringify(snap.screen);
      if (reset || hist.length || screenJson !== this.screenJson) {
        this.screen = snap.screen;
        this.screenJson = screenJson;
        const data = JSON.stringify({ ...snap.screen, reset, hist });
        for (const c of this.clients) sse(c, 'screen', data);
      }
    } catch {
      if (!this.gone) {
        this.clear();
        this.gone = JSON.stringify({ error: `tmux session "${this.name}" not found` });
        for (const c of this.clients) sse(c, 'gone', this.gone);
      }
    } finally {
      this.busy = false;
    }
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

// ---------------------------------------------------------------- http helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (v === null || typeof v !== 'object') throw new Error('not an object');
        resolve(v);
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- server

export function createServer(cfg) {
  const watchers = new Map();
  let streams = 0;
  const failures = []; // timestamps of failed logins (global; behind a proxy all IPs look alike)

  function tailscaleOk(req) {
    if (!cfg.allowedTailscaleLogins.length) return true;
    const login = req.headers['tailscale-user-login'];
    return typeof login === 'string' && cfg.allowedTailscaleLogins.includes(login);
  }

  function authed(req) {
    if (!tailscaleOk(req)) return false;
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok) return false;
    const [exp, mac] = tok.split('.');
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(mac, sign(cfg, exp));
  }

  // CSRF: state-changing requests must be same-origin JSON with a custom header.
  function sameOrigin(req) {
    if (req.headers['x-coord-dash'] !== '1') return false;
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      return host === req.headers.host || host === req.headers['x-forwarded-host'];
    } catch {
      return false;
    }
  }

  function cookie(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cfg.secureCookie ? '; Secure' : ''}`;
  }

  function serveStatic(res, rel) {
    const file = path.resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
    const type = MIME[path.extname(file)];
    if (!type) return send(res, 404, 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      send(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    });
  }

  function sessionParam(url) {
    const s = url.searchParams.get('s') || '';
    return NAME_RE.test(s) ? s : null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (!tailscaleOk(req)) return send(res, 403, 'forbidden');

    // ---- public
    if (req.method === 'GET' && p === '/login') return serveStatic(res, '/login.html');
    if (req.method === 'GET' && (p.startsWith('/vendor/') || ['/login.js', '/style.css', '/icon.svg'].includes(p)))
      return serveStatic(res, p);

    if (req.method === 'POST' && p === '/api/login') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
      const now = Date.now();
      while (failures.length && failures[0] < now - 10 * 60e3) failures.shift();
      if (failures.length >= 10) return send(res, 429, { error: 'too many attempts, wait 10 minutes' });
      const body = await readJson(req);
      if (typeof body.password === 'string' && verifyPassword(cfg.passwordHash, body.password)) {
        const exp = String(now + SESSION_DAYS * 86400e3);
        console.log(`login ok (${req.headers['tailscale-user-login'] || 'no tailscale identity'})`);
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(`${exp}.${sign(cfg, exp)}`, SESSION_DAYS * 86400) });
      }
      failures.push(now);
      console.warn(`login failed (${failures.length} in last 10 min)`);
      await sleep(1000);
      return send(res, 401, { error: 'wrong password' });
    }

    // ---- everything below requires a session
    if (!authed(req)) {
      if (req.method === 'GET' && p === '/') return send(res, 302, '', { Location: '/login' });
      return send(res, 401, { error: 'login required' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, '/index.html');
    if (req.method === 'GET' && (p === '/app.js' || p === '/lib.js')) return serveStatic(res, p);

    if (req.method === 'POST' && p === '/api/logout') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }

    if (req.method === 'GET' && p === '/api/sessions') {
      return send(res, 200, { configured: cfg.sessions, running: await listSessions(cfg) });
    }

    if (req.method === 'GET' && p === '/api/stream') {
      const name = sessionParam(url);
      if (!name) return send(res, 400, { error: 'bad session name' });
      if (streams >= MAX_STREAMS) return send(res, 503, { error: 'too many open streams' });
      streams++;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      let w = watchers.get(name);
      if (!w) {
        w = new Watcher(cfg, name, (n) => watchers.delete(n));
        watchers.set(name, w);
      }
      w.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        streams--;
        w.remove(res);
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/history') {
      const name = sessionParam(url);
      if (!name) return send(res, 400, { error: 'bad session name' });
      const lines = Math.min(10000, Math.max(100, Number(url.searchParams.get('lines')) || 3000));
      try {
        const t = target(name);
        const out = await tmux(cfg, ['display-message', '-p', '-t', t, '#{pane_width}', ';', 'capture-pane', '-p', '-e', '-S', `-${lines}`, '-t', t]);
        const nl = out.indexOf('\n');
        return send(res, 200, { cols: Number(out.slice(0, nl)), lines: out.slice(nl + 1).replace(/\n$/, '').split('\n') });
      } catch (e) {
        return send(res, 404, { error: e.message });
      }
    }

    if (req.method === 'POST' && p === '/api/resize') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
      const body = await readJson(req);
      const name = typeof body.s === 'string' && NAME_RE.test(body.s) ? body.s : null;
      if (!name) return send(res, 400, { error: 'bad session name' });
      const args = resizeArgs(target(name), body.cols, body.rows);
      if (!args) return send(res, 400, { error: 'bad size' });
      try {
        await tmux(cfg, args);
      } catch (e) {
        return send(res, 404, { error: e.message });
      }
      setTimeout(() => watchers.get(name)?.tick(), 60); // give the program a moment to redraw (SIGWINCH)
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && (p === '/api/send' || p === '/api/key')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
      const body = await readJson(req);
      const name = typeof body.s === 'string' && NAME_RE.test(body.s) ? body.s : null;
      if (!name) return send(res, 400, { error: 'bad session name' });
      try {
        if (p === '/api/key') {
          const args = keyArgs(body.key, target(name));
          if (!args) return send(res, 400, { error: 'key not allowed' });
          await tmux(cfg, args);
          console.log(`key ${body.key} -> ${name}`);
        } else {
          if (typeof body.text !== 'string' || body.text.length > MAX_TEXT) return send(res, 400, { error: 'bad text' });
          // Drop control characters (except newline/tab) so text can't smuggle key sequences.
          const text = body.text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
          await sendText(cfg, name, text, body.enter !== false);
          console.log(`text (${text.length} chars${body.enter !== false ? ' + Enter' : ''}) -> ${name}`);
        }
      } catch (e) {
        return send(res, 404, { error: e.message });
      }
      setTimeout(() => watchers.get(name)?.tick(), 120);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error(e);
    });
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const server = createServer(cfg);
  server.on('error', (e) => die(`cannot listen on ${cfg.host}:${cfg.port}: ${e.code || e.message}${e.code === 'EADDRNOTAVAIL' ? ' (is Tailscale up? check `tailscale ip -4`)' : ''}`));
  server.listen(cfg.port, cfg.host, () => {
    console.log(`coord-dash listening on http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`);
    console.log(`config ${CONFIG_PATH}; default sessions: ${cfg.sessions.join(', ') || '(none)'}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
