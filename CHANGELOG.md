# Changelog

All notable changes to dsh-mneme are documented here.

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
