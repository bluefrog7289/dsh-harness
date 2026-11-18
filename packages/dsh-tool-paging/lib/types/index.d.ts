import type z from "@deepseek-ai/schemastery";

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "harness/tool-paging/activate": { type: "harness/tool-paging/activate"; namespace: string };
  }
}

export interface ToolPagingConfig {
  pagedToolPatterns: string[];
  maxActiveNamespaces: number;
  maxResidentTokens: number;
  idleReclaimSteps: number;
}

export interface ToolPagingState {
  active: string[];
  idle: Record<string, number>;
}

export declare const name: "tool-paging";
export declare const inject: readonly ["tools", "agents"];
export declare const ACTIVATE_EVENT: "harness/tool-paging/activate";
export declare const METRIC: "harness_tool_paging_activations";
export declare const Config: z<Partial<ToolPagingConfig>, ToolPagingConfig>;
export declare const State: z<Partial<ToolPagingState>, ToolPagingState>;
export declare function namespaceOfPattern(pattern: string): string;
export declare function namespaceOfTool(toolName: string, patterns: string[]): string | undefined;
export declare function reduce(
  state: ToolPagingState,
  event: { type: string; namespace?: string },
  config: ToolPagingConfig,
): ToolPagingState;
/** toolPaging 投影 handle 的最小面（`await ctx.sessionProjections.register(...)` 的返回）。 */
export interface ToolPagingHandle {
  stateOf(session: unknown): ToolPagingState;
}
/**
 * 门控判定：该 session 是否已激活某族。
 * 供工具所有者在自己的注册处使用：`when: (c) => isActive(handle, c.agent.session, "mcp__")`。
 */
export declare function isActive(handle: ToolPagingHandle, session: unknown, namespace: string): boolean;
export declare function apply(ctx: unknown, config: ToolPagingConfig): void;
