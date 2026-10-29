'use strict';

// Runs the built app in QA mode (src/renderer/qa.js drives the UI) and exits
// with its result.
//   node scripts/qa.js [path-to-binary]
// Default binary: src-tauri/target/{release,debug}/eftconsole[.exe]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = process.platform === 'win32' ? 'eftconsole.exe' : 'eftconsole';
const bin = process.argv[2] ||
  ['release', 'debug'].map((p) => path.join(root, 'src-tauri/target', p, exe)).find((p) => fs.existsSync(p));
if (!bin || !fs.existsSync(bin)) {
  console.error('No built binary found; run `npx tauri build --no-bundle` first.');
  process.exit(2);
}

const out = process.env.QA_OUT || path.join(os.tmpdir(), 'eftconsole-qa');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(path.join(out, 'qa.log'), { force: true });

// Pin the shell and skip user rc files so results don't depend on the machine.
const shell = process.platform === 'win32'
  ? { shell: 'cmd.exe', shellArgs: [] }
  : fs.existsSync('/bin/zsh') ? { shell: '/bin/zsh', shellArgs: ['-f'] } : { shell: '/bin/bash', shellArgs: ['--norc'] };
const configPath = path.join(out, '.eftconsole.json');
fs.writeFileSync(configPath, JSON.stringify(shell));

console.log(`QA: ${bin}`);
const child = spawn(bin, [], {
  stdio: 'ignore',
  env: { ...process.env, EFTCONSOLE_QA: '1', EFTCONSOLE_CONFIG: configPath, QA_OUT: out },
});
const timer = setTimeout(() => {
  console.log('FAIL  watchdog: QA did not finish in 4 minutes');
  child.kill();
}, 4 * 60 * 1000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const log = path.join(out, 'qa.log');
  console.log(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(no qa.log written)');
  process.exit(code ?? 1);
});
