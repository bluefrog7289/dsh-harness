import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';

export declare const name: 'compaction-guarded';
/** 照 `dsh-compaction-basic:801-805` 抄：llm / tokenMeter / sessions，另加 sessionProjections。 */
export declare const inject: ['llm', 'tokenMeter', 'sessions', 'sessionProjections'];

/** 熔断 notice 正文（16 字符，远小于 CONTEXT_SUMMARY_MAX_CHARS=120）。 */
export declare const NOTICE_TEXT: '压缩已熔断，保留原文，请手动处理';
export { NOTICE_TEXT as noticeText };

export interface GuardedCompactionConfig {
  thresholdRatio?: number;
  retainRatio?: number;
  headroomTokens?: number;
  maxOverflowRetries?: number;
  /** 连续 durable 摘要失败达到该数即熔断；默认 3。 */
  maxConsecutiveFailures?: number;
  /** pruner clear_at_least：单次 prune 的节省低于该 token 数就跳过；默认 256。 */
  minSavingsTokens?: number;
  /** 显式覆盖 pruner 字符阈值；缺省由 contextWindow 派生。 */
  thresholdChars?: number;
  /** 字符→token 换算系数；默认 3.5。 */
  charsPerToken?: number;
  auto?: boolean;
}

export declare const Config: ReturnType<typeof z.object>;

/** 熔断投影状态：纯折叠 durable 日志。 */
export interface CompactionGuardedState {
  failures: number;
  circuitOpen: boolean;
  notified: boolean;
}

/** 由 contextWindow 派生的 pruner 字符预算。 */
export interface PruneBudget {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

/**
 * 整行替换 `dsh-compaction-tool-result-pruner` 的 `ctx.toolResultPruner`。
 * 与官方的差异：预算按 contextWindow 派生、clear_at_least 门槛、跳过计数。
 */
export declare class GuardedToolResultPruner extends ToolResultPruner {
  static inject: ['tokenMeter'];
  static Config: ReturnType<typeof z.object>;
  constructor(ctx: Context, config?: GuardedCompactionConfig);
  /** contextWindow 未知时退回官方 8192/4096/1024。 */
  budgetFor(contextWindow?: number): PruneBudget;
  pruneSession(session: Session): { pruned: unknown[]; charsRemoved: number };
}

/**
 * 整行替换 `dsh-compaction-basic` 的 `ctx.compaction`。
 * 继承官方 `BasicCompactionEngine`：摘要器、8 段模板、`compactRegion`、配对校验、
 * overflow 恢复全部复用，仅覆盖 `compactIfNeeded` / `compactPressure` 加熔断闸门。
 */
export declare class GuardedCompactionEngine extends BasicCompactionEngine {
  static inject: ['llm', 'tokenMeter', 'sessions', 'sessionProjections'];
  static Config: ReturnType<typeof z.object>;
  maxConsecutiveFailures: number;
  /** `sessionProjections.register` 的 thenable→handle。 */
  projectionReady: Promise<{ stateOf(session: Session): CompactionGuardedState }>;
  constructor(ctx: Context, config?: GuardedCompactionConfig);
  stateOf(session: Session): Promise<CompactionGuardedState>;
  /** 自注册 `agent/pre-step`：熔断打开时注入一条 notice。 */
  registerGuardedStep(): void;
  compactIfNeeded(
    agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0],
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>;
  compactPressure(
    agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0],
    header: unknown,
    signal: AbortSignal,
    requireBelowThreshold: boolean,
  ): Promise<CompactionResult | null>;
  /** 继承自官方（未重写摘要器）。 */
  compactRegion(start: SessionSeq, end: SessionSeq, agent: Parameters<BasicCompactionEngine['compactRegion']>[2], signal?: AbortSignal): Promise<CompactionResult>;
}

export default GuardedCompactionEngine;
