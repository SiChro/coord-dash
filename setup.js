#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// Interactive setup: writes ~/.config/coord-dash/config.json (mode 600).
//   node setup.js            create or update (keeps existing values as defaults)
//   node setup.js --rotate   also rotate the cookie secret (logs out every browser)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CONFIG_PATH =
  process.env.COORD_DASH_CONFIG || path.join(os.homedir(), '.config', 'coord-dash', 'config.json');

let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {}

let running = [];
try {
  running = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean);
} catch {}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
// Hidden input: while a password is asked, echo only the prompt (readline re-draws
// "prompt + typed text" on every key), never the typed characters.
let hiddenPrompt = null;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  if (hiddenPrompt === null) return write(s);
  if (s.startsWith(hiddenPrompt)) write(hiddenPrompt);
  else if (/[\r\n]/.test(s)) write('\n');
};
const ask = (q, def) =>
  new Promise((r) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => r(a.trim() || def || '')));
const askHidden = (q) =>
  new Promise((r) => {
    hiddenPrompt = q;
    rl.question(q, (a) => {
      hiddenPrompt = null;
      r(a);
    });
  });

console.log(`coord-dash setup -> ${CONFIG_PATH}`);
if (running.length) console.log(`tmux sessions running now: ${running.join(', ')}`);

let passwordHash = existing.passwordHash;
const change = !passwordHash || (await ask('Change password? (y/N)', 'n')).toLowerCase().startsWith('y');
if (change) {
  for (;;) {
    const a = await askHidden('New dashboard password (min 12 chars): ');
    if (a.length < 12) {
      console.log('Too short.');
      continue;
    }
    const b = await askHidden('Repeat password: ');
    if (a !== b) {
      console.log('Passwords differ.');
      continue;
    }
    const salt = crypto.randomBytes(16);
    passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(a, salt, 32).toString('base64')}`;
    break;
  }
}

const defSessions = (existing.sessions || running).join(',');
const sessions = (await ask('Sessions shown by default (comma-separated)', defSessions))
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
const host = await ask('Listen address (127.0.0.1 behind tailscale serve, or your 100.x Tailscale IP)', existing.host || '127.0.0.1');
const port = Number(await ask('Port', String(existing.port || 7681)));
const logins = (
  await ask('Allowed Tailscale logins, comma-separated (empty = any tailnet user; needs tailscale serve)', (existing.allowedTailscaleLogins || []).join(','))
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
rl.close();

const cfg = {
  ...existing,
  host,
  port,
  sessions,
  allowedTailscaleLogins: logins,
  passwordHash,
  cookieSecret:
    process.argv.includes('--rotate') || !existing.cookieSecret ? crypto.randomBytes(32).toString('base64url') : existing.cookieSecret,
};
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(CONFIG_PATH, 0o600);
console.log(`Saved ${CONFIG_PATH}`);
