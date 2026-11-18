/**
 * Budgeted replacement for `@deepseek-ai/dsh-tool-skill`: the same durable
 * session skill catalog and model-facing `skill` loader, plus a total metadata
 * budget that degrades the whole catalog to name + path when exceeded.
 *
 * @module @harness/dsh-tool-skill-budgeted
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export declare const name: 'tool-skill-budgeted';
export declare const inject: ['agents', 'tools', 'skills', 'workingDirectory'];

/** Model-facing skill catalog budget configuration. */
export interface Config {
    /** Total byte budget for rendered catalog entries; exceeding it degrades the whole catalog. */
    metadataBudget?: number;
    /** Maximum normalized description length per entry; replaces `catalogDescriptionMaxLength`. */
    descriptionMaxChars?: number;
}

/**
 * Degradation notice source. A separate `kind` is required, not `skill-catalog` +
 * `form: 'notice'`: the released `skill-catalog` validator literal-checks `form: 'catalog'`.
 */
export interface SkillCatalogBudgetSource {
    readonly kind: 'skill-catalog-budget';
    readonly form: 'notice';
    /** One-line account: the pre-degradation byte total and the budget. */
    readonly summary: string;
}

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'skill-catalog-budget': SkillCatalogBudgetSource;
    }
}

/** Validate and default the budgeted catalog configuration. */
export declare const Config: z<Config>;

/**
 * Register the `skill` tool and the budgeted session skill catalog.
 * Discovery and loading stay in `dsh-skill`; only the catalog output layer is owned here.
 */
export declare function apply(ctx: Context, config?: Config): void;
