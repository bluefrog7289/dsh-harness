import z from "@deepseek-ai/schemastery";
import { foldAll, foldEvent, initialState, summarize } from "./fold.js";

// 挂点：ctx.sessionProjections.register({key:'metrics'}) 维护计数；agent/pre-step 在 await next() 之后观测（读 cell 强制推进）。
// 依赖契约：dsh-session 的 SessionEventMap；dsh-compaction 声明合并的 compaction/end；dsh-token-meter 仅经 ctx.get('tokenMeter') 可选探测（不进 inject）。
// 取不到 tokenMeter 时 reasoning_ratio / prefix_cache_hit 记 null（数据本身仍从 assistant/message.usage 折叠，与 token-meter 的 tokenUsage 同源）。

const name = "metrics-derive";
const inject = ["agents", "sessionProjections"];

const DEFAULT_BUCKETS = [1, 2, 3, 4, 5, 10, 20];

const Config = z.object({
  /** 步序分桶上界（含），默认 1/2/3/4/5/6-10/11-20/21+。 */
  buckets: z.array(z.number()).default(DEFAULT_BUCKETS),
});

/** 状态是纯 JSON；透传解析器只服务 persisted-checkpoint 的 restore 路径。 */
const stateSchema = { parse: (value) => value };

/** apply 注册出的活投影句柄；未挂载（CLI）时 null，snapshot 退回直接折叠事件流。 */
let handle = null;
/** apply 的 ctx；用于 ctx.get('tokenMeter') 可选探测。 */
let pluginCtx = null;
/** 当前分桶边界。 */
let buckets = DEFAULT_BUCKETS;

/**
 * 读 7 个派生指标的当前值。挂载后走投影 cell（与实时驱动一致）；未挂载时直接折叠事件流。
 * reasoning_ratio / prefix_cache_hit 的口径与 dsh-token-meter 的 tokenUsage 投影同源
 * （assistant/message.usage 的服务端计数）；`ctx.get('tokenMeter')` 取不到时这两项记 null（不伪造）。
 * @param session - 要读取的 dsh Session。
 * @returns 7 个 key 齐全的指标对象。
 */
export function snapshot(session) {
  const state = handle !== null ? handle.stateOf(session) : foldAll(session.snapshotEvents(), buckets);
  const metrics = summarize(state);
  if (pluginCtx === null || pluginCtx.get("tokenMeter") === undefined) {
    metrics.reasoning_ratio = null;
    metrics.prefix_cache_hit = null;
  }
  return metrics;
}

function apply(ctx, config) {
  buckets = config.buckets;
  pluginCtx = ctx;
  const projection = ctx.sessionProjections.register({
    key: "metrics",
    stateVersion: 1,
    stateSchema,
    init: () => initialState(),
    apply: (state, event) => foldEvent(state, event, buckets),
  });
  projection.then((resolved) => {
    handle = resolved;
  });
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    handle ??= await projection;
    handle.stateOf(agent.session);
    return decision;
  });
}

export { Config, apply, inject, name };
