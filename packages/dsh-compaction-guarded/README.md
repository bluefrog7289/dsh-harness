# dsh-compaction-guarded

一行替换两个官方压缩 Service：`ctx.compaction`（继承 `BasicCompactionEngine`，摘要器/8 段模板/`compactRegion`/配对校验全部复用，未复制一行摘要文本）+ `ctx.toolResultPruner`。
新增三件：① 熔断 `maxConsecutiveFailures=3`（连续 durable 摘要失败→`compactIfNeeded`/`compactPressure` 返回 `null` + 注入 `form:"notice"` 消息，仅真实 `user/message` 重置，状态存 `sessionProjections` 键 `compactionGuarded`）；
② 阈值派生 `thresholdChars` 缺省 `floor(contextWindow*2.8)`（= 0.8 阈值比 × 3.5 字符/token 的近似），`headChars`/`tailChars` 取 50%/12.5%（保持官方 8192/4096/1024 比例），窗口未知时退回官方默认；
③ `clear_at_least`：`minSavingsTokens=256`，本次 prune 合计节省不足则整批跳过（原文保留），计 `harness_prune_min_savings_skips`。

`compactRegion` **不可作为独立符号 import**：`@deepseek-ai/dsh-compaction` 只导出抽象声明（`lib/types/index.d.ts:157`），实现是 `BasicCompactionEngine.prototype` 上的方法（`dsh-compaction-basic/lib/index.js:988`，模块仅导出 `BasicCompactionEngine`/`default`）。因此本包用**继承**复用而非 import 函数——降级项为零。契约：`dsh-compaction-basic` 的 `compactIfNeeded`/`compactPressure`/`compactNow`/`summarize`，`dsh-compaction-tool-result-pruner` 的 `ToolResultPruner`/`PRUNE_MARKER`/`DEFAULTS`。
