import { createHash } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { escapeText, isModelInvocable, isSkillName, isUserInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";

// 挂点：整行替换 dsh-tool-skill（catalog 在 dsh-tool-skill/lib/index.js:945 生成 entries、:1028 渲染、:1094 单条截断；
// dsh-skill 只出 list/snapshot/get 发现层，没有 catalog 公开面，故只能整行替换、复刻输出层）。
// 依赖契约：ctx.skills.snapshot()/get()、ctx.tools.register()/get()、ctx.workingDirectory.ensure()、agent/pre-step waterfall、
// user/message 的 skill-catalog（form:catalog）与 notice（form:notice）source。
// 参数：metadataBudget = catalog 行总字节预算（默认 20000）；descriptionMaxChars = 单条描述上限（默认 250）。超总预算整体降级为 name+path 并追加一条 notice。

const name = "tool-skill-budgeted";
const inject = ["agents", "tools", "skills", "workingDirectory"];

const Config = z.object({
  /** catalog 条目的总字节预算；超出即整体降级。 */
  metadataBudget: z.number().default(20000),
  /** 单条 description 的字符上限；替代官方的 catalogDescriptionMaxLength。 */
  descriptionMaxChars: z.number().default(250),
});

/** 单条描述规范化并截断（与 dsh-tool-skill:1094 的 catalogDescription 等价）。 */
function catalogDescription(value, maxLength) {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

/** 降级模式下代替 description 的位置：优先磁盘路径，其次 provider 的 resourceBase。 */
function skillLocation(skill) {
  if (skill.path !== undefined) return skill.path;
  const base = skill.resourceBase;
  if (base === undefined) return "";
  if (base.kind === "directory") return base.path;
  if (base.kind === "url") return base.url;
  return base.description;
}

/** 模型可见的 catalog 行（与 dsh-tool-skill:1028 等价）。 */
function renderCatalogEntries(entries) {
  return entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`);
}

/** catalog 行总字节数，即 harness_skill_catalog_bytes 的口径。 */
function catalogBytes(entries) {
  return Buffer.byteLength(renderCatalogEntries(entries).join("\n"), "utf8");
}

/**
 * 生成 catalog 条目：先按 descriptionMaxChars 单条截断；若总字节超 metadataBudget，
 * 整体降级为「只有名字 + 路径」（不带 description）。
 */
function buildCatalog(skills, config) {
  const full = skills.map((skill) => ({
    name: skill.name,
    description: catalogDescription(skill.description, config.descriptionMaxChars),
  }));
  const fullBytes = catalogBytes(full);
  if (fullBytes <= config.metadataBudget) return { entries: full, bytes: fullBytes, fullBytes, degraded: false };
  const lean = skills.map((skill) => ({ name: skill.name, description: skillLocation(skill) }));
  return { entries: lean, bytes: catalogBytes(lean), fullBytes, degraded: true };
}

/** Catalog identity：entries + 完整性，与 dsh-tool-skill:1035 一致。 */
function digestCatalogEntries(entries, incomplete = false) {
  const canonical = entries.map((entry) => JSON.stringify([entry.name, entry.description])).join("\n");
  return createHash("sha256").update(incomplete ? "incomplete\n" : "").update(canonical).digest("hex");
}

function readCatalogEntries(source) {
  const entries = source.entries;
  if (!Array.isArray(entries)) return undefined;
  const readable = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { name, description } = entry;
    if (typeof name !== "string" || name === "" || typeof description !== "string") return undefined;
    readable.push({ name, description });
  }
  return readable;
}

/** 本会话已发布 catalog 的可见 digest 与是否曾经发布过。 */
function catalogHistory(agent) {
  const visible = new Set(agent.session.surface.nodes);
  let published = false;
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    const event = agent.session.eventAt(index);
    if (event === undefined) throw new Error(`skill catalog cannot read seq ${String(index)} below the current Session length`);
    if (event.type !== "user/message" || event.data.source.kind !== "skill-catalog") continue;
    const entries = readCatalogEntries(event.data.source);
    if (entries === undefined) continue;
    const digest = digestCatalogEntries(entries, event.data.source.incomplete === true);
    published = true;
    if (visible.has(event.seq)) return { visibleDigest: digest, published };
  }
  return { published };
}

/** 本步消息批次里的 catalog 消息。 */
function catalogMessage(messages) {
  for (const message of messages) {
    if (message.source.kind !== "skill-catalog") continue;
    const entries = readCatalogEntries(message.source);
    if (entries !== undefined) return { message, entries, incomplete: message.source.incomplete === true };
  }
  return undefined;
}

function renderCatalogMessage(entries, incomplete) {
  return createUserMessage({
    content: [{
      type: "text",
      text: [
        "<system-reminder>",
        entries.length === 0 ? "No skills could be confirmed in this discovery attempt." : "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
        "",
        "<available_skills>",
        ...renderCatalogEntries(entries),
        "</available_skills>",
        "",
        ...incomplete ? [incompleteCatalogNotice(), ""] : [],
        entries.length === 0 ? "Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog." : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
        "</system-reminder>",
      ].join("\n"),
    }],
    source: { kind: "skill-catalog", form: "catalog", entries, ...incomplete ? { incomplete: true } : {} },
  });
}

function renderCatalogUpdate(entries, incomplete) {
  const availability = entries.length === 0
    ? [incomplete ? "No skills could be confirmed in this discovery attempt. Do not use names from earlier skill catalogs." : "No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.", "A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it."]
    : ["Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.", "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill."];
  return createUserMessage({
    content: [{
      type: "text",
      text: [
        "<system-reminder>",
        incomplete ? "Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:" : "The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:",
        "",
        "<available_skills>",
        ...renderCatalogEntries(entries),
        "</available_skills>",
        "",
        ...incomplete ? [incompleteCatalogNotice(), ""] : [],
        ...availability,
        "</system-reminder>",
      ].join("\n"),
    }],
    source: { kind: "skill-catalog", form: "catalog", update: true, entries, ...incomplete ? { incomplete: true } : {} },
  });
}

function incompleteCatalogNotice() {
  return "Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.";
}

/** 超总预算时紧随 catalog 发出的一条 notice，说明已降级为 name+path。 */
function degradationNotice(bytes, budget) {
  const text = `The skill catalog would be ${String(bytes)} bytes, over the ${String(budget)}-byte metadata budget. Descriptions were dropped; the catalog lists skill names and paths only.`;
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "skill-catalog-budget", form: "notice", summary: text },
  });
}

/** 用户消息里空白分隔的 `/name` 手势（与 dsh-tool-skill:1108 一致）。 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

function invokedSkillNames(messages) {
  const names = [];
  for (const message of messages) {
    if (message.source.kind !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const gesture = match[2];
        if (gesture !== undefined && !names.includes(gesture)) names.push(gesture);
      }
    }
  }
  return names;
}

function apply(ctx, config = {}) {
  const metadataBudget = config.metadataBudget ?? 20000;
  const descriptionMaxChars = config.descriptionMaxChars ?? 250;

  const skillTool = defineTool({
    name: "skill",
    description: "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
    parameters: {
      name: {
        type: "string",
        required: true,
        description: "The exact skill name from the available skills list.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", required: true },
          provider: { type: "string", required: true },
          resourceBase: { oneOf: [
            { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true, const: "directory" }, path: { type: "string", required: true } } },
            { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true, const: "url" }, url: { type: "string", required: true } } },
            { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true, const: "opaque" }, description: { type: "string", required: true } } },
          ] },
          content: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`);
      const lookup = {
        cwd: exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal),
        signal: exec.signal,
        scope: exec.agent,
      };
      const summary = (await ctx.skills.list(lookup)).find((skill) => skill.name === args.name);
      if (!summary) throw new Error(`skill "${args.name}" is unknown or no longer available`);
      if (!isModelInvocable(summary)) throw new Error(`skill "${args.name}" is not available for model invocation`);
      const skill = await ctx.skills.get(args.name, lookup);
      if (!skill) throw new Error(`skill "${args.name}" is unknown or no longer available`);
      if (!isModelInvocable(skill)) throw new Error(`skill "${args.name}" is not available for model invocation`);
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? { resourceBase: { ...skill.resourceBase } } : {},
        content: skill.content,
      };
    },
    presentCall(args) {
      return { card: "generic", title: `Load skill ${args.name}`, kind: "read", rawInput: args.name };
    },
  });
  ctx.tools.register(skillTool);

  // 用户显式 `/name` 调用：把 skill 正文作为 instructions 注入本步。
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const names = invokedSkillNames(messages);
    if (names.length === 0) return decision;
    signal.throwIfAborted();
    const lookup = { cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent };
    const injections = [];
    for (const skillName of names) {
      const skill = await ctx.skills.get(skillName, lookup);
      signal.throwIfAborted();
      if (skill === undefined || !isUserInvocable(skill)) continue;
      injections.push(createUserMessage({
        content: [{ type: "text", text: renderSkillContent(skill) }],
        source: { kind: "skill-invocation", name: skillName, form: "instructions" },
      }));
    }
    if (injections.length === 0) return decision;
    return { ...decision, messages: [...decision.messages, ...injections] };
  });

  // catalog 输出层：唯一与官方不同的部分 —— 加总预算与降级。
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal.throwIfAborted();
    const snapshot = ctx.tools.get(skillTool.name, agent) === skillTool
      ? await ctx.skills.snapshot({ cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent })
      : { skills: [], complete: true };
    signal.throwIfAborted();
    const skills = snapshot.skills.filter(isModelInvocable);
    const catalog = buildCatalog(skills, { metadataBudget, descriptionMaxChars });
    const entries = catalog.entries;
    const incomplete = !snapshot.complete;
    const digest = digestCatalogEntries(entries, incomplete);
    const history = catalogHistory(agent);
    const existing = catalogMessage(decision.messages);
    if (history.visibleDigest === digest) {
      return existing === undefined ? decision : {
        ...decision,
        messages: decision.messages.filter((message) => message.id !== existing.message.id),
      };
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries, existing.incomplete) === digest) return decision;
    if (!history.published && skills.length === 0 && !incomplete) {
      return existing === undefined ? decision : {
        ...decision,
        messages: decision.messages.filter((message) => message.id !== existing.message.id),
      };
    }
    const rendered = history.published ? renderCatalogUpdate(entries, incomplete) : renderCatalogMessage(entries, incomplete);
    const messages = existing === undefined
      ? [...decision.messages, rendered]
      : decision.messages.map((message) => message.id === existing.message.id ? rendered : message);
    ctx.get("sessionStats")?.counter("harness_skill_catalog_bytes", catalog.bytes);
    if (!catalog.degraded) return { ...decision, messages };
    return { ...decision, messages: [...messages, degradationNotice(catalog.fullBytes, metadataBudget)] };
  });
}

export { Config, apply, inject, name };
