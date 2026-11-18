import z from "@deepseek-ai/schemastery";

// 挂点：systemPrompt.section() + systemPrompt.context()，同名 harness:source，order 由 getSectionOrder/getContextOrder 取。
// 依赖契约：dsh-system-prompt 的 section()/context()/getSectionOrder()/getContextOrder()，四者均为公开导出。
// 参数：checkout = 当前 DSH 实现 checkout 的绝对路径，默认 process.cwd()；值只进 context，不进 section。

const name = "harness-source-only";
const inject = ["systemPrompt"];

/** 不含路径的固定说明：checkout 与 cwd 是两个值，checkout 只用于改 DSH 自身。 */
const SOURCE_TEXT =
  "运行时上下文给出 DSH 实现 checkout 的路径。checkout 与当前工作目录是两个不同的值，可能不一致：不要据此推断工作目录，需要时用 pwd 查询。该 checkout 只用于查看或修改 DSH 自身，不是任务的工作区。";

const Config = z.object({
  /** 当前 DSH 实现 checkout 的绝对路径。 */
  checkout: z.string().default(process.cwd()),
});

function apply(ctx, config) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "harness:source",
        order: ctx.systemPrompt.getSectionOrder("HARNESS_SOURCE"),
        interpolate: false,
        text: SOURCE_TEXT,
      }),
    "harness-source-only.section()",
  );
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: "harness:source",
        order: ctx.systemPrompt.getContextOrder("HARNESS_SOURCE"),
        interpolate: false,
        text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(config.checkout)}.`,
      }),
    "harness-source-only.context()",
  );
}

export { Config, apply, inject, name };
