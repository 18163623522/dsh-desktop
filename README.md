# DeepSeek Harness 桌面端（dsh-desktop）

把 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）打包成 Windows 桌面应用。

原理：Electron 壳 + 内嵌官方 npm 包 `@deepseek-ai/dsh`。主进程以 `ELECTRON_RUN_AS_NODE` 启动 `dsh web` 本地服务（127.0.0.1:3080），BrowserWindow 加载其 Web UI。目标机器无需安装 Node.js。

## 产物

- **NSIS 安装包**：向导式安装，桌面/开始菜单快捷方式，含卸载器
- **便携版**：单文件免安装 exe

## 关键实现点（踩坑记录）

1. **`--expose-internals`**：dsh 的 HMR 插件需要访问 Node 内部模块，其原生兜底插件在 `ELECTRON_RUN_AS_NODE` 下不可用，spawn 后端时必须显式传该标志。
2. **peerDependencies 打包**：electron-builder 的依赖收集只走 `dependencies`，会漏掉 npm 自动安装到顶层的 peer 包（dsh 有约 19 个）。因此用 `app-deps/`（干净生产安装）+ `extraResources` 原样打包，不走收集器。
3. **目录选择 worker 需要真实 Node**：dsh 的 win32 文件夹对话框 worker 内 `koffi.view` 在 Electron 内嵌 Node 下会 `napi_get_last_error_info` fatal。随包带一个真实 `node.exe`（`vendor/`），通过 `--require` 钩子把后端的 `process.execPath` 指回它。
4. **剥离密钥环境变量**：若启动环境带 `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`，dsh 会把设置界面的密钥输入框锁成只读。main.js 在 spawn 时剥离，让密钥在 UI 中填写。
5. **原生模块均为 N-API**（sharp/koffi/node-pty），无需按 Electron 重编译（`npmRebuild: false`）。

## 构建步骤

```bash
# 1. 安装开发依赖（electron / electron-builder / dsh 本地调试用）
npm install

# 2. 准备生产依赖副本（extraResources 打包源，含全部 peer 依赖）
cd app-deps && npm install && cd ..
# 可选：剪掉非 win32-x64 的 node-pty prebuilds 减小体积
rm -rf app-deps/node_modules/node-pty/prebuilds/{darwin-arm64,darwin-x64,win32-arm64}

# 3. 放入真实 node.exe（目录选择 worker 依赖，Git 不跟踪）
mkdir -p vendor && cp "$(dirname "$(which node)")/node.exe" vendor/node.exe

# 4. 打包（便携版 + 安装包，产物在 dist/）
npm run dist

# 开发模式运行
npm start
```

国内网络建议先设置镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 行为说明

- 单实例锁；若 3080 端口已有 dsh 服务在跑会直接复用
- 内置 skill：随包分发 `bundled-skills/` 目录（当前内置 J-Space 认知套件），启动时通过 `DSH_BUNDLED_SKILL_DIR` 环境变量挂载，由 dsh 的 skill-filesystem 插件以 `bundled` 源（rank 600，最低优先级）加载；用户/项目自装同名 skill 可覆盖内置版本
- 内置插件：随包分发 12 个社区插件（作为 `app-deps` 依赖打进 `resources/node_modules`，dsh 的 bundle 解析为「安装目录优先」），启动时由 `ensureBundledPlugins()` 幂等地挂到 profile 的 `dsh.profile.bundles`。挂载是每个插件一次性的决定（记录于 manifest 的 `dsh.desktop.bundledPlugins`）：用户或冲突自愈移除后不再强制加回；同名插件以随包版本为准：

  | 插件 | 说明 |
  |------|------|
  | `dsh-goal-mode` | 目标模式（内置）：制定计划 → 批准 → 自动执行到完成 |
  | `dshmarket` | 插件市场 |
  | `dsh-better-sidebar` | 侧边栏增强（CodeMirror 编辑器等） |
  | `dsh-at-file` | `@路径` 文件引用 |
  | `@anionex/dsh-vision-toolkit` | 视觉工具包 |
  | `dsh-mnemon` | 记忆插件 |
  | `@yejiming/dsh-data-agent` | 数据代理（共享数据库连接 + SQL 工具） |
  | `@zseven-w/dsh-openpencil` | 画布 |
  | `@liustack/modlens` | 模型透镜 |
  | `@nanmicoder/dsh-auto-mode` | 自动权限模式 |
  | `@nanmicoder/dsh-agent-teams` | 多代理协作 |
  | `deepseek-flow` | 深度求索工作流 |
  | `dsh-manager` | 设置页「MCP / Skill / Agent」管理入口（打开桌面端管理窗口） |

- 管理窗口：**设置页新增「MCP / Skill / Agent」分区**（`dsh-manager` 客户端插件注册 settings.section，三个直达按钮）+ 右下角悬浮「⚙ 管理」按钮，打开独立管理窗口，集中管理 **MCP 服务器**（写入 profile `cordis.patch.yml` 的 `mcp-client` 行，dsh 热加载）、**Skill 自定义目录**（`skill-filesystem` 的 `customSkillDirs`，热加载）与 **Agent 预设**（`~/.dsh/.agent-presets` 增删 + `settings.yaml` 默认预设）
- 退出时按进程树终止 dsh 及其派生进程（Windows `taskkill /T /F`）
- dsh 服务日志：`%APPDATA%\DeepSeek Harness\dsh-server.log`
- 便携版按「应用名+版本号」缓存临时解压目录，改版本号可强制重新解压

## 许可

本项目打包壳为 MIT。dsh 本体及其依赖遵循各自许可（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 为 MIT）。DeepSeek 鲸鱼图标来自 DeepSeek 官方 PWA 图标，版权归 DeepSeek 所有。
