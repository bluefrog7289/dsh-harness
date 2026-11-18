import z from "@deepseek-ai/schemastery";

// 挂点：systemPrompt.section()，order = PLAN_POLICY - 1（即 499）。
// 依赖契约：dsh-system-prompt 的 section()/getSectionOrder()，二者均为公开导出。
// 双态：complete:true 的 preset 会丢弃本段，必须改用 compose() 把它拼进 persona.prefix。

const name = "conduct";
const inject = ["systemPrompt"];

/** 八条行为规则，每一条都关闭一条搜索分支，不是风格偏好。 */
const CONDUCT = [
  "同一假设的推演不超过两轮；超过则停止推演，改为调用检查工具取得事实。",
  "缺少事实时立即停止推演并调用检查工具。不得在推演中假设未验证的状态。",
  "推演只用于决定下一步具体操作，不预演完整实现。",
  "多处彼此独立的检查或搜索，在同一轮内并发发起。",
  "Shell 无状态：每条命令自带 cd 与环境设置，不依赖上一条命令的副作用。",
  "正确性一律以工具的实际输出为准。不得凭推演断言结果。",
  "不列举被否决的备选方案。只给结论与依据。",
  "按 YAGNI 七阶梯选择实现路径：不做 → 复用现有 → 标准库 → 平台原生能力 → 一行 → 最小代码。",
].join("\n");

const Config = z.object({
  /** 规则文本；默认是八条内置规则。 */
  text: z.string().default(CONDUCT),
});

/**
 * 把身份与规则拼成单段文本，供 complete:true 的极简 preset 使用。
 * @param prefix - 身份文本（dsh-persona 的 prefix）。
 * @param text - 规则文本，默认为内置八条。
 */
function compose(prefix, text = CONDUCT) {
  return `${prefix}\n\n${text}`;
}

function apply(ctx, config) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "harness:conduct",
        order: ctx.systemPrompt.getSectionOrder("PLAN_POLICY") - 1,
        text: config.text,
      }),
    "conduct.section()",
  );
}

export { Config, CONDUCT, apply, compose, inject, name };
