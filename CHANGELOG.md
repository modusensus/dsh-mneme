# Changelog

All notable changes to dsh-mneme are documented here.

## [Unreleased]

- **反思更新（v0.2.1）**：`update` 决策 + 失败追踪
  - autoDream 新增 `update` 决策类型：修正单条记忆的过时/错误内容（单 id、必须实际变化、非 summary、24h 保护、每次 ≤2）
  - 审计记录 update 的 `_before` 快照；update 后向量索引同步
  - `failure_memories` 表：记录用户纠正（user_correction）+ 查询/统计接口
  - 配置：`reflectionUpdateEnabled` / `reflectionFailureTracking` / `reflectionUpdateMaxPerRun` / `reflectionUpdateMinAgeHours`

- **Semantic 升级（v0.2.0-semantic）**：完全离线语义记忆引擎
  - 本地 Embedding：`embedProvider: local`（ONNX bge-small-zh-v1.5，transformers.js/onnxruntime）或 `ollama`；原 `openai` 外部 API 保留为默认，向后兼容
  - 向量索引层：`vector_meta` 模型指纹追踪 + 索引统计（`/api/dsh-mneme/semantic`）
  - Rerank 精排：`rerankEnabled`（bge-reranker-base cross-encoder），召回后精排 Top-K，失败自动跳过
  - 混合搜索：`memory_search` 新增 `mode: hybrid`（向量优先 + 关键词补位）；`auto` 保持关键词优先 + 向量补位
  - autoDream 语义增强：K-Means 聚类预分组（k-means++）、`[潜在冲突]` 向量相似度标记、整理后向量索引重建
  - 模型下载：断点续传 + 缓存（transformers.js 内置）；`.npmrc` 跳过 onnxruntime CUDA 下载避免安装失败
  - 文档：`docs/SEMANTIC.md` / `docs/LOCAL_MODEL.md` / `docs/MIGRATION.md` + 基准脚本 `benchmark-embed` / `benchmark-rerank`
- autoDream 裁决审计：每次运行写入 `dream_runs`（输入快照 sha256 digest + 完整输入快照 + LLM 决策清单 + 逐 id 去向 + receipt `dsh-mneme:run:<id>:<status>:<hash>:<count>:<applied>`），可离线回放、定位静默错误
- 幂等决策应用：merge / conflict 重复应用无累积副作用（来源注释不重复追加），防并发/重放下的重复合并
- 三轴线压测 `npm run stress`：长会话检索（Recall@k、陈旧残留率）/ 冲突裁决（可重放仲裁集）/ 多 Agent 并发（丢更新、重复合并、事务/崩溃恢复）

## [0.1.6] - 2026-08-14

- Vector (semantic) search via OpenAI-compatible embeddings endpoint, with automatic fallback to LIKE keyword search on failure
- Web GUI memory panel: browse by type, full-text + semantic search

## [0.1.5] - 2026-08-14

- autoDream consolidation refinements: conflict resolution with source tracking, fail-safe decision validation

## [0.1.4] - 2026-08-14

- User settings: profile + behavior rules injected every turn
- Custom slash commands (register, route to agent)

## [0.1.3] - 2026-08-14

- autoDream background consolidation: dedup / merge / archive / conflict resolution

## [0.1.2] - 2026-08-14

- Session summarization: auto-distill preferences / decisions / lessons at session end
- Web panel improvements

## [0.1.1] - 2026-08-13

- Memory tools: memory_save / memory_search / memory_list / memory_update / memory_delete / memory_forget
- Markdown mirror sync (human-editable, manual edits take priority)

## [0.1.0] - 2026-08-13

- Initial release: cross-session memory for DeepSeek Harness
- SQLite store (node:sqlite, zero native deps) + human-editable Markdown mirror
- Auto-injection of relevant memories at session start
