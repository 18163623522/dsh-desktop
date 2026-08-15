const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const HOST = '127.0.0.1';
const PORT = 3080;
const BASE_URL = `http://${HOST}:${PORT}`;
const STARTUP_TIMEOUT_MS = 90_000;

let dshProcess = null;
let dshExitInfo = null;
let mainWindow = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(main);
}

function resolveDshEntry() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'node_modules')
    : path.join(__dirname, 'node_modules');
  return path.join(
    base, '@deepseek-ai', 'dsh', 'lib', 'bin.js'
  );
}

function dshLogPath() {
  return path.join(app.getPath('userData'), 'dsh-server.log');
}

function startDshServer() {
  const entry = resolveDshEntry();
  if (!fs.existsSync(entry)) {
    fatal(`未找到 dsh 运行时：${entry}`);
  }

  const logStream = fs.createWriteStream(dshLogPath(), { flags: 'w' });

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // dsh 检测到环境变量提供 API 密钥时，会把设置界面的密钥输入框锁定为只读
  // （“由启动环境提供”）。剥离这些变量，让密钥在界面中可填写、由 dsh 配置管理。
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;
  const preloadArgs = [];
  if (app.isPackaged) {
    // 目录选择 worker 依赖真实 Node（koffi 在 Electron 内嵌 Node 下会 fatal）。
    // 通过钩子把后端的 process.execPath 指回随包 node.exe，使其派生的 worker
    // 运行于真实 Node。以 --require 实参传入（不走 NODE_OPTIONS，避免解析/空格问题）。
    const realNode = path.join(process.resourcesPath, 'vendor', 'node.exe');
    const hook = path.join(process.resourcesPath, 'vendor', 'exec-path-hook.cjs');
    if (fs.existsSync(realNode) && fs.existsSync(hook)) {
      env.DSH_REAL_NODE = realNode;
      preloadArgs.push('--require', hook);
    }
  }

  // dsh 的 HMR 插件需要 --expose-internals 才能访问 Node 内部模块；
  // 其原生插件兜底方案在 ELECTRON_RUN_AS_NODE 下不可用，故显式传该标志
  dshProcess = spawn(
    process.execPath,
    ['--expose-internals', ...preloadArgs, entry, 'web'],
    {
      cwd: app.getPath('home'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  dshProcess.stdout.on('data', (d) => logStream.write(d));
  dshProcess.stderr.on('data', (d) => logStream.write(d));
  dshProcess.on('exit', (code, signal) => {
    logStream.end(`\n[dsh exited: code=${code} signal=${signal}]\n`);
    if (!quitting) dshExitInfo = { code, signal };
  });
}

function stopDshServer() {
  if (!dshProcess) return;
  const pid = dshProcess.pid;
  dshProcess = null;
  if (process.platform === 'win32' && pid) {
    // dsh 会派生多级子进程，必须按进程树终止
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try { dshProcess?.kill?.('SIGTERM'); } catch {}
  }
}

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}`, (res) => {
      res.resume();
      resolve(res.statusCode ? res.statusCode < 500 : false);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkServer()) return true;
    if (dshExitInfo) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#101014',
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:3080') || url.startsWith(BASE_URL)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

async function main() {
  Menu.setApplicationMenu(null);
  createWindow();

  // 端口已被占用时（例如已有一个 dsh 实例），直接复用现有服务
  if (!(await checkServer())) {
    startDshServer();
  }

  const ok = await waitForServer();
  if (!ok) {
    const detail = dshExitInfo
      ? `dsh 服务进程异常退出（code=${dshExitInfo.code} signal=${dshExitInfo.signal}）。`
      : `等待 ${STARTUP_TIMEOUT_MS / 1000} 秒后服务仍未就绪。`;
    fatal(`DeepSeek Harness 启动失败。\n\n${detail}\n\n日志文件：${dshLogPath()}`);
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 服务就绪初期可能出现连接重置，短暂重试
  for (let i = 0; i < 5; i++) {
    try {
      await mainWindow.loadURL(BASE_URL);
      break;
    } catch (err) {
      if (i === 4) {
        fatal(`无法加载界面：${err.message}\n\n日志文件：${dshLogPath()}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function fatal(message) {
  dialog.showErrorBox('DeepSeek Harness', message);
  app.exit(1);
}

app.on('before-quit', () => {
  quitting = true;
  stopDshServer();
});

app.on('window-all-closed', () => {
  app.quit();
});
