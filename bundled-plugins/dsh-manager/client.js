/**
 * dsh-manager — browser half.
 *
 * 在设置页的 nav rail 里注册「MCP / Skill / Agent」分区（settings.section slot，
 * 与官方 ui-settings-general 的分区机制相同）。分区内容为三个直达按钮：
 * 打开桌面端管理窗口（manager.html）并切换到对应标签页。
 * 纯手写 ModuleLoader bundle，无需编译步骤。
 */
window.__ModuleLoader__.load({
  id: "dsh-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS（主题 token，带兜底色）───────────────────────────────────────
    var CSS = ".mgm_section{display:flex;flex-direction:column;gap:12px;width:100%}" +
      ".mgm_title{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary,#e6edf3)}" +
      ".mgm_desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#8b949e)}" +
      ".mgm_cards{display:flex;flex-direction:column;gap:8px;margin-top:4px}" +
      ".mgm_card{display:flex;align-items:center;gap:12px;background:var(--dsw-alias-bg-layer-2,#21262d);border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:10px;padding:12px 14px}" +
      ".mgm_icon{font-size:18px;line-height:1;flex:none}" +
      ".mgm_body{flex:1;min-width:0}" +
      ".mgm_name{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#e6edf3)}" +
      ".mgm_meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#8b949e)}" +
      ".mgm_btn{flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary,#679efe);background:var(--dsw-alias-state-business-primary,#679efe);color:#fff;font-size:13px;font-weight:500;cursor:pointer}" +
      ".mgm_btn:hover{filter:brightness(1.08)}" +
      ".mgm_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6e7681)}";
    var tagId = "dsh-manager/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-manager";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    var TABS = [
      { id: "mcp", icon: "🔌", name: "MCP 服务器", meta: "添加 / 编辑 / 删除 stdio 与 streamable-http 服务器，保存后热加载" },
      { id: "skill", icon: "🧩", name: "Skills", meta: "自定义 Skill 目录管理 + 用户 / 内置 Skill 浏览" },
      { id: "agent", icon: "🤖", name: "Agent 预设", meta: "预设列表、新建、删除、设为默认" }
    ];

    function openManager(tabId) {
      try {
        if (window.dshDesktop && typeof window.dshDesktop.openManager === "function") {
          window.dshDesktop.openManager(tabId);
          return;
        }
      } catch (e) {}
      // 兜底：老版本/非桌面端环境没有桥 —— 给出悬浮按钮提示
      try {
        if (typeof window.alert === "function") {
          window.alert("请使用右下角「⚙ 管理」悬浮按钮打开管理窗口。");
        }
      } catch (e) {}
    }

    function ManagerSection() {
      return h("div", { className: "mgm_section" },
        h("div", { className: "mgm_title" }, "MCP / Skill / Agent 管理"),
        h("div", { className: "mgm_desc" }, "集中管理本机 profile 的 MCP 服务器、Skill 目录与 Agent 预设（配置文件热生效，无需重启）。"),
        h("div", { className: "mgm_cards" },
          TABS.map(function (tab) {
            return h("div", { key: tab.id, className: "mgm_card" },
              h("span", { className: "mgm_icon" }, tab.icon),
              h("div", { className: "mgm_body" },
                h("div", { className: "mgm_name" }, tab.name),
                h("div", { className: "mgm_meta" }, tab.meta)
              ),
              h("button", {
                type: "button",
                className: "mgm_btn",
                onClick: function () { openManager(tab.id); }
              }, "打开管理")
            );
          })
        ),
        h("div", { className: "mgm_hint" }, "管理窗口也可通过右下角「⚙ 管理」悬浮按钮打开；配置仅作用于本机（~/.dsh/profiles/web）。")
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-manager",
          order: 60,
          label: function () { return "MCP / Skill / Agent"; }
        }, ManagerSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
