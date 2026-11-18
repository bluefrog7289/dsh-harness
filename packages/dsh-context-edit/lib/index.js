/**
 * dsh-context-edit —— 会话上下文编辑插件。
 *
 * 挂点：`sessionProjections.register({ key: 'contextEdit' })` + `ctx.tools.register(context_edit)`。
 * 依赖契约：`@deepseek-ai/dsh-session` 的事件写入面 `session.append<T>(type, data)`
 *   （`dsh-session/lib/types/index.d.ts:286`，`SessionEventMap` 可被 `declare module` 合并扩展）
 *   与 `@deepseek-ai/dsh-tools` 的 `defineTool` / `parameters` property-map 规格。
 * 参数：`seq` = 目标事件序号；`content` = 替换文本（空串表示删除该条上下文）。
 * 分支标识：dsh 无公开「当前分支」概念，以 `agent.session.id` 作为分支切分边界写入 `branchId`。
 */
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionSeq } from "@deepseek-ai/dsh-session";

/** Cordis 插件名（loader 诊断用）。 */
const name = "context-edit";

/** 所需 dsh 服务：投影注册表、工具注册表、agent 注册表。 */
const inject = ["sessionProjections", "tools", "agents"];

/** schemastery 配置：单会话最多允许多少次上下文编辑。 */
const Config = z.object({
	maxEditsPerSession: z.number().default(50)
});

/** 投影状态：按 session 累积的编辑记录（纯函数 apply 的输入输出）。 */
const contextEditStateSchema = z$1.object({
	edits: z$1.array(z$1.object({
		targetSeq: z$1.number(),
		replacement: z$1.array(z$1.object({
			type: z$1.literal("text"),
			text: z$1.string()
		})).nullable(),
		branchId: z$1.string()
	}))
});

/**
 * 注册 contextEdit 投影与 context_edit 工具。
 * @param ctx - 插件上下文；投影与工具随 ctx 生命周期释放。
 * @param config - `maxEditsPerSession` 会话编辑上限。
 */
function apply(ctx, config) {
	const maxEditsPerSession = config.maxEditsPerSession ?? 50;

	const ready = ctx.sessionProjections.register({
		key: "contextEdit",
		stateVersion: 1,
		stateSchema: contextEditStateSchema,
		init: () => ({ edits: [] }),
		apply: (state, event) => {
			if (event.type !== "harness/context-edit") return state;
			return {
				...state,
				edits: [...state.edits, {
					targetSeq: event.data.targetSeq,
					replacement: event.data.replacement,
					branchId: event.data.branchId
				}]
			};
		}
	});

	ctx.tools.register(defineTool({
		name: "context_edit",
		description: "编辑本会话上下文中已有的一条事件：把序号 seq 的原文替换为 content（content 为空串表示删除该条）。",
		parameters: {
			seq: {
				type: "number",
				required: true,
				description: "要替换的事件序号（session 事件 seq）。"
			},
			content: {
				type: "string",
				required: true,
				description: "替换后的文本；空串表示删除该条上下文。"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => value.isError === true
				? value.content
				: [{ type: "text", text: value.text }]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			const handle = await ready;
			const state = handle.stateOf(agent.session);
			if (state.edits.length >= maxEditsPerSession) {
				return {
					isError: true,
					content: [{ type: "text", text: `context_edit: 本会话编辑数已达上限 ${maxEditsPerSession}` }]
				};
			}
			const target = agent.session.eventAt(SessionSeq(args.seq));
			const previousLength = typeof target?.data?.content === "string" ? target.data.content.length : 0;
			const replacement = args.content === "" ? null : [{ type: "text", text: args.content }];
			agent.session.append("harness/context-edit", {
				targetSeq: args.seq,
				replacement,
				branchId: agent.session.id
			});
			ctx.get("sessionStats")?.counter("harness_context_edit_count", 1);
			return { text: `被替换的原文长度 ${previousLength} → 新长度 ${args.content.length}` };
		}
	}));
}

export { name, inject, Config, apply };
