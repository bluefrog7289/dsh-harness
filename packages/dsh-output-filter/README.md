# dsh-output-filter

挂 `tools/post-execute`，只过滤 shell/bash 类工具的**成功**结果；8 个命令族（git/npm/go/cargo/docker/kubectl/pytest/curl），不认识就透传。过滤后不比原文短 `minSavingRatio`（默认 0.1）就不改，省下的字节计入 `harness_output_filter_saved_bytes`。
契约：`dsh-tools` 的 `PostToolDecision`（`{kind:'accept', content}`）。失败结果归 `dsh-error-brief`。
