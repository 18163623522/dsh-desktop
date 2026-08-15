// 渲染进程 ↔ 主进程桥接：仅暴露更新检查这一个能力，保持 contextIsolation
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  checkUpdate: () => ipcRenderer.send('dsh-check-update'),
});
