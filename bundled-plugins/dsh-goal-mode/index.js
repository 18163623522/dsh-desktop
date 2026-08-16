/**
 * dsh-goal-mode — node half.
 *
 * 「目标模式」编排：注册 /goal-mode 命令，把 DSH 已有的 plan mode 与 goal mode
 * 串成一条链 —— 切换开关开启 → 进入计划模式制定计划 → 用户批准 → 自动创建目标
 * → host 的 goal-round driver 接手多轮执行到完成。
 *
 * 关键点：planMode 服务是每会话隔离的（standard preset 的 planning isolate 域），
 * host 层无法直接注入；改为通过 ctx.commands.execute 复用现成的 /plan 命令来进
 * 计划模式，从而只依赖 host 层的 commands / goals / agents 三个服务。
 */

/** Cordis plugin name. */
const name = "goal-mode";
/** Host services this plugin needs (all host-plane, none per-session). */
const inject = ["commands", "goals", "agents"];

/** Extract the plain-text of a user message (joins text blocks). */
function extractText(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text + "\n";
  }
  return out.trim();
}

function apply(ctx) {
  // 待批准的目标模式流程：sessionId -> { objective: string | null }
  const pending = new Map();

  ctx.on("session/event", (session, event) => {
    const entry = pending.get(session.id);
    if (entry === undefined) return;

    // 无参数开关路径：把第一条真实用户消息当作目标文本
    if (event.type === "user/message" && entry.objective === null) {
      const src = event.data && event.data.source;
      if (src && src.kind === "user") {
        const text = extractText(event.data);
        if (text !== "") entry.objective = text;
      }
      return;
    }

    // 计划模式关闭（批准或退出）→ 自动创建目标；goal-round driver 接手执行
    if (event.type === "plan/mode" && event.data && event.data.active === false) {
      pending.delete(session.id);
      const agent = ctx.agents.get(session.id);
      if (agent === undefined || agent.session !== session) return;
      const objective = entry.objective;
      if (objective === null || objective === "") return;
      try {
        ctx.goals.create(agent, { objective });
        ctx.logger.info(`[goal-mode] plan approved; goal created for agent "${agent.id}"`);
      } catch (error) {
        ctx.logger.warn(`[goal-mode] could not create goal for agent "${agent.id}": ${String(error && error.message ? error.message : error)}`);
      }
    }
  });

  ctx.commands.register({
    name: "goal-mode",
    description: "目标模式：制定计划，批准后自动创建目标并执行到完成",
    input: { hint: "[任务描述]" },
    handler: async ({ agent, rawInput, signal }) => {
      const task = rawInput.trim();
      pending.set(agent.session.id, { objective: task === "" ? null : task });
      if (task === "") {
        // 切换开关路径：只进计划模式，目标文本由用户下一步输入
        await ctx.commands.execute(agent, "/plan", signal);
        return { kind: "success", text: "目标模式已开启：请输入你的目标，我会先制定计划。" };
      }
      await ctx.commands.execute(agent, `/plan ${task}`, signal);
      return { kind: "success", text: "目标模式已开启：AI 正在制定计划，你批准后会自动创建目标并执行到完成。" };
    }
  });
}

export { apply, inject, name };
