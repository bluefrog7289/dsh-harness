#!/usr/bin/env node
// CLI 自测：读一个 JSONL session 文件（每行一个 SessionEvent，或 {seq,type,data,time} 信封），输出 7 指标表。
// 用法：node bin/report.js <session.jsonl> [--buckets 1,2,3,4,5,10,20]
// 依赖契约：与 lib/fold.js 相同的 SessionEventMap；不连 dsh 运行时，故 tokenMeter 缺席 → 两项记 n/a。

import { readFileSync } from "node:fs";
import { foldAll, summarize } from "../lib/fold.js";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const bucketArg = args.includes("--buckets") ? args[args.indexOf("--buckets") + 1] : undefined;
const buckets = bucketArg === undefined ? [1, 2, 3, 4, 5, 10, 20] : bucketArg.split(",").map(Number);

const events = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const metrics = summarize(foldAll(events, buckets));

/** 表里的一行；null 显示 n/a（不伪造）。 */
const cell = (value) => (value === null || value === undefined ? "n/a" : String(value));

const rows = [
  ["unbacked_claims", `${cell(metrics.unbacked_claims.ratio)} (${metrics.unbacked_claims.unbacked}/${metrics.unbacked_claims.claims})`],
  ["reasoning_ratio", "n/a (tokenMeter absent)"],
  ["prefix_cache_hit.overall", "n/a (tokenMeter absent)"],
  ["tool_spec_bytes", cell(metrics.tool_spec_bytes)],
  ["steps_per_task", cell(metrics.steps_per_task)],
  [
    "repeat_tool_calls_after_compaction",
    `${cell(metrics.repeat_tool_calls_after_compaction.ratio)} (${metrics.repeat_tool_calls_after_compaction.repeats}/${metrics.repeat_tool_calls_after_compaction.calls}, compactions=${metrics.repeat_tool_calls_after_compaction.compactions})`,
  ],
  [
    "file_reread_rate_after_compaction",
    `${cell(metrics.file_reread_rate_after_compaction.ratio)} (${metrics.file_reread_rate_after_compaction.rereads}/${metrics.file_reread_rate_after_compaction.reads}, compactions=${metrics.file_reread_rate_after_compaction.compactions})`,
  ],
];

const width = Math.max(...rows.map(([key]) => key.length));
console.log(`${"metric".padEnd(width)}  value`);
for (const [key, value] of rows) console.log(`${key.padEnd(width)}  ${value}`);

console.log(`\nprefix_cache_hit buckets: ${JSON.stringify(metrics.prefix_cache_hit.buckets)}`);
