'use strict';

// Runs after `npm install`:
// 1. Electron >= 45 no longer downloads its binary in its own install script.
// 2. node-pty 1.1.0 prebuilds ship spawn-helper without the exec bit, which makes
//    every spawn fail on macOS with "posix_spawnp failed".
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

execFileSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' });

const prebuilds = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
