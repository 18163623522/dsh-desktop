// dsh-owntui — 自研 DeepSeek Harness 终端前端。
// 契约（来自官方 rc.6 组件与社区实现）：
//   ctx.agents.create({ sessionId, agentOptions }) / .resume({ resumeSessionId, ... })
//   agent.followup(text | userMessage)
//   ctx.on('session/event', (session, event)) — turn/start|end, tool/call|result, ...
import readline from 'node:readline';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

// 事件汇总（实现同官方 dsh-headless 的 summarize：取最后一条助手文本 + 回合结果）
function summarize(events, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') { started = true; continue; }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = (event.data.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

export const name = 'dsh-owntui';
export const inject = ['agents'];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const w = (s) => process.stdout.write(s);
const brief = (v, n = 80) => {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { return ''; }
  if (s == null) return '';
  s = s.replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

export function apply(ctx, config) {
  const debug = !!process.env.OWNTUI_DEBUG;
  const ipcMode = process.env.OWNTUI_IPC === '1';
  let agent = null;
  let currentSession = null;
  let agentsSvc = null;
  let defaultModelSvc = null;
  let sessionsSvc = null;
  let streamedThisTurn = false;

  ctx.on('session/event', (session, event) => {
    // IPC 模式下终端渲染器不得写 stdout（会污染 JSON 行协议）
    if (ipcMode) return;
    if (!agent || session !== agent.session) return;
    if (debug) {
      try { w(C.dim(`[evt] ${JSON.stringify(event).slice(0, 600)}\n`)); } catch {}
    }
    renderEvent(event);
  });

  function renderEvent(ev) {
    const t = ev?.type ?? ev?.kind ?? '';
    const d = ev?.data ?? {};
    if (t === 'turn/start' || t === 'turn/end') {
      if (d?.reason?.kind === 'error') {
        w(`  ${C.yellow('✗ ' + brief(d.reason.error?.message ?? d.reason))}\n`);
      }
      return;
    }
    if (t === 'session/title' || t === 'agent/status' || t === 'step/start' || t === 'step/end') return;
    if (t.startsWith('agent/inbox') || t === 'user/message') return;
    if (t === 'assistant/message') {
      const text = (d.message?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) { streamedThisTurn = true; w(`${text}`); }
      return;
    }
    if (t === 'tool/call') {
      w(`  ${C.cyan('⚙ ' + (d.name ?? d.tool ?? 'tool'))} ${C.dim(brief(d.args ?? d.input))}\n`);
      return;
    }
    if (t === 'tool/result') {
      w(`  ${C.green('✓')} ${C.dim(brief(d.result ?? d.output))}\n`);
      return;
    }
    if (t === 'error') {
      w(`  ${C.yellow('✗ ' + brief(d.message ?? ev))}\n`);
      return;
    }
  }

  async function idle() {
    try {
      const wi = agent.whenIdle;
      if (wi && typeof wi.then === 'function') await wi;
      else if (typeof wi === 'function') await wi.call(agent);
    } catch {}
  }

  async function newAgent(sessionId) {
    const selection = defaultModelSvc.currentSelection();
    const created = await agentsSvc.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        // 注意：setup 必须返回 undefined（官方同款花括号体），返回值需带 .commit
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    agent = created.agent ?? created;
    currentSession = sessionId;
    await idle();
    return agent;
  }

  async function send(text) {
    if (!agent) await newAgent(`session-${crypto.randomUUID()}`);
    streamedThisTurn = false;
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await idle();
    try { await sessionsSvc?.flush?.(agent.session); } catch {}
    return summarize(agent.session.events, firstSeq);
  }

  async function exitApp(code = 0) {
    try { await ctx.dispose?.(); } catch {}
    process.exit(code);
  }

  // 官方范式（参考 dsh-headless）：等插件树加载完毕后懒取服务，无 ready 事件
  run().catch(async (e) => {
    w(C.yellow(`error: ${e?.stack ?? e}\n`));
    process.exit(1);
  });

  // IPC 模式：GUI 窗口用。stdin 逐行收 JSON 指令，stdout 逐行回 JSON 事件。
  async function runIpc() {
    await ctx.get('loader')?.await();
    agentsSvc = ctx.get('agents');
    defaultModelSvc = ctx.get('agentDefaultModel');
    sessionsSvc = ctx.get('sessions');

    const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    ctx.on('session/event', (session, event) => {
      if (!agent || session !== agent.session) return;
      const t = event?.type;
      if (t === 'assistant/message') {
        const text = (event.data?.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) emit({ type: 'assistant', text });
      } else if (t === 'tool/call') {
        emit({ type: 'tool', name: event.data?.name ?? 'tool', brief: brief(event.data?.args ?? event.data?.input, 120) });
      } else if (t === 'turn/end') {
        const reason = event.data?.reason;
        emit({ type: 'turn-end', ok: reason?.kind !== 'error', error: reason?.kind === 'error' ? reason.error?.message : undefined });
      } else if (t === 'session/title') {
        emit({ type: 'title', title: event.data?.title });
      }
    });

    emit({ type: 'ready', version: '0.1.0' });

    rl.on('line', async (line) => {
      let req;
      try { req = JSON.parse(line); } catch { emit({ type: 'error', message: 'bad json' }); return; }
      try {
        if (req.op === 'send') {
          const outcome = await send(req.text);
          emit({ type: 'reply-end', text: outcome?.text ?? '', ok: outcome?.reason?.kind !== 'error', error: outcome?.reason?.error?.message });
        } else if (req.op === 'new') {
          await newAgent(`session-${crypto.randomUUID()}`);
          emit({ type: 'session', id: currentSession });
        } else if (req.op === 'resume') {
          const sel = defaultModelSvc.currentSelection();
          const r = await agentsSvc.resume({
            resumeSessionId: req.id,
            agentOptions: { provider: sel.provider, model: sel.model },
            setup: (agentCtx) => { installModelSelection(agentCtx, { current: sel, assembled: undefined }); },
          });
          agent = r.agent ?? r;
          currentSession = req.id;
          await idle();
          emit({ type: 'session', id: currentSession });
        } else if (req.op === 'ping') {
          emit({ type: 'pong' });
        } else if (req.op === 'exit') {
          await exitApp(0);
        } else {
          emit({ type: 'error', message: 'unknown op: ' + req.op });
        }
      } catch (e) {
        emit({ type: 'error', message: String(e?.message ?? e) });
      }
    });
    rl.on('close', () => { exitApp(0); });
  }

  async function run() {
    if (process.env.OWNTUI_IPC === '1') return runIpc();
    await ctx.get('loader')?.await();
    agentsSvc = ctx.get('agents');
    defaultModelSvc = ctx.get('agentDefaultModel');
    sessionsSvc = ctx.get('sessions');
    const selection = defaultModelSvc.currentSelection();
    process.stderr.write(`[owntui] model=${selection.provider}/${selection.model}\n`);

    const oneshot = process.env.OWNTUI_ONESHOT;
    if (oneshot) {
      const outcome = await send(oneshot);
      if (streamedThisTurn) w('\n');
      else w(`\n${outcome?.text || C.yellow('(no text)')}\n`);
      if (outcome?.reason?.kind === 'error') {
        w(C.yellow(`error: ${outcome.reason.error?.message}\n`));
        await exitApp(1);
      }
      await exitApp(0);
    }

    const resumeId = process.env.OWNTUI_RESUME;
    if (resumeId) {
      try {
        const sel = defaultModelSvc.currentSelection();
        const r = await agentsSvc.resume({
          resumeSessionId: resumeId,
          agentOptions: { provider: sel.provider, model: sel.model },
          setup: (agentCtx) => { installModelSelection(agentCtx, { current: sel, assembled: undefined }); },
        });
        agent = r.agent ?? r;
        currentSession = resumeId;
        await idle();
      } catch (e) {
        w(C.yellow(`resume failed: ${e?.message ?? e}\n`));
      }
    }

    w(C.bold('\ndsh-owntui\n'));
    w(C.dim(`session: ${currentSession ?? '(new on first message)'}\n`));
    w(C.dim('commands: /new /resume <id> /session /help /exit\n\n'));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt(C.cyan('> '));
    rl.prompt();
    rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) { rl.prompt(); return; }
      if (text === '/exit') { rl.close(); return; }
      if (text === '/help') {
        w('/new 新会话  /resume <id> 恢复  /session 当前会话  /exit 退出\n'); rl.prompt(); return;
      }
      if (text === '/session') { w(`${currentSession ?? '(none)'}\n`); rl.prompt(); return; }
      if (text === '/new') {
        try { await newAgent(`session-${crypto.randomUUID()}`); w(C.dim(`new session: ${currentSession}\n`)); }
        catch (e) { w(C.yellow(`new failed: ${e?.message ?? e}\n`)); }
        rl.prompt(); return;
      }
      if (text.startsWith('/resume ')) {
        const id = text.slice(9).trim();
        try {
          const sel = defaultModelSvc.currentSelection();
          const r = await agentsSvc.resume({
            resumeSessionId: id,
            agentOptions: { provider: sel.provider, model: sel.model },
            setup: (agentCtx) => { installModelSelection(agentCtx, { current: sel, assembled: undefined }); },
          });
          agent = r.agent ?? r; currentSession = id;
          await idle();
          w(C.dim(`resumed ${id}\n`));
        } catch (e) { w(C.yellow(`resume failed: ${e?.message ?? e}\n`)); }
        rl.prompt(); return;
      }
      try {
        const outcome = await send(text);
        if (streamedThisTurn) w('\n\n');
        else if (outcome?.text) w(`\n${outcome.text}\n\n`);
        else w('\n');
        if (outcome?.reason?.kind === 'error') {
          w(C.yellow(`error: ${outcome.reason.error?.message}\n`));
        }
      } catch (e) {
        w(C.yellow(`error: ${e?.message ?? e}\n`));
      }
      rl.prompt();
    });
    rl.on('close', () => { exitApp(0); });
  }
}
