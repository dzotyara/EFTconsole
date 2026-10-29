'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { execFile } = require('child_process');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// User config lives in ~/.eftconsole.json (or $EFTCONSOLE_CONFIG); every key is optional.
const CONFIG_PATH = process.env.EFTCONSOLE_CONFIG || path.join(os.homedir(), '.eftconsole.json');
const DEFAULT_CONFIG = {
  shell: null, // null = auto-detect
  shellArgs: null,
  fontSize: 14,
  fontFamily: null,
  bootAnimation: true,
  scanlines: true,
  cursorBlink: true,
  callsign: null, // shown in the status bar; defaults to the OS user name
};

function loadConfig() {
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...user };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function findOnPath(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveShell(config) {
  if (config.shell) {
    return { file: config.shell, args: config.shellArgs || [] };
  }
  if (isWin) {
    const pwsh = findOnPath('pwsh.exe');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

const config = loadConfig();
const terminals = new Map();

const SIGNAL_NAMES = Object.fromEntries(Object.entries(os.constants.signals).map(([name, num]) => [num, name]));
// Windows has no signals; these are the exit codes a process gets when it is
// terminated from outside (taskkill /F, Task Manager, Stop-Process, Ctrl+Break).
const WIN_KILL_CODES = new Set([1, -1, 0xffffffff, 0xc000013a]);

function describeExit(exitCode, signal) {
  if (signal) return { exitCode, killed: true, cause: SIGNAL_NAMES[signal] || `signal ${signal}` };
  if (isWin && WIN_KILL_CODES.has(exitCode)) return { exitCode, killed: true, cause: 'terminated' };
  return { exitCode, killed: false };
}
let nextId = 1;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 560,
    minHeight: 360,
    backgroundColor: '#0a0b09',
    show: false,
    frame: isMac, // macOS keeps native traffic lights via hiddenInset
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links clicked in the terminal open in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('closed', () => {
    for (const term of terminals.values()) term.kill();
    terminals.clear();
    win = null;
  });
}

ipcMain.handle('config:get', () => ({
  ...config,
  platform: process.platform,
  hostname: os.hostname(),
  username: os.userInfo().username,
}));

ipcMain.handle('pty:spawn', (_e, { cols, rows }) => {
  const { file, args } = resolveShell(config);
  const id = nextId++;
  const term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: { ...process.env, TERM_PROGRAM: 'EFTconsole', COLORTERM: 'truecolor' },
  });
  terminals.set(id, term);

  term.onData((data) => win && win.webContents.send('pty:data', id, data));
  term.onExit(({ exitCode, signal }) => {
    terminals.delete(id);
    if (isWin) setTimeout(reapOrphanConhosts, 500);
    if (win) win.webContents.send('pty:exit', id, describeExit(exitCode, signal));
  });

  return { id, pid: term.pid, shell: path.basename(file).replace(/\.exe$/i, '') };
});

// node-pty 1.1 never closes the pseudoconsole of a shell that exits on its own,
// so its conhost.exe (a direct child of this process) lives on forever. Pair
// every live shell with the conhost created right before it; whatever is left
// over belongs to a dead shell. Fresh conhosts are skipped: their shell may
// still be starting.
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
function reapOrphanConhosts() {
  const script =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ` +
    `Select-Object ProcessId,Name,@{n='t';e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, out) => {
    if (err || !out.trim()) return;
    let procs = JSON.parse(out);
    if (!Array.isArray(procs)) procs = [procs];
    const byTime = (a, b) => a.t - b.t;
    const livePids = new Set([...terminals.values()].map((t) => t.pid));
    const shells = procs.filter((p) => livePids.has(p.ProcessId)).sort(byTime);
    const hosts = procs.filter((p) => /^conhost\.exe$/i.test(p.Name)).sort(byTime);

    const owned = new Set();
    for (const sh of shells) {
      const host = hosts.filter((h) => h.t <= sh.t && !owned.has(h.ProcessId)).pop();
      if (host) owned.add(host.ProcessId);
    }
    const cutoff = (Date.now() - 3000 + FILETIME_EPOCH_OFFSET_MS) * 10000;
    let retry = false;
    for (const h of hosts) {
      if (owned.has(h.ProcessId)) continue;
      if (h.t > cutoff) {
        retry = true;
        continue;
      }
      try {
        process.kill(h.ProcessId);
      } catch {
        // already gone
      }
    }
    if (retry) setTimeout(reapOrphanConhosts, 3500);
  });
}

ipcMain.on('pty:write', (_e, id, data) => terminals.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try {
    terminals.get(id)?.resize(cols, rows);
  } catch {
    // resizing a pty that just exited throws; safe to ignore
  }
});
ipcMain.on('pty:kill', (_e, id) => {
  terminals.get(id)?.kill();
  terminals.delete(id);
});

ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win?.close());
ipcMain.on('window:devtools', () => win?.webContents.toggleDevTools());
ipcMain.on('config:open', () => openConfig());

// CPU usage from os.cpus() deltas works on every platform (loadavg is 0 on Windows).
let lastCpu = os.cpus();
function sampleCpu() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((cpu, i) => {
    const prev = lastCpu[i]?.times || cpu.times;
    for (const key of Object.keys(cpu.times)) {
      const delta = cpu.times[key] - prev[key];
      total += delta;
      if (key === 'idle') idle += delta;
    }
  });
  lastCpu = now;
  return total > 0 ? 1 - idle / total : 0;
}

// os.freemem() on macOS excludes file cache, so it always reads ~99% used.
// Use the same buckets as Activity Monitor's "Memory Used" instead.
function sampleMem() {
  const fallback = 1 - os.freemem() / os.totalmem();
  if (!isMac) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile('/usr/bin/vm_stat', (err, out) => {
      if (err) return resolve(fallback);
      const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] || 4096);
      const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] || 0);
      const used = pages('Anonymous pages') - pages('Pages purgeable') +
        pages('Pages wired down') + pages('Pages occupied by compressor');
      resolve(used > 0 ? Math.min(1, (used * pageSize) / os.totalmem()) : fallback);
    });
  });
}

setInterval(async () => {
  if (!win) return;
  const cpu = sampleCpu();
  const mem = await sampleMem();
  win?.webContents.send('stats', { cpu, mem });
}, 2000);

// On macOS shortcuts go through the native menu. Frameless Windows/Linux
// windows have no menu bar, so the renderer handles shortcuts there itself.
function buildMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const send = (channel) => () => win?.webContents.send(channel);
  const template = [
    { role: 'appMenu' },
    {
      label: 'Shell',
      submenu: [
        { label: 'New Tab', accelerator: 'Cmd+T', click: send('tab:new') },
        { label: 'Close Tab', accelerator: 'Cmd+W', click: send('tab:close') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('tab:next') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('tab:prev') },
        { type: 'separator' },
        { label: 'Open Config', click: () => openConfig() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy', accelerator: 'Cmd+C', click: send('edit:copy') },
        { label: 'Paste', accelerator: 'Cmd+V', click: send('edit:paste') },
        { label: 'Select All', accelerator: 'Cmd+A', click: send('edit:selectAll') },
        { label: 'Clear', accelerator: 'Cmd+K', click: send('edit:clear') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'Cmd+=', click: send('font:bigger') },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: send('font:smaller') },
        { label: 'Reset Zoom', accelerator: 'Cmd+0', click: send('font:reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  shell.openPath(CONFIG_PATH).then((err) => {
    // Windows has no default app for .json out of the box.
    if (err && isWin) execFile('notepad.exe', [CONFIG_PATH]);
  });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
