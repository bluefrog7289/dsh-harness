import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'context-delta';
export declare const inject: ['systemPrompt', 'agents'];
/**
 * `maxDeltaBytes`：差分文本上限，超过则退化为全量 JSON 重发。
 * `sources`：参与快照的 source；`files` 仅占位、默认不实现。
 */
export declare const Config: ReturnType<typeof z.object>;
/**
 * 注册 `harness:delta:runtime` runtime context：
 * 首轮全量 JSON，之后只发 JSON merge-patch 行，无变化则重发上一轮文本（交给 dsh 的整段 hash 去重）。
 * 上一轮快照经 `sessionProjections` 的 `contextDelta` 单元持久化，崩溃后可恢复。
 */
export declare function apply(ctx: Context, config: { maxDeltaBytes?: number; sources?: string[] }): Promise<void>;
