import z from "@deepseek-ai/schemastery";
import { z as zd } from "zod";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";

// 挂点：ctx.on('session/event') 判真进展 + agent/created|disposed 建拆每 agent 状态 + ctx.effect(setInterval) 巡检。
// 依赖契约：dsh-session 的 step/start、assistant/message、tool/call、tool/result（进展）；dsh-agent 的 agent.inject()。
// 参数：enabled 默认关；minSilenceMs 默认 900000 起，每检出指数翻倍至 maxSilenceMs 默认 14400000。

const name = "stall-detector";
const inject = ["agents"];

/** 严格按 §3.31：新的模型请求/回复、工具调用开始或结束才算进展。 */
const PROGRESS = {
  "step/start": "新的模型请求",
  "assistant/message": "模型回复已落地",
  "tool/call": "工具调用开始",
  "tool/result": "工具调用结束",
};

/** 流式 token（agent/assistant-stream）与 bash 心跳都不在此表 —— 它们不算进展。 */

const Config = z.object({
  /** 默认关：快任务太慢、慢任务太急，由部署方开。 */
  enabled: z.boolean().default(false),
  /** 起始静默阈值（毫秒），默认 15 min。 */
  minSilenceMs: z.number().default(900000),
  /** 阈值指数翻倍的上限（毫秒），默认 4 h。 */
  maxSilenceMs: z.number().default(14400000),
  /** 巡检周期（毫秒）。 */
  checkIntervalMs: z.number().default(60000),
});

const stallStateSchema = zd.object({
  phase: zd.string(),
  lastProgressAt: zd.number(),
  lastEvent: zd.string(),
  detections: zd.number().int().nonnegative(),
});

function noticeFor(minutes, action) {
  const text = `stall-detector: 已静止 ${minutes} 分钟，当前动作 ${action}。若无预期等待，考虑中断或改用更小的步骤。`;
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: name, form: "notice", summary: boundContextSummary(`已静止 ${minutes} 分钟，当前动作 ${action}`) },
  });
}

function apply(ctx, config) {
  const states = new Map();

  const start = (agent) => {
    const now = Date.now();
    states.set(agent, {
      lastProgressAt: now,
      lastInjectionAt: 0,
      threshold: config.minSilenceMs,
      lastEvent: "agent/created",
      detections: 0,
    });
  };

  const count = () => {
    ctx.get("sessionStats")?.counter?.("harness_stall_detections", 1);
  };

  if (config.enabled) {
    for (const agent of ctx.agents.list()) start(agent);
  }

  ctx.on("agent/created", ({ agent }) => {
    if (config.enabled) start(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    states.delete(agent);
  });

  // 真进展：重置阈值与时间戳；流式 token 与 bash 心跳不在 PROGRESS 表里，天然不算。
  ctx.on("session/event", (session, event) => {
    if (!config.enabled) return;
    const label = PROGRESS[event.type];
    if (label === undefined) return;
    const agent = ctx.agents.get(session.id);
    if (agent === undefined) return;
    const state = states.get(agent);
    if (state === undefined) return;
    state.lastProgressAt = event.time ?? Date.now();
    state.lastEvent = `${label}（${event.type}）`;
    state.threshold = config.minSilenceMs;
  });

  ctx.effect(() => {
    if (!config.enabled) return () => {};
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [agent, state] of states) {
        if (agent.status !== "running") continue;
        const silence = now - state.lastProgressAt;
        if (silence < state.threshold) continue;
        if (now - state.lastInjectionAt < state.threshold) continue;
        const minutes = Math.round(silence / 60000);
        agent.inject(noticeFor(minutes, state.lastEvent));
        state.lastInjectionAt = now;
        state.detections += 1;
        state.threshold = Math.min(state.threshold * 2, config.maxSilenceMs);
        count();
      }
    }, config.checkIntervalMs);
    return () => clearInterval(timer);
  }, "stall-detector.interval()");
}

export { Config, PROGRESS, apply, inject, name };
