# dsh-tool-skill-budgeted — 必须整行替换 `@deepseek-ai/dsh-tool-skill`

替换点：`dsh-tool-skill/lib/index.js:945`（entries 生成）、`:1028`（渲染）、`:1094`（单条截断）；catalog 在该包内部生成，`dsh-skill` 只出 `list/snapshot/get` 发现层、无公开钩子。复刻范围：`catalogDescription`/`renderCatalogEntries`/`renderCatalogMessage`/`renderCatalogUpdate`/`digestCatalogEntries`/`catalogHistory`/`catalogMessage` 与两个 `agent/pre-step` 监听（约 250 行）。
本包差异：`metadataBudget`（默认 20000，catalog 行总字节预算）+ `descriptionMaxChars`（默认 250，单条上限）；超总预算整体降级为「只有名字 + 路径」并追加一条 `notice`。降级判定在 `lib/index.js` 的 `buildCatalog()`，notice 在 catalog 监听末尾抛出。
计数 `harness_skill_catalog_bytes`；发现/加载仍走官方 `dsh-skill` / `dsh-skill-filesystem`。
