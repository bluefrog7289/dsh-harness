// 纯折叠：把 session 事件流折叠成 7 个派生指标所需的计数（无 IO、不新增采集层）。
// 依赖契约：dsh-session 的 SessionEventMap（turn/start、step/start、step/end、assistant/message.usage、
// tool/call、tool/result、request/header.tools）+ dsh-compaction 声明合并的 compaction/end（error 字段）。

/** 断言措辞：命中 assistant 文本即视为一条"已完成/已修复/通过"类断言。 */
const CLAIM_TEXT =
  /(?:已完成|已修复|已通过|已实现|完成|修复|通过|\bdone\b|\bfixed\b|\bpassed\b|\bimplemented\b|\bcompleted\b)/i;

/** read 类工具名：read / tool:read / read_image / read_file。 */
const READ_TOOL = /(?:^|[:_])read(?:$|_)/;

/** 压缩后退化观察窗口宽度（步）。 */
export const COMPACTION_WINDOW_STEPS = 5;

/** 空状态；纯 JSON，满足 projection checkpoint 前置条件。 */
export function initialState() {
  return {
    turns: 0,
    step: null,
    claims: 0,
    unbackedClaims: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningSamples: 0,
    cacheBuckets: [],
    toolSpecBytes: null,
    compactions: 0,
    postCalls: 0,
    postRepeats: 0,
    postReads: 0,
    postRereads: 0,
    window: null,
  };
}

/**
 * 步序 → 分桶标签。buckets 是步序上界（含），默认 [1,2,3,4,5,10,20] →
 * 1 / 2 / 3 / 4 / 5 / 6-10 / 11-20 / 21+。
 */
export function bucketLabel(step, buckets) {
  let lo = 1;
  for (const edge of buckets) {
    if (step <= edge) return lo === edge ? String(edge) : `${lo}-${edge}`;
    lo = edge + 1;
  }
  return `${lo}+`;
}

/** assistant 消息里可见 text 块的拼接。 */
function textOf(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** read 类工具的目标文件：优先 file_path/path；参数非 JSON 时退回原始串。 */
function readTargetOf(args) {
  try {
    const parsed = JSON.parse(args);
    return parsed.file_path ?? parsed.path ?? args;
  } catch {
    return args;
  }
}

function addUsage(state, step, usage, buckets) {
  const label = bucketLabel(step, buckets);
  const index = state.cacheBuckets.findIndex((entry) => entry.bucket === label);
  const cacheRead = usage.cacheReadTokens ?? 0;
  const uncachedInput = usage.inputTokens;
  const cacheBuckets =
    index === -1
      ? [...state.cacheBuckets, { bucket: label, cacheRead, uncachedInput }]
      : state.cacheBuckets.map((entry, i) =>
          i === index
            ? {
                ...entry,
                cacheRead: entry.cacheRead + cacheRead,
                uncachedInput: entry.uncachedInput + uncachedInput,
              }
            : entry,
        );
  return {
    ...state,
    cacheBuckets,
    outputTokens: state.outputTokens + usage.outputTokens,
    reasoningTokens: state.reasoningTokens + (usage.reasoningTokens ?? 0),
    reasoningSamples: state.reasoningSamples + (usage.reasoningTokens === undefined ? 0 : 1),
  };
}

function recordToolCall(state, name, args) {
  if (state.window === null || state.window.stepsLeft <= 0) return state;
  const fingerprint = `${name}\n${args}`;
  const repeat = state.window.callSeen.includes(fingerprint);
  let next = {
    ...state,
    postCalls: state.postCalls + 1,
    postRepeats: state.postRepeats + (repeat ? 1 : 0),
    window: {
      ...state.window,
      callSeen: repeat ? state.window.callSeen : [...state.window.callSeen, fingerprint],
    },
  };
  if (READ_TOOL.test(name)) {
    const path = readTargetOf(args);
    const reread = next.window.readSeen.includes(path);
    next = {
      ...next,
      postReads: next.postReads + 1,
      postRereads: next.postRereads + (reread ? 1 : 0),
      window: {
        ...next.window,
        readSeen: reread ? next.window.readSeen : [...next.window.readSeen, path],
      },
    };
  }
  return next;
}

function closeStep(state, turn, step) {
  let next = state;
  const open = state.step;
  if (open !== null && open.turn === turn && open.step === step) {
    next =
      open.claims === 0
        ? { ...next, step: null }
        : {
            ...next,
            step: null,
            claims: next.claims + open.claims,
            unbackedClaims:
              next.unbackedClaims + (open.toolSuccesses === 0 ? open.claims : 0),
          };
  }
  if (next.window !== null && next.window.stepsLeft > 0) {
    next = { ...next, window: { ...next.window, stepsLeft: next.window.stepsLeft - 1 } };
  }
  return next;
}

/**
 * 纯转移：state + 一个已提交事件 → 下一个 state。无关事件返回同一引用（Object.is 零下游工作）。
 * @param state - 之前的计数状态。
 * @param event - 一个已提交的 SessionEvent。
 * @param buckets - 步序分桶边界。
 */
export function foldEvent(state, event, buckets) {
  switch (event.type) {
    case "turn/start":
      return { ...state, turns: state.turns + 1 };

    case "step/start":
      return {
        ...state,
        step: { turn: event.data.turn, step: event.data.step, claims: 0, toolSuccesses: 0 },
      };

    case "step/end":
      return closeStep(state, event.data.turn, event.data.step);

    case "assistant/message": {
      let next = state;
      if (event.data.usage !== undefined) next = addUsage(next, event.data.step, event.data.usage, buckets);
      if (CLAIM_TEXT.test(textOf(event.data.message))) {
        const open = next.step;
        next =
          open !== null && open.turn === event.data.turn && open.step === event.data.step
            ? { ...next, step: { ...open, claims: open.claims + 1 } }
            : next;
      }
      return next;
    }

    case "tool/result": {
      const open = state.step;
      if (event.data.message.isError === true) return state;
      return open !== null && open.turn === event.data.turn && open.step === event.data.step
        ? { ...state, step: { ...open, toolSuccesses: open.toolSuccesses + 1 } }
        : state;
    }

    case "tool/call":
      return recordToolCall(state, event.data.name, event.data.arguments);

    case "request/header":
      return event.data.header.tools === undefined
        ? state
        : { ...state, toolSpecBytes: Buffer.byteLength(JSON.stringify(event.data.header.tools), "utf8") };

    case "compaction/end":
      return event.data.error !== undefined
        ? state
        : {
            ...state,
            compactions: state.compactions + 1,
            window: { stepsLeft: COMPACTION_WINDOW_STEPS, callSeen: [], readSeen: [] },
          };

    default:
      return state;
  }
}

/** 从事件流直接折叠（CLI / 未挂载场景）。 */
export function foldAll(events, buckets) {
  return events.reduce((state, event) => foldEvent(state, event, buckets), initialState());
}

/** 比例；分母为 0 或样本缺失时 null（不伪造）。 */
export function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 计数状态 → 7 个指标（FINAL-REPORT §3.45）。tokenMeter 相关两项由调用方按可获取性置 null。
 * @param state - 折叠后的计数状态。
 * @returns 7 个 key 齐全的指标对象。
 */
export function summarize(state) {
  const cacheRead = state.cacheBuckets.reduce((sum, entry) => sum + entry.cacheRead, 0);
  const uncachedInput = state.cacheBuckets.reduce((sum, entry) => sum + entry.uncachedInput, 0);
  return {
    unbacked_claims: {
      claims: state.claims,
      unbacked: state.unbackedClaims,
      ratio: ratio(state.unbackedClaims, state.claims),
    },
    reasoning_ratio: state.reasoningSamples === 0 ? null : ratio(state.reasoningTokens, state.outputTokens),
    prefix_cache_hit: {
      overall: ratio(cacheRead, cacheRead + uncachedInput),
      buckets: state.cacheBuckets.map((entry) => ({
        bucket: entry.bucket,
        hit: ratio(entry.cacheRead, entry.cacheRead + entry.uncachedInput),
        samples: entry.cacheRead + entry.uncachedInput,
      })),
    },
    tool_spec_bytes: state.toolSpecBytes,
    steps_per_task: state.turns,
    repeat_tool_calls_after_compaction: {
      compactions: state.compactions,
      calls: state.postCalls,
      repeats: state.postRepeats,
      ratio: ratio(state.postRepeats, state.postCalls),
    },
    file_reread_rate_after_compaction: {
      compactions: state.compactions,
      reads: state.postReads,
      rereads: state.postRereads,
      ratio: ratio(state.postRereads, state.postReads),
    },
  };
}
