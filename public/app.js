// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Simon Chromec
// coord-dash browser client. Renders tmux capture-pane snapshots into read-only xterm.js
// terminals; input goes to the server, which uses tmux send-keys.
/* global Terminal, Unicode11Addon */
'use strict';

const STORE = 'coord-dash.panels';
const grid = document.getElementById('grid');
const tpl = document.getElementById('panel-tpl');
const addSel = document.getElementById('add');
const panels = new Map(); // name -> panel state

const store = {
  get() {
    try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
  },
  set(v) {
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode */ }
  },
};

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Coord-Dash': '1' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function makeTerm(opts) {
  const t = new Terminal({
    disableStdin: true,
    cursorBlink: false,
    fontSize: 13,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", Consolas, monospace',
    allowProposedApi: true,
    scrollback: 3000,
    theme: { background: '#0f1115', foreground: '#d7dae0' },
    ...opts,
  });
  t.loadAddon(new Unicode11Addon.Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}

const {
  fitFontSize, copyText, termSize, minPanelPx, columnCount, rowCounts, equalSizes, dragSplit, restoreLayout,
} = window.CoordDashLib;
const wide = window.matchMedia('(min-width: 601px)');
const FONT = { wide: 13, phone: 11 }; // terminal font size in px
const baseFont = () => (wide.matches ? FONT.wide : FONT.phone);
const SCROLLBAR = 14; // room right of the text for the scrollbar (.term .xterm padding-right)
const DIVIDER = 12; // px: grab area between panels
const COL_PX = 480; // a row holds as many panels side by side as fit at this width
const USER_SCROLL_MS = 1000; // scroll events this soon after wheel/touch/drag input are the user's
let fontsReady = false;

// ---------------------------------------------------------------- terminal size
// Each tmux window is resized to what fits its panel at the base font (POST /api/resize,
// tmux resize-window + window-size manual). Until tmux has caught up (or when another browser
// set a different size) the terminal is fitted by shrinking the font, never with a CSS
// transform: xterm maps mouse clicks with its own cell size, so a scaled terminal would
// select the wrong characters.

// Cell size at a font size, measured by a hidden probe terminal (same font, same renderer).
const probes = new Map();
function cellAt(font) {
  const key = `${font}@${window.devicePixelRatio}`;
  let probe = probes.get(key);
  if (!probe) {
    const el = Object.assign(document.createElement('div'), { className: 'probe term' });
    el.setAttribute('aria-hidden', 'true');
    document.body.append(el);
    probe = makeTerm({ cols: 10, rows: 4, fontSize: font });
    probe.open(el);
    probes.set(key, probe);
  }
  return cellOf(probe);
}
function cellOf(t) {
  // xterm 5 keeps the exact cell size internally (vendored, fixed version); the screen
  // element's size divided by cols/rows is the fallback.
  const d = t._core?._renderService?.dimensions?.css?.cell;
  if (d && d.width > 0 && d.height > 0) return { w: d.width, h: d.height };
  const r = t.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  return r && r.width > 0 ? { w: r.width / t.cols, h: r.height / t.rows } : null;
}
function resetProbes() {
  probes.forEach((t) => { t.element?.parentElement?.remove(); t.dispose(); });
  probes.clear();
}

// Columns × rows that fit the panel's screen area, or null (hidden, not measured yet).
function wantSize(p) {
  if (!fontsReady || p.closed || !p.screen.offsetWidth) return null;
  const cell = cellAt(baseFont());
  if (!cell) return null;
  // offset*, not client*: the sideways-panning scrollbar (.pan) must not change the wanted size
  return termSize({ width: p.screen.offsetWidth - SCROLLBAR, height: p.screen.offsetHeight, cellW: cell.w, cellH: cell.h });
}

// Ask tmux for the panel's size. One request per session at a time, at most every 100 ms;
// only the newest wanted size is sent. force: send even if tmux already has that size
// (tapping a panel re-claims the session when another browser has resized it).
function requestResize(p, force = false) {
  const w = wantSize(p);
  if (!w) return;
  p.el.dataset.want = `${w.cols}x${w.rows}`; // for tests and debugging: compare with the size label
  const same = (a) => !!a && a.cols === w.cols && a.rows === w.rows;
  // p.sent = last size the server accepted (the next frame may still show the old one)
  if (!force && (same(p.pending) || (!p.pending && !p.busy && same(p.sent || p.tmux)))) return;
  p.pending = w;
  pumpResize(p);
}
function pumpResize(p) {
  if (p.closed || p.busy || !p.pending || p.timer) return;
  const wait = (p.lastSent || 0) + 100 - performance.now();
  if (wait > 0) {
    p.timer = setTimeout(() => { p.timer = 0; pumpResize(p); }, wait);
    return;
  }
  const size = p.pending;
  p.pending = null;
  p.busy = true;
  p.lastSent = performance.now();
  api('/api/resize', { s: p.name, ...size })
    .then(() => { p.sent = size; })
    .catch((err) => console.warn(`resize ${p.name}: ${err.message}`))
    .finally(() => { p.busy = false; pumpResize(p); });
}
const resizeAll = () => panels.forEach((p) => requestResize(p));

// Fit the terminal (tmux's cols × rows) into the screen area with the font size: the base
// font when tmux already matches the panel, smaller while it doesn't. Runs only after web
// fonts are ready (cell size measured with the final font).
function fit(p) {
  if (!fontsReady || !p.term.element) return;
  const w = wantSize(p);
  if (w && p.tmux && w.cols === p.tmux.cols && w.rows === p.tmux.rows) {
    // tmux matches the panel: that size was computed for the base font, so it fits exactly
    // (fitting by measurement could settle a step below it because of rounding).
    p.screen.classList.remove('pan');
    if (p.term.options.fontSize !== baseFont()) p.term.options.fontSize = baseFont();
    return;
  }
  const availW = p.screen.clientWidth;
  const availH = p.screen.clientHeight;
  for (let i = 0; i < 4; i++) { // the font→width relation isn't exactly linear; settle in a few steps
    const font = p.term.options.fontSize;
    const r = fitFontSize({ font, width: p.termEl.offsetWidth, height: p.termEl.offsetHeight, availW, availH, min: 6, max: baseFont() });
    p.screen.classList.toggle('pan', r.pan); // too narrow to read: scroll sideways instead
    if (Math.abs(r.size - font) < 0.01) break;
    p.term.options.fontSize = r.size;
  }
}
const fitAll = () => panels.forEach(fit);

// ---------------------------------------------------------------- layout
// Desktop: rows of panels side by side, filling the area down to the key bar, with draggable
// dividers between panels (side by side) and between rows (stacked). Sizes are fractions per
// row / per panel, saved per browser with the maximized panel. Phone: one panel at a time,
// tabs at the top; the tab shown is the panel the key bar targets.
const LAYOUT = 'coord-dash.layout';
const tabs = document.getElementById('tabs');
let lay = { counts: [], rows: [], cols: [], max: null };
let built = '';

function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT)); } catch { return null; }
}
function saveLayout() {
  try { localStorage.setItem(LAYOUT, JSON.stringify(lay)); } catch { /* private mode */ }
}
function gridBox() {
  const cs = getComputedStyle(grid);
  return {
    w: grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    h: grid.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  };
}
// Smallest panel: 20 columns × 6 rows at the base font plus header, message box and borders.
function minPx() {
  const cell = (fontsReady && cellAt(baseFont())) || { w: 8, h: 15 };
  const p = [...panels.values()].find((q) => q.screen.clientWidth > 0);
  const chromeW = p ? p.el.offsetWidth - p.screen.clientWidth + SCROLLBAR : 16;
  const chromeH = p ? p.el.offsetHeight - p.screen.clientHeight : 130;
  return minPanelPx({ cellW: cell.w, cellH: cell.h, chromeW, chromeH });
}

// Put the panels into rows (only when the shape changes: moving a panel loses its focus).
function buildLayout() {
  const names = [...panels.keys()];
  const phone = !wide.matches;
  const { w, h } = gridBox();
  const counts = phone ? [] : rowCounts(names.length, columnCount(w, names.length, COL_PX));
  const key = JSON.stringify([phone, names, counts]);
  renderTabs();
  if (key === built) { applySizes(); return; }
  built = key;
  if (!phone && lay.counts.join() !== counts.join()) {
    const m = minPx();
    lay = restoreLayout(loadLayout(), { counts, width: w, height: h, divider: DIVIDER, minW: m.w, minH: m.h, names });
  }
  if (lay.max && !panels.has(lay.max)) lay.max = null;
  const kids = [];
  if (phone) {
    for (const n of names) kids.push(panels.get(n).el);
  } else {
    let k = 0;
    counts.forEach((c, r) => {
      if (r) kids.push(divider('h', r - 1));
      const row = Object.assign(document.createElement('div'), { className: 'prow' });
      for (let i = 0; i < c; i++, k++) {
        if (i) row.append(divider('v', i - 1, r));
        row.append(panels.get(names[k]).el);
      }
      kids.push(row);
    });
  }
  // Moving an element resets its scroll position, and xterm would follow its viewport to the
  // top of the scrollback: put every terminal back where it was (at the bottom = stay live).
  const keep = [...panels.values()].map((p) => [p, p.live ? null : p.term.buffer.active.viewportY]);
  grid.replaceChildren(...kids);
  applySizes();
  requestAnimationFrame(() => {
    for (const [p, y] of keep) {
      if (!panels.has(p.name)) continue;
      if (y === null) p.term.scrollToBottom();
      else p.term.scrollToLine(y);
      updateLive(p);
    }
  });
}

function applySizes() {
  const phone = !wide.matches;
  grid.classList.toggle('phone', phone);
  grid.classList.toggle('maxed', !phone && !!lay.max);
  for (const p of panels.values()) {
    p.el.classList.toggle('maxed', !phone && p.name === lay.max);
    p.maxBtn.setAttribute('aria-pressed', String(!phone && p.name === lay.max));
    p.maxBtn.title = p.name === lay.max ? 'Restore the previous sizes' : 'Maximize this panel';
    if (phone) { p.el.style.flex = ''; p.el.style.minWidth = ''; }
  }
  if (phone) return;
  const m = minPx();
  grid.querySelectorAll(':scope > .prow').forEach((row, r) => {
    row.style.flex = `${(lay.rows[r] ?? 1) * 1000} 1 0px`; // ×1000: flex-grow sums below 1 leave a gap
    row.style.minHeight = `${m.h}px`;
    let hasMax = false;
    row.querySelectorAll(':scope > .panel').forEach((el, i) => {
      el.style.flex = `${(lay.cols[r]?.[i] ?? 1) * 1000} 1 0px`;
      el.style.minWidth = `${m.w}px`;
      if (el.classList.contains('maxed')) hasMax = true;
    });
    row.classList.toggle('has-max', hasMax);
  });
}

function toggleMax(name) {
  lay.max = lay.max === name ? null : name;
  applySizes();
  saveLayout();
  setActive(name);
}

// A divider between two panels in row r (kind 'v', dragged sideways) or between rows
// (kind 'h', dragged up/down). Pointer events cover mouse, pen and touch. Double-click or
// double-tap resets that row (or the row heights) to equal sizes.
let raf = 0;
function scheduleApply() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; applySizes(); }); // panels re-fit via their ResizeObserver
}
function divider(kind, i, r) {
  const d = Object.assign(document.createElement('div'), {
    className: `divider ${kind}`,
    title: 'Drag to resize · double-click to reset to equal sizes',
  });
  d.setAttribute('role', 'separator');
  d.setAttribute('aria-orientation', kind === 'v' ? 'vertical' : 'horizontal');
  let drag = null;
  let lastDown = -1e9;
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.timeStamp - lastDown < 350) { // second click/tap: reset
      lastDown = -1e9;
      if (kind === 'h') lay.rows = equalSizes(lay.rows.length);
      else lay.cols[r] = equalSizes(lay.cols[r].length);
      applySizes();
      saveLayout();
      return;
    }
    lastDown = e.timeStamp;
    const fr = kind === 'h' ? lay.rows : lay.cols[r];
    const space = kind === 'h' ? gridBox().h : d.parentElement.clientWidth;
    const m = minPx();
    drag = {
      id: e.pointerId, start: kind === 'h' ? e.clientY : e.clientX, fr: fr.slice(),
      total: space - (fr.length - 1) * DIVIDER, min: kind === 'h' ? m.h : m.w,
    };
    d.setPointerCapture(e.pointerId);
    d.classList.add('drag');
    document.body.classList.add('dragging', kind === 'h' ? 'drag-h' : 'drag-v');
  });
  const moveTo = (e) => {
    const delta = (kind === 'h' ? e.clientY : e.clientX) - drag.start;
    if (Math.abs(delta) > 3) lastDown = -1e9; // a drag, not the first click of a double-click
    const next = dragSplit(drag.fr, i, delta, drag.total, drag.min);
    if (kind === 'h') lay.rows = next;
    else lay.cols[r] = next;
  };
  d.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    moveTo(e);
    scheduleApply();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.type === 'pointerup') moveTo(e); // the last move can be coalesced into the release
    drag = null;
    d.classList.remove('drag');
    document.body.classList.remove('dragging', 'drag-h', 'drag-v');
    applySizes();
    fitAll();
    resizeAll();
    saveLayout();
  };
  d.addEventListener('pointerup', end);
  d.addEventListener('pointercancel', end);
  return d;
}

function renderTabs() {
  tabs.hidden = wide.matches || panels.size === 0;
  tabs.replaceChildren(...[...panels.keys()].map((n) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: n });
    b.dataset.name = n;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(n === active));
    return b;
  }));
}
tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-name]');
  if (!b) return;
  setActive(b.dataset.name);
  claim(panels.get(b.dataset.name));
});

function setState(p, cls, text) {
  p.el.dataset.state = cls;
  p.stateEl.textContent = text;
}

// A frame is the visible screen plus any scrollback lines that are new since the last frame
// (or the whole scrollback when f.reset). New lines are pushed into xterm's own scrollback:
// draw them at the top of the screen, then scroll them off with line feeds at the bottom row.
// xterm keeps the viewport where it is while you're scrolled up.
function render(p, f) {
  const t = p.term;
  if (f.reset) p.live = true;
  const follow = p.live; // live view, not scrolled up by the user (see watchScroll)
  if (f.reset) t.reset();
  p.tmux = { cols: f.cols, rows: f.rows };
  const resized = t.cols !== f.cols || t.rows !== f.rows;
  if (resized) t.resize(f.cols, f.rows);
  let out = '';
  for (let i = 0; i < f.hist.length; i += f.rows) {
    const chunk = f.hist.slice(i, i + f.rows);
    out += '\x1b[0m\x1b[H\x1b[J' + chunk.join('\r\n') + `\x1b[${f.rows};1H` + '\n'.repeat(chunk.length);
  }
  out += '\x1b[0m\x1b[H\x1b[J' + f.lines.join('\r\n') +
    `\x1b[0m\x1b[${f.cy + 1};${f.cx + 1}H` + (f.cursor ? '\x1b[?25h' : '\x1b[?25l');
  t.write(out, () => {
    if (resized || f.reset || !p.fitted) { fit(p); p.fitted = true; }
    if (follow) t.scrollToBottom();
    if (follow && (f.reset || resized)) {
      // A reset or resize changes the scroll area; the browser may clamp the viewport's
      // scrollTop and fire a late scroll event that xterm takes for the user scrolling to the
      // top. Scroll to the bottom again once that has happened.
      requestAnimationFrame(() => {
        if (panels.get(p.name) !== p) return; // closed meanwhile
        t.scrollToBottom();
        updateLive(p);
      });
    }
    updateLive(p);
  });
  setState(p, 'live', `${f.cols}×${f.rows}`);
}

function updateLive(p) {
  p.liveBtn.hidden = p.live;
}

// p.live: the panel follows the live screen. Only the user can turn that off, by scrolling up
// with the wheel, touch or the scrollbar. xterm's viewport also moves without the user: a
// resize or a font change (fit() while a divider is dragged) changes the scroll area, and the
// browser fires a late scroll event that xterm takes for a scroll. Judged by the viewport alone,
// that froze a panel showing old rows with the new screen below. So a scroll event counts as
// the user's only shortly after their input; any other scroll of a live panel is undone.
function watchScroll(p) {
  const input = () => { p.userAt = performance.now(); };
  p.termEl.addEventListener('wheel', input, { passive: true });
  p.termEl.addEventListener('touchmove', input, { passive: true });
  p.termEl.addEventListener('touchend', input, { passive: true }); // momentum scrolling follows
  p.termEl.addEventListener('pointermove', (e) => { if (e.buttons) input(); }, { passive: true });
  const onScroll = () => {
    const b = p.term.buffer.active;
    const bottom = b.viewportY >= b.baseY;
    if (performance.now() - p.userAt < USER_SCROLL_MS) {
      p.live = bottom;
    } else if (p.live && !bottom) {
      p.term.scrollToBottom();
    }
    updateLive(p);
  };
  p.term.onScroll(onScroll);
  p.termEl.querySelector('.xterm-viewport').addEventListener('scroll', onScroll, { passive: true });
  p.liveBtn.addEventListener('click', () => { p.live = true; p.term.scrollToBottom(); updateLive(p); });
}

function connect(p) {
  if (p.es) return;
  const es = new EventSource(`/api/stream?s=${encodeURIComponent(p.name)}`);
  p.es = es;
  es.addEventListener('screen', (e) => render(p, JSON.parse(e.data)));
  es.addEventListener('gone', (e) => setState(p, 'gone', JSON.parse(e.data).error));
  es.onerror = () => {
    setState(p, 'down', 'reconnecting…');
    api('/api/sessions').catch(() => {}); // redirects to /login if the session expired
  };
}

function disconnect(p) {
  p.es?.close();
  p.es = null;
}

function addPanel(name) {
  if (panels.has(name)) return;
  const el = tpl.content.firstElementChild.cloneNode(true);
  const p = {
    name, el,
    screen: el.querySelector('.screen'),
    termEl: el.querySelector('.term'),
    stateEl: el.querySelector('.state'),
    liveBtn: el.querySelector('.live'),
    maxBtn: el.querySelector('.max'),
    term: makeTerm({ cols: 80, rows: 24, fontSize: baseFont() }),
    es: null,
    fitted: false,
    live: true, userAt: -1e9, // following the live screen; time of the last scroll input (watchScroll)
    tmux: null, // size of the last frame: the real tmux window size
    pending: null, busy: false, timer: 0, lastSent: 0, sent: null, closed: false, observer: null, // resize requests (requestResize)
  };
  el.dataset.name = name;
  el.querySelector('.name').textContent = name;
  grid.append(el); // measured in place; buildLayout() moves it into its row
  p.term.open(p.termEl);
  watchScroll(p);
  panels.set(name, p);
  store.set([...panels.keys()]);
  // Load, window resize, divider drag, maximize, tab switch, message box resize: all of them
  // change the screen area. ResizeObserver callbacks run at most once per frame.
  p.observer = new ResizeObserver(() => { if (!p.closed) { fit(p); requestResize(p); } });
  p.observer.observe(p.screen);
  setState(p, 'down', 'connecting…');
  if (!document.hidden) connect(p);

  const form = el.querySelector('form');
  const ta = form.querySelector('textarea'); // not el: xterm adds its own hidden textarea
  const enter = el.querySelector('.enter');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value;
    if (!text && !enter.checked) return;
    try {
      await api('/api/send', { s: name, text, enter: enter.checked });
      ta.value = '';
    } catch (err) {
      alert(`Could not send to ${name}: ${err.message}`);
    }
  });
  el.addEventListener('pointerdown', () => { setActive(name); claim(p); });
  el.addEventListener('focusin', () => setActive(name));
  if (!active) setActive(name);
  p.maxBtn.addEventListener('click', () => toggleMax(name));
  el.querySelector('.close').addEventListener('click', () => {
    p.closed = true;
    p.pending = null;
    p.observer.disconnect();
    disconnect(p);
    clearTimeout(p.timer);
    p.term.dispose();
    el.remove();
    panels.delete(name);
    store.set([...panels.keys()]);
    if (active === name) setActive(panels.keys().next().value ?? null);
    buildLayout();
  });
  buildLayout();
  el.querySelector('.hist').addEventListener('click', () => showHistory(name));
}

// ---------------------------------------------------------------- keys
// The fixed bottom bar and the ☰ Ctrl sheet send to the active panel: the last one tapped.
const sheet = document.getElementById('sheet');
const recentBox = document.getElementById('recent');
let active = null;
function setActive(name) {
  if (name === active) return;
  panels.get(active)?.el.classList.remove('active');
  active = name;
  panels.get(name)?.el.classList.add('active');
  for (const s of document.querySelectorAll('#sheet .target, #keybar .ktarget span')) s.textContent = name ?? '(no panel)';
  for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.name === name));
}
// The targeted panel's size wins: if another browser shows the same session at a different
// size, tapping this panel (or its phone tab) resizes the session to fit here again.
function claim(p) {
  requestAnimationFrame(() => requestResize(p, true)); // after a tab switch has laid it out
}

// Copy: browser clipboard only, nothing is sent to tmux. Selection of the targeted panel,
// or its visible screen when nothing is selected.
let toastTimer = 0;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1500);
}
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { return await navigator.clipboard.writeText(text); } catch { /* refused: try the fallback */ }
  }
  // No Clipboard API (plain http on a Tailscale IP) or it refused: copy from a temporary textarea.
  const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS ignores select() alone
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy refused');
}
document.getElementById('copy').addEventListener('click', async () => {
  const p = panels.get(active);
  if (!p) { toast('No panel'); return; }
  try {
    await writeClipboard(copyText(p.term));
    toast('Copied');
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
});

// Recent: the last 3 sheet keys sent, newest first, per browser.
const RECENT = 'coord-dash.recent-keys';
const sheetBtn = (key) => [...sheet.querySelectorAll('.items:not(#recent) [data-key]')].find((b) => b.dataset.key === key);
function recentGet() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT));
    return Array.isArray(v) ? v.filter((k) => sheetBtn(k)).slice(0, 3) : [];
  } catch { return []; }
}
function recentAdd(key) {
  const v = [key, ...recentGet().filter((k) => k !== key)].slice(0, 3);
  try { localStorage.setItem(RECENT, JSON.stringify(v)); } catch { /* private mode */ }
}
function renderRecent() {
  const keys = recentGet();
  recentBox.replaceChildren(...keys.map((k) => sheetBtn(k).cloneNode(true)));
  sheet.querySelector('.recent-sec').hidden = keys.length === 0;
}

function openSheet() { renderRecent(); sheet.hidden = false; }
function closeSheet() { sheet.hidden = true; }
document.getElementById('ctrl-open').addEventListener('click', openSheet);
sheet.querySelector('.sheet-back').addEventListener('click', closeSheet);
sheet.querySelector('.sheet-close').addEventListener('click', closeSheet);

async function sendKey(b) {
  const inSheet = sheet.contains(b);
  if (inSheet) closeSheet(); // the sheet closes after every tap
  const name = active;
  if (!name || !panels.has(name)) { alert('Open a session panel first.'); return; }
  const what = b.dataset.label || b.textContent;
  if (b.dataset.confirm && !confirm(`Send ${what} to "${name}"?`)) return;
  try {
    await api('/api/key', { s: name, key: b.dataset.key });
    if (inSheet) recentAdd(b.dataset.key);
  } catch (err) { alert(`Could not send ${what} to ${name}: ${err.message}`); }
}
// Keep focus (and the phone keyboard) in the message box when a bar key is tapped.
document.getElementById('keybar').addEventListener('mousedown', (e) => e.preventDefault());
for (const box of [document.getElementById('keybar'), sheet]) {
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (b) sendKey(b);
  });
}

let histTerm = null;
const hist = document.getElementById('history');
async function showHistory(name) {
  let data;
  try { data = await api(`/api/history?s=${encodeURIComponent(name)}&lines=3000`); } catch (e) { alert(e.message); return; }
  hist.hidden = false;
  hist.querySelector('.title').textContent = `${name} — last ${data.lines.length} lines`;
  const box = hist.querySelector('.hterm');
  histTerm?.dispose();
  histTerm = makeTerm({ cols: data.cols, rows: 20, scrollback: 10000 });
  histTerm.open(box);
  const scr = box.querySelector('.xterm-screen');
  const rowPx = scr ? scr.offsetHeight / 20 : 16;
  histTerm.resize(data.cols, Math.max(10, Math.floor(box.clientHeight / rowPx) - 1));
  histTerm.write(data.lines.join('\r\n'), () => histTerm.scrollToBottom());
}
hist.querySelector('.close').addEventListener('click', () => {
  hist.hidden = true;
  histTerm?.dispose();
  histTerm = null;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!sheet.hidden) closeSheet();
  else if (!hist.hidden) hist.querySelector('.close').click();
});

async function refreshAdd() {
  const { running } = await api('/api/sessions');
  addSel.length = 1;
  for (const s of running.filter((n) => !panels.has(n))) addSel.add(new Option(s, s));
  addSel.options[0].textContent = addSel.length > 1 ? '+ add session…' : '+ add session (none free)';
}
addSel.addEventListener('focus', refreshAdd);
addSel.addEventListener('mousedown', refreshAdd);
addSel.addEventListener('change', () => {
  if (addSel.value) { addPanel(addSel.value); setActive(addSel.value); }
  addSel.value = '';
  refreshAdd();
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  location.href = '/login';
});

// Stop polling tmux while the tab is in the background.
document.addEventListener('visibilitychange', () => {
  for (const p of panels.values()) document.hidden ? disconnect(p) : connect(p);
});
// Track the visual viewport (phone keyboard, pinch zoom): the page is exactly as tall as what
// is visible, so the bar sits right above the keyboard. Then re-fit and keep the box in view.
function onViewport() {
  const vv = window.visualViewport;
  if (vv) {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    // iOS pans the visual viewport instead of resizing when the keyboard opens: follow it.
    // (A translate, unlike scale, doesn't disturb xterm's mouse mapping.)
    document.body.style.transform = vv.offsetTop > 0 ? `translateY(${Math.round(vv.offsetTop)}px)` : '';
  }
  buildLayout();
  fitAll();
  const f = document.activeElement;
  if (f && f.tagName === 'TEXTAREA' && grid.contains(f)) f.scrollIntoView({ block: 'nearest' });
}
window.addEventListener('resize', onViewport);
window.addEventListener('orientationchange', onViewport);
window.visualViewport?.addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('scroll', onViewport);
// Phone ↔ desktop: other layout and base font; panels re-fit through their ResizeObserver.
wide.addEventListener('change', () => { buildLayout(); fitAll(); resizeAll(); });
new ResizeObserver(() => { buildLayout(); fitAll(); }).observe(grid);

(async () => {
  onViewport();
  await document.fonts.ready;
  fontsReady = true;
  document.fonts.addEventListener('loadingdone', () => { resetProbes(); fitAll(); resizeAll(); });
  const { configured, running } = await api('/api/sessions');
  const saved = store.get();
  const initial = Array.isArray(saved) ? saved : configured.length ? configured : running.slice(0, 2);
  initial.forEach(addPanel);
  refreshAdd();
})();
