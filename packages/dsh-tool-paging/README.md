实测：`ToolRegistrationOptions.when` 在注册时写入 `layer.tools.insert(name,{definition,when})`（dsh-tools/lib/index.js:441-444），且同层重名注册直接抛错（:385）——**注册后无法修改/重注册他人的 `when`**。
`when` 确实能拦掉 dispatch：`resolve()` 逐条 `await registration.when(context)`，false 即不入 admitted 集（:547-557），非本步的调用由 `executable()` 返回 undefined → UNKNOWN_TOOL（:530-533）；契约见 contracts.d.ts:109-119「False excludes it from both declarations and dispatch」。
本包实际做法：提供 `sessionProjections` 投影（key `toolPaging`）+ 导出 `isActive(handle,session,ns)`；分页由**工具所有者在自己的 register 处**加 `when: (c)=>isActive(handle,c.agent.session,'mcp__')` 生效；未激活族既不声明也不可 dispatch。
超 `maxResidentTokens` 只提示不截断；`namespace` 不在配置中返回错误并列可用列表。
