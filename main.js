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
let pendingUpdateVersion = null;

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

// ===== 内置插件：随包分发的社区插件集 =====
// 插件本体随 app-deps/node_modules 打包（resources/node_modules），dsh 的
// bundle 解析是「安装目录优先」，因此这里只需要把插件名挂到 profile 的
// dsh.profile.bundles（幂等；不复制文件）。插件自身的第三方依赖同样位于
// resources/node_modules 平铺目录，由 dsh 的模块解析兜底目录自然命中。
const BUNDLED_PLUGINS = [
  'dsh-goal-mode',               // 目标模式（内置）
  'dshmarket',                   // 插件市场
  'dsh-better-sidebar',          // 侧边栏增强
  'dsh-at-file',                 // @文件引用
  '@anionex/dsh-vision-toolkit', // 视觉工具包
  'dsh-mnemon',                  // 记忆
  '@yejiming/dsh-data-agent',    // 数据代理
  '@zseven-w/dsh-openpencil',    // 画布
  '@liustack/modlens',           // 模型透镜
  '@nanmicoder/dsh-auto-mode',   // 自动权限模式
  '@nanmicoder/dsh-agent-teams', // 多代理协作
  'deepseek-flow',               // 深度求索工作流
  'dsh-manager'                  // 设置页管理入口（MCP/Skill/Agent）
];

function ensureBundledPlugins() {
  const { pkg: pkgPath } = profilePaths();
  const log = (m) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'dsh-server.log'), `[bundled-plugins] ${m}\n`); } catch {}
  };

  try {
    let manifest;
    if (fs.existsSync(pkgPath)) {
      manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } else {
      // 首次运行：按 dsh 默认模板创建
      manifest = {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
      };
      fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
    }
    const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles;
    if (!Array.isArray(bundles)) {
      log('profile bundles is not an array — leaving manifest untouched');
      return;
    }
    // 挂载是「每个插件一次」的决定：记录在 dsh.desktop.bundledPlugins。
    // 已在册（曾挂载过/用户已装过）而当前不在 bundles 里的，视为用户或自愈
    // 主动移除——不再强制加回，避免「自愈移除 → 重启再加回」的死循环。
    const desktopMeta = manifest.dsh && manifest.dsh.desktop && typeof manifest.dsh.desktop === 'object' && !Array.isArray(manifest.dsh.desktop)
      ? manifest.dsh.desktop
      : {};
    const seen = new Set(Array.isArray(desktopMeta.bundledPlugins) ? desktopMeta.bundledPlugins : []);
    const toAdd = BUNDLED_PLUGINS.filter((b) => !bundles.includes(b) && !seen.has(b));
    if (toAdd.length) {
      manifest.dsh.profile.bundles = [...bundles, ...toAdd];
      log(`mounted ${toAdd.length} bundled plugin(s) in profile bundles: ${toAdd.join(', ')}`);
    }
    const nextSeen = new Set([...seen, ...BUNDLED_PLUGINS.filter((b) => bundles.includes(b) || toAdd.includes(b))]);
    manifest.dsh = manifest.dsh || {};
    manifest.dsh.desktop = { ...desktopMeta, bundledPlugins: [...nextSeen] };
    if (toAdd.length || !seen.size || seen.size !== nextSeen.size) {
      fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n');
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

// 在加载列表里找出声明了冲突 ID 的社区插件（取顺序靠后的，视为后来者/加害者）。
// 插件本体既可能在 profile 自己的 node_modules（用户自装），也可能只存在于
// dsh 的模块解析兜底目录（随包插件，$DSH_HOME/profiles/node_modules 的 junction），
// 两处都扫描。
function findConflictingBundle(dupId) {
  const { pkg: pkgPath, nodeModules } = profilePaths();
  let bundles;
  try {
    bundles = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dsh?.profile?.bundles;
  } catch { return null; }
  if (!Array.isArray(bundles)) return null;
  const fallbackModules = path.join(app.getPath('home'), '.dsh', 'profiles', 'node_modules');
  let culprit = null;
  for (const b of bundles) {
    if (OFFICIAL_BUNDLES.has(b)) continue;
    try {
      if (
        bundleDeclaredIds(nodeModules, b).has(dupId) ||
        bundleDeclaredIds(fallbackModules, b).has(dupId)
      ) culprit = b;
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
    let state = {};
    try { state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch {}
    if (state === null || typeof state !== 'object' || Array.isArray(state)) state = {};
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
          mkBtn('dsh-mgr-btn', '\\u2699 管理', '管理 MCP / Skill / Agent',
            function () { if (window.dshDesktop && window.dshDesktop.openManager) window.dshDesktop.openManager(); }, 200);
        })();
      `)
      .catch(() => {});
  });

  return mainWindow;
}

async function main() {
  Menu.setApplicationMenu(null);
  ensureBundledPlugins();
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

// ===== 更新通知 UI（发现新版本进度卡片 + 下载完成后的就绪弹窗）=====
const UPD_ACCENT = '#4d7fff';

function injectUpdateCss() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`
    (function () {
      if (document.getElementById('dsh-upd-css')) return;
      var s = document.createElement('style');
      s.id = 'dsh-upd-css';
      s.textContent = [
        '.dsh-upd-card{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;min-width:300px;max-width:86vw;padding:12px 16px;border-radius:14px;background:rgba(22,22,30,.94);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 30px rgba(0,0,0,.45);backdrop-filter:blur(10px);color:#e8e8ec;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}',
        '.dsh-upd-spinner{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.18);border-top-color:${UPD_ACCENT};animation:dsh-upd-spin .8s linear infinite;flex:none;}',
        '@keyframes dsh-upd-spin{to{transform:rotate(360deg)}}',
        '.dsh-upd-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;}',
        '.dsh-upd-title{font-size:13px;font-weight:600;}',
        '.dsh-upd-sub{font-size:12px;opacity:.7;}',
        '.dsh-upd-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;}',
        '.dsh-upd-fill{height:100%;border-radius:2px;background:${UPD_ACCENT};transition:width .3s ease;}',
        '.dsh-upd-x{cursor:pointer;opacity:.5;font-size:16px;line-height:1;flex:none;padding:0 2px;}',
        '.dsh-upd-x:hover{opacity:1;}',
        '.dsh-upd-overlay{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(8,8,12,.55);backdrop-filter:blur(4px);}',
        '.dsh-upd-modal{width:320px;max-width:88vw;padding:22px;border-radius:16px;text-align:center;background:rgba(22,22,30,.96);border:1px solid rgba(255,255,255,.12);box-shadow:0 16px 48px rgba(0,0,0,.55);color:#e8e8ec;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}',
        '.dsh-upd-ico{width:42px;height:42px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(77,127,255,.16);color:${UPD_ACCENT};font-size:20px;}',
        '.dsh-upd-modal-title{font-size:16px;font-weight:700;margin-bottom:6px;}',
        '.dsh-upd-modal-ver{font-size:13px;opacity:.75;margin-bottom:4px;}',
        '.dsh-upd-modal-desc{font-size:12px;opacity:.55;margin-bottom:18px;}',
        '.dsh-upd-btn{display:inline-block;padding:8px 18px;border-radius:9px;font-size:13px;cursor:pointer;border:1px solid transparent;transition:opacity .15s;}',
        '.dsh-upd-btn:hover{opacity:.85;}',
        '.dsh-upd-btn-primary{background:${UPD_ACCENT};color:#fff;}',
        '.dsh-upd-btn-ghost{background:transparent;border-color:rgba(255,255,255,.18);color:#e8e8ec;margin-left:10px;}'
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    })();
  `).catch(() => {});
}

function showUpdateProgress(version, percent) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  injectUpdateCss();
  const v = JSON.stringify(String(version ?? ''));
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  mainWindow.webContents.executeJavaScript(`
    (function () {
      var b = document.getElementById('dsh-upd-card');
      if (!b) {
        b = document.createElement('div');
        b.id = 'dsh-upd-card';
        b.className = 'dsh-upd-card';
        b.innerHTML = '<div class="dsh-upd-spinner"></div><div class="dsh-upd-body"><div class="dsh-upd-title"></div><div class="dsh-upd-sub"></div><div class="dsh-upd-bar"><div class="dsh-upd-fill"></div></div></div><span class="dsh-upd-x">\\u00d7</span>';
        b.querySelector('.dsh-upd-x').onclick = function () { b.remove(); };
        (document.body || document.documentElement).appendChild(b);
      }
      b.querySelector('.dsh-upd-title').textContent = '发现新版本 v' + ${v};
      b.querySelector('.dsh-upd-sub').textContent = '正在下载 ' + ${pct} + '%';
      b.querySelector('.dsh-upd-fill').style.width = ${pct} + '%';
    })();
  `).catch(() => {});
}

function showUpdateReady(version) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  injectUpdateCss();
  const v = JSON.stringify(String(version ?? ''));
  mainWindow.webContents.executeJavaScript(`
    (function () {
      if (document.getElementById('dsh-upd-overlay')) return;
      var o = document.createElement('div');
      o.id = 'dsh-upd-overlay';
      o.className = 'dsh-upd-overlay';
      o.innerHTML = '<div class="dsh-upd-modal"><div class="dsh-upd-ico">\\u2713</div><div class="dsh-upd-modal-title">更新已就绪</div><div class="dsh-upd-modal-ver">v' + ${v} + '</div><div class="dsh-upd-modal-desc">重启应用后完成安装</div><div><button class="dsh-upd-btn dsh-upd-btn-primary" id="dsh-upd-restart">立即重启</button><button class="dsh-upd-btn dsh-upd-btn-ghost" id="dsh-upd-later">稍后</button></div></div>';
      o.querySelector('#dsh-upd-restart').onclick = function () {
        if (window.dshDesktop && window.dshDesktop.restartUpdate) window.dshDesktop.restartUpdate();
      };
      o.querySelector('#dsh-upd-later').onclick = function () { o.remove(); };
      o.onclick = function (e) { if (e.target === o) o.remove(); };
      (document.body || document.documentElement).appendChild(o);
    })();
  `).catch(() => {});
}

function dismissUpdateBanner() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`
    (function () {
      var b = document.getElementById('dsh-upd-card');
      if (b) b.remove();
      var o = document.getElementById('dsh-upd-overlay');
      if (o) o.remove();
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
    pendingUpdateVersion = i.version;
    showUpdateProgress(i.version, 0);
  });
  autoUpdater.on('update-not-available', () => logUpd('up to date'));
  autoUpdater.on('download-progress', (p) => {
    logUpd(`downloading ${p.percent.toFixed(1)}%`);
    if (pendingUpdateVersion) {
      showUpdateProgress(pendingUpdateVersion, p.percent);
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    logUpd(`downloaded ${info.version}`);
    pendingUpdateVersion = null;
    dismissUpdateBanner();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    showUpdateReady(info.version);
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
    } else {
      // 发现新版：立即展示进度卡片，下载完成后由就绪弹窗接管
      showUpdateProgress(latest, 0);
    }
  } catch (e) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'DeepSeek Harness',
      message: '检查更新失败',
      detail: String(e?.message ?? e),
    });
  }
});

// 就绪弹窗「立即重启」：终止 dsh 后交给 electron-updater 安装
ipcMain.on('dsh-restart-update', () => {
  quitting = true;
  stopDshServer();
  autoUpdater.quitAndInstall();
});

// ===== 管理窗口（MCP / Skill / Agent）=====
// 独立 BrowserWindow（manager.html），通过 IPC 直接管理 dsh 的本地配置：
// - MCP：profile cordis.patch.yml 里的 mcp-client 行（dsh 热重载，无需重启）
// - Skill：skill-filesystem 的 customSkillDirs 配置行 + 各 Skill 根目录浏览
// - Agent：~/.dsh/.agent-presets 用户预设（增删）+ settings.yaml 默认预设
let managerWindow = null;

function managerHome() {
  return app.getPath('home');
}

function managerPaths() {
  const home = managerHome();
  return {
    profileDir: path.join(home, '.dsh', 'profiles', 'web'),
    profilePatch: path.join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    settingsYaml: path.join(home, '.dsh', 'settings.yaml'),
    userSkillDir: path.join(home, '.dsh', 'skills'),
    userPresetDir: path.join(home, '.dsh', '.agent-presets'),
    shippedPresetDir: path.join(
      app.isPackaged ? process.resourcesPath : __dirname,
      'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'
    ),
    bundledSkillDir: app.isPackaged
      ? path.join(process.resourcesPath, 'bundled-skills')
      : path.join(__dirname, 'bundled-skills'),
  };
}

// dsh 自带 yaml 库（dsh-settings-file 依赖），打包后位于 resources/node_modules/yaml
function loadYamlLib() {
  try {
    return require(path.join(app.isPackaged ? process.resourcesPath : __dirname, 'node_modules', 'yaml'));
  } catch {
    try { return require('yaml'); } catch { return null; }
  }
}

function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 读取 profile cordis.patch.yml（不存在时按 dsh 模板创建）。解析失败返回 null。
function readProfilePatch() {
  const p = managerPaths().profilePatch;
  let raw;
  if (fs.existsSync(p)) {
    raw = fs.readFileSync(p, 'utf8');
  } else {
    raw = '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n';
  }
  const Y = loadYamlLib();
  if (!Y) return null;
  const doc = Y.parseDocument(raw);
  if (doc.errors && doc.errors.length) return null;
  return { Y, doc, path: p };
}

function patchEntries(doc) {
  const seq = doc && doc.contents;
  return seq && seq.items ? seq.items : [];
}

// 提取全部 mcp-client 条目（一行 insert 可含多个实例，对应多个服务器）
function readMcpServers() {
  const patch = readProfilePatch();
  if (!patch) return { servers: [], parseError: true };
  const servers = [];
  for (const row of patchEntries(patch.doc)) {
    if (!row || !row.has || !row.has('insert')) continue;
    const ins = row.get('insert');
    if (!ins || !ins.items) continue;
    for (const entry of ins.items) {
      if (entry && entry.get && entry.get('id') === 'mcp-client') {
        const cfg = entry.get('config');
        try { servers.push(cfg && typeof cfg.toJS === 'function' ? cfg.toJS() : {}); } catch { servers.push({}); }
      }
    }
  }
  return { servers, parseError: false };
}

function writeMcpServers(servers) {
  if (!Array.isArray(servers)) throw new Error('servers 必须是数组');
  const patch = readProfilePatch();
  if (!patch) throw new Error('无法解析 cordis.patch.yml（可能包含不支持的语法），请手动编辑该文件');
  const { Y, doc } = patch;
  const seq = doc.contents;
  if (!seq || !seq.items) throw new Error('cordis.patch.yml 顶层必须是数组');
  // 1) 移除现有 mcp-client 条目（空掉的 insert 行一并删除）
  for (const row of [...seq.items]) {
    if (!row || !row.has || !row.has('insert')) continue;
    const ins = row.get('insert');
    if (!ins || !ins.items) continue;
    const kept = ins.items.filter((e) => !(e && e.get && e.get('id') === 'mcp-client'));
    ins.items = kept;
    if (!kept.length) {
      const i = seq.items.indexOf(row);
      if (i >= 0) seq.items.splice(i, 1);
    }
  }
  // 2) 追加新条目
  if (servers.length) {
    seq.items.push(doc.createNode({
      insert: servers.map((s) => ({ id: 'mcp-client', config: s })),
    }));
  }
  atomicWriteText(patch.path, String(doc));
}

// skill-filesystem 覆盖行（id 定向配置，customSkillDirs）
function readCustomSkillDirs() {
  const patch = readProfilePatch();
  if (!patch) return { dirs: [], parseError: true };
  let dirs = [];
  for (const row of patchEntries(patch.doc)) {
    if (!row || !row.get || row.has && row.has('insert')) continue;
    if (row.get('id') !== 'skill-filesystem') continue;
    const cfg = row.get('config');
    try {
      const js = cfg && typeof cfg.toJS === 'function' ? cfg.toJS() : null;
      if (js && Array.isArray(js.customSkillDirs)) dirs = js.customSkillDirs.map(String);
    } catch {}
  }
  return { dirs, parseError: false };
}

function writeCustomSkillDirs(dirs) {
  if (!Array.isArray(dirs)) throw new Error('dirs 必须是数组');
  const patch = readProfilePatch();
  if (!patch) throw new Error('无法解析 cordis.patch.yml（可能包含不支持的语法），请手动编辑该文件');
  const { Y, doc } = patch;
  const seq = doc.contents;
  if (!seq || !seq.items) throw new Error('cordis.patch.yml 顶层必须是数组');
  for (const row of [...seq.items]) {
    if (!row || !row.get || row.has && row.has('insert')) continue;
    if (row.get('id') === 'skill-filesystem') {
      const i = seq.items.indexOf(row);
      if (i >= 0) seq.items.splice(i, 1);
    }
  }
  if (dirs.length) {
    seq.items.push(doc.createNode({ id: 'skill-filesystem', config: { customSkillDirs: dirs } }));
  }
  atomicWriteText(patch.path, String(doc));
}

// settings.yaml（命名空间分节；dsh-settings-file 热发布外部修改）
function readSettingsDoc() {
  const p = managerPaths().settingsYaml;
  let raw;
  if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf8');
  else raw = '{}\n';
  const Y = loadYamlLib();
  if (!Y) return null;
  const doc = Y.parseDocument(raw);
  if (doc.errors && doc.errors.length) return null;
  return { Y, doc, path: p };
}

function getDefaultPresetId() {
  const s = readSettingsDoc();
  if (!s) return null;
  try {
    const js = s.doc.toJS ? s.doc.toJS() : null;
    const v = js && js['agent-presets'] && js['agent-presets'].default;
    return v === undefined || v === null ? null : String(v);
  } catch { return null; }
}

function setDefaultPresetId(id) {
  const s = readSettingsDoc();
  if (!s) throw new Error('无法解析 settings.yaml');
  if (id === null || id === '') {
    s.doc.deleteIn(['agent-presets', 'default']);
    const section = s.doc.get('agent-presets');
    const count = section && section.items
      ? (typeof section.items.size === 'number' ? section.items.size : Object.keys(section.items).length)
      : 0;
    if (count === 0) s.doc.delete('agent-presets');
  } else {
    s.doc.setIn(['agent-presets', 'default'], String(id));
  }
  atomicWriteText(s.path, String(s.doc));
}

// dsh 预设发现规则（dsh-agent-presets scanRoot）：小写字母/数字开头，仅小写字母、数字、-
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readPresetMeta(presetDir, id) {
  const yml = path.join(presetDir, 'preset.yml');
  try {
    const Y = loadYamlLib();
    const doc = Y ? Y.parseDocument(fs.readFileSync(yml, 'utf8')) : null;
    const js = doc && !(doc.errors && doc.errors.length) && typeof doc.toJS === 'function' ? doc.toJS() : null;
    return {
      id,
      name: js && js.name ? String(js.name) : id,
      description: js && js.description ? String(js.description) : '',
      order: js && Number.isFinite(js.order) ? js.order : 99,
    };
  } catch { return { id, name: id, description: '', order: 99 }; }
}

function listPresets() {
  const { userPresetDir, shippedPresetDir } = managerPaths();
  const byId = new Map();
  try {
    for (const d of fs.readdirSync(shippedPresetDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      byId.set(d.name, { ...readPresetMeta(shippedPresetDir + path.sep + d.name, d.name), source: 'shipped' });
    }
  } catch {}
  try {
    for (const d of fs.readdirSync(userPresetDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      byId.set(d.name, { ...readPresetMeta(userPresetDir + path.sep + d.name, d.name), source: 'user' });
    }
  } catch {}
  const def = getDefaultPresetId();
  return [...byId.values()]
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
    .map((p) => ({ ...p, isDefault: p.id === def }));
}

function createPreset(id, name, description) {
  if (!PRESET_ID_PATTERN.test(id)) throw new Error('预设 id 须以小写字母或数字开头，仅含小写字母、数字、-（1-64 字符）');
  const { userPresetDir, shippedPresetDir } = managerPaths();
  const dst = path.join(userPresetDir, id);
  if (fs.existsSync(dst)) throw new Error(`预设 "${id}" 已存在`);
  fs.mkdirSync(dst, { recursive: true });
  // 模板：复制官方 standard 预设的 agent.cordis.yml（完整编码 Agent）；缺失时用最小模板
  const stdAgent = path.join(shippedPresetDir, 'standard', 'agent.cordis.yml');
  const agentCordis = fs.existsSync(stdAgent)
    ? fs.readFileSync(stdAgent, 'utf8')
    : [
        '# Minimal agent preset created by the DeepSeek Harness manager.',
        '# Rows are agent-plane; the roster mounts them inside an isolate realm.',
        '- id: persona',
        "  name: '@deepseek-ai/dsh-persona'",
        '  config:',
        '    text: >-',
        '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
        '',
      ].join('\n');
  fs.writeFileSync(path.join(dst, 'agent.cordis.yml'), agentCordis, 'utf8');
  const Y = loadYamlLib();
  const meta = { name: name || id, description: description || '', order: 99 };
  fs.writeFileSync(path.join(dst, 'preset.yml'), Y ? Y.stringify(meta) : `name: ${meta.name}\ndescription: ${meta.description}\norder: 99\n`, 'utf8');
  return { id, ...meta };
}

function deletePreset(id) {
  if (!PRESET_ID_PATTERN.test(id)) throw new Error('非法的预设 id');
  const dst = path.join(managerPaths().userPresetDir, id);
  if (!fs.existsSync(dst)) throw new Error(`用户预设 "${id}" 不存在`);
  fs.rmSync(dst, { recursive: true, force: true });
  if (getDefaultPresetId() === id) setDefaultPresetId(null);
}

function listSkillsIn(dir) {
  const out = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) out.push({ name: d.name, kind: 'dir' });
      else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) out.push({ name: d.name.replace(/\.md$/i, ''), kind: 'file' });
    }
  } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function managerState() {
  const p = managerPaths();
  const mcp = readMcpServers();
  const skills = readCustomSkillDirs();
  return {
    profile: { dir: p.profileDir, patchPath: p.profilePatch, patchExists: fs.existsSync(p.profilePatch) },
    mcp,
    skills: {
      ...skills,
      userDir: p.userSkillDir,
      bundledDir: p.bundledSkillDir,
      userSkills: listSkillsIn(p.userSkillDir),
      bundledSkills: listSkillsIn(p.bundledSkillDir),
    },
    agents: { presets: listPresets(), defaultId: getDefaultPresetId(), userDir: p.userPresetDir, shippedDir: p.shippedPresetDir },
    service: { owned: !!dshProcess, port: PORT },
  };
}

function openManagerWindow(tab) {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    if (tab) managerWindow.webContents.send('manager-focus-tab', String(tab));
    return;
  }
  managerWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 780,
    minHeight: 540,
    title: 'DeepSeek Harness · 管理',
    backgroundColor: '#101014',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  managerWindow.loadFile(path.join(__dirname, 'manager.html'), {
    query: tab ? { tab: String(tab) } : undefined,
  });
  managerWindow.on('closed', () => {
    managerWindow = null;
  });
}

ipcMain.on('dsh-open-manager', (_e, tab) => openManagerWindow(tab));

ipcMain.handle('manager-invoke', async (_e, op, payload) => {
  const out = (extra) => ({ ok: true, ...extra });
  try {
    switch (op) {
      case 'state': return out(managerState());
      case 'mcp-save': writeMcpServers(payload && payload.servers); return out(managerState());
      case 'skill-dirs-save': writeCustomSkillDirs(payload && payload.dirs); return out(managerState());
      case 'preset-create': createPreset(payload.id, payload.name, payload.description); return out(managerState());
      case 'preset-delete': deletePreset(payload.id); return out(managerState());
      case 'preset-default': setDefaultPresetId(payload && payload.id != null ? payload.id : null); return out(managerState());
      case 'open-path':
        if (payload && payload.path) await shell.openPath(String(payload.path));
        return out({});
      case 'choose-dir': {
        const win = managerWindow && !managerWindow.isDestroyed() ? managerWindow : mainWindow;
        const result = await dialog.showOpenDialog(win, {
          title: '选择目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        return out({ path: result.canceled || !result.filePaths.length ? null : result.filePaths[0] });
      }
      case 'restart-service': {
        if (!dshProcess) return { ok: true, restarted: false, reason: 'external', ...managerState() };
        stopDshServer();
        const healed = await startDshWithSelfHeal();
        if (!healed) throw new Error('dsh 服务重启失败：进程退出或插件树加载失败（见 dsh-server.log）');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        return out({ restarted: true, healed, ...managerState() });
      }
      default: throw new Error(`未知操作：${op}`);
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
