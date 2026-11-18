import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'harness-source-only';
export declare const inject: ['systemPrompt'];
/** 参数：checkout = 当前 DSH 实现 checkout 的绝对路径。 */
export declare const Config: ReturnType<typeof z.object>;
/**
 * 注册 `harness:source` 的 section 与 context 各一条。
 * order 分别取 `getSectionOrder('HARNESS_SOURCE')` 与 `getContextOrder('HARNESS_SOURCE')`。
 */
export declare function apply(ctx: Context, config: { checkout?: string }): void;
