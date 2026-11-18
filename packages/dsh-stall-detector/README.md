# dsh-stall-detector — 进展严格定义为：新的模型请求（`step/start`）或回复（`assistant/message`）、工具调用开始或结束（`tool/call` / `tool/result`）；bash 每秒心跳与流式 token（`agent/assistant-stream`）一律不算。
静默阈值 `minSilenceMs`（默认 900000 = 15 min）起，每次检出**指数翻倍**至 `maxSilenceMs`（默认 14400000 = 4 h）；任一新进展把阈值重置回 `minSilenceMs`。
检出后注入一条 `notice`（**不是 reject**）：`已静止 X 分钟，当前动作 Y`；计数写 `harness_stall_detections`。
`Config.enabled` 默认 **false**（默认关）；检查用 fiber effect 拥有的 `setInterval`（`ctx.effect` 释放），故 `inject` 保持 `['agents']` 不变。
挂点：`session/event`（判进展）+ `agent/created|disposed`（建/拆每 agent 状态）。
