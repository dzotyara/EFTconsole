'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('eft', {
  getConfig: () => ipcRenderer.invoke('config:get'),

  spawn: (cols, rows) => ipcRenderer.invoke('pty:spawn', { cols, rows }),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (cb) => on('pty:data', cb),
  onExit: (cb) => on('pty:exit', cb),

  copy: (text) => ipcRenderer.send('clipboard:write', text),
  paste: () => ipcRenderer.invoke('clipboard:read'),

  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),

  onStats: (cb) => on('stats', cb),
  onCommand: (channel, cb) => on(channel, cb),
  openConfig: () => ipcRenderer.send('config:open'),
  toggleDevTools: () => ipcRenderer.send('window:devtools'),
});
