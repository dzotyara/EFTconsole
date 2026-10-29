// End-to-end QA: drives the real app with synthesized mouse/keyboard input and
// checks DOM and window state.
//
//   npm run qa              native mode for this OS
//   npm run qa:win-sim      macOS/Linux only: run the Windows code paths
//
// On Windows it uses cmd.exe; elsewhere zsh/bash without user rc files.
// Screenshots land in $QA_OUT (default: $TMPDIR/eftconsole-qa).
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const REAL_WIN = process.platform === 'win32';
const SIMULATE_WIN = process.env.QA_SIMULATE_WIN === '1' && !REAL_WIN;
const MODE = REAL_WIN || SIMULATE_WIN ? 'win' : 'mac';
const OUT = process.env.QA_OUT || path.join(os.tmpdir(), 'eftconsole-qa');
fs.mkdirSync(OUT, { recursive: true });

// Windows CI doesn't reliably surface Electron's stdout, so mirror it to a file.
const LOG = path.join(OUT, 'qa.log');
fs.writeFileSync(LOG, '');
const log = console.log;
console.log = (...args) => {
  log(...args);
  fs.appendFileSync(LOG, args.join(' ') + '\n');
};
process.on('uncaughtException', (e) => console.log('UNCAUGHT', e.stack));
console.log(`qa start: platform=${process.platform} electron=${process.versions.electron}`);

const { app, clipboard, shell, Menu } = require('electron');

// Shell-specific commands used by the checks.
const posixShell = fs.existsSync('/bin/zsh') ? ['/bin/zsh', ['-f']] : ['/bin/bash', ['--norc']];
const SH = REAL_WIN
  ? {
      shell: 'cmd.exe', args: [], name: 'cmd',
      sleep: 'ping -n 30 127.0.0.1 >nul',
      size: 'mode con',
      sizeRe: (rows, cols) => new RegExp(`Lines:\\s+${rows}[\\s\\S]*Columns:\\s+${cols}`),
    }
  : {
      shell: posixShell[0], args: posixShell[1], name: path.basename(posixShell[0]),
      sleep: 'sleep 30',
      size: 'stty size',
      sizeRe: (rows, cols) => new RegExp(`\\n${rows} ${cols}`),
    };

// Temp config pinning the shell, so user rc files can't interfere. (Don't touch
// HOME/USERPROFILE: Chromium on Windows crashes at startup if they change.)
const home = fs.mkdtempSync(path.join(OUT, `cfg-${MODE}-`));
process.env.EFTCONSOLE_CONFIG = path.join(home, '.eftconsole.json');
fs.writeFileSync(process.env.EFTCONSOLE_CONFIG, JSON.stringify({ shell: SH.shell, shellArgs: SH.args }));

if (SIMULATE_WIN) {
  // Load node-pty with the real platform first, then make the app code think it's on Windows.
  require(require.resolve('node-pty', { paths: [APP] }));
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

const opened = [];
const external = [];
shell.openPath = async (p) => { opened.push(p); return ''; };
shell.openExternal = async (u) => { external.push(u); };
// Keep the app alive after its window closes so the report can be printed.
app.quit = () => {};

let pass = 0;
let fail = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
process.on('uncaughtException', (e) => errors.push('main: ' + e.stack));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shells (and their console hosts) still parented under this process.
function shellProcesses() {
  const { execFileSync } = require('child_process');
  let procs;
  if (REAL_WIN) {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress']).toString();
    procs = JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }));
  } else {
    procs = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=']).toString().trim().split('\n').map((l) => {
      const [pid, ppid, ...rest] = l.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), name: path.basename(rest.join(' ')) };
    });
  }
  const found = [];
  const walk = (pid) => {
    for (const p of procs) {
      if (p.ppid !== pid || /^(powershell|ps)(\.exe)?$/i.test(p.name)) continue;
      if (/^(cmd|conhost|openconsole|ping|-?zsh|-?bash)(\.exe)?$/i.test(p.name)) found.push(p);
      walk(p.pid);
    }
  };
  walk(process.pid);
  return found;
}

function killAll(list) {
  for (const p of list) {
    try { process.kill(p.pid); } catch {}
  }
}

// Never hang CI: bail out if the run takes far longer than it should.
setTimeout(() => {
  console.log('FAIL  watchdog: QA did not finish in 4 minutes');
  killAll(shellProcesses());
  app.exit(1);
}, 4 * 60 * 1000).unref();

async function run(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`);
  const waitFor = async (fn, ms = 4000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (await fn()) return true;
      await sleep(100);
    }
    return false;
  };
  const center = (sel) => js(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  const click = async (pt, button = 'left') => {
    wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button, clickCount: 1 });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button, clickCount: 1 });
    await sleep(250);
  };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(300);
  };
  const type = async (text) => { wc.insertText(text); await sleep(120); };
  const enter = () => key('Return');
  const run = async (cmd) => { await type(cmd); await enter(); await sleep(300); };
  const buffer = () => js(`const b = active.term.buffer.active; let s = '';
    for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s;`);
  const state = () => js(`return { n: tabs.length, active: tabs.indexOf(active), dead: tabs.map(t => !!t.dead), font: fontSize };`);
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `qa-${MODE}-${name}.png`), (await wc.capturePage()).toPNG());

  const SHORTCUTS = {
    'tab:new': [['T', ['control', 'shift']], 'New Tab'],
    'tab:close': [['W', ['control', 'shift']], 'Close Tab'],
    'tab:next': [['Tab', ['control']], 'Next Tab'],
    'tab:prev': [['Tab', ['control', 'shift']], 'Previous Tab'],
    'edit:copy': [['C', ['control', 'shift']], 'Copy'],
    'edit:paste': [['V', ['control', 'shift']], 'Paste'],
    'edit:selectAll': [['A', ['control', 'shift']], 'Select All'],
    'edit:clear': [['K', ['control', 'shift']], 'Clear'],
    'font:bigger': [['=', ['control']], 'Zoom In'],
    'font:smaller': [['-', ['control']], 'Zoom Out'],
    'font:reset': [['0', ['control']], 'Reset Zoom'],
  };
  const findMenu = (label) => {
    const walk = (items) => {
      for (const it of items) {
        if (it.label === label) return it;
        if (it.submenu) { const f = walk(it.submenu.items); if (f) return f; }
      }
      return null;
    };
    return walk(Menu.getApplicationMenu()?.items || []);
  };
  const shortcut = async (name) => {
    const [[code, mods], label] = SHORTCUTS[name];
    if (MODE === 'win') return key(code, mods);
    // On macOS these go through the native menu, which sendInputEvent can't reach.
    const item = findMenu(label);
    if (!item) { check(`menu item "${label}" exists`, false); return; }
    item.click();
    await sleep(300);
  };
  const jumpKey = (n) => key(String(n), [MODE === 'win' ? 'control' : 'meta']);

  win.focus();
  wc.setBackgroundThrottling(false);

  // ---- boot overlay & hit testing ----
  const t0 = Date.now();
  await waitFor(() => js(`return getComputedStyle(document.querySelector('#boot')).display === 'none'`), 8000);
  console.log(`boot finished after ${Date.now() - t0}ms`);
  await shot('01-after-boot');
  const bootDisplay = await js(`return getComputedStyle(document.querySelector('#boot')).display`);
  check('boot overlay removed after boot', bootDisplay === 'none', `display=${bootDisplay}`);

  const hit = (sel) => js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    if (!r.width) return { hidden: true };
    const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    let region = 'none';
    for (const s of stack) {
      const v = getComputedStyle(s).getPropertyValue('-webkit-app-region') || getComputedStyle(s).webkitAppRegion;
      if (v === 'drag' || v === 'no-drag') { region = v; break; }
    }
    return { inside: el.contains(stack[0]), top: stack[0].id || stack[0].className, region };`);
  const hitTargets = ['#new-tab', '#settings', '.tab .title', '.tab .x', '#terminals'];
  if (MODE === 'win') hitTargets.push('#window-controls [data-action=minimize]', '#window-controls [data-action=maximize]', '#window-controls [data-action=close]');
  for (const sel of hitTargets) {
    const h = await hit(sel);
    check(`clickable: ${sel}`, h.inside && h.region !== 'drag', JSON.stringify(h));
  }
  if (MODE === 'mac') {
    const wc2 = await js(`return getComputedStyle(document.querySelector('#window-controls')).display`);
    check('mac: custom window controls hidden', wc2 === 'none');
  }

  // ---- typing ----
  await waitFor(async () => (await buffer()).trim().length > 0);
  await click(await center('#terminals'));
  await run('echo qa-42');
  check('typing + enter runs command', await waitFor(async () => /\nqa-42/.test(await buffer())));

  // ---- mouse: tabs ----
  await click(await center('#new-tab'));
  let s = await state();
  check('click + opens a new tab', s.n === 2 && s.active === 1, JSON.stringify(s));
  check('new tab gets a prompt', await waitFor(async () => (await buffer()).trim().length > 0));
  await click(await center('.tab:nth-child(1) .title'));
  s = await state();
  check('click tab 1 activates it', s.active === 0, JSON.stringify(s));
  await click(await center('.tab:nth-child(2) .x'));
  s = await state();
  check('click x closes tab 2', s.n === 1 && s.active === 0, JSON.stringify(s));

  // ---- shortcuts ----
  await shortcut('tab:new');
  await sleep(300);
  s = await state();
  check('shortcut: new tab', s.n === 2 && s.active === 1, JSON.stringify(s));
  await click(await center('.tab:nth-child(2) .title'), 'middle');
  s = await state();
  check('middle click closes tab', s.n === 1, JSON.stringify(s));
  await shortcut('tab:new');
  await shortcut('tab:new');
  await sleep(300);
  s = await state();
  check('shortcut: new tab x2', s.n === 3 && s.active === 2, JSON.stringify(s));
  await shortcut('tab:next');
  s = await state();
  check('shortcut: next tab wraps', s.active === 0, JSON.stringify(s));
  await shortcut('tab:prev');
  s = await state();
  check('shortcut: prev tab wraps', s.active === 2, JSON.stringify(s));
  await key('Tab', ['control']);
  s = await state();
  check('Ctrl+Tab key (renderer)', s.active === 0, JSON.stringify(s));
  await jumpKey(2);
  s = await state();
  check(`${MODE === 'win' ? 'Ctrl' : 'Cmd'}+2 jumps to tab 2`, s.active === 1, JSON.stringify(s));
  await shortcut('tab:close');
  s = await state();
  check('shortcut: close tab', s.n === 2, JSON.stringify(s));
  await jumpKey(1);

  // ---- clipboard ----
  await run('echo clip-77');
  await shortcut('edit:selectAll');
  await shortcut('edit:copy');
  check('select all + copy', (await clipboard.readText()).includes('clip-77'), JSON.stringify((await clipboard.readText()).slice(0, 60)));
  if (MODE === 'win') check('selection cleared after copy', !(await js(`return active.term.hasSelection()`)));
  await clipboard.writeText('echo pasted-55');
  await shortcut('edit:paste');
  await enter();
  check('paste shortcut', await waitFor(async () => /\npasted-55/.test(await buffer())));

  if (MODE === 'win') {
    await clipboard.writeText('echo ctrlv-66');
    await key('V', ['control']);
    await enter();
    check('Ctrl+V pastes', await waitFor(async () => /\nctrlv-66/.test(await buffer())));
    await run(SH.sleep);
    await key('C', ['control']);
    await run('echo after-int');
    check('Ctrl+C without selection interrupts', await waitFor(async () => /\nafter-int/.test(await buffer()), 2500));
    await clipboard.clear();
    await shortcut('edit:selectAll');
    await key('C', ['control']);
    check('Ctrl+C with selection copies', (await clipboard.readText()).includes('after-int'));
  }

  // ---- right click & mouse selection ----
  await clipboard.writeText('echo rc-paste-88');
  await click(await center('#terminals'), 'right');
  await enter();
  check('right click pastes when nothing selected', await waitFor(async () => /\nrc-paste-88/.test(await buffer())));
  const sc = await js(`const r = active.pane.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.x, y: r.y };`);
  wc.sendInputEvent({ type: 'mouseDown', x: sc.x + 4, y: sc.y + 8, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) { wc.sendInputEvent({ type: 'mouseMove', x: sc.x + 4 + i * 40, y: sc.y + 8 + i * 6, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(30); }
  wc.sendInputEvent({ type: 'mouseUp', x: sc.x + 204, y: sc.y + 38, button: 'left', clickCount: 1 });
  await sleep(200);
  check('mouse drag selects text', await js(`return active.term.hasSelection()`));
  await clipboard.clear();
  await click({ x: sc.x + 100, y: sc.y + 20 }, 'right');
  check('right click copies selection', (await clipboard.readText()).length > 0, JSON.stringify((await clipboard.readText()).slice(0, 40)));

  // ---- font & clear ----
  await shortcut('font:bigger');
  s = await state();
  check('zoom in', s.font === 15, JSON.stringify(s));
  await shortcut('font:smaller');
  await shortcut('font:smaller');
  s = await state();
  check('zoom out', s.font === 13, JSON.stringify(s));
  await shortcut('font:reset');
  s = await state();
  check('zoom reset', s.font === 14, JSON.stringify(s));
  await shortcut('edit:clear');
  check('clear', !(await buffer()).includes('clip-77'));

  // ---- resize propagates to the pty ----
  win.setSize(700, 420);
  await sleep(600);
  const dims = await js(`return { cols: active.term.cols, rows: active.term.rows }`);
  await run(SH.size);
  check('window resize reaches the pty', await waitFor(async () => SH.sizeRe(dims.rows, dims.cols).test(await buffer())), JSON.stringify(dims));
  win.setSize(1100, 700);
  await sleep(500);

  // ---- links ----
  await shortcut('edit:clear');
  await run('echo https://example.com/eft');
  const link = await js(`
    const b = active.term.buffer.active;
    let row = -1;
    for (let i = 0; i < active.term.rows; i++) {
      const t = b.getLine(b.viewportY + i)?.translateToString(true) || '';
      if (t.startsWith('https://example.com/eft')) { row = i; break; }
    }
    const r = active.pane.querySelector('.xterm-screen').getBoundingClientRect();
    const cell = active.term._core._renderService.dimensions.css.cell;
    return { row, x: Math.round(r.x + cell.width * 5), y: Math.round(r.y + cell.height * (row + 0.5)) };`);
  wc.sendInputEvent({ type: 'mouseMove', x: link.x, y: link.y });
  await sleep(300);
  await click(link);
  await sleep(300);
  check('clicking a URL opens it externally', external.includes('https://example.com/eft'), JSON.stringify({ link, external }));

  // ---- shell exit screens ----
  await run('exit 3');
  check('exit 3 shows KILLED IN ACTION', await waitFor(() => js(`return !!active.pane.querySelector('.raid-end.kia')`)));
  await shot('02-kia');
  await click(await center('#new-tab'));
  await sleep(300);
  await jumpKey(2);
  check('dead tab: other tabs still usable', (await state()).active === 1);
  await jumpKey(1);
  check('back on the dead tab', await js(`return active === tabs[0] && !!active.dead`));
  await type('ls');
  check('dead tab ignores typing', !(await buffer()).includes('ls'));
  await enter();
  await sleep(800);
  const redeployed = await js(`return !active.dead && !active.pane.querySelector('.raid-end')`);
  check('Enter redeploys a dead tab', redeployed);
  await run('echo back-99');
  check('redeployed shell works', await waitFor(async () => /\nback-99/.test(await buffer())));

  // Killing the shell process from outside -> KILLED / HEAD, EYES
  process.kill(await js(`return active.pid`), 'SIGKILL');
  check('killed shell shows KILLED / HEAD, EYES', await waitFor(() => js(`
    const el = active.pane.querySelector('.raid-end.killed');
    return !!el && el.innerText.includes('KILLED') && el.innerText.includes('HEAD, EYES');`)));
  await shot('02b-killed');
  await enter();
  await sleep(800);
  check('Enter redeploys a killed tab', await js(`return !active.dead && !active.pane.querySelector('.raid-end')`));
  await run('echo alive-11');
  check('shell works after kill + redeploy', await waitFor(async () => /\nalive-11/.test(await buffer())));
  await run('exit');
  check('exit 0 shows SURVIVED', await waitFor(() => js(`return !!active.pane.querySelector('.raid-end:not(.kia)')`)));
  const before = (await state()).n;
  await key('Escape');
  await sleep(300);
  s = await state();
  check('Esc closes a dead tab', s.n === before - 1, JSON.stringify(s));

  // ---- settings & status bar ----
  await click(await center('#settings'));
  check('gear opens config', opened.some((p) => p.endsWith('.eftconsole.json')), JSON.stringify(opened));
  const sb = await js(`return { cpu: document.querySelector('#v-cpu').textContent, mem: document.querySelector('#v-mem').textContent,
    raid: document.querySelector('#sb-raid').textContent, shell: document.querySelector('#sb-shell').textContent }`);
  check('status bar populated', /^\d+%$/.test(sb.cpu) && /^\d+%$/.test(sb.mem) && sb.raid !== '00:00:00' && sb.shell === SH.name, JSON.stringify(sb));

  // ---- many tabs layout ----
  for (let i = 0; i < 10; i++) await shortcut('tab:new');
  await sleep(500);
  const layout = await js(`const plus = document.querySelector('#new-tab').getBoundingClientRect();
    const gear = document.querySelector('#settings').getBoundingClientRect();
    return { n: tabs.length, plusRight: plus.right, gearLeft: gear.left, width: innerWidth };`);
  check('many tabs: + and gear stay visible', layout.plusRight <= layout.gearLeft && layout.gearLeft < layout.width, JSON.stringify(layout));
  await shot('03-many-tabs');

  // ---- window controls ----
  if (MODE === 'win') {
    await click(await center('#window-controls [data-action=maximize]'));
    await sleep(500);
    check('maximize button', win.isMaximized());
    await click(await center('#window-controls [data-action=maximize]'));
    await sleep(500);
    check('restore button', !win.isMaximized());
    await click(await center('#window-controls [data-action=minimize]'));
    await sleep(500);
    check('minimize button', win.isMinimized());
    win.restore();
    await sleep(500);
  }

  check('no renderer/main errors', errors.length === 0, errors.join(' | ').slice(0, 600));

  // ---- closing ----
  const closed = new Promise((r) => win.once('closed', r));
  if (MODE === 'win') await click(await center('#window-controls [data-action=close]'));
  else { while (!win.isDestroyed() && (await state()).n > 0) await shortcut('tab:close'); }
  const didClose = await Promise.race([closed.then(() => true), sleep(3000).then(() => false)]);
  check(MODE === 'win' ? 'close button closes window' : 'closing last tab closes window', didClose);

  await sleep(1500);
  const leftovers = shellProcesses();
  check('no shell processes left after closing', leftovers.length === 0, JSON.stringify(leftovers));
  killAll(leftovers);
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push('renderer: ' + e.message);
  });
  win.webContents.once('did-finish-load', () => {
    run(win)
      .catch((e) => check('harness crashed', false, e.stack))
      .finally(() => {
        console.log(`\n${MODE.toUpperCase()}${SIMULATE_WIN ? ' (simulated)' : ''}: ${pass} passed, ${fail} failed`);
        fs.rmSync(home, { recursive: true, force: true });
        app.exit(fail ? 1 : 0);
      });
  });
});

require(path.join(APP, 'src/main.js'));
