import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: 'error-brief';
export declare const inject: ['tools'];
export declare const Config: ReturnType<typeof z.object>;
/** 挂 `tools/post-execute`：只处理 isError:true，只改 content 不碰 meta。 */
export declare function apply(ctx: Context, config?: { maxStackLines?: number; repeatFingerprintWindow?: number }): void;
