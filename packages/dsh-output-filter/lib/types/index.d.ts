import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'output-filter';
export declare const inject: ['tools'];
/** 8 个命令族：git / npm / go / cargo / docker / kubectl / pytest / curl。 */
export declare const DEFAULT_FAMILIES: string[];
/** 每族一个纯函数：`(stdout, sub, command) => filtered`。 */
export declare const FAMILY_FILTERS: Record<string, (text: string, sub?: string, command?: unknown) => string>;
/** 拆出命令族与子命令，跳过 sudo / env 前缀与 VAR=VAL 赋值。 */
export declare function splitCommand(command: unknown): { family: string; sub: string | undefined } | undefined;
export declare const Config: ReturnType<typeof z.object>;
/** 挂 `tools/post-execute`：只过滤成功结果，省不足 minSavingRatio 就原样接受。 */
export declare function apply(ctx: Context, config?: { families?: string[]; minSavingRatio?: number }): void;
