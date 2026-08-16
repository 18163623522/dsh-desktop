// 渲染进程 ↔ 主进程桥接：
//   主窗口（dsh Web UI）：dshDesktop —— 检查更新 / 打开 TUI 窗口
//   TUI 窗口（tui.html）：dshGui —— 聊天事件通道
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  checkUpdate: () => ipcRenderer.send('dsh-check-update'),
  openTui: () => ipcRenderer.send('dsh-open-tui'),
});

contextBridge.exposeInMainWorld('dshGui', {
  send: (text) => ipcRenderer.send('dsh-gui-send', text),
  newSession: () => ipcRenderer.send('dsh-gui-new'),
  onEvent: (cb) => ipcRenderer.on('dsh-gui-event', (_e, ev) => cb(ev)),
});
