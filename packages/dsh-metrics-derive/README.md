# dsh-metrics-derive

7 个派生指标（FINAL-REPORT §3.45），只读已有事件、不新增采集层；`snapshot(session)` 返回 `unbacked_claims` / `reasoning_ratio` / `prefix_cache_hit` / `tool_spec_bytes` / `steps_per_task` / `repeat_tool_calls_after_compaction` / `file_reread_rate_after_compaction`。
数据源：`assistant/message.usage`（服务端 usage，同 `dsh-token-meter`）、`tool/call`+`tool/result`、`request/header.tools`、`turn/start`、`compaction/end`；`tokenMeter` 仅 `ctx.get('tokenMeter')` 探测、不进 `inject`，取不到则 `reasoning_ratio`/`prefix_cache_hit` = `null`（来源应为 `dsh-token-meter`）。
CLI：`node bin/report.js <session.jsonl> [--buckets 1,2,3,4,5,10,20]`；`apply` 挂 `sessionProjections.register({key:'metrics',stateVersion:1})` + `agent/pre-step`（`await next()` 后读 cell）。
