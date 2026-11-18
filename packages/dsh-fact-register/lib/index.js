import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";

// 挂点：sessionProjections.register(key 'facts') 纯同步折叠 event stream；systemPrompt.context 两段
//   harness:facts:resident（getContextOrder('TEAM_IDENTITY')，required:true）与 harness:facts:catalog（130）；
//   tools.register 唯一工具 fact_recall({id})。P6：没有任何写入工具，事实只能从 event stream 折叠。
// 依赖契约：dsh-session-projection 的 register()/stateOf()；dsh-system-prompt 的 context()/getContextOrder()；
//   dsh-tools 的 register() 与 ToolExecutionResult.isError（lib/types/contracts.d.ts:289-303）。
// 参数：residentLimit 常驻上限（超限 deadend 优先）；catalogNameMaxChars catalog 名字截断；
//   constraintPatterns / decisionPatterns 句级识别正则（大小写不敏感）。

const name = "fact-register";
const inject = ["agents", "sessionProjections", "systemPrompt", "tools"];

const PROJECTION_KEY = "facts";
const RESIDENT_NAME = "harness:facts:resident";
const CATALOG_NAME = "harness:facts:catalog";
/** catalog 段在 CONTRACT §2.4 里是固定号 130（无对应 CONTEXT_ORDERS 名字）。 */
const CATALOG_ORDER = 130;
const MAX_FACT_CHARS = 200;
const MAX_REASON_CHARS = 80;

const DEFAULT_CONSTRAINT_PATTERNS = [
  "必须",
  "不要",
  "禁止",
  "只能",
  "一定要",
  "\\bmust\\b",
  "\\bdo not\\b",
  "\\bdon'?t\\b",
  "\\bnever\\b",
];
const DEFAULT_DECISION_PATTERNS = [
  "决定",
  "采用",
  "改用",
  "定下来",
  "\\bdecided\\b",
];

const Config = z.object({
  /** resident 层条数上限；超限时 deadend 优先保留，constraint 让位。 */
  residentLimit: z.number().default(12),
  /** catalog 每条 decision 只留前 N 字。 */
  catalogNameMaxChars: z.number().default(60),
  /** constraint 的句级识别正则（源码字符串）。 */
  constraintPatterns: z.array(z.string()).default(DEFAULT_CONSTRAINT_PATTERNS),
  /** decision 的句级识别正则（源码字符串）。 */
  decisionPatterns: z.array(z.string()).default(DEFAULT_DECISION_PATTERNS),
});

/** 一条事实：id 形如 constraint-3 / decision-2 / deadend-5。schemastery 默认字段可缺，故逐个 .required()。 */
const factSchema = z
  .object({
    id: z.string().required(),
    cls: z.string().required(),
    text: z.string().required(),
    seq: z.number().required(),
    source: z.string().required(),
    hits: z.number().required(),
    lastSeq: z.number().required(),
  })
  .required();

/** 折叠状态：三个列表共用 `facts`（按 cls 区分）+ 序号计数器 + 去重/折叠索引 + 未完成调用。 */
const stateSchema = z
  .object({
    revision: z.number().required(),
    facts: z.array(factSchema).required(),
    counter: z
      .object({ constraint: z.number().required(), decision: z.number().required(), deadend: z.number().required() })
      .required(),
    seen: z.dict(z.string()).required(),
    deadends: z.dict(z.string()).required(),
    pending: z.dict(z.object({ name: z.string().required(), fingerprint: z.string().required() }).required()).required(),
  })
  .required();

/**
 * 投影注册表要的是 `.parse(value)` 面（dsh-session-projection 用它校验持久化缓存行，不符即丢弃重折）。
 * schemastery 的校验面是「调用即校验」，这里只补 `.parse` 这个名字。
 */
const factsStateSchema = { parse: (value) => stateSchema(value) };

/** 句子切分：中文标点、换行与英文句点后断句。 */
const SENTENCE_BREAK = /(?<=[。！？；;.!?\n])/u;

/** 一个消息/事件里的可见文本。 */
function textOf(content) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

/** 文本 → 去空句子列表。 */
function sentencesOf(text) {
  return text.split(SENTENCE_BREAK).map((part) => part.trim()).filter((part) => part !== "");
}

/** 截断到 limit 字（中文按码元计，够用）。 */
function clip(text, limit = MAX_FACT_CHARS) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** args 的 sha1 前 8 位，作为 deadend 折叠指纹。 */
function argsFingerprint(args) {
  return createHash("sha1").update(args).digest("hex").slice(0, 8);
}

/** 句子的去重键（类 + 文本指纹），避免同一句话在多个事件里重复登记。 */
function dedupeKey(cls, text) {
  return `${cls}:${createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
}

/** 登记一条事实；重复句子返回原 state 引用（fold 的零工作路径）。 */
function addFact(state, cls, text, seq, source) {
  const key = dedupeKey(cls, text);
  if (state.seen[key] !== undefined) return state;
  const ordinal = state.counter[cls] + 1;
  const id = `${cls}-${ordinal}`;
  return {
    ...state,
    revision: state.revision + 1,
    facts: [...state.facts, { id, cls, text: clip(text), seq, source, hits: 1, lastSeq: seq }],
    counter: { ...state.counter, [cls]: ordinal },
    seen: { ...state.seen, [key]: id },
  };
}

/** 去掉一个 pending 调用（成败都要去，避免状态随调用数膨胀）。 */
function forgetCall(state, callId) {
  if (state.pending[callId] === undefined) return state;
  const pending = { ...state.pending };
  delete pending[callId];
  return { ...state, pending };
}

/**
 * tool/result → deadend。失败标记的唯一权威是 tools/post-execute 归一化结果的 `isError`
 * （dsh-tools/lib/types/contracts.d.ts:301-303 ToolExecutionFailure.isError），它在事件流里的
 * 持久形态就是 `ToolResultMessage.isError`（dsh-llm/lib/types/message.d.ts:159），
 * 且 `data.error` 仅在该标记为 true 时出现（dsh-session/lib/types/types.d.ts:386-390）。
 * 取事件流而非活钩子：折叠可恢复（P6 + 崩溃恢复），且两者是同一份 outcome。
 */
function foldToolResult(state, event) {
  const { message, error } = event.data;
  const callId = message.toolCallId;
  if (message.isError !== true) return forgetCall(state, callId);
  const call = state.pending[callId];
  if (call === undefined) return forgetCall(state, callId);
  const key = `${call.name}#${call.fingerprint}`;
  const existing = state.deadends[key];
  if (existing !== undefined) {
    return {
      ...state,
      revision: state.revision + 1,
      facts: state.facts.map((fact) => (fact.id === existing ? { ...fact, hits: fact.hits + 1, lastSeq: event.seq } : fact)),
      pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== callId)),
    };
  }
  const reason = error?.code ?? clip(textOf(message.content).split("\n")[0] ?? "", MAX_REASON_CHARS);
  const ordinal = state.counter.deadend + 1;
  const id = `deadend-${ordinal}`;
  const text = `${call.name} args ${call.fingerprint} 失败：${reason}`;
  return {
    ...state,
    revision: state.revision + 1,
    facts: [...state.facts, { id, cls: "deadend", text: clip(text), seq: event.seq, source: `tool ${call.name}`, hits: 1, lastSeq: event.seq }],
    counter: { ...state.counter, deadend: ordinal },
    seen: { ...state.seen, [dedupeKey("deadend", text)]: id },
    deadends: { ...state.deadends, [key]: id },
    pending: Object.fromEntries(Object.entries(state.pending).filter(([pendingId]) => pendingId !== callId)),
  };
}

/** 编译模式列表；任一非法正则即抛（装载期失败，符合 §2.7）。 */
function compile(patterns) {
  return patterns.map((source) => new RegExp(source, "iu"));
}

/** resident 段：全部 constraint + 全部 deadend，超限时 deadend 优先。
 *  constraint 取最旧的（resident 前缀跨步稳定，利 KV cache），deadend 取最新的（最贵的近期教训）。 */
function renderResident(state, limit) {
  const constraints = state.facts.filter((fact) => fact.cls === "constraint");
  const deadends = state.facts.filter((fact) => fact.cls === "deadend");
  const keptDeadends = deadends.slice(-limit);
  const keptConstraints = constraints.slice(0, Math.max(0, limit - keptDeadends.length));
  const dropped = constraints.length - keptConstraints.length;
  const lines = [];
  for (const fact of keptConstraints) lines.push(`- ${fact.id}: ${fact.text}`);
  for (const fact of keptDeadends) lines.push(`- ${fact.id}: ${fact.text}${fact.hits > 1 ? ` (x${fact.hits})` : ""}`);
  if (dropped > 0) lines.push(`(+${dropped} more constraint(s) in the log; read them with fact_recall)`);
  if (lines.length === 0) return "";
  return `Facts that stay resident — constraints must hold, dead ends must not be retried:\n${lines.join("\n")}`;
}

/** catalog 段：只列 decision 的名字，正文按需 fact_recall。 */
function renderCatalog(state, nameMaxChars) {
  const decisions = state.facts.filter((fact) => fact.cls === "decision");
  if (decisions.length === 0) return "";
  const lines = decisions.map((fact) => `- ${fact.id}: ${clip(fact.text, nameMaxChars)}`);
  return `Confirmed decisions (names only — fact_recall(id) returns the body):\n${lines.join("\n")}`;
}

/** 一条事实的完整正文 + 来源（seq + 消息序号 / 工具名）。 */
function renderRecall(state, id) {
  const fact = state.facts.find((entry) => entry.id === id);
  if (fact === undefined) throw new Error(`fact_recall: unknown fact id ${JSON.stringify(id)}`);
  const origin = fact.cls === "deadend"
    ? `${fact.source} at seq ${fact.seq} (failed ${fact.hits}x, last seq ${fact.lastSeq ?? fact.seq})`
    : `${fact.source} at seq ${fact.seq}`;
  return `${fact.id} [${fact.cls}]\n${fact.text}\nsource: ${origin}`;
}

/**
 * 注册三层事实投影：投影折叠 + resident/catalog 两个 context + fact_recall 工具。
 * @param ctx - 带 agents/sessionProjections/systemPrompt/tools 的插件上下文。
 * @param config - 上限、截断长度与两类句级识别正则。
 */
async function apply(ctx, config) {
  const constraintPatterns = compile(config.constraintPatterns);
  const decisionPatterns = compile(config.decisionPatterns);

  const factsHandle = await ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: factsStateSchema,
    init: () => ({ revision: 0, facts: [], counter: { constraint: 0, decision: 0, deadend: 0 }, seen: {}, deadends: {}, pending: {} }),
    apply: (state, event) => {
      switch (event.type) {
        case "user/message": {
          // 只认人类消息；其它 kind 是本进程其它插件的注入文本。
          if (event.data.source.kind !== "user") return state;
          let next = state;
          for (const sentence of sentencesOf(textOf(event.data.content))) {
            if (!constraintPatterns.some((pattern) => pattern.test(sentence))) continue;
            next = addFact(next, "constraint", sentence, event.seq, "user/message");
          }
          return next;
        }
        case "assistant/message": {
          let next = state;
          for (const sentence of sentencesOf(textOf(event.data.message.content))) {
            if (!decisionPatterns.some((pattern) => pattern.test(sentence))) continue;
            next = addFact(next, "decision", sentence, event.seq, "assistant/message");
          }
          return next;
        }
        case "tool/call":
          return {
            ...state,
            pending: {
              ...state.pending,
              [event.data.callId]: { name: event.data.name, fingerprint: argsFingerprint(event.data.arguments) },
            },
          };
        case "tool/result":
          return foldToolResult(state, event);
        default:
          return state;
      }
    },
  });

  /** session → 上次投影结果（按 revision 增量，pending 变化不重渲染）。 */
  const projections = new WeakMap();

  /** 取（必要时重建）某 session 的两段投影文本；事实集合没变就返回上一份。 */
  function viewFor(session) {
    const state = factsHandle.stateOf(session);
    const cached = projections.get(session);
    if (cached !== undefined && cached.revision === state.revision) return cached;
    const view = {
      revision: state.revision,
      resident: renderResident(state, config.residentLimit),
      catalog: renderCatalog(state, config.catalogNameMaxChars),
    };
    projections.set(session, view);
    return view;
  }

  /** 空 session（无 agent 作用域）不贡献文本。 */
  function viewOfContext(context) {
    const session = context.agent?.session;
    return session === undefined ? undefined : viewFor(session);
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: RESIDENT_NAME,
        order: ctx.systemPrompt.getContextOrder("TEAM_IDENTITY"),
        required: true,
        interpolate: false,
        text: (context) => viewOfContext(context)?.resident ?? "",
      }),
    "fact-register.resident()",
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: CATALOG_NAME,
        order: CATALOG_ORDER,
        interpolate: false,
        text: (context) => viewOfContext(context)?.catalog ?? "",
      }),
    "fact-register.catalog()",
  );

  ctx.tools.register({
    name: "fact_recall",
    description: "Read one registered fact by id (constraint-N / decision-N / deadend-N) and return its full body with the event-stream origin that produced it.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Exact id as shown in the resident facts or the decision catalog, e.g. constraint-3.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render(_args, value) {
        return [{ type: "text", text: value }];
      },
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      return Promise.resolve(renderRecall(factsHandle.stateOf(exec.agent.session), args.id));
    },
  });

  // 唯一的重投影时机：agent/pre-step（P2）。viewFor 按 revision 增量，集合没变就原样返回。
  ctx.on("agent/pre-step", ({ agent }, next) => {
    viewFor(agent.session);
    return next();
  });
}

export { Config, apply, inject, name };
