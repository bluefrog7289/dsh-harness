# dsh-conduct

八条行为规则，order = `getSectionOrder('PLAN_POLICY') - 1`（499）。双态：常规 preset 用独立 section；`complete: true` 的极简 preset 用 `compose(prefix, text)` 拼进 `persona.prefix`。
契约：`dsh-system-prompt` 的 `section()` / `getSectionOrder()`。
