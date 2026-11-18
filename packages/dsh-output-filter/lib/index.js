import z from "@deepseek-ai/schemastery";

// 挂点：tools/post-execute waterfall（只改写 shell/bash 类工具的【成功】结果；失败归 error-brief）。
// 依赖契约：dsh-tools 的 PostToolDecision `{ kind:'accept', content }`（contracts.d.ts）。
// 参数：families 启用的命令族；minSavingRatio 过滤后至少省下的比例（不到则不改，P5 宁可不改）。

const name = "output-filter";
const inject = ["tools"];

const DEFAULT_FAMILIES = ["git", "npm", "go", "cargo", "docker", "kubectl", "pytest", "curl"];

const Config = z.object({
  /** 启用的命令族；未列出的族一律透传。 */
  families: z.array(z.string()).default(DEFAULT_FAMILIES),
  /** 过滤后至少比原文短的比例；达不到就原样接受。 */
  minSavingRatio: z.number().default(0.1),
});

/** shell 类工具名（这些工具的 args.command 是 shell 命令）。 */
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "pwsh"]);

/**
 * 拆出命令族与子命令：跳过 sudo / env 前缀和 VAR=VAL 赋值。
 * @param {unknown} command - tool args 里的 command。
 * @returns {{family: string, sub: string|undefined}|undefined}
 */
function splitCommand(command) {
  if (typeof command !== "string") return undefined;
  const parts = command.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length) {
    const base = parts[i].split("/").pop();
    if (base === "sudo" || base === "time" || base === "nohup" || base === "command") {
      i += 1;
      continue;
    }
    if (base === "env") {
      i += 1;
      while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
      i += 1;
      continue;
    }
    break;
  }
  const first = parts[i];
  if (first === undefined) return undefined;
  return { family: first.split("/").pop(), sub: parts[i + 1] };
}

/** `git status`：未跟踪文件列表压成计数。 */
function gitStatus(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^Untracked files:/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    let count = 0;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") break;
      if (/^\s*\(use "/.test(line)) continue;
      if (/^\s+\S/.test(line)) count += 1;
    }
    out.push(`Untracked files: (${count} untracked)`);
    i = j - 1;
  }
  return out.join("\n");
}

/** `git log`：只留 `<hash7> <subject>`。 */
function gitLog(text) {
  const out = [];
  let hash;
  let expectSubject = false;
  for (const line of text.split("\n")) {
    const commit = /^commit ([0-9a-f]{7,40})\s*$/.exec(line);
    if (commit !== null) {
      hash = commit[1].slice(0, 7);
      expectSubject = false;
      continue;
    }
    if (hash === undefined) {
      const oneline = /^([0-9a-f]{7,40}) (.+)$/.exec(line);
      if (oneline !== null) out.push(`${oneline[1].slice(0, 7)} ${oneline[2]}`);
      continue;
    }
    if (!expectSubject) {
      if (line.trim() === "") expectSubject = true;
      continue;
    }
    if (line.trim() === "") continue;
    out.push(`${hash} ${line.trim()}`);
    hash = undefined;
    expectSubject = false;
  }
  return out.join("\n");
}

/** `git diff`：保留 hunk 头 + 变更行，上下文行只留紧邻变更的 ±1 行。 */
function gitDiff(text) {
  const lines = text.split("\n");
  const changed = lines.map(
    (line) => /^[+-]/.test(line) && !/^(\+\+\+|---)(\s|$)/.test(line),
  );
  return lines
    .filter((line, i) => {
      if (/^(diff --git |index |--- |\+\+\+ |@@ |new file|deleted file|similarity index|rename |old mode|new mode|Binary files)/.test(line)) return true;
      if (changed[i]) return true;
      if (!line.startsWith(" ")) return false;
      return changed[i - 1] === true || changed[i + 1] === true;
    })
    .join("\n");
}

/** `npm`：去掉 notice / 进度条，`added N packages in` 与 `npm warn` 保留。 */
function npm(text) {
  return text
    .split("\n")
    .filter((line) => {
      if (/^npm notice\b/.test(line)) return false;
      if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⸨⸩█▓▒░]/.test(line)) return false;
      if (/^\s*\d+%/.test(line)) return false;
      if (/^\s*\|?\s*#{4,}/.test(line)) return false;
      return true;
    })
    .join("\n");
}

/** `go build` / `go test`：成功只留最后一行结论，失败全留。 */
function go(text, sub) {
  if (sub !== "build" && sub !== "test") return text;
  if (/^(FAIL|--- FAIL|# )/m.test(text)) return text;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? text : lines[lines.length - 1];
}

/** `cargo`：去掉 Compiling / Downloading 行，warning / error 保留。 */
function cargo(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(Compiling|Downloading|Downloaded|Updating|Locking|Adding|Fresh|Checking|Waiting)\s/.test(line))
    .join("\n");
}

/** 表格类输出（docker ps / kubectl）：只留表头 + 数据行，去掉说明段与空行。 */
function table(text, headerPattern) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => headerPattern.test(line));
  if (start === -1) return text;
  const kept = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^(For more|See |Note:|The |Use |Run |This |Warning:)/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

const DOCKER_HEADER = /^CONTAINER ID\b/;
const KUBECTL_HEADER = /^[A-Z][A-Z0-9]*([ _/-][A-Z0-9]+)*\s{2,}\S/;

/** `pytest`：去掉 `====` 分隔线与空行，保留 FAILED / PASSED 摘要行。 */
function pytest(text) {
  const STATUS = /\b(PASSED|FAILED|ERROR|passed|failed|error|xfailed|xpassed|skipped)\b/;
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return false;
      if (/^[=]{4,}/.test(trimmed) || /^[-]{4,}/.test(trimmed)) return STATUS.test(trimmed);
      return true;
    })
    .join("\n");
}

/** `curl`：仅 `-s`（含 -sS/-fsS）且响应是 JSON 时压成单行；其余透传。 */
function curl(text, _sub, command) {
  const parts = typeof command === "string" ? command.trim().split(/\s+/) : [];
  const silent = parts.some((p) => p === "--silent" || /^-[A-Za-z]*s[A-Za-z]*$/.test(p));
  if (!silent) return text;
  try {
    return JSON.stringify(JSON.parse(text.trim()));
  } catch {
    return text; // 不是 JSON，透传
  }
}

/** `git`：按子命令分派；`git --no-pager log` 这类带全局 flag 的照样认出子命令。 */
function git(text, sub, command) {
  const known = sub === "status" || sub === "log" || sub === "diff" ? sub : undefined;
  const target =
    known ??
    (typeof command === "string" ? command.trim().split(/\s+/).find((token) => token === "status" || token === "log" || token === "diff") : undefined);
  if (target === "status") return gitStatus(text);
  if (target === "log") return gitLog(text);
  if (target === "diff") return gitDiff(text);
  return text;
}

/** 每族一个纯函数：`(stdout, sub, command) => filtered`。 */
const FAMILY_FILTERS = {
  git,
  npm,
  go,
  cargo,
  docker: (text, sub) => (sub === "ps" ? table(text, DOCKER_HEADER) : text),
  kubectl: (text) => table(text, KUBECTL_HEADER),
  pytest,
  curl,
};

/** 取唯一文本块；多块或含非文本块时不改。 */
function singleText(content) {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0];
  return block !== undefined && block.type === "text" ? block.text : undefined;
}

/**
 * 挂 post-execute：成功 shell 结果 → 命令族过滤 → 省不足 minSavingRatio 就原样接受。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{families?: string[], minSavingRatio?: number}} config
 */
function apply(ctx, config) {
  const families = new Set(config?.families ?? DEFAULT_FAMILIES);
  const minSavingRatio = config?.minSavingRatio ?? 0.1;

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const out = await next();
    try {
      if (out.kind !== "accept" || Object.hasOwn(out, "value")) return out;
      if (result.isError === true) return out; // 失败结果归 dsh-error-brief
      if (!SHELL_TOOLS.has(exec.name)) return out;
      const content = out.content ?? result.content;
      const text = singleText(content);
      if (text === undefined || text.length === 0) return out;
      const command = exec.arguments?.command;
      const split = splitCommand(command);
      if (split === undefined || !families.has(split.family)) return out;
      const filtered = FAMILY_FILTERS[split.family](text, split.sub, command);
      if (typeof filtered !== "string" || filtered.length === 0) return out;
      const saved = text.length - filtered.length;
      if (saved < text.length * minSavingRatio) return out; // 省得不够，宁可不改
      const filteredContent = [{ ...content[0], text: filtered }];
      ctx.get("sessionStats")?.counter?.("harness_output_filter_saved_bytes", saved);
      return { ...out, content: filteredContent };
    } catch {
      return out; // 过滤失败即透传，不抛错
    }
  });
}

export { Config, DEFAULT_FAMILIES, FAMILY_FILTERS, apply, inject, name, splitCommand };
