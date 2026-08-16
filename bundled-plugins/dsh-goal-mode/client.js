/**
 * dsh-goal-mode — browser half.
 *
 * composer 工具行里、access 模式/plan 控件旁边的「目标模式」切换开关。
 * 开关状态来自 host 计算的 plan 投影（计划模式激活 = 开关亮起）。
 * 开启时经 remote.commands 执行 /goal-mode（进计划模式并挂起目标创建），
 * 关闭时执行 /plan off。纯手写 ModuleLoader bundle，无需编译步骤。
 */
window.__ModuleLoader__.load({
  id: "dsh-goal-mode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS（主题 token，带兜底色）───────────────────────────────────────
    var CSS = ".gm_toggle{display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-2,#21262d);border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:999px;height:26px;padding:0 8px 0 9px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary,#8b949e)}" +
      ".gm_toggle:hover:not(:disabled){border-color:var(--dsw-alias-border-l1,#444c56)}" +
      ".gm_toggle:disabled{opacity:.5;cursor:default}" +
      ".gm_toggle_on{color:var(--dsw-alias-label-primary,#e6edf3);border-color:var(--dsw-alias-state-business-primary,#679efe);background:var(--dsw-alias-state-business-tertiary,rgba(103,158,254,.14))}" +
      ".gm_glyph{font-size:13px;line-height:1}" +
      ".gm_label{font-size:13px;font-weight:500;line-height:20px}" +
      ".gm_switch{position:relative;width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#30363d);flex:none;transition:background .15s}" +
      ".gm_knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-label-secondary,#8b949e);transition:transform .15s}" +
      ".gm_toggle_on .gm_switch{background:var(--dsw-alias-state-business-primary,#679efe)}" +
      ".gm_toggle_on .gm_knob{transform:translateX(12px);background:#fff}" +
      ".gm_error{color:var(--dsw-alias-state-error-primary,#f85149);font-size:12px;line-height:18px}";
    var tagId = "dsh-goal-mode/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-goal-mode";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "goal-mode";
    var inject = ["slots", "remote", "remote.commands", "locale"];
    var zh = {
      label: "目标模式",
      "aria.on": "目标模式已开启，点击关闭",
      "aria.off": "目标模式已关闭，点击开启",
      "title.on": "目标模式已开启 — 点击退出（取消制定计划）",
      "title.off": "目标模式 — 点击开启：制定计划，批准后自动执行到完成"
    };
    var en = {
      label: "Goal Mode",
      "aria.on": "Goal mode on, click to turn off",
      "aria.off": "Goal mode off, click to turn on",
      "title.on": "Goal mode on — click to exit (cancel planning)",
      "title.off": "Goal mode — click to turn on: draft a plan, then execute after approval"
    };

    // ── component ─────────────────────────────────────────────────────────
    function GoalModeToggle(props) {
      var useProjection = props.useProjection;
      var toggle = props.toggle;
      var t = props.t;
      var plan = useProjection("plan");
      var active = plan === undefined ? false : (plan.pending ? !plan.active : plan.active);
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = react.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var onClick = function () {
        if (busy) return;
        setBusy(true);
        setError(null);
        Promise.resolve(toggle(!active)).then(function (failure) {
          setBusy(false);
          if (failure) setError(failure);
        }, function (reason) {
          setBusy(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      };

      return h("span", { className: "gm_wrap" },
        h("button", {
          type: "button",
          className: "gm_toggle" + (active ? " gm_toggle_on" : ""),
          "aria-pressed": active ? "true" : "false",
          "aria-label": t(active ? "aria.on" : "aria.off"),
          title: t(active ? "title.on" : "title.off"),
          disabled: busy,
          onClick: onClick
        },
          h("span", { className: "gm_glyph" }, "🎯"),
          h("span", { className: "gm_label" }, t("label")),
          h("span", { className: "gm_switch" }, h("span", { className: "gm_knob" }))
        ),
        error !== null ? h("span", { className: "gm_error", role: "status" }, error) : null
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-goal-mode: dictionaries");
      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register({
          name: "conversation.input.left",
          id: "goal-mode",
          order: 10,
          locale: NS,
          inject: function (sessionId) {
            return {
              toggle: async function (on) {
                var cmd = on ? "/goal-mode" : "/plan off";
                var result = await ctx.remote.commands.execute(sessionId, cmd);
                if (!result.ok) {
                  return result.error ? (result.error.message + " (" + result.error.code + ")") : "failed";
                }
                return null;
              }
            };
          }
        }, GoalModeToggle);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
