# dsh-error-brief

挂 `tools/post-execute`，只处理 `isError: true`：错误类型 + 关键行 + 下一步，堆栈截到 `maxStackLines`（默认 10），末尾 `[full output: <sha1 前 8 位>]`；同一指纹第 N 次只回 `[same error #N: <关键行>]`（`repeatFingerprintWindow` 默认 5，session 内有效）。
只改 `content`，不碰 `meta`；处理失败即透传。契约：`dsh-tools` 的 `PostToolDecision`。
