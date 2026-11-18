# dsh-context-delta
挂点 `systemPrompt.context({name:'harness:delta:runtime', order: getContextOrder('WEB_SURFACE')+10})`（选它：值随 assembly 走，直接复用 `RuntimeContextProjection` 的 `form:'snapshot'` 语义与整段 hash 去重，不新增 ContextForm）。
语义：首轮全量 JSON，其后只发 `{"op":...,"path":...,"value":...}` merge-patch 行；无变化则重发上一轮同一段文本（整段字节不变 → dsh 不产出新消息）；差分超 `maxDeltaBytes`（默认 4096）退化为全量。
上一轮快照存 `sessionProjections` 的 `contextDelta`（stateVersion 1），崩溃由事件流折叠恢复；`cwd` 取 `ctx.get('workingDirectory').get(session)` 否则 `process.cwd()`，`git` 仅经 `ctx.get('subprocess')` 跑 `git rev-parse --abbrev-ref HEAD`（取不到即跳过），`files` 默认不实现仅占位。
