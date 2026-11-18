import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'budget-gate';
export declare const inject: ['agents', 'llm', 'tokenMeter'];
export declare const Config: ReturnType<typeof z.object>;
/**
 * 三级预算门禁，挂 `agent/pre-step`（`agent/request` 已 deprecated）。
 * `turnBudget` 只标注；`sessionBudget` 80% notice、100% 先 `agent.inject()` 一条说明
 * 「继续 / 换会话」两个选项的 notice 再 `{kind:'reject'}`；`taskBudget` 仅显式设置时生效（硬顶，
 * 跨会话含 fork 累计，存插件实例内存 + 可选 `profileDir` 下 JSON）。
 * 默认 `sessionBudget: 0`、`taskBudget: 0`、`turnBudget: 0`（0 = 关）。
 */
export declare function apply(ctx: Context, config: {
  turnBudget?: number;
  sessionBudget?: number;
  taskBudget?: number;
  warnRatio?: number;
  profileDir?: string;
  taskUsageFile?: string;
}): void;
