import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'turn-state-machine';
export declare const inject: ['agents', 'sessionProjections'];
/** FINAL-REPORT §3.29 的 10 个 phase。 */
export declare const PHASES: string[];
/** 写死的迁移白名单：from → 允许的 to。 */
export declare const ALLOWED: Record<string, string[]>;
export declare const Config: ReturnType<typeof z.object>;
/**
 * 注册 `turnState` 投影（key = `turnState`），订阅 agent 事件推迁移，并在
 * `agent/pre-step` 边界校验。`strict: false`（默认）只发 `harness/invalid-transition` 不阻断。
 */
export declare function apply(ctx: Context, config: { strict?: boolean }): void;
