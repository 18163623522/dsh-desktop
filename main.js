const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// GUI 进程的 stdout 管道可能关闭（桌面启动场景），console 写入会 EPIPE 崩溃；
// 更新器日志一律落盘，并放行良性的 EPIPE 未捕获异常
process.on('uncaughtException', (err) => {
  if (err?.code === 'EPIPE') return;
  throw err;
});

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

// 内置 skill 根目录：随包分发的技能（rank 最低，用户/项目自装同名 skill 可覆盖）
function bundledSkillDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-skills')
    : path.join(__dirname, 'bundled-skills');
}

function dshLogPath() {
  return path.join(app.getPath('userData'), 'dsh-server.log');
}

// ===== 插件冲突自愈 =====
// dsh 加载插件树时遇到重复条目 ID 会直接退出（duplicate loader entry id）。
// 这里在启动失败时解析报错，自动停用声明该 ID 的社区插件（官方 bundle 不动），
// 备份配置后重试，把"打不开"变成"自动恢复 + 告知"。
const OFFICIAL_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

function profilePaths() {
  const profileDir = path.join(app.getPath('home'), '.dsh', 'profiles', 'web');
  return {
    pkg: path.join(profileDir, 'package.json'),
    nodeModules: path.join(profileDir, 'node_modules'),
    backup: path.join(profileDir, 'package.json.dsh-desktop-bak'),
  };
}

// ===== 内置插件：目标模式（dsh-goal-mode）=====
// 随包分发「目标模式」插件，并在启动时自动挂载到 profile：
// 1) 把插件文件落到 profile 的 node_modules；2) 把它加入 dsh.profile.bundles。
// 幂等：已存在则跳过；失败不阻断启动。
function ensureGoalModePlugin() {
  const bundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-plugins')
    : path.join(__dirname, 'bundled-plugins');
  const src = path.join(bundledDir, 'dsh-goal-mode');
  if (!fs.existsSync(path.join(src, 'package.json'))) return; // 未随包分发，跳过

  const { pkg: pkgPath, nodeModules } = profilePaths();
  const dst = path.join(nodeModules, 'dsh-goal-mode');
  const BUNDLE = 'dsh-goal-mode';
  const log = (m) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'dsh-server.log'), `[dsh-goal-mode] ${m}\n`); } catch {}
  };

  try {
    // 1) 插件文件：仅在缺失时复制
    if (!fs.existsSync(path.join(dst, 'package.json'))) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']) {
        const from = path.join(src, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, f));
      }
      log('copied plugin into profile node_modules');
    }

    // 2) profile package.json：确保 dsh-goal-mode 在 bundles 里
    let manifest;
    if (fs.existsSync(pkgPath)) {
      manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } else {
      // 首次运行：按 dsh 默认模板创建，并带上 dsh-goal-mode
      manifest = {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
      };
      fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
    }
    const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles;
    if (Array.isArray(bundles) && !bundles.includes(BUNDLE)) {
      manifest.dsh = manifest.dsh || {};
      manifest.dsh.profile = manifest.dsh.profile || {};
      manifest.dsh.profile.bundles = [...bundles, BUNDLE];
      fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n');
      log('mounted dsh-goal-mode in profile bundles');
    }
  } catch (e) {
    log(`auto-mount failed: ${e && e.message ? e.message : e}`);
  }
}

function bundleDeclaredIds(nodeModules, bundle) {
  const root = path.join(nodeModules, ...bundle.split('/'));
  const ymls = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.dsh?.bundle?.patch) ymls.push(pkg.dsh.bundle.patch);
  } catch { return new Set(); }
  if (!ymls.length) {
    for (const c of ['cordis.yml', 'cordis.patch.yml']) {
      if (fs.existsSync(path.join(root, c))) ymls.push(c);
    }
  }
  const ids = new Set();
  for (const y of ymls) {
    const f = path.join(root, y);
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\s*-\s*id:\s*(\S+)/gm)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

// 在加载列表里找出声明了冲突 ID 的社区插件（取顺序靠后的，视为后来者/加害者）
function findConflictingBundle(dupId) {
  const { pkg: pkgPath, nodeModules } = profilePaths();
  let bundles;
  try {
    bundles = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh?.profile?.bundles;
  } catch { return null; }
  if (!Array.isArray(bundles)) return null;
  let culprit = null;
  for (const b of bundles) {
    if (OFFICIAL_BUNDLES.has(b)) continue;
    try {
      if (bundleDeclaredIds(nodeModules, b).has(dupId)) culprit = b;
    } catch {}
  }
  return culprit;
}

// 加载列表里最后一个社区插件（安全模式逐个排除时的候选）
function lastCommunityBundle() {
  const { pkg: pkgPath } = profilePaths();
  try {
    const bundles = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return null;
    return [...bundles].reverse().find((b) => !OFFICIAL_BUNDLES.has(b)) ?? null;
  } catch { return null; }
}

function disableBundle(bundleName, doBackup) {
  const { pkg: pkgPath, backup } = profilePaths();
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== bundleName);
  // 备份只在会话内第一次修改时做，保留用户完整原始配置
  if (doBackup) fs.copyFileSync(pkgPath, backup);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

async function startDshWithSelfHeal() {
  const healed = [];
  let backedUp = false;
  const dbg = (msg) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'heal-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
  for (let attempt = 0; attempt < 10; attempt++) {
    dshExitInfo = null;
    startDshServer();
    if (await waitForServer()) { dbg(`attempt ${attempt}: server ready`); return healed; }
    dbg(`attempt ${attempt}: failed, exitInfo=${JSON.stringify(dshExitInfo)}`);
    // exit 事件可能先于最后的 stderr 落盘（Windows 管道竞态），读日志前稍等
    await new Promise((r) => setTimeout(r, 1500));
    let log = '';
    try { log = fs.readFileSync(dshLogPath(), 'utf8'); } catch (e) { dbg(`read log fail: ${e.message}`); }
    dbg(`attempt ${attempt}: log ${log.length} chars, hasTreeFail=${log.includes('plugin tree failed to load')}`);
    if (!log.includes('plugin tree failed to load')) { dbg('give up: not a plugin tree failure'); return null; }
    const dup = log.match(/duplicate loader entry id: (\S+)/);
    let culprit = null;
    let reason = '';
    if (dup) {
      culprit = findConflictingBundle(dup[1]);
      reason = `冲突条目 ${dup[1]}`;
    } else {
      culprit = lastCommunityBundle();
      reason = '插件树加载失败（安全模式排除）';
    }
    dbg(`attempt ${attempt}: culprit=${culprit} reason=${reason}`);
    if (!culprit) { dbg('give up: no culprit'); return null; }
    try {
      disableBundle(culprit, !backedUp);
    } catch (e) { dbg(`disableBundle threw: ${e.message}`); return null; }
    backedUp = true;
    healed.push({ bundle: culprit, reason });
    dbg(`attempt ${attempt}: disabled ${culprit}, retrying`);
  }
  dbg('exhausted attempts');
  return null;
}

function startDshServer() {
  const entry = resolveDshEntry();
  if (!fs.existsSync(entry)) {
    fatal(`未找到 dsh 运行时：${entry}`);
  }

  const logStream = fs.createWriteStream(dshLogPath(), { flags: 'w' });

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // 随包内置的 skill（如 j-space），通过 skill-filesystem 的 bundled 根加载
  env.DSH_BUNDLED_SKILL_DIR = bundledSkillDir();
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
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (await checkServer()) {
      consecutive++;
      // 端口会先于插件树加载而短暂打开（加载失败随即退出），需连续确认稳定
      if (consecutive >= 3 && !dshExitInfo) return true;
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      consecutive = 0;
      if (dshExitInfo) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

// ===== 窗口状态记忆（大小/位置）=====
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadWindowState(key) {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'))[key];
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {}
  return null;
}
function saveWindowState(key, win) {
  try {
    if (win.isMinimized()) return;
    const p = win.getPosition(), s = win.getSize();
    const state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8').catch(() => '{}') || '{}');
    state[key] = { x: p[0], y: p[1], width: s[0], height: s[1] };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state, null, 2));
  } catch {}
}

function createWindow() {
  const saved = loadWindowState('main');
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
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
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.on('close', () => saveWindowState('main', mainWindow));

  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:3080') || url.startsWith(BASE_URL)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 注入悬浮按钮组（TUI 窗口 + 检查更新；页面每次加载后重新注入）
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents
      .executeJavaScript(`
        (function () {
          function mkBtn(id, text, title, fn, rightPx) {
            if (document.getElementById(id)) return;
            var b = document.createElement('button');
            b.id = id;
            b.textContent = text;
            b.title = title;
            b.style.cssText = [
              'position:fixed', 'right:' + rightPx + 'px', 'bottom:12px', 'z-index:2147483647',
              'padding:4px 10px', 'font-size:12px', 'line-height:1.5',
              'border:1px solid rgba(255,255,255,.18)', 'border-radius:8px',
              'background:rgba(20,20,26,.72)', 'color:#e8e8ec',
              'cursor:pointer', 'backdrop-filter:blur(6px)', 'opacity:.75',
            ].join(';');
            b.onmouseenter = function () { b.style.opacity = '1'; };
            b.onmouseleave = function () { b.style.opacity = '.75'; };
            b.onclick = fn;
            (document.body || document.documentElement).appendChild(b);
          }
          mkBtn('dsh-upd-btn', '\\u27f3 检查更新', '检查 DeepSeek Harness 桌面端更新',
            function () { if (window.dshDesktop && window.dshDesktop.checkUpdate) window.dshDesktop.checkUpdate(); }, 12);
          mkBtn('dsh-tui-btn', '\\u2328 TUI', '打开终端 TUI 窗口（owntui）',
            function () { if (window.dshDesktop && window.dshDesktop.openTui) window.dshDesktop.openTui(); }, 106);
        })();
      `)
      .catch(() => {});
  });

  return mainWindow;
}

async function main() {
  Menu.setApplicationMenu(null);
  ensureGoalModePlugin();
  createWindow();

  // 端口已被占用时（例如已有一个 dsh 实例），直接复用现有服务
  if (!(await checkServer())) {
    const healed = await startDshWithSelfHeal();
    if (!healed) {
      const detail = dshExitInfo
        ? `dsh 服务进程异常退出（code=${dshExitInfo.code} signal=${dshExitInfo.signal}）。`
        : `等待 ${STARTUP_TIMEOUT_MS / 1000} 秒后服务仍未就绪。`;
      fatal(`DeepSeek Harness 启动失败。\n\n${detail}\n\n日志文件：${dshLogPath()}`);
    }
    if (healed.length) {
      const list = healed.map((h) => `• ${h.bundle}（${h.reason}）`).join('\n');
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'DeepSeek Harness',
        message: '已自动停用导致启动失败的插件',
        detail: `以下插件导致 dsh 插件树加载失败，已从加载列表停用（包未卸载）：\n\n${list}\n\n原配置备份于：${profilePaths().backup}`,
        buttons: ['好的'],
      });
    }
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
  setupAutoUpdate();
}

function fatal(message) {
  dialog.showErrorBox('DeepSeek Harness', message);
  app.exit(1);
}

// ===== 更新通知横幅（发现新版本时在页面顶部提示，下载完成后由重启弹窗接管）=====
function showUpdateBanner(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const msg = JSON.stringify(String(text ?? ''));
  mainWindow.webContents.executeJavaScript(`
    (function () {
      var b = document.getElementById('dsh-upd-banner');
      if (!b) {
        b = document.createElement('div');
        b.id = 'dsh-upd-banner';
        b.style.cssText = [
          'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
          'padding:8px 14px', 'font-size:13px', 'line-height:1.5',
          'border:1px solid rgba(255,255,255,.18)', 'border-radius:10px',
          'background:rgba(20,20,26,.85)', 'color:#e8e8ec',
          'box-shadow:0 4px 16px rgba(0,0,0,.4)', 'backdrop-filter:blur(8px)',
          'display:flex', 'align-items:center', 'gap:10px', 'max-width:80vw'
        ].join(';');
        (document.body || document.documentElement).appendChild(b);
      }
      b.textContent = '';
      b.appendChild(document.createTextNode(${msg}));
      var x = document.createElement('span');
      x.textContent = '\\u00d7';
      x.style.cssText = 'cursor:pointer;opacity:.6;font-size:15px;line-height:1;';
      x.onclick = function () { b.remove(); };
      b.appendChild(x);
    })();
  `).catch(() => {});
}

function dismissUpdateBanner() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`
    (function () {
      var b = document.getElementById('dsh-upd-banner');
      if (b) b.remove();
    })();
  `).catch(() => {});
}

// ===== 自动更新（electron-updater + GitHub Releases，仓库公开可匿名下载）=====
// 便携版不支持自更新（electron-updater 限制），出错一律静默不打扰。
// DSH_UPDATER_TEST=1：开发模式测试钩子——伪装成旧版本走完整检查/下载流程
function setupAutoUpdate() {
  const testMode = !!process.env.DSH_UPDATER_TEST;
  if (!app.isPackaged && !testMode) return;
  if (testMode && !app.isPackaged) {
    app.setVersion('0.1.6');
    autoUpdater.forceDevUpdateConfig = true;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const logUpd = (m) => {
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'updater.log'),
        `[${new Date().toISOString()}] ${m}\n`
      );
    } catch {}
  };
  autoUpdater.logger = { info: logUpd, warn: logUpd, error: logUpd, debug: logUpd };
  autoUpdater.on('checking-for-update', () => logUpd('checking...'));
  autoUpdater.on('update-available', (i) => {
    logUpd(`available: ${i.version}`);
    showUpdateBanner(`发现新版本 v${i.version}，正在下载…`);
  });
  autoUpdater.on('update-not-available', () => logUpd('up to date'));
  autoUpdater.on('download-progress', (p) => logUpd(`downloading ${p.percent.toFixed(1)}%`));
  autoUpdater.on('update-downloaded', (i) => logUpd(`downloaded ${i.version}`));

  autoUpdater.on('update-downloaded', async (info) => {
    dismissUpdateBanner();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'DeepSeek Harness',
      message: `新版本 ${info.version} 已就绪`,
      detail: '重启应用后完成安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
    });
    if (r.response === 0) {
      quitting = true;
      stopDshServer();
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on('error', () => {});

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

// 悬浮按钮触发的手动检查（带结果反馈；发现新版走自动下载 → 既有重启弹窗）
ipcMain.on('dsh-check-update', async () => {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'DeepSeek Harness',
      message: '开发模式下不可用',
      detail: '自动更新仅在安装版中生效。',
    });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!latest || latest === app.getVersion()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'DeepSeek Harness',
        message: '已是最新版本',
        detail: `当前版本 ${app.getVersion()}`,
      });
    }
    // 有新版：autoDownload 已开启，下载完成后由 update-downloaded 弹窗接管
  } catch (e) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'DeepSeek Harness',
      message: '检查更新失败',
      detail: String(e?.message ?? e),
    });
  }
});

// ===== TUI 窗口（Web 风格聊天 GUI，常驻 owntui 后端走 JSON 行协议）=====
let tuiWindow = null;
let tuiBackend = null;
let tuiBuf = '';

function tuiDshEntry() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'node_modules')
    : path.join(__dirname, 'node_modules');
  return path.join(base, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function killTuiBackend() {
  if (!tuiBackend) return;
  const pid = tuiBackend.pid;
  tuiBackend = null;
  tuiBuf = '';
  if (process.platform === 'win32' && pid) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

function guiEvent(ev) {
  if (tuiWindow && !tuiWindow.isDestroyed()) {
    tuiWindow.webContents.send('dsh-gui-event', ev);
  }
}

function spawnTuiBackend() {
  if (tuiBackend) return;
  const nodeExe = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'node.exe')
    : process.execPath;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', OWNTUI_IPC: '1' };
  env.DSH_BUNDLED_SKILL_DIR = bundledSkillDir();
  tuiBackend = spawn(
    nodeExe,
    ['--expose-internals', tuiDshEntry(), '--profile', 'owntui'],
    { cwd: app.getPath('home'), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  tuiBackend.stdout.setEncoding('utf8');
  tuiBackend.stdout.on('data', (chunk) => {
    tuiBuf += chunk;
    let idx;
    while ((idx = tuiBuf.indexOf('\n')) >= 0) {
      const line = tuiBuf.slice(0, idx).trim();
      tuiBuf = tuiBuf.slice(idx + 1);
      if (!line) continue;
      try { guiEvent(JSON.parse(line)); } catch {}
    }
  });
  tuiBackend.stderr.setEncoding('utf8');
  tuiBackend.stderr.on('data', (d) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'tui-backend.log'), d); } catch {}
  });
  tuiBackend.on('exit', (code) => {
    tuiBackend = null;
    guiEvent({ type: 'exit', code });
  });
}

function tuiWrite(obj) {
  try { tuiBackend?.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
}

function openTuiWindow() {
  if (tuiWindow && !tuiWindow.isDestroyed()) {
    tuiWindow.show();
    tuiWindow.focus();
    return;
  }
  // owntui profile 需已初始化（~/.dsh/profiles/owntui）
  const profilePkg = path.join(app.getPath('home'), '.dsh', 'profiles', 'owntui', 'package.json');
  if (!fs.existsSync(profilePkg)) {
    dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: 'DeepSeek Harness TUI',
      message: 'TUI 配置尚未初始化',
      detail: '请先在任意终端执行一次：\n\nnpx @deepseek-ai/dsh plugin --profile owntui add F:/Cache/AI/dsh-desktop/owntui\n\n完成后再打开 TUI 窗口。',
    });
    return;
  }
  tuiWindow = new BrowserWindow({
    width: loadWindowState('tui')?.width ?? 860,
    height: loadWindowState('tui')?.height ?? 680,
    x: loadWindowState('tui')?.x,
    y: loadWindowState('tui')?.y,
    title: 'DeepSeek Harness · TUI',
    backgroundColor: '#101014',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  tuiWindow.on('close', () => saveWindowState('tui', tuiWindow));
  tuiWindow.loadFile(path.join(__dirname, 'tui.html'));
  tuiWindow.on('closed', () => {
    tuiWindow = null;
    killTuiBackend();
  });
  tuiWindow.webContents.on('did-finish-load', () => spawnTuiBackend());
}

ipcMain.on('dsh-open-tui', () => openTuiWindow());
ipcMain.on('dsh-gui-send', (_e, text) => tuiWrite({ op: 'send', text }));
ipcMain.on('dsh-gui-new', () => tuiWrite({ op: 'new' }));

app.on('before-quit', () => {
  quitting = true;
  stopDshServer();
});

app.on('window-all-closed', () => {
  app.quit();
});
