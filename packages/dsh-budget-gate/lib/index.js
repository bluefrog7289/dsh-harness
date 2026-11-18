import z from "@deepseek-ai/schemastery";
import { z as zd } from "zod";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 挂点：agent/pre-step（不是已 deprecated 的 agent/request）+ sessionProjections.register({key:'budgetUsage'})。
// 依赖契约：PreStepDecision = {kind:'reject'} | {kind:'enter',messages}（dsh-agent/lib/types/runtime-types.d.ts:117-124）
//   —— reject 无原因字段，故拒绝前必须先 agent.inject() 一条 notice；usage 取 assistant/message.usage。
// 参数：turnBudget 只标注；sessionBudget 80% notice / 100% reject；taskBudget 仅显式设置时生效（硬顶）。

const name = "budget-gate";
const inject = ["agents", "llm", "tokenMeter", "sessionProjections"];

const Config = z.object({
  /** 单轮 token 预算：只标注不阻断。0 = 关（默认）。 */
  turnBudget: z.number().default(0),
  /** 单会话累计 token 预算：80% notice，100% 拒绝新请求。0 = 关（默认）。 */
  sessionBudget: z.number().default(0),
  /** 跨会话累计 token 预算（含 fork）：硬顶。仅在用户显式设置时生效。0 = 关（默认）。 */
  taskBudget: z.number().default(0),
  /** 会话预算的预警比例。 */
  warnRatio: z.number().default(0.8),
  /** task 累计落盘目录；空串 = 不落盘，只存插件实例内存。 */
  profileDir: z.string().default(""),
  /** task 累计落盘文件名（profileDir 非空时生效）。 */
  taskUsageFile: z.string().default("budget-task-usage.json"),
});

/** 会话累计投影：折叠 assistant/message.usage，跨 resume/fork 复算。 */
const usageSchema = zd.object({
  turnTokens: zd.number().nonnegative(),
  sessionTokens: zd.number().nonnegative(),
  steps: zd.number().int().nonnegative(),
});

const initialUsage = () => ({ turnTokens: 0, sessionTokens: 0, steps: 0 });

/** 计费口径（dsh-llm TokenUsage）：billed input = input + cacheRead + cacheWrite。 */
function billed(usage) {
  if (usage === undefined) return 0;
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function foldUsage(state, event) {
  if (event.type === "turn/start") return state.turnTokens === 0 ? state : { ...state, turnTokens: 0 };
  if (event.type !== "assistant/message") return state;
  const delta = billed(event.data.usage);
  if (delta === 0) return state;
  return {
    turnTokens: state.turnTokens + delta,
    sessionTokens: state.sessionTokens + delta,
    steps: state.steps + 1,
  };
}

function notice(text, summary) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: name, form: "notice", summary: boundContextSummary(summary) },
  });
}

function apply(ctx, config) {
  const { turnBudget, sessionBudget, taskBudget, warnRatio, profileDir } = config;
  const file = profileDir === "" ? "" : join(profileDir, config.taskUsageFile);

  /** task 累计跨 session（含 fork）：基线按 session 记，累计值 = Σ(lastSeen - baseline) + 落盘基数。 */
  const baselines = new Map();
  const lastSeen = new Map();
  let taskBase = 0;

  if (file !== "") {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      taskBase = saved.taskTokens ?? 0;
      for (const [id, row] of Object.entries(saved.sessions ?? {})) baselines.set(id, row.baseline ?? 0);
    } catch {
      taskBase = 0;
    }
  }

  const persist = () => {
    if (file === "") return;
    writeFileSync(
      file,
      JSON.stringify({ taskTokens: taskBase, sessions: Object.fromEntries([...baselines].map(([id, base]) => [id, { baseline: base }])) }),
    );
  };

  const sessionUsed = (handle, agent) => {
    const state = handle.stateOf(agent.session);
    if (state.sessionTokens > 0) return state.sessionTokens;
    return ctx.tokenMeter.measure(agent.session).totalTokens;
  };

  const taskUsed = (sessionId, used) => {
    if (!baselines.has(sessionId)) baselines.set(sessionId, used);
    lastSeen.set(sessionId, used);
    let closed = 0;
    for (const [id, base] of baselines) closed += Math.max(0, (lastSeen.get(id) ?? base) - base);
    return taskBase + closed;
  };

  const handleReady = ctx.sessionProjections.register({
    key: "budgetUsage",
    stateVersion: 1,
    stateSchema: usageSchema,
    init: initialUsage,
    apply: foldUsage,
  });

  /** 已经发过 notice 的一次性闸门（每 session 每阶段一次，避免每步刷屏）。 */
  const warned = new Map();

  const count = (metric) => ctx.get("sessionStats")?.counter?.(metric, 1);

  ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
    const handle = await handleReady;
    if (signal.aborted) return next();

    const used = sessionUsed(handle, agent);
    const sessionId = agent.session.id;
    const gate = warned.get(sessionId) ?? {};
    const optionText = "两个选项：（1）继续（本条 notice 后仍会被下一次预算检查拦住，需先提高 sessionBudget 或换会话）；（2）换一个新会话，当前会话的累计不再增长。";

    // 硬顶：仅 taskBudget 显式设置时生效，先说明再拒绝。
    if (taskBudget > 0) {
      const total = taskUsed(sessionId, used);
      if (total >= taskBudget) {
        agent.inject(
          notice(
            `budget-gate: 任务累计 ${total} token 已达 taskBudget ${taskBudget}（跨会话含 fork 的硬顶）。${optionText}`,
            `taskBudget 硬顶 ${total}/${taskBudget}`,
          ),
        );
        count("harness_budget_rejections");
        return { kind: "reject" };
      }
    }

    // 会话 100%：先 inject notice 说明原因与选项，再 reject —— reject 本身不带原因。
    if (sessionBudget > 0 && used >= sessionBudget) {
      agent.inject(
        notice(
          `budget-gate: 本会话累计 ${used} token 已达 sessionBudget ${sessionBudget}（turn ${turn}）。${optionText}`,
          `sessionBudget 到顶 ${used}/${sessionBudget}`,
        ),
      );
      count("harness_budget_rejections");
      return { kind: "reject" };
    }

    // 会话 80%：一条 notice，不阻断。
    if (sessionBudget > 0 && used >= sessionBudget * warnRatio && gate.session !== true) {
      agent.inject(
        notice(
          `budget-gate: 本会话已用 ${used}/${sessionBudget} token（${Math.round((used / sessionBudget) * 100)}%），接近 sessionBudget。`,
          `sessionBudget ${Math.round((used / sessionBudget) * 100)}%`,
        ),
      );
      gate.session = true;
      warned.set(sessionId, gate);
    }

    // 单轮预算：只标注（notice 一次/轮），绝不阻断。
    if (turnBudget > 0) {
      const turnTokens = handle.stateOf(agent.session).turnTokens;
      const key = `turn:${turn}`;
      if (turnTokens > turnBudget && gate[key] !== true) {
        agent.inject(
          notice(
            `budget-gate: 本轮（turn ${turn}）已用 ${turnTokens} token，超过 turnBudget ${turnBudget} —— 仅标注，不阻断。`,
            `turnBudget 超出 ${turnTokens}/${turnBudget}`,
          ),
        );
        gate[key] = true;
        warned.set(sessionId, gate);
      }
    }

    if (taskBudget > 0) persist();
    return next();
  });

  ctx.on("agent/disposed", ({ agent }) => {
    warned.delete(agent.session.id);
  });
}

export { Config, apply, inject, name };
