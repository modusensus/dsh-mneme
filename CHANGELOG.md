# Changelog

> **完整版本历史见 [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md)**（正式版本正源，0.3.8 → 0.7.8）。以下为仓库早期开发记录（0.1.0–0.2.x，2026-08-13~14，已归档）。

All notable changes to dsh-mneme are documented here.

## [Unreleased]

- **诚实审计修复（v0.2.7，F-03）**
  - autoDream 决策无变更且 summary 为空时，不再误报 ok:true——新增 `noop` 状态（ok:false，baseline 不刷新），避免空跑循环
  - 有变更但 summary 缺失 → `degraded`（ok:true 但如实标记 summary 缺失）
  - parseReceipt 支持 ok/noop/degraded/reconcile/failed
  - 测试 259 → **263**

- **社区贡献 · 嵌入式面板 UI 改进（PR #2，@Liuxin4950）**
  - 记忆面板与设置面板的嵌入模式（settings.section 插槽）不再复用弹窗面板样式（去掉 boxShadow / background / borderRadius / padding），改为全宽平铺渲染，消除 DSH 设置页内多余的悬浮卡片与阴影
  - 弹窗（portal）模式保持原有面板样式不变；新增回归测试锁定 embedded 分支不携带 modal chrome

- **安全审计修复（v0.2.5）**
  - 并发安全：CAS 冲突守卫——过期快照不再覆盖并发写入（防丢更新）
  - 事务化决策应用：merge/archive 原子提交，receipt 反映已提交子步骤，部分提交 = reconcile（绝不虚报 ok）
  - 压测硬断言：lost-update 与多步原子性失败即非零退出（`npm run stress`）
  - 运行时人工编辑三方合并（three-way），不再静默覆盖
  - 新增 `memory_archive` 工具（第 7 个模型工具）+ `memory_list include_archived`，归档可恢复
  - reranker 改为 opt-in：`rerankEnabled=false`、`rerankProvider=none` 默认（裸装不加载 onnxruntime）
  - npm `files` 纳入 scripts/test，tarball 内可直接跑压测
  - 测试 236 → **258**（+22）

- **安全加固（v0.2.4）**：API 鉴权 `apiToken`（写操作与密钥端点要求 Bearer 校验）+ `apiKey` 掩码回传 + timing-safe token 比对

- **审查修复补丁（v0.2.3）**
  - failure 记录增加 `before` JSON 快照（title/content/importance 变更可追溯，不只 content）
  - vector-index `rebuildIndex` guard 改为检查 `embedSingle`（修复 embed/embedSingle 不一致导致的静默跳过）

- **流水线补全（v0.2.2）**
  - reflection 修复：failure 记录检查 title/importance 变化（不只 content）；支持 query 上下文（memory_update 加 `reason` 参数）；update 校验失败不污染 claimed；`failure_memories` 清理（`deleteOldFailures` + 启动自动清理 90 天前）
  - 专项测试补全：`vector-index.test.js`（modelHash 漂移/重建/增量）+ `service-search.test.js`（hybrid/auto/rerank 端到端）
  - api.js `/search` 的 mode 参数文档化
  - 测试 212 → **233**

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
