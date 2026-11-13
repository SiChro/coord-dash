// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// scripts/start-sessions.sh against a fake `tmux` on PATH that only records its arguments.
// No real tmux server is ever contacted, so this is safe to run inside a tmux session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'start-sessions.sh');

// Fake tmux: logs every call; `has-session -t =running` succeeds, every other session is absent.
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "$1" = has-session ]; then [ "$3" = "=running" ] && exit 0; exit 1; fi
exit 0
`;

function run(sessions, { file } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-dash-start-'));
  const bin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'), FAKE_TMUX, { mode: 0o755 });
  const log = path.join(tmp, 'tmux.log');
  fs.writeFileSync(log, '');
  const list = path.join(tmp, 'sessions');
  if (sessions !== null) fs.writeFileSync(list, sessions);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_TMUX_LOG: log };
  const r = spawnSync('/bin/sh', [SCRIPT, file ?? list], { env, encoding: 'utf8' });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr, calls, home };
}

test('starts a session in its directory and types the command, then Enter', () => {
  const r = run('coord | ~/proj | claude --resume\n');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, [
    'has-session -t =coord',
    `new-session -d -s coord -c ${r.home}/proj`,
    'send-keys -t =coord: -l -- claude --resume',
    'send-keys -t =coord: Enter',
  ]);
  assert.match(r.out, /started coord/);
});

test('no command: just a shell; empty directory means $HOME', () => {
  const r = run('worker | ~/proj |\nplain |  |\n');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, [
    'has-session -t =worker',
    `new-session -d -s worker -c ${r.home}/proj`,
    'has-session -t =plain',
    `new-session -d -s plain -c ${r.home}`,
  ]);
});

test('a running session is left alone', () => {
  const r = run('running | ~/proj | claude\n');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, ['has-session -t =running']);
  assert.match(r.out, /running already running/);
});

test('comments, blank lines and a last line without newline', () => {
  const r = run('# a comment\n\n   \nlast | ~/proj | claude');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.filter((c) => c.startsWith('new-session')), [`new-session -d -s last -c ${r.home}/proj`]);
});

test('bad names and missing directories are skipped, the rest still start, exit 1', () => {
  const r = run('bad;name | ~/proj | x\n-t | ~/proj |\nnodir | ~/missing | x\nok | ~/proj |\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /skipping "bad;name"/);
  assert.match(r.err, /skipping nodir: no directory/);
  // "-t" is a valid name; tmux only ever sees it as the exact target "=-t".
  assert.deepEqual(r.calls.filter((c) => c.startsWith('new-session')), [
    `new-session -d -s -t -c ${r.home}/proj`,
    `new-session -d -s ok -c ${r.home}/proj`,
  ]);
  assert.ok(!r.calls.some((c) => c.includes('bad;name') || c.includes('nodir')));
});

test('missing sessions file: clear error, exit 1, tmux never called', () => {
  const r = run(null, { file: '/nonexistent/coord-dash/sessions' });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot read \/nonexistent\/coord-dash\/sessions/);
  assert.deepEqual(r.calls, []);
});
