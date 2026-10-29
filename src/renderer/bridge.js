'use strict';

// window.eft: the frontend's only door to the native side (Tauri commands/events).
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const dataListeners = [];
  const emitData = (id, bytes) => dataListeners.forEach((cb) => cb(id, bytes));
  const on = (event, cb) => {
    listen(event, (e) => cb(e.payload));
  };

  window.eft = {
    getConfig: () => invoke('config_get'),

    async spawn(cols, rows) {
      // Output may arrive before invoke resolves with the id; hold it until then.
      let id = null;
      const early = [];
      const channel = new Channel();
      channel.onmessage = (buf) => {
        const bytes = new Uint8Array(buf);
        if (id === null) early.push(bytes);
        else emitData(id, bytes);
      };
      const info = await invoke('pty_spawn', { cols, rows, onData: channel });
      id = info.id;
      early.forEach((bytes) => emitData(id, bytes));
      return info;
    },
    write: (id, data) => invoke('pty_write', { id, data }),
    resize: (id, cols, rows) => invoke('pty_resize', { id, cols, rows }),
    kill: (id) => invoke('pty_kill', { id }),
    onData: (cb) => dataListeners.push(cb),
    onExit: (cb) => on('pty:exit', ({ id, info }) => cb(id, info)),

    copy: (text) => invoke('clipboard_write', { text }),
    paste: () => invoke('clipboard_read'),
    openExternal: (url) => invoke('open_external', { url }),
    openConfig: () => invoke('config_open'),

    minimize: () => invoke('window_minimize'),
    toggleMaximize: () => invoke('window_toggle_maximize'),
    close: () => invoke('window_close'),
    toggleDevTools: () => invoke('window_devtools'),

    onStats: (cb) => on('stats', cb),
    // Native menu items (macOS) arrive as one "command" event carrying the item id.
    onCommand: (channel, cb) => on('command', (id) => id === channel && cb()),
  };
})();
