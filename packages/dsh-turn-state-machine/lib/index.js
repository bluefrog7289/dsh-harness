import z from "@deepseek-ai/schemastery";
import { z as zd } from "zod";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";

// 挂点：agent/pre-step 边界校验 + agent 事件推迁移 + sessionProjections.register({key:'turnState'})。
// 依赖契约：dsh-agent/lib/types/runtime-types.d.ts:117-124 的 PreStepDecision（reject 无原因字段）；
//   agent/status、agent/assistant-stream、agent/error；dsh-session 的 turn|step|tool 事件。
// 参数：strict=false（默认）非法迁移只记 harness/invalid-transition 事件不阻断；true 时在 pre-step 拒绝（先 inject notice）。

const name = "turn-state-machine";
const inject = ["agents", "sessionProjections"];

/** FINAL-REPORT §3.29 的 10 个 phase。 */
const PHASES = [
  "idle",
  "processing_input",
  "awaiting_model_response",
  "streaming",
  "scheduling_tools",
  "executing_tools",
  "aggregating_results",
  "completing",
  "awaiting_permission",
  "error",
];

/**
 * 写死的迁移白名单：from → 允许的 to。自身转移由 advance() 当作 no-op。
 * 每个 phase 都允许 → `idle`（driver 静默）与 → `error`（失败）；`completing` 还允许
 * → `processing_input`（同一 driver 排空里的下一轮，中间不发 agent/status idle）。
 */
const ALLOWED = {
  idle: ["processing_input", "awaiting_model_response", "completing", "error"],
  processing_input: ["awaiting_model_response", "completing", "idle", "error"],
  awaiting_model_response: ["streaming", "scheduling_tools", "aggregating_results", "completing", "idle", "error"],
  streaming: ["scheduling_tools", "aggregating_results", "completing", "idle", "error"],
  scheduling_tools: ["executing_tools", "awaiting_permission", "aggregating_results", "completing", "idle", "error"],
  executing_tools: ["awaiting_permission", "aggregating_results", "scheduling_tools", "completing", "idle", "error"],
  awaiting_permission: ["executing_tools", "aggregating_results", "completing", "idle", "error"],
  aggregating_results: ["awaiting_model_response", "scheduling_tools", "executing_tools", "completing", "idle", "error"],
  completing: ["idle", "processing_input", "error"],
  error: ["idle", "completing", "processing_input"],
};

/**
 * pre-step 是「下一轮模型请求」的入口。`completing` 也是合法入口 —— 上一个 turn
 * `aborted` 收敛到 `completing` 后，同一 driver 排空里的下一轮不再发 `agent/status idle`。
 */
const ENTRY = new Set(["idle", "processing_input", "awaiting_model_response", "aggregating_results", "awaiting_permission", "completing"]);

const Config = z.object({
  /** false = 只记录不阻断（默认）；true = 非法迁移在 agent/pre-step 边界拒绝。 */
  strict: z.boolean().default(false),
});

const turnStateSchema = zd.object({
  phase: zd.string(),
  turn: zd.number().int().nonnegative(),
  step: zd.number().int().nonnegative(),
  lastEvent: zd.string(),
  at: zd.number().nonnegative(),
});

const initialState = () => ({ phase: "idle", turn: 0, step: 0, lastEvent: "init", at: 0 });

/** 'aborted' 是正常终止（§3.30）：只有 error 才归 error，其余一律 completing。 */
function turnEndPhase(reason) {
  return reason?.kind === "error" ? "error" : "completing";
}

/** 纯折叠：只读日志事件，不读时钟（时间取 event.time），可跨 fork/resume 复算。 */
function fold(state, event) {
  const at = event.time;
  switch (event.type) {
    case "turn/start":
      return { phase: "processing_input", turn: event.data.turn, step: 0, lastEvent: event.type, at };
    case "step/start":
      return { phase: "awaiting_model_response", turn: event.data.turn, step: event.data.step, lastEvent: event.type, at };
    case "assistant/message":
      return { ...state, phase: "aggregating_results", lastEvent: event.type, at };
    case "tool/call":
      return { ...state, phase: "scheduling_tools", lastEvent: event.type, at };
    case "tool/result":
      return { ...state, phase: "aggregating_results", lastEvent: event.type, at };
    case "step/end":
      return { ...state, phase: "aggregating_results", lastEvent: event.type, at };
    case "turn/end":
      return { ...state, phase: turnEndPhase(event.data.reason), lastEvent: event.type, at };
    default:
      return state;
  }
}

function notice(text, summary) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: name, form: "notice", summary: boundContextSummary(summary) },
  });
}

function apply(ctx, config) {
  /** 活迁移面：日志折不出 streaming，且 pre-step 需要「当前」phase；按 sessionId 存插件实例内存。 */
  const live = new Map();

  const current = (agent, projectionState) => live.get(agent.session.id) ?? projectionState;

  const recordInvalid = (agent, from, to, event) => {
    ctx.emit("harness/invalid-transition", {
      sessionId: agent.session.id,
      from,
      to,
      event,
      phase: config.strict ? "rejected" : "recorded",
    });
  };

  /** 推一次活迁移；非法时记事件并保持原 phase（strict 只在 pre-step 边界拒绝）。 */
  const advance = (agent, to, lastEvent, turn, step) => {
    const cur = live.get(agent.session.id) ?? initialState();
    if (cur.phase === to) return;
    if (!(ALLOWED[cur.phase] ?? []).includes(to)) {
      recordInvalid(agent, cur.phase, to, lastEvent);
      return;
    }
    live.set(agent.session.id, {
      phase: to,
      turn: turn ?? cur.turn,
      step: step ?? cur.step,
      lastEvent,
      at: Date.now(),
    });
  };

  const projectionReady = ctx.sessionProjections.register({
    key: "turnState",
    stateVersion: 1,
    stateSchema: turnStateSchema,
    init: initialState,
    apply: fold,
  });

  // 日志事件：durable 迁移来源（含 turn/end 的 aborted → completing）。
  ctx.on("session/event", (session, event) => {
    const agent = { session, id: session.id };
    switch (event.type) {
      case "turn/start":
        advance(agent, "processing_input", event.type, event.data.turn, 0);
        return;
      case "step/start":
        advance(agent, "awaiting_model_response", event.type, event.data.turn, event.data.step);
        return;
      case "assistant/message":
        advance(agent, "aggregating_results", event.type);
        return;
      case "tool/call":
        advance(agent, "scheduling_tools", event.type);
        return;
      case "tool/result":
        advance(agent, "aggregating_results", event.type);
        return;
      case "turn/end":
        advance(agent, turnEndPhase(event.data.reason), event.type);
        return;
      default:
        return;
    }
  });

  // 活事件：streaming 只在 live 面可见；agent/error 走 error。
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (frame.type === "start") advance(agent, "streaming", "assistant-stream/start");
  });
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") advance(agent, "idle", "agent/status:idle");
  });
  ctx.on("agent/error", ({ agent }) => {
    advance(agent, "error", "agent/error");
  });
  ctx.on("agent/disposed", ({ agent }) => {
    live.delete(agent.session.id);
  });

  // 边界校验：每次 pre-step 必须先处于合法的「下一轮请求」入口。
  ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
    const handle = await projectionReady;
    if (signal.aborted) return next();
    const state = current(agent, handle.stateOf(agent.session));
    if (!ENTRY.has(state.phase)) {
      recordInvalid(agent, state.phase, "awaiting_model_response", `pre-step:${turn}:${step}`);
      if (config.strict) {
        agent.inject(
          notice(
            `turn-state-machine: 拒绝在非法 phase "${state.phase}" 进入模型请求（turn ${turn} step ${step}）。`,
            `invalid transition ${state.phase} → awaiting_model_response`,
          ),
        );
        return { kind: "reject" };
      }
    }
    advance(agent, "awaiting_model_response", "agent/pre-step", turn, step);
    return next();
  });}

export { ALLOWED, Config, PHASES, apply, inject, name };
