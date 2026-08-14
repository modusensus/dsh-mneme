# Changelog

All notable changes to dsh-mneme are documented here.

## [Unreleased]

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
