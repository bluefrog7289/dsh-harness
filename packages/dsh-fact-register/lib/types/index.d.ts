import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'fact-register';
export declare const inject: ['agents', 'sessionProjections', 'systemPrompt', 'tools'];

/** resident 上限、catalog 截断长度、两类的句级识别正则；全部有默认值。 */
export declare const Config: ReturnType<typeof z.object>;

/**
 * 注册三层事实投影：
 * - `harness:facts:resident`（`getContextOrder('TEAM_IDENTITY')`, `required: true`）：constraint + deadend，超限 deadend 优先；
 * - `harness:facts:catalog`（order 130）：只列 decision 名字；
 * - 工具 `fact_recall({ id })`：返回正文 + event stream 来源（seq + 工具名或消息序号）。
 *
 * 事实只由 `sessionProjections`（key `facts`, stateVersion 1）折叠 event stream 得出，没有任何写入工具（P6）。
 */
export declare function apply(
  ctx: Context,
  config: {
    residentLimit?: number;
    catalogNameMaxChars?: number;
    constraintPatterns?: string[];
    decisionPatterns?: string[];
  },
): Promise<void>;
