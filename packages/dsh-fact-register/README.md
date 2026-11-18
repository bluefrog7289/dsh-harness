# dsh-fact-register

三层事实登记：`harness:facts:resident`（constraint + deadend，`getContextOrder('TEAM_IDENTITY')`，required）+ `harness:facts:catalog`（decision 名字，130）+ 工具 `fact_recall({id})`。
事实只由 `sessionProjections` 折叠 event stream 得出（key `facts`）；deadend 唯一来源是 `tools/post-execute` 的 `ToolExecutionResult.isError === true`（`dsh-tools/lib/types/contracts.d.ts:301-303`）。**没有 fact_add。**
