# dsh-turn-state-machine — `PreStepDecision` 实际类型 = `{kind:'reject'}`（无原因字段）| `{kind:'enter', messages, startsRequestSeries?}`（`dsh-agent/lib/types/runtime-types.d.ts:117-124`，`dsh-agent-loop/lib/index.js:666,685` 的 `preStep`/waterfall）。
10 个 phase + 写死迁移白名单；非法迁移只 `ctx.emit('harness/invalid-transition')` 不抛错（`strict:true` 才在 `agent/pre-step` 边界 reject，reject 前先 `agent.inject()` 一条 notice）。
`'aborted'` 归 `completing`（正常终止），`error` 才是 `error`；投影 `turnState` 存 phase，按日志折叠可跨 fork/resume 复算。
挂点：`agent/pre-step`（边界校验）+ `agent/status`/`agent/assistant-stream`/`agent/error`/`session/event`（推迁移）+ `sessionProjections.register({key:'turnState'})`。
`awaiting_permission` 在基座无 approval 服务时不进入，占位在白名单中。
