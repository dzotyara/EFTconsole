'use strict';

/* global tabs, active, fontSize, createTab, activate */

// End-to-end QA, loaded only when the app runs with EFTCONSOLE_QA=1 (see
// scripts/qa.js). Drives the live UI with DOM events and real shells, then hands
// the results to the native side, which also checks for leftover processes.
(async () => {
  const { invoke } = window.__TAURI__.core;
  const config = await window.eft.getConfig();
  const WIN = config.platform === 'win32';
  const shellName = (config.shell || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const SH = WIN
    ? {
        sleep: 'ping -n 30 127.0.0.1 >nul',
        size: 'mode con',
        sizeRe: (rows, cols) => new RegExp(`Lines:\\s+${rows}[\\s\\S]*Columns:\\s+${cols}`),
        kill: (pid) => `taskkill /F /PID ${pid}`,
      }
    : {
        sleep: 'sleep 30',
        size: 'stty size',
        sizeRe: (rows, cols) => new RegExp(`\\n${rows} ${cols}`),
        kill: (pid) => `kill -9 ${pid}`,
      };

  const lines = [];
  let failed = 0;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  };

  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (await fn()) return true;
      await sleep(100);
    }
    return false;
  };
  const buffer = () => {
    const b = active.term.buffer.active;
    let s = '';
    for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n';
    return s;
  };
  const state = () => ({ n: tabs.length, active: tabs.indexOf(active), font: fontSize });
  const S = () => JSON.stringify(state());

  // The element under the pointer must be the target itself and not a window drag zone.
  const hit = (el) => {
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      inside: !!top && el.contains(top),
      top: top ? top.id || top.className : null,
      drag: !!top && top.hasAttribute('data-tauri-drag-region'),
    };
  };
  const mouse = (el, type, button = 0, extra = {}) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, button,
      buttons: type === 'mouseup' ? 0 : 1 << button,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, ...extra,
    }));
  };
  const click = async (el, button = 0) => {
    const h = hit(el);
    if (!h.inside) return false;
    mouse(el, 'mousedown', button);
    mouse(el, 'mouseup', button);
    if (button === 0) mouse(el, 'click', button);
    await sleep(300);
    return true;
  };
  // xterm derives Ctrl+letter from the legacy keyCode, which synthetic events
  // leave at 0, so fill it in the way a real keypress would.
  const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9 };
  const keyEvent = (type, k, mods) => {
    const ev = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...mods });
    const code = KEY_CODES[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    Object.defineProperty(ev, 'keyCode', { get: () => code });
    Object.defineProperty(ev, 'which', { get: () => code });
    return ev;
  };
  const key = async (k, mods = {}) => {
    const target = document.activeElement || document.body;
    target.dispatchEvent(keyEvent('keydown', k, mods));
    target.dispatchEvent(keyEvent('keyup', k, mods));
    await sleep(300);
  };
  const run = async (cmd) => {
    active.term.input(cmd + '\r', true);
    await sleep(400);
  };

  const WIN_KEYS = {
    'tab:new': ['T', { ctrlKey: true, shiftKey: true }],
    'tab:close': ['W', { ctrlKey: true, shiftKey: true }],
    'tab:next': ['Tab', { ctrlKey: true }],
    'tab:prev': ['Tab', { ctrlKey: true, shiftKey: true }],
    'edit:copy': ['C', { ctrlKey: true, shiftKey: true }],
    'edit:paste': ['V', { ctrlKey: true, shiftKey: true }],
    'edit:selectAll': ['A', { ctrlKey: true, shiftKey: true }],
    'edit:clear': ['K', { ctrlKey: true, shiftKey: true }],
    'font:bigger': ['=', { ctrlKey: true }],
    'font:smaller': ['-', { ctrlKey: true }],
    'font:reset': ['0', { ctrlKey: true }],
  };
  // macOS routes these through the native menu; trigger the same menu handler.
  const shortcut = async (name) => {
    if (WIN || name === 'tab:next' || name === 'tab:prev') return key(...WIN_KEYS[name]);
    await invoke('qa_menu', { id: name });
    await sleep(350);
  };
  const jump = (n) => key(String(n), WIN ? { ctrlKey: true } : { metaKey: true });
  const tabEl = (n) => $(`.tab:nth-child(${n})`);

  try {
    // ---- boot & hit testing ----
    await waitFor(() => getComputedStyle($('#boot')).display === 'none', 8000);
    check('boot overlay removed after boot', getComputedStyle($('#boot')).display === 'none');
    const targets = ['#new-tab', '#settings', '.tab .title', '.tab .x', '#terminals'];
    if (WIN) targets.push('[data-action=minimize]', '[data-action=maximize]', '[data-action=close]');
    for (const sel of targets) {
      const h = hit($(sel));
      check(`clickable: ${sel}`, h.inside && !h.drag, JSON.stringify(h));
    }
    check('title bar background drags the window', $('#titlebar').hasAttribute('data-tauri-drag-region')
      && $('.drag-spacer').hasAttribute('data-tauri-drag-region'));
    if (!WIN) check('mac: custom window controls hidden', getComputedStyle($('#window-controls')).display === 'none');

    // ---- typing ----
    await waitFor(() => buffer().trim().length > 0);
    await run('echo qa-42');
    check('typing + enter runs command', await waitFor(() => /\nqa-42/.test(buffer())));

    // ---- tabs by mouse ----
    await click($('#new-tab'));
    await sleep(500);
    check('click + opens a new tab', tabs.length === 2 && tabs.indexOf(active) === 1, S());
    check('new tab gets a prompt', await waitFor(() => buffer().trim().length > 0));
    await click(tabEl(1).querySelector('.title'));
    check('click tab 1 activates it', tabs.indexOf(active) === 0, S());
    await click(tabEl(2).querySelector('.x'));
    check('click x closes tab 2', tabs.length === 1, S());

    // ---- shortcuts ----
    active.term.focus();
    await shortcut('tab:new');
    await sleep(400);
    check('shortcut: new tab', tabs.length === 2 && tabs.indexOf(active) === 1, S());
    await click(tabEl(2).querySelector('.title'), 1);
    check('middle click closes tab', tabs.length === 1, S());
    await shortcut('tab:new');
    await shortcut('tab:new');
    await sleep(400);
    check('shortcut: new tab x2', tabs.length === 3 && tabs.indexOf(active) === 2, S());
    await shortcut('tab:next');
    check('next tab wraps', tabs.indexOf(active) === 0, S());
    await shortcut('tab:prev');
    check('prev tab wraps', tabs.indexOf(active) === 2, S());
    await jump(2);
    check(`${WIN ? 'Ctrl' : 'Cmd'}+2 jumps to tab 2`, tabs.indexOf(active) === 1, S());
    await shortcut('tab:close');
    check('shortcut: close tab', tabs.length === 2, S());
    await jump(1);

    // ---- clipboard ----
    await run('echo clip-77');
    await shortcut('edit:selectAll');
    await shortcut('edit:copy');
    check('select all + copy', (await window.eft.paste()).includes('clip-77'));
    await window.eft.copy('echo pasted-55');
    await shortcut('edit:paste');
    await run('');
    check('paste shortcut', await waitFor(() => /\npasted-55/.test(buffer())));
    if (WIN) {
      check('selection cleared after copy', !active.term.hasSelection());
      await window.eft.copy('echo ctrlv-66');
      active.term.focus();
      await key('v', { ctrlKey: true });
      await run('');
      check('Ctrl+V pastes', await waitFor(() => /\nctrlv-66/.test(buffer())));
    }

    // ---- Ctrl+C interrupts the foreground program ----
    const writes = [];
    const realWrite = window.eft.write;
    window.eft.write = (id, data) => {
      writes.push(data);
      return realWrite(id, data);
    };
    active.term.clearSelection();
    await run(SH.sleep);
    await sleep(500);
    active.term.focus();
    await key('c', { ctrlKey: true });
    const sentEtx = writes.includes('\x03');
    await run('echo after-int');
    check('Ctrl+C sends ^C to the shell', sentEtx, JSON.stringify(writes.slice(-4)));
    check('Ctrl+C interrupts a running command', await waitFor(() => /\nafter-int/.test(buffer()), 4000));
    if (!/\nafter-int/.test(buffer())) {
      // Don't let a stuck command cascade into every later check.
      active.term.input('\x03', true);
      await waitFor(() => /\nafter-int/.test(buffer()), 35000);
    }
    window.eft.write = realWrite;
    if (WIN) {
      active.term.selectAll();
      await window.eft.copy('');
      await key('c', { ctrlKey: true });
      check('Ctrl+C with selection copies', (await window.eft.paste()).includes('after-int'));
    }

    // ---- right click ----
    const screen = () => active.pane.querySelector('.xterm-screen');
    await window.eft.copy('echo rc-paste-88');
    active.term.clearSelection();
    mouse(screen(), 'contextmenu', 2);
    await sleep(300);
    await run('');
    check('right click pastes when nothing selected', await waitFor(() => /\nrc-paste-88/.test(buffer())));
    active.term.select(0, 0, 12);
    await window.eft.copy('');
    mouse(screen(), 'contextmenu', 2);
    await sleep(300);
    check('right click copies selection', (await window.eft.paste()).length > 0 && !active.term.hasSelection());

    // ---- font & clear ----
    await shortcut('font:bigger');
    check('zoom in', fontSize === 15, S());
    await shortcut('font:smaller');
    await shortcut('font:smaller');
    check('zoom out', fontSize === 13, S());
    await shortcut('font:reset');
    check('zoom reset', fontSize === 14, S());
    await shortcut('edit:clear');
    check('clear', !buffer().includes('clip-77'));

    // ---- resize reaches the pty ----
    const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;
    await getCurrentWindow().setSize(new LogicalSize(700, 420));
    await sleep(800);
    const dims = { rows: active.term.rows, cols: active.term.cols };
    await run(SH.size);
    check('window resize reaches the pty', await waitFor(() => SH.sizeRe(dims.rows, dims.cols).test(buffer())), JSON.stringify(dims));
    await getCurrentWindow().setSize(new LogicalSize(1100, 700));
    await sleep(600);

    // ---- links ----
    await shortcut('edit:clear');
    await run('echo https://example.com/eft');
    await sleep(300);
    const b = active.term.buffer.active;
    let row = -1;
    for (let i = 0; i < active.term.rows; i++) {
      if ((b.getLine(b.viewportY + i)?.translateToString(true) || '').startsWith('https://example.com/eft')) row = i;
    }
    const r = screen().getBoundingClientRect();
    const cell = { w: r.width / active.term.cols, h: r.height / active.term.rows };
    const at = { clientX: r.x + cell.w * 5, clientY: r.y + cell.h * (row + 0.5) };
    for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) {
      screen().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...at }));
      await sleep(150);
    }
    await sleep(300);
    const opened = await invoke('qa_opened');
    check('clicking a URL opens it externally', opened.includes('https://example.com/eft'), JSON.stringify({ row, opened }));

    // ---- raid end screens ----
    await run('exit 3');
    check('exit 3 shows KILLED IN ACTION', await waitFor(() => !!active.pane.querySelector('.raid-end.kia')));
    await click($('#new-tab'));
    await sleep(500);
    await jump(2);
    check('dead tab: other tabs still usable', tabs.indexOf(active) === 1, S());
    await jump(1);
    check('back on the dead tab', active === tabs[0] && !!active.dead);
    active.term.focus();
    await key('l');
    await key('s');
    check('dead tab ignores typing', !buffer().includes('ls'));
    await key('Enter');
    await sleep(900);
    check('Enter redeploys a dead tab', !active.dead && !active.pane.querySelector('.raid-end'));
    await waitFor(() => buffer().trim().length > 0);
    await run('echo back-99');
    check('redeployed shell works', await waitFor(() => /\nback-99/.test(buffer())));

    await run(SH.kill(active.pid));
    check('killed shell shows KILLED / HEAD, EYES', await waitFor(() => {
      const el = active.pane.querySelector('.raid-end.killed');
      return !!el && el.innerText.includes('KILLED') && el.innerText.includes('HEAD, EYES');
    }, 6000), active.pane.querySelector('.raid-end')?.innerText.replace(/\s+/g, ' '));
    await key('Enter');
    await sleep(900);
    check('Enter redeploys a killed tab', !active.dead && !active.pane.querySelector('.raid-end'));
    await waitFor(() => buffer().trim().length > 0);
    await run('echo alive-11');
    check('shell works after kill + redeploy', await waitFor(() => /\nalive-11/.test(buffer())));

    await run('exit');
    check('exit 0 shows SURVIVED', await waitFor(() => !!active.pane.querySelector('.raid-end:not(.kia):not(.killed)')));
    const before = tabs.length;
    await key('Escape');
    check('Esc closes a dead tab', tabs.length === before - 1, S());

    // ---- settings & status bar ----
    await click($('#settings'));
    await sleep(300);
    check('gear opens config', (await invoke('qa_opened')).some((p) => p.endsWith('.eftconsole.json')));
    await sleep(2200);
    const sb = {
      cpu: $('#v-cpu').textContent, mem: $('#v-mem').textContent,
      raid: $('#sb-raid').textContent, shell: $('#sb-shell').textContent,
    };
    check('status bar populated', /^\d+%$/.test(sb.cpu) && /^\d+%$/.test(sb.mem) && sb.mem !== '0%'
      && sb.raid !== '00:00:00' && sb.shell === shellName, JSON.stringify(sb));

    // ---- many tabs ----
    for (let i = 0; i < 10; i++) await shortcut('tab:new');
    await sleep(600);
    const plus = $('#new-tab').getBoundingClientRect();
    const gear = $('#settings').getBoundingClientRect();
    check('many tabs: + and gear stay visible', plus.right <= gear.left && gear.right <= innerWidth,
      JSON.stringify({ n: tabs.length, plus: plus.right, gear: gear.left, w: innerWidth }));

    // ---- window controls ----
    if (WIN) {
      await click($('[data-action=maximize]'));
      await sleep(700);
      check('maximize button', (await invoke('qa_window_state')).maximized);
      await click($('[data-action=maximize]'));
      await sleep(700);
      check('restore button', !(await invoke('qa_window_state')).maximized);
      await click($('[data-action=minimize]'));
      await sleep(700);
      check('minimize button', (await invoke('qa_window_state')).minimized);
      await invoke('qa_window_state', { action: 'restore' });
      await sleep(500);
    }

    check('no frontend errors', errors.length === 0, errors.join(' | ').slice(0, 500));
  } catch (e) {
    check('QA script crashed', false, String(e && e.stack || e));
  }

  await invoke('qa_report', { lines, failed });
})();
