# dsh-budget-gate — `PreStepDecision` 实际类型 = `{kind:'reject'}`（**无原因字段**）| `{kind:'enter', messages, startsRequestSeries?}`（`dsh-agent/lib/types/runtime-types.d.ts:117-124`）→ 故拒绝前必须先 `agent.inject()` 一条 `notice`。
挂 **`agent/pre-step`**（`agent/request` 已 deprecated 且不能改 messages）。三级：`turnBudget` 只标注；`sessionBudget` 80% 注入 notice、100% notice 说明「继续 / 换会话」两个选项后 `reject`；`taskBudget` 仅用户显式设置时生效（硬顶）。
默认全关：`sessionBudget: 0`、`taskBudget: 0`、`turnBudget: 0`（0 = 关）。session 累计用 `sessionProjections.register({key:'budgetUsage'})` 折叠日志里 `assistant/message.usage`。
task 累计跨 session（含 fork）→ 插件实例内存 + 可选 `profileDir` 下 JSON（`taskUsageFile`）持久化；fork 的子会话从父会话的 task 计数继承起点。
