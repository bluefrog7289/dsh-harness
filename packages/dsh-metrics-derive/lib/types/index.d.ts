import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'metrics-derive';
export declare const inject: ['agents', 'sessionProjections'];
/** 步序分桶边界；默认 [1,2,3,4,5,10,20]。 */
export declare const Config: ReturnType<typeof z.object>;

/** 一个分桶的 prefix cache 命中口径。 */
export interface CacheBucket {
  bucket: string;
  hit: number | null;
  samples: number;
}

/** `snapshot()` 返回的 7 个派生指标。 */
export interface MetricsSnapshot {
  /** 质量项：断言「已完成/已修复/通过」但同一步内无成功 tool/result 的条数与比例。 */
  unbacked_claims: { claims: number; unbacked: number; ratio: number | null };
  /** 成本项：reasoning_tokens / output_tokens；无 usage 样本时为 null。 */
  reasoning_ratio: number | null;
  /** 成本项：cacheRead / (cacheRead+uncachedInput)，按步序分桶。tokenMeter 缺席时整体为 null。 */
  prefix_cache_hit: { overall: number | null; buckets: CacheBucket[] } | null;
  /** 成本项：最近一次 request/header 里工具 schema 的序列化字节数；无 header 时 null。 */
  tool_spec_bytes: number | null;
  /** 最终判据：session 内 turn/start 计数。 */
  steps_per_task: number;
  /** 退化项：压缩结束后 5 步内重复 (toolName+args) 的比率。 */
  repeat_tool_calls_after_compaction: {
    compactions: number;
    calls: number;
    repeats: number;
    ratio: number | null;
  };
  /** 退化项：压缩结束后 5 步内重复 read 同一文件的比率。 */
  file_reread_rate_after_compaction: {
    compactions: number;
    reads: number;
    rereads: number;
    ratio: number | null;
  };
}

/** 读 7 个指标的当前值（挂载后走投影 cell；未挂载时直接折叠事件流）。 */
export declare function snapshot(session: Session): MetricsSnapshot;

export declare function apply(ctx: Context, config: { buckets?: number[] }): void;
