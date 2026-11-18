import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  DEFAULTS as PRUNE_DEFAULTS,
  PRUNE_MARKER,
  ToolResultPruner,
} from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { boundContextSummary, createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";

// 挂点：ctx.compaction = 本类（继承 dsh-compaction-basic 的 BasicCompactionEngine，自动压缩监听器、
//   compactRegion、8 段摘要模板与 KV-cache 复用摘要器全部继承，未复制一行摘要文本）；
//   本 fiber 内再注册 ctx.toolResultPruner = GuardedToolResultPruner（整行替换官方 pruner）。
// 依赖契约：dsh-compaction-basic 的 BasicCompactionEngine（compactIfNeeded / compactPressure /
//   compactNow / summarize / inject）；dsh-compaction-tool-result-pruner 的 ToolResultPruner /
//   PRUNE_MARKER / DEFAULTS；dsh-compaction 的 CompactionEngine 服务名 "compaction"；
//   dsh-llm 的 createUserMessage / freezeMessage / boundContextSummary；
//   dsh-session-projection 的 sessionProjections.register（thenable→handle）。
// 参数：thresholdRatio/retainRatio/headroomTokens/maxOverflowRetries 透传官方 engine；
//   maxConsecutiveFailures=3 连续 durable 摘要失败熔断阈值；minSavingsTokens=256 clear_at_least；
//   thresholdChars 可选（缺省 floor(contextWindow*2.8)）；charsPerToken=3.5 字符→token 换算。

const name = "compaction-guarded";
const inject = ["llm", "tokenMeter", "sessions", "sessionProjections"];

/** 熔断 notice 正文（≤ CONTEXT_SUMMARY_MAX_CHARS = 120）。 */
const NOTICE_TEXT = "压缩已熔断，保留原文，请手动处理";

/** `BasicCompactionEngine` 认识的键；本包新增键在移交前剥离。 */
const BASIC_KEYS = [
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
];

const Config = z.object({
  thresholdRatio: z.number().default(0.8),
  retainRatio: z.number().default(0.16),
  headroomTokens: z.number().step(1).min(0).default(65536),
  maxOverflowRetries: z.number().step(1).min(0).default(1),
  maxConsecutiveFailures: z.number().step(1).min(1).default(3),
  minSavingsTokens: z.number().step(1).min(0).default(256),
  thresholdChars: z.number().step(1).min(1),
  charsPerToken: z.number().min(0.1).default(3.5),
  auto: z.boolean().default(true),
});

/** 只把官方 engine 认识的键交给它。 */
function basicSubset(config) {
  const out = {};
  for (const key of BASIC_KEYS) if (config[key] !== undefined) out[key] = config[key];
  return out;
}

/** 记账到 sessionStats（可选服务，缺失即跳过）。 */
function count(ctx, metric, delta) {
  ctx.get("sessionStats")?.counter?.(metric, delta);
}

/**
 * 熔断投影：纯折叠 durable 日志，进程内不另存状态。
 * `compaction/end` 带 error 计一次连续失败、不带 error 归零；
 * 只有真实用户输入（`source.kind === "user"`）重置，注入源不重置。
 */
const guardedStateSchema = zod.object({
  failures: zod.number().int().nonnegative(),
  circuitOpen: zod.boolean(),
  notified: zod.boolean(),
});

/**
 * tool-result pruner：整行替换官方 Service（同一服务名 `toolResultPruner`）。
 * 与官方的三处差异：预算按 contextWindow 派生、clear_at_least 门槛、跳过计数。
 */
class GuardedToolResultPruner extends ToolResultPruner {
  static inject = ["tokenMeter"];
  static Config = z.object({
    thresholdChars: z.number().step(1).min(1),
    headChars: z.number().step(1).min(0),
    tailChars: z.number().step(1).min(0),
    minSavingsTokens: z.number().step(1).min(0).default(256),
    charsPerToken: z.number().min(0.1).default(3.5),
  });

  /** 本包自己的预算配置（Service 实例被 cordis 代理，故用普通字段而非 #private）。 */
  budget;

  constructor(ctx, config = {}) {
    super(ctx, PRUNE_DEFAULTS);
    this.budget = config;
  }

  /** 由 contextWindow 派生字符预算；窗口未知时退回官方 8192/4096/1024。 */
  budgetFor(contextWindow) {
    const { thresholdChars, headChars, tailChars } = this.budget;
    const threshold =
      thresholdChars ??
      (contextWindow === undefined ? PRUNE_DEFAULTS.thresholdChars : Math.floor(contextWindow * 2.8));
    return {
      thresholdChars: threshold,
      headChars: headChars ?? Math.floor(threshold * 0.5),
      tailChars: tailChars ?? Math.floor(threshold * 0.125),
    };
  }

  /** 官方 head/middle/tail 切片算法，预算改为入参。 */
  pruneBlocks(blocks, budget) {
    const totalChars = this.measureContent(blocks);
    if (totalChars <= budget.thresholdChars) return null;
    const removedStart = budget.headChars;
    const removedEnd = totalChars - budget.tailChars;
    const pruned = [];
    let consumed = 0;
    let markerInserted = false;
    for (const block of blocks) {
      if (block.type !== "text") {
        pruned.push(block);
        continue;
      }
      const points = Array.from(block.text);
      const blockStart = consumed;
      const blockEnd = blockStart + points.length;
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
      const marker =
        blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : "";
      if (marker.length > 0) markerInserted = true;
      const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("");
      if (text.length > 0) pruned.push({ ...block, text });
      consumed = blockEnd;
    }
    return pruned;
  }

  /**
   * clear_at_least：先只算不写，全部候选的节省合计 ≥ minSavingsTokens 才落盘；
   * 未达门槛则原文保留（避免 8192 附近反复重建前缀、缓存全废），并计一次跳过。
   */
  pruneSession(session) {
    const { contextWindow } = this.ctx.tokenMeter.contextPressure(session);
    const budget = this.budgetFor(contextWindow);
    const plans = [];
    let charsRemoved = 0;
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq);
      if (event?.type !== "tool/result") continue;
      const original = session.deriveEventMessage(event);
      const content = this.pruneBlocks(original.content, budget);
      if (content === null) continue;
      const charsBefore = this.measureContent(original.content);
      const charsAfter = this.measureContent(content);
      plans.push({ seq, event, original, content, charsBefore, charsAfter });
      charsRemoved += charsBefore - charsAfter;
    }
    if (Math.floor(charsRemoved / this.budget.charsPerToken) < this.budget.minSavingsTokens) {
      count(this.ctx, "harness_prune_min_savings_skips", 1);
      return { pruned: [], charsRemoved: 0 };
    }
    const pruned = [];
    for (const plan of plans) {
      const message = freezeMessage({ ...plan.original, content: plan.content });
      session.append("compaction/prune", {
        shadowedRange: { start: plan.seq, end: plan.seq },
        shadowedSeqs: [plan.seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(plan.original),
      });
      const replacement = session.append(
        "tool/result",
        { ...plan.event.data, message },
        {
          surfaceOp: { op: "replace", startSeq: plan.seq, endSeq: plan.seq },
          sourceEventSeqs: [plan.seq],
        },
      );
      pruned.push({
        originalSeq: plan.seq,
        replacementSeq: replacement.seq,
        callId: plan.event.data.message.source.callId,
        charsBefore: plan.charsBefore,
        charsAfter: plan.charsAfter,
      });
    }
    return { pruned, charsRemoved };
  }
}

/**
 * 压缩守卫：继承官方 backend（摘要器、8 段模板、配对校验、overflow 恢复全部复用），
 * 叠加连续失败熔断 + notice、pruner 阈值派生、pruner clear_at_least。
 */
class GuardedCompactionEngine extends BasicCompactionEngine {
  static inject = inject;
  static Config = Config;

  /** 熔断阈值。 */
  maxConsecutiveFailures;
  /** sessionProjections 注册（thenable→handle）。 */
  projectionReady;

  constructor(ctx, config = {}) {
    super(ctx, basicSubset(config));
    const maxFailures = (this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3);
    this.projectionReady = ctx.sessionProjections.register({
      key: "compactionGuarded",
      stateVersion: 1,
      stateSchema: guardedStateSchema,
      init: () => ({ failures: 0, circuitOpen: false, notified: false }),
      apply: (state, event) => {
        let next = state;
        if (event.type === "compaction/end") {
          const failed = event.data.error !== undefined;
          const failures = failed ? state.failures + 1 : 0;
          next = { failures, circuitOpen: failed && failures >= maxFailures, notified: false };
        } else if (event.type === "user/message") {
          const source = event.data.source;
          if (source.kind === name && source.form === "notice") next = { ...state, notified: true };
          else if (source.kind === "user") next = { failures: 0, circuitOpen: false, notified: false };
        }
        return next.failures === state.failures &&
          next.circuitOpen === state.circuitOpen &&
          next.notified === state.notified
          ? state
          : next;
      },
    });
    new GuardedToolResultPruner(ctx, {
      thresholdChars: config.thresholdChars,
      minSavingsTokens: config.minSavingsTokens ?? 256,
      charsPerToken: config.charsPerToken ?? 3.5,
    });
    if (this.config.auto) this.registerGuardedStep();
  }

  /** 读当前 session 的熔断投影状态。 */
  async stateOf(session) {
    const handle = await this.projectionReady;
    return handle.stateOf(session);
  }

  /**
   * 自注册 pre-step：官方监听器先跑（自动压缩已被下列覆盖点挡掉），
   * 本监听器只在熔断打开的那一步注入一条 ≤120 字符 notice。
   */
  registerGuardedStep() {
    const { ctx } = this;
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === "reject" || signal.aborted) return decision;
      const state = await this.stateOf(agent.session);
      if (!state.circuitOpen || state.notified) return decision;
      count(ctx, "harness_compaction_circuit_open", 1);
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: "text", text: NOTICE_TEXT }],
            source: { kind: name, form: "notice", summary: boundContextSummary(NOTICE_TEXT) },
          }),
        ],
      };
    });
  }

  /** 熔断打开后自动路径一律不再尝试（返回 null = 本步不压缩）；人工 /compact 不受影响。 */
  async compactIfNeeded(agent, trigger, signal) {
    const state = await this.stateOf(agent.session);
    if (state.circuitOpen) return null;
    return super.compactIfNeeded(agent, trigger, signal);
  }

  async compactPressure(agent, header, signal, requireBelowThreshold) {
    const state = await this.stateOf(agent.session);
    if (state.circuitOpen) return null;
    return super.compactPressure(agent, header, signal, requireBelowThreshold);
  }
}

export { Config, GuardedCompactionEngine, GuardedToolResultPruner, GuardedCompactionEngine as default, NOTICE_TEXT, inject, name };

export { NOTICE_TEXT as noticeText };
