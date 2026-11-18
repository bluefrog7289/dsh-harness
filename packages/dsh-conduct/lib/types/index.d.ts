import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'conduct';
export declare const inject: ['systemPrompt'];
/** 八条内置行为规则（换行连接）。 */
export declare const CONDUCT: string;
export declare const Config: ReturnType<typeof z.object>;
/**
 * 把身份与规则拼成单段文本，供 `complete: true` 的极简 preset 使用。
 * 极简 preset 会丢弃除 persona 外的所有 section，故 conduct 必须并入 prefix。
 */
export declare function compose(prefix: string, text?: string): string;
export declare function apply(ctx: Context, config: { text?: string }): void;
