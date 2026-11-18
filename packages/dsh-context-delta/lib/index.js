import z from "@deepseek-ai/schemastery";

// 挂点：systemPrompt.context({ name:'harness:delta:runtime', order: getContextOrder('WEB_SURFACE') + 10 })。
// 依赖契约：dsh-system-prompt 的 context()/getContextOrder()（公开导出）；dsh-agent-loop 的 RuntimeContextProjection.project()
// （lib/index.js:333-348）把全部 context 段拼成一条 form:'snapshot' 的 user 消息，整段文本相同才跳过，否则整条重发。
// 参数：maxDeltaBytes = 差分文本上限（超限退回全量）；sources = 参与快照的 source，files 仅占位不实现。

const name = "context-delta";
const inject = ["systemPrompt", "agents"];

/** 本包在 runtime-context 快照里的段落名（契约 §2.5）。 */
const CONTEXT_NAME = "harness:delta:runtime";
/** 上一轮快照的 projection key：崩溃后由事件流折叠恢复。 */
const PROJECTION_KEY = "contextDelta";
/** git 采样的硬时限；超时即当取不到。 */
const GIT_TIMEOUT_MS = 2000;

const Config = z.object({
  /** 差分文本超过该字节数时退化为全量 JSON 重发（全量时 dsh 的整段 hash 去重仍然生效）。 */
  maxDeltaBytes: z.number().default(4096),
  /** 参与快照的 source；files 默认不实现（文件清单每轮都变且体量大），仅保留占位。 */
  sources: z.array(z.string()).default(["cwd", "git", "files"]),
});

/** sessionProjections 用 zod 的 .parse 校验持久化状态；本包无 zod 依赖，状态是自写的纯 JSON。 */
const stateSchema = { parse: (value) => value };

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const escapePointer = (key) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapePointer = (key) => key.replace(/~1/g, "/").replace(/~0/g, "~");

/** 两个快照之间的 JSON merge-patch 行；previous === null 表示没有上一轮。 */
function operations(previous, current, base = "") {
  const lines = [];
  for (const [key, value] of Object.entries(current)) {
    const path = `${base}/${escapePointer(key)}`;
    const before = previous === null ? undefined : previous[key];
    if (isObject(before) && isObject(value)) {
      lines.push(...operations(before, value, path));
      continue;
    }
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    lines.push({ op: previous !== null && key in previous ? "replace" : "add", path, value });
  }
  for (const key of Object.keys(previous ?? {})) {
    if (!(key in current)) lines.push({ op: "remove", path: `${base}/${escapePointer(key)}` });
  }
  return lines;
}

/** 在一份快照上应用一条 merge-patch 行，返回新对象。 */
function patch(snapshot, line) {
  const segments = line.path.split("/").slice(1).map(unescapePointer);
  const root = { ...snapshot };
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] = { ...cursor[segment] };
    cursor = cursor[segment];
  }
  const last = segments.at(-1);
  if (line.op === "remove") delete cursor[last];
  else cursor[last] = line.value;
  return root;
}

/** 把本包贡献的文本折回快照：单行是整体 JSON，其余每行是可 JSON.parse 的 merge-patch。 */
function fold(previous, text) {
  let snapshot = previous;
  for (const row of text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
    const parsed = JSON.parse(row);
    snapshot = parsed.op === undefined ? parsed : patch(snapshot ?? {}, parsed);
  }
  return snapshot;
}

/** 每个 cwd 最近一次采到的 git 分支；采不到（非仓库 / 无 subprocess）就没有条目。 */
const branches = new Map();

/** 经 ctx.get('subprocess') 跑 git rev-parse --abbrev-ref HEAD；取不到就跳过该 source。 */
async function sampleGit(ctx, cwd, signal) {
  const subprocess = ctx.get("subprocess");
  if (subprocess === undefined) return;
  try {
    const executable = await subprocess.resolveExecutable("git", undefined, signal);
    const child = subprocess.spawn({
      argv: [executable, "rev-parse", "--abbrev-ref", "HEAD"],
      cwd,
      stdio: { stdin: "ignore", stdout: { maxBytes: 4096 }, stderr: { maxBytes: 1024 } },
      graceMs: GIT_TIMEOUT_MS,
      signal: AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]),
    });
    await child.done;
    const branch = child.collected.stdout?.readFrom(0).text.trim();
    if (branch) branches.set(cwd, branch);
    else branches.delete(cwd);
  } catch {
    branches.delete(cwd);
  }
}

/** 当前快照；sources 之外的键不出现，files 默认不实现（只留占位）。 */
function snapshotOf(ctx, session, config) {
  const cwd = (session === undefined ? undefined : ctx.get("workingDirectory")?.get(session)) ?? process.cwd();
  const snapshot = {};
  if (config.sources.includes("cwd")) snapshot.cwd = cwd;
  if (config.sources.includes("git") && branches.has(cwd)) snapshot.git = { branch: branches.get(cwd) };
  return snapshot;
}

/**
 * 首轮全量 JSON；之后只发变化项（JSON merge-patch 行）；无变化返回空串。
 * 空文本段会被 renderContextSections 丢弃，进而改变整段快照的 hash；所以调用点把空串翻译成
 * 「重发上一轮同一段文本」：值不变 → 整段字节相同 → RuntimeContextProjection.project() 直接去重、不产出消息。
 */
function render(snapshot, previous, maxDeltaBytes) {
  if (previous === null) return JSON.stringify(snapshot);
  const text = operations(previous, snapshot).map((line) => JSON.stringify(line)).join("\n");
  return Buffer.byteLength(text, "utf8") > maxDeltaBytes ? JSON.stringify(snapshot) : text;
}

async function apply(ctx, config) {
  /** 上一轮快照 + 上一轮已提交的本段文本；只认已提交的 user 消息，崩溃后由事件流折叠恢复。 */
  const handle = await ctx.get("sessionProjections").register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => ({ snapshot: null, text: "" }),
    apply: (state, event) => {
      if (event.type !== "user/message" || event.data.source.form !== "snapshot") return state;
      const contribution = event.data.source.sections.find((section) => section.name === CONTEXT_NAME);
      if (contribution === undefined || contribution.text === state.text) return state;
      ctx.get("sessionStats")?.counter?.("harness_context_delta_bytes", Buffer.byteLength(contribution.text, "utf8"));
      return { snapshot: fold(state.snapshot, contribution.text), text: contribution.text };
    },
  });

  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: ctx.systemPrompt.getContextOrder("WEB_SURFACE") + 10,
    interpolate: false,
    text: (context) => {
      const session = context.agent?.session;
      // 无会话（非 agent 的纯展示组装）时无上一轮可对齐，本段不贡献。
      if (session === undefined) return "";
      const state = handle.stateOf(session);
      const delta = render(snapshotOf(ctx, session, config), state.snapshot, config.maxDeltaBytes);
      return delta.length > 0 ? delta : state.text;
    },
  });

  ctx.on(
    "agent/pre-step",
    async ({ agent, signal }, next) => {
      // 在 next() 之前采样：step() 的 refreshContext 在 pre-step 之后才解析 provider，本步即可看到新分支。
      await sampleGit(ctx, ctx.get("workingDirectory")?.get(agent.session) ?? process.cwd(), signal);
      return next();
    },
    { prepend: true },
  );
}

export { Config, apply, inject, name };
