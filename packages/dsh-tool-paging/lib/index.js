import z from "@deepseek-ai/schemastery";

// 挂点：ctx.tools.register(def) 注册 tool_activate；ctx.sessionProjections.register({key:'toolPaging'}) 维护激活集合。
// 依赖契约：ToolRegistrationOptions.when 在注册时固定且不可后改（dsh-tools/lib/index.js:433-444）；
//   同一 layer 重名 register 直接抛错（ToolLayer，dsh-tools/lib/index.js:385）。
//   故本包的真实能力边界是：激活状态 + 清单 + isActive(handle, session, ns) 门控函数。
//   把某族纳入分页的工作由**工具所有者自己注册时**完成：
//   ctx.tools.register(def, { when: (c) => isActive(handle, c.agent.session, "mcp__") })。
//   本包不代为注册他人工具，也不假装能整行替换。
// 参数：pagedToolPatterns 族模式（按前缀展开，末尾 * 为前缀匹配）；maxActiveNamespaces 活跃族上限；maxResidentTokens 常驻提示阈值；idleReclaimSteps 空闲回收步数。

const name = "tool-paging";
const inject = ["tools", "agents"];

const ACTIVATE_EVENT = "harness/tool-paging/activate";
const METRIC = "harness_tool_paging_activations";

const Config = z.object({
  pagedToolPatterns: z
    .array(z.string())
    .default(["mcp__*", "browser_*", "task_board_*", "team_*", "squad*", "ui_*", "ssh_*"])
    .description("被分页的工具族模式；末尾 * 表示前缀，族名即去掉 * 后的前缀"),
  maxActiveNamespaces: z.number().default(3).description("单会话同时活跃的族上限"),
  maxResidentTokens: z.number().default(8000).description("常驻 wire token 提示阈值（超限只提示、不截断）"),
  idleReclaimSteps: z.number().default(0).description("空闲多少步后回收族；0 表示不回收"),
});

const State = z.object({
  active: z.array(z.string()).default([]),
  idle: z.dict(z.number()).default({}),
});

/** 'mcp__*' -> 'mcp__'；'squad*' -> 'squad'；无 * 原样返回。 */
function namespaceOfPattern(pattern) {
  return pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
}

/** 用一个模式匹配工具名，命中返回族名。 */
function namespaceOf(toolName, pattern) {
  const prefix = namespaceOfPattern(pattern);
  return pattern.endsWith("*")
    ? toolName.startsWith(prefix) && toolName.length > prefix.length
    : toolName === prefix;
}

/** 该工具名属于哪个已配置族；不属于返回 undefined。 */
function namespaceOfTool(toolName, patterns) {
  for (const pattern of patterns) if (namespaceOf(toolName, pattern)) return namespaceOfPattern(pattern);
  return undefined;
}

function reduce(state, event, config) {
  if (event.type === ACTIVATE_EVENT) {
    const active = state.active.includes(event.namespace) ? state.active : [...state.active, event.namespace];
    const kept =
      active.length > config.maxActiveNamespaces ? active.slice(active.length - config.maxActiveNamespaces) : active;
    return { active: kept, idle: Object.fromEntries(kept.map((ns) => [ns, 0])) };
  }
  if (event.type === "agent/step-end") {
    const active = [];
    const idle = {};
    for (const ns of state.active) {
      const steps = (state.idle[ns] ?? 0) + 1;
      if (config.idleReclaimSteps > 0 && steps >= config.idleReclaimSteps) continue;
      active.push(ns);
      idle[ns] = steps;
    }
    return { active, idle };
  }
  return state;
}

function apply(ctx, config) {
  const projection = ctx.get("sessionProjections").register({
    key: "toolPaging",
    stateVersion: 1,
    stateSchema: State,
    init: () => ({ active: [], idle: {} }),
    apply: (state, event) => reduce(state, event, config),
  });

  const namespaces = config.pagedToolPatterns.map(namespaceOfPattern);
  const pagedDefinitions = () => {
    const view = ctx.tools.view(undefined);
    return [...view.visible.entries()].filter(([n]) => namespaceOfTool(n, config.pagedToolPatterns) !== undefined);
  };
  const toolsOf = (namespace) =>
    pagedDefinitions().filter(([, d]) => namespaceOfTool(d.name, config.pagedToolPatterns) === namespace).map(([n]) => n);
  const residentTokens = () =>
    pagedDefinitions().reduce((sum, [, d]) => sum + Math.ceil(JSON.stringify({ name: d.name, description: d.description, parameters: d.parameters }).length / 4), 0);

  const counter = (delta) => ctx.get("sessionStats")?.counter(METRIC, delta);

  ctx.tools.register({
    name: "tool_activate",
    description: "Activate a paged tool namespace for the current session and list the tools it contains.",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string" } },
      required: ["namespace"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      render: (value) => value.text,
    },
    async execute(input, exec) {
      if (!namespaces.includes(input.namespace)) {
        return {
          isError: true,
          content: [
            { type: "text", text: `unknown namespace "${input.namespace}"; available: ${namespaces.join(", ")}` },
          ],
        };
      }
      exec.agent.session.append(ACTIVATE_EVENT, { namespace: input.namespace });
      counter(1);
      const handle = await projection;
      const state = handle.stateOf(exec.agent.session);
      const tools = toolsOf(input.namespace);
      const lines = [`activated ${input.namespace}: ${tools.length ? tools.join(", ") : "(no tools registered yet)"}`];
      if (state.active.length >= config.maxActiveNamespaces)
        lines.push(`active namespaces at cap ${config.maxActiveNamespaces}: ${state.active.join(", ")}`);
      const tokens = residentTokens();
      if (tokens > config.maxResidentTokens)
        lines.push(
          `note: resident paged payload ~${tokens} tokens > maxResidentTokens=${config.maxResidentTokens} (kept, not truncated)`,
        );
      return { text: lines.join("\n") };
    },
  });
}

/**
 * 门控判定：该 session 是否已激活某族。
 * 用法（在工具所有者的 apply 里）：
 *   const handle = await ctx.sessionProjections.register({...同上 key:'toolPaging'...});  // 同一 key 只能注册一次
 *   ctx.tools.register(def, { when: (c) => isActive(handle, c.agent.session, "mcp__") });
 * 不注册他人的工具（同层同名 register 抛错：dsh-tools/lib/index.js:385）。
 * @param handle - 已 await 的 toolPaging 投影 handle（有 stateOf）。
 * @param session - 目标 session。
 * @param namespace - 族名（如 "mcp__"）。
 */
function isActive(handle, session, namespace) {
  const state = handle?.stateOf(session);
  return state?.active?.includes(namespace) === true;
}

export { ACTIVATE_EVENT, Config, METRIC, State, apply, inject, isActive, name, namespaceOfPattern, namespaceOfTool, reduce };
