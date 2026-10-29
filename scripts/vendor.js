'use strict';

// Copies the xterm.js runtime files into src/renderer/vendor, which Tauri
// bundles as the frontend (node_modules itself is not shipped).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src/renderer/vendor');
const files = [
  '@xterm/xterm/lib/xterm.js',
  '@xterm/xterm/css/xterm.css',
  '@xterm/addon-fit/lib/addon-fit.js',
  '@xterm/addon-web-links/lib/addon-web-links.js',
];

fs.mkdirSync(out, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(root, 'node_modules', file), path.join(out, path.basename(file)));
}
