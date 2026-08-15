// dsh 的 win32 目录选择 worker 用 process.execPath（即 Electron）拉起，
// 而 worker 内的 koffi.view 在 Electron 内嵌 Node 下会 fatal（napi_get_last_error_info）。
// 真实 Node 下则正常。因此在 dsh 后端启动前，把 process.execPath 指回随包真实 node，
// 使后端 spawn 出的 worker 运行于真实 Node。仅 ELECTRON_RUN_AS_NODE 场景生效。
if (process.env.DSH_REAL_NODE) {
  try {
    Object.defineProperty(process, 'execPath', {
      value: process.env.DSH_REAL_NODE,
      configurable: true,
    });
  } catch {}
}
