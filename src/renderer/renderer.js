'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

const THEME = {
  background: '#00000000',
  foreground: '#c8c3a8',
  cursor: '#d9c27a',
  cursorAccent: '#0a0b09',
  selectionBackground: 'rgba(210, 203, 169, 0.28)',
  scrollbarSliderBackground: 'rgba(124, 121, 102, 0.35)',
  scrollbarSliderHoverBackground: 'rgba(124, 121, 102, 0.6)',
  scrollbarSliderActiveBackground: 'rgba(210, 203, 169, 0.6)',
  black: '#1b1c17',
  red: '#b5452f',
  green: '#8a9a5b',
  yellow: '#c9a54a',
  blue: '#5f7a8a',
  magenta: '#8c6a7d',
  cyan: '#6f9488',
  white: '#c8c3a8',
  brightBlack: '#5a5a4b',
  brightRed: '#d0644a',
  brightGreen: '#a8b874',
  brightYellow: '#e0c46a',
  brightBlue: '#7f9cad',
  brightMagenta: '#ab889b',
  brightCyan: '#8fb5a8',
  brightWhite: '#ece6ca',
};

const DEFAULT_FONT = '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';
const METER_SEGMENTS = 10;

const $ = (sel) => document.querySelector(sel);
const pad = (n, len = 2) => String(n).padStart(len, '0');

let config;
let isMac = false;
let fontSize = 14;
const tabs = [];
let active = null;
const byPty = new Map();

/* ---------- tabs ---------- */

async function createTab() {
  const pane = document.createElement('div');
  pane.className = 'pane';
  $('#terminals').appendChild(pane);

  const term = new Terminal({
    allowTransparency: true,
    theme: THEME,
    fontFamily: config.fontFamily || DEFAULT_FONT,
    fontSize,
    lineHeight: 1.15,
    cursorStyle: 'block',
    cursorBlink: config.cursorBlink,
    scrollback: 10000,
    macOptionIsMeta: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => window.open(url)));
  term.open(pane);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = '<span class="num"></span><span class="title"></span><button class="x" title="Close">&times;</button>';
  $('#tabs').appendChild(tabEl);

  const tab = { pane, term, fit, tabEl, ptyId: null, shell: '', title: '' };
  tabs.push(tab);

  tabEl.addEventListener('mousedown', (e) => {
    if (e.button === 1) closeTab(tab);
    else if (!e.target.classList.contains('x')) activate(tab);
  });
  tabEl.querySelector('.x').addEventListener('click', () => closeTab(tab));

  term.onData((data) => {
    if (tab.ptyId != null) window.eft.write(tab.ptyId, data);
  });
  term.onResize(({ cols, rows }) => {
    if (tab.ptyId != null) window.eft.resize(tab.ptyId, cols, rows);
  });
  term.onTitleChange((title) => {
    tab.title = title;
    renderTabs();
  });
  term.attachCustomKeyEventHandler((e) => handleKey(e, tab));

  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    // Windows Terminal convention: right click copies a selection, otherwise pastes.
    if (term.hasSelection()) {
      window.eft.copy(term.getSelection());
      term.clearSelection();
    } else {
      term.paste(await window.eft.paste());
    }
  });

  activate(tab);
  await spawnShell(tab);
  return tab;
}

async function spawnShell(tab) {
  tab.fit.fit();
  const { id, shell } = await window.eft.spawn(tab.term.cols, tab.term.rows);
  tab.ptyId = id;
  tab.shell = shell;
  tab.dead = false;
  byPty.set(id, tab);
  renderTabs();
  if (tab === active) $('#sb-shell').textContent = shell;
}

function activate(tab) {
  if (active) active.pane.classList.remove('active');
  active = tab;
  tab.pane.classList.add('active');
  renderTabs();
  $('#sb-shell').textContent = tab.shell || '—';
  requestAnimationFrame(() => {
    tab.fit.fit();
    tab.term.focus();
  });
}

function closeTab(tab) {
  if (tab.ptyId != null && !tab.dead) window.eft.kill(tab.ptyId);
  byPty.delete(tab.ptyId);
  tab.term.dispose();
  tab.pane.remove();
  tab.tabEl.remove();

  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    window.eft.close();
    return;
  }
  if (tab === active) {
    active = null;
    activate(tabs[Math.min(idx, tabs.length - 1)]);
  } else {
    renderTabs();
  }
}

function cycle(step) {
  if (tabs.length < 2) return;
  const idx = tabs.indexOf(active);
  activate(tabs[(idx + step + tabs.length) % tabs.length]);
}

function renderTabs() {
  tabs.forEach((tab, i) => {
    tab.tabEl.classList.toggle('active', tab === active);
    tab.tabEl.classList.toggle('dead', !!tab.dead);
    tab.tabEl.querySelector('.num').textContent = pad(i + 1);
    tab.tabEl.querySelector('.title').textContent = tab.title || tab.shell || 'deploying';
    tab.tabEl.title = tab.title || tab.shell;
  });
}

/* ---------- raid end (shell exited) ---------- */

function showRaidEnd(tab, exitCode) {
  tab.dead = true;
  renderTabs();

  const survived = exitCode === 0;
  const el = document.createElement('div');
  el.className = 'raid-end' + (survived ? '' : ' kia');
  el.innerHTML = `
    <div class="status">${survived ? 'Survived' : 'Killed in action'}</div>
    <div class="detail">${tab.shell} exited with code ${exitCode}</div>
    <div class="hint">Enter &mdash; redeploy &nbsp;&middot;&nbsp; Esc &mdash; close tab</div>`;
  tab.pane.appendChild(el);
  tab.raidEnd = el;
}

async function redeploy(tab) {
  tab.raidEnd?.remove();
  tab.raidEnd = null;
  tab.title = '';
  tab.term.reset();
  await spawnShell(tab);
}

/* ---------- commands & keys ---------- */

const commands = {
  'tab:new': () => createTab(),
  'tab:close': () => active && closeTab(active),
  'tab:next': () => cycle(1),
  'tab:prev': () => cycle(-1),
  'edit:copy': () => {
    if (active?.term.hasSelection()) window.eft.copy(active.term.getSelection());
  },
  'edit:paste': async () => active?.term.paste(await window.eft.paste()),
  'edit:selectAll': () => active?.term.selectAll(),
  'edit:clear': () => active?.term.clear(),
  'font:bigger': () => setFontSize(fontSize + 1),
  'font:smaller': () => setFontSize(fontSize - 1),
  'font:reset': () => setFontSize(config.fontSize),
};

function setFontSize(size) {
  fontSize = Math.max(8, Math.min(32, size));
  for (const tab of tabs) tab.term.options.fontSize = fontSize;
  active?.fit.fit();
}

// Windows/Linux shortcuts (macOS routes these through the native menu instead).
function shortcutFor(e) {
  if (e.type !== 'keydown') return null;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'tab') return e.shiftKey ? 'tab:prev' : 'tab:next';
  if (isMac || !e.ctrlKey || e.altKey) return null;

  if (e.shiftKey) {
    return { t: 'tab:new', w: 'tab:close', c: 'edit:copy', v: 'edit:paste', a: 'edit:selectAll', k: 'edit:clear', i: 'devtools' }[key] || null;
  }
  if (key === 'c' && active?.term.hasSelection()) return 'edit:copy';
  if (key === 'v') return 'edit:paste';
  if (key === '=' || key === '+') return 'font:bigger';
  if (key === '-') return 'font:smaller';
  if (key === '0') return 'font:reset';
  return null;
}

function handleKey(e, tab) {
  if (tab.dead) {
    if (e.type === 'keydown' && e.key === 'Enter') redeploy(tab);
    if (e.type === 'keydown' && e.key === 'Escape') closeTab(tab);
    return false;
  }

  // Cmd/Ctrl+1..9 jump to tab
  if (e.type === 'keydown' && (isMac ? e.metaKey : e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    const target = tabs[Number(e.key) - 1];
    if (target) activate(target);
    return false;
  }

  const cmd = shortcutFor(e);
  if (!cmd) return true;
  e.preventDefault();
  if (cmd === 'devtools') window.eft.toggleDevTools();
  else commands[cmd]();
  if (cmd === 'edit:copy') active.term.clearSelection();
  return false;
}

/* ---------- status bar ---------- */

function buildMeter(el) {
  el.innerHTML = '<i></i>'.repeat(METER_SEGMENTS);
}

function setMeter(id, value) {
  const meter = $(`#m-${id}`);
  const lit = Math.round(value * METER_SEGMENTS);
  [...meter.children].forEach((seg, i) => seg.classList.toggle('on', i < lit));
  meter.classList.toggle('warn', value >= 0.7 && value < 0.9);
  meter.classList.toggle('crit', value >= 0.9);
  $(`#v-${id}`).textContent = Math.round(value * 100) + '%';
}

function startClocks() {
  const start = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    $('#sb-raid').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    const now = new Date();
    $('#sb-clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- boot sequence ---------- */

const BOOT_STAGES = [
  'Establishing connection',
  'Loading location data',
  'Loading loot',
  'Awaiting session start',
  'Deploying',
];

function boot() {
  return new Promise((resolve) => {
    if (!config.bootAnimation) {
      resolve();
      return;
    }
    const el = $('#boot');
    el.hidden = false;
    const duration = 1800;
    const started = performance.now();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', finish, true);
      el.removeEventListener('mousedown', finish);
      el.classList.add('fade');
      setTimeout(() => {
        el.hidden = true;
      }, 350);
      resolve();
    };

    const frame = (t) => {
      if (done) return;
      const p = Math.min(1, (t - started) / duration);
      $('#boot-progress').style.width = `${p * 100}%`;
      $('#boot-stage').textContent = BOOT_STAGES[Math.min(BOOT_STAGES.length - 1, Math.floor(p * BOOT_STAGES.length))];
      const left = Math.max(0, 3 * (1 - p));
      $('#boot-timer').textContent = `00:0${Math.floor(left)}.${pad(Math.floor((left % 1) * 100))}`;
      if (p < 1) requestAnimationFrame(frame);
      else setTimeout(finish, 150);
    };
    requestAnimationFrame(frame);
    window.addEventListener('keydown', finish, true);
    el.addEventListener('mousedown', finish);
  });
}

/* ---------- init ---------- */

async function init() {
  config = await window.eft.getConfig();
  isMac = config.platform === 'darwin';
  fontSize = config.fontSize;
  document.body.classList.add(isMac ? 'mac' : 'win');
  document.body.classList.toggle('no-scanlines', !config.scanlines);

  $('#sb-callsign').textContent = config.callsign || config.username;
  $('#sb-location').textContent = config.hostname.replace(/\.local$/, '');
  buildMeter($('#m-cpu'));
  buildMeter($('#m-mem'));
  startClocks();

  window.eft.onData((id, data) => byPty.get(id)?.term.write(data));
  window.eft.onExit((id, code) => {
    const tab = byPty.get(id);
    byPty.delete(id);
    if (tab) showRaidEnd(tab, code);
  });
  window.eft.onStats(({ cpu, mem }) => {
    setMeter('cpu', cpu);
    setMeter('mem', mem);
  });
  for (const [channel, fn] of Object.entries(commands)) window.eft.onCommand(channel, fn);

  $('#new-tab').addEventListener('click', () => createTab());
  $('#settings').addEventListener('click', () => window.eft.openConfig());
  $('#window-controls').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'minimize') window.eft.minimize();
    if (action === 'maximize') window.eft.toggleMaximize();
    if (action === 'close') window.eft.close();
  });

  new ResizeObserver(() => active?.fit.fit()).observe($('#terminals'));

  // The shell starts behind the boot screen so the prompt is ready when it fades.
  const booting = boot();
  await createTab();
  await booting;
  active?.term.focus();
}

init();
