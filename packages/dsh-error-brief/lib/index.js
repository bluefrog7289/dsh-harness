import { createHash } from "node:crypto";
import z from "@deepseek-ai/schemastery";

// 挂点：tools/post-execute waterfall（只改写 isError:true 的结果；成功结果归 dsh-output-filter）。
// 依赖契约：dsh-tools 的 PostToolDecision `{ kind:'accept', content }`；只改 content，不碰 meta。
// 参数：maxStackLines 堆栈保留行数；repeatFingerprintWindow 重复指纹记忆窗口（session 内有效）。

const name = "error-brief";
const inject = ["tools"];

const Config = z.object({
  /** 错误里堆栈最多保留的行数。 */
  maxStackLines: z.number().default(10),
  /** 记住多少个不同错误指纹；超出窗口的最旧指纹被丢弃。 */
  repeatFingerprintWindow: z.number().default(5),
});

/** 关键行识别：错误类型、关键行、下一步提示。 */
const KEY_LINE = /(Error:|error:|cannot|not found|failed)/;

/** `XxxError:` / `Error:` 前缀（含 `FooError:`），用于只取冒号后的正文。 */
const TYPE_PREFIX = /^(?:[A-Za-z_$][\w$]*)?(?:Error|Exception):\s*/;

/** 错误类型 → 一句下一步（无匹配则用默认）。 */
const NEXT_STEP = [
  [/not found|No such file|command not found/i, "verify the path / name exists before retrying."],
  [/permission denied|EACCES|EPERM/i, "check permissions or escalate once; do not retry the same way."],
  [/timed out|timeout|ETIMEDOUT/i, "narrow the command or raise the timeout; do not resend unchanged."],
  [/cannot|unable to|could not/i, "fix the stated precondition instead of retrying the same call."],
  [/failed/i, "read the key line above; change the input, not the retry count."],
];

/** 每个 session 的指纹计数：Map<sessionId, Map<fingerprint, count>>，session 内有效。 */
const FINGERPRINTS = new Map();

/** 识别错误类型：优先结构化 error.name，其次文本里的 XxxError。 */
function errorType(result, text) {
  const structured = result.error?.info?.name ?? result.error?.name;
  if (typeof structured === "string" && structured.length > 0) return structured;
  const named = /\b([A-Za-z_$][\w$]*(?:Error|Exception))\b/.exec(text);
  return named?.[1] ?? "Error";
}

/** sha1 前 8 位（取完整内容前 200 字符）。 */
function digest(text) {
  return createHash("sha1").update(text.slice(0, 200)).digest("hex").slice(0, 8);
}

/** 关键行：含 Error:/error:/cannot/not found/failed 的第一行；否则第一个非空行。 */
function keyLineOf(lines) {
  const found = lines.find((line) => KEY_LINE.test(line));
  return found ?? lines.find((line) => line.trim() !== "") ?? "";
}

/** 按错误文本选一句下一步。 */
function nextStep(text) {
  for (const [pattern, step] of NEXT_STEP) if (pattern.test(text)) return step;
  return "use the key line above to fix the cause; avoid repeating the same call.";
}

/** 记一次指纹并返回该指纹的出现次数（窗口外的最旧指纹被丢弃）。 */
function bump(sessionId, fingerprint, window) {
  let counts = FINGERPRINTS.get(sessionId);
  if (counts === undefined) {
    counts = new Map();
    FINGERPRINTS.set(sessionId, counts);
  }
  const count = (counts.get(fingerprint) ?? 0) + 1;
  counts.delete(fingerprint);
  counts.set(fingerprint, count);
  while (counts.size > Math.max(1, window)) counts.delete(counts.keys().next().value);
  return count;
}

/** 拼装简洁错误：错误类型 + 关键行 + 下一步 + 截断堆栈 + 全文指纹。 */
function brief(text, type, maxStackLines) {
  const lines = text.split("\n");
  const key = keyLineOf(lines).trim();
  const shown = key.replace(TYPE_PREFIX, "");
  const header = `${type}: ${shown}`;
  const keyIndex = lines.findIndex((line) => line.trim() === key);
  const stack = lines
    .slice(keyIndex === -1 ? 0 : keyIndex + 1)
    .filter((line) => line.trim() !== "")
    .slice(0, maxStackLines)
    .map((line) => line.trimEnd());
  const parts = [header, `next: ${nextStep(text)}`];
  for (const line of stack) if (line !== header) parts.push(line);
  parts.push(`[full output: ${digest(text)}]`);
  return parts.join("\n");
}

/** 取全部文本块内容；含非文本块时不改。 */
function textOf(content) {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  if (content.some((block) => block.type !== "text")) return undefined;
  return content.map((block) => block.text).join("\n");
}

/**
 * 挂 post-execute：isError 结果 → 错误简洁化，重复指纹只回 `[same error #N: ...]`。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{maxStackLines?: number, repeatFingerprintWindow?: number}} config
 */
function apply(ctx, config) {
  const maxStackLines = config?.maxStackLines ?? 10;
  const window = config?.repeatFingerprintWindow ?? 5;

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const out = await next();
    try {
      if (out.kind !== "accept" || Object.hasOwn(out, "value")) return out;
      if (result.isError !== true) return out; // 成功结果归 dsh-output-filter
      const content = out.content ?? result.content;
      const text = textOf(content);
      if (text === undefined || text.trim() === "") return out;
      const type = errorType(result, text);
      const key = keyLineOf(text.split("\n")).trim();
      const sessionId = exec.agent?.session?.header?.id ?? "global";
      const seen = bump(sessionId, `${type}\u0000${key}`, window);
      const briefed =
        seen > 1
          ? `[same error #${seen}: ${key.replace(TYPE_PREFIX, "")}]`
          : brief(text, type, maxStackLines);
      if (briefed.length >= text.length) return out; // 不变短就不改
      return { ...out, content: [{ type: "text", text: briefed }] };
    } catch {
      return out; // 简洁化失败即透传，不抛错
    }
  });
}

export { Config, apply, inject, name };
