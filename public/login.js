// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Coord-Dash': '1' },
    body: JSON.stringify({ password: document.getElementById('pw').value }),
  });
  if (r.ok) location.href = '/';
  else err.textContent = (await r.json().catch(() => ({}))).error || `Error ${r.status}`;
});
