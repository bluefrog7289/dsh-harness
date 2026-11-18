/**
 * dsh-context-edit 类型声明：导出面 + `harness/context-edit` 会话事件扩展。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

declare module "@deepseek-ai/dsh-session" {
	interface SessionEventMap {
		"harness/context-edit": {
			targetSeq: number;
			replacement: { type: "text"; text: string }[] | null;
			branchId: string;
		};
	}
}

export declare const name: "context-edit";
export declare const inject: readonly ["sessionProjections", "tools", "agents"];
export declare const Config: ReturnType<typeof z.object>;
export declare function apply(ctx: Context, config: { maxEditsPerSession: number }): void;
