import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'stall-detector';
export declare const inject: ['agents'];
/** 唯一算作进展的事件 → 人类可读标签。`agent/assistant-stream` 与 bash 心跳不在其中。 */
export declare const PROGRESS: Record<string, string>;
export declare const Config: ReturnType<typeof z.object>;
/**
 * 维护每 agent 的「最后一次真进展」时间戳；静默超过阈值（起 15 min，指数翻倍至 4 h）时
 * `agent.inject()` 一条 `notice`（不是 reject），并写 `harness_stall_detections`。
 * `enabled` 默认 false。
 */
export declare function apply(ctx: Context, config: {
  enabled?: boolean;
  minSilenceMs?: number;
  maxSilenceMs?: number;
  checkIntervalMs?: number;
}): void;
