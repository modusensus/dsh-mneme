<p align="center"><strong>中文 | <a href="docs/SEMANTIC.md">English (Semantic)</a></strong></p>

# dsh-mneme

English | [简体中文](README.md)

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-685%20passed-success)](https://github.com/modusensus/dsh-mneme)

> A cross-session memory plugin for DeepSeek Harness: it lets the Agent remember you, remember your projects, and organize memories automatically. **Mneme** (Μνήμη) — named after Mnemosyne, the Greek goddess of memory who presides over memory and dreams, just as autoDream consolidates memories in the background.

`dsh-mneme` is a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that gives Agents persistent cross-session memory. It draws on Claude's **Dream mechanism** and the **autoDream** implementation ideas from cc-haha / Claude Code — it does not just **store** memories, it also **consolidates them automatically** (deduplication, merging, conflict adjudication, summary generation), so the memory store keeps getting more refined with use.

## ✨ Features

### Memory Storage (SQLite + Markdown Mirror)

- **SQLite primary storage**: `~/.dsh/memory/memory.db`, built-in `node:sqlite`, zero native dependencies
- **Markdown mirror**: `preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md` — human-readable and hand-editable (**manual edits take priority** when merged back into the store)
- **9 memory types**: `preference` / `project` / `decision` / `history` / `summary` / `pattern` + coding-retrospect types `rejected_solution` / `pitfall` / `constraint` (v0.7.13, `codingRetrospect` opt-in; the `user`/`fact` types were dropped in the v0.7.12 rewrite)
- **Mirror sync state machine (v0.3.6+)**: the mirror is strongly consistent with the primary store, with sync debt modeled via `generation` (desired round) / `applied_generation` (applied round)
  - Business write operations **atomically increment** the desired generation **within their own transaction** — even a crash after COMMIT but before rendering recovers on restart from the durable debt, never silently skipped (v0.3.8)
  - `generation` is incremented with atomic SQLite statements — zero loss under multi-process concurrency; a `CHECK` upper bound rejects negative values/overflow
  - Per-type `committed / failed / pending` receipts; the health endpoint distinguishes `ok / degraded / unknown`
  - State write failures are never silent: sync failures are logged and leave debt behind, converging automatically on restart

### Model Tools (7)

| Tool | Function |
|------|------|
| `memory_save` | Save a memory (automatic dedup and merge by title) |
| `memory_search` | Full-text search (Chinese-substring friendly; vector semantic search can be enabled) |
| `memory_list` | Paginated listing by type (`include_archived=true` to view archived items) |
| `memory_update` | Modify an existing memory |
| `memory_delete` | Delete a memory |
| `memory_forget` | Suppress injection (down-weighted rather than deleted; recoverable) |
| `memory_archive` | Archive/restore memories (v0.2.5; archived items are hidden from listing/search/injection/consolidation, `archived=false` restores them) |

### Auto Injection + Session Summary

- **Auto injection**: at the start of a new session, a memory digest is injected (the `summary` first, plus a few high-importance items)
- **Session summary**: at `turn/end`, an LLM distills the preferences/decisions/lessons of the session and stores them automatically (plugin-injected context is filtered out to avoid contamination)

### autoDream Automatic Memory Consolidation 🧠

- **Trigger**: fires asynchronously and automatically once memory count > 10 or total characters > 5000 (never blocks writes)
- **Decision-list consolidation**: the LLM outputs a decision list of `keep` / `merge` / `archive` / `conflict` / `update` decisions, which the server validates and then applies item by item
  - `merge`: merges entries with similar topics, keeping the most information-complete one
  - `archive`: archives outdated/redundant entries (recoverable, never physically deleted)
  - `conflict`: adjudicates contradictory information — the winner is kept, the loser is archived with a provenance note appended
  - `update` (v0.2.1): directly corrects outdated/incorrect content of a single memory (single id / must actually change / not `summary` / 24h protection / ≤2 per run)
- **Failure tracking (v0.2.1)**: when the user corrects a memory, it is written to the `failure_memories` table (old value/new value), accumulating data for future self-evolution
- **Summary generation**: after consolidation, a "memory store overview" (single instance) is generated, injected with priority in the next session
- **Fail-safe**: "individually invalid" decisions (unknown id / invalid action / cross-type merge / out-of-range importance, Issue #26) are skipped and the valid subset applied — the run is marked `degraded` and the memory store is never corrupted; only global errors (coverage shortfall / update overflow) reject the whole list
- **Adjudication audit**: every run writes to the `dream_runs` audit table (input snapshot sha256 digest + full input snapshot + decision list + per-id disposition + receipt), replayable offline; merge / conflict / update are applied idempotently — replays and concurrent duplicate runs have no cumulative side effects; `update` records a `_before` snapshot

#### dreamMaxTokens Tuning Guide

The default `8192` covers ordinary memory stores. When the **memory volume is large** (tens of thousands of characters or more), the decision list and summary may exceed the default budget; scale it up by size:

| Memory store size | Recommended `dreamMaxTokens` |
|-----------|----------------------|
| Ordinary (<10k chars) | `8192` (default) |
| Medium (10k–50k chars) | `65536` |
| Large (>50k chars) | `131072` (cap) |

> With **reasoning models** (e.g. DeepSeek-R1-like), the model may spend the entire budget on reasoning and return an empty body (the log shows `no json array in llm output`). In that case, setting `dreamReasoningEffort` to `low` suppresses reasoning overhead and leaves the budget for the body output; the sleep side has the corresponding `sleepReasoningEffort`. The default `none` omits the field entirely, fully honoring the model's own default — behavior identical to earlier versions.

### Sleep Mode: System-Level Sleep 💤 (v0.4.0, opt-in)

Upgrades autoDream's "passive threshold triggering" into "proactive scheduled maintenance + tiered compression". Once the system has been idle for `sleepIdleMinutes` minutes, deep maintenance runs automatically. **Off by default** (`sleepModeEnabled: false`); once enabled:

- **Interruptible**: implemented with AbortController — user activity aborts the current cycle (`noteWrite` resets the idle timer + the abort signal)
- **Serially safe**: sleep cycles go through the `service.enqueue` serial queue, strictly non-overlapping with autoDream; `minRefTimeMs` prevents memories recalled after the snapshot from being mistakenly demoted
- **Four-phase deep maintenance**:
  1. `conflict_resolution`: store-wide conflict resolution, strictness configurable in three levels (gentle 0.92 / normal 0.85 / aggressive 0.75)
  2. `archival_demotion`: tiered by `last_accessed_at` — not recalled for 30 days → compressed into a summary (original text kept in `_full_content`, losslessly restorable); 90 days → fully archived
  3. `pattern_discovery`: the LLM scans recent memories to distill patterns, producing `type=pattern` memories, with strict evidence validation to prevent fabrication
  4. `relation_completion`: detects orphaned entities and completes implicit relations (co-occurrence `related_to` / project `part_of` / technology `depends_on`)
- **Fail-safe**: each phase has its own try/catch — an LLM failure only skips the corresponding phase; without an LLM route, the pure-rule fallbacks (demotion/relations) still run
- **Audit continuity**: sleep cycles write to `dream_runs` with `run_type='sleep'`, sharing the audit table with autoDream for traceability

> See `docs/SLEEP.md` for configuration; see `docs/MIGRATION.md` for migration notes.

### Web Memory Panel

Official settings panel → "Memory Store Settings" → "Memory" tab: browse by type, full-text search; once vector search is enabled, the "Semantic" toggle becomes available for vector recall.

### User Settings (Profile / Rules) and Custom Commands ⚙️

Official settings panel → "Memory Store Settings" tab:

- **User profile**: a free-text passage describing the user (role, background, preferences), **injected into the system prompt every turn** so the Agent always follows it
- **Rules**: a list of behavioral rules the Agent must obey (e.g. "give the conclusion first"), likewise injected every turn
- **Custom commands**: register slash commands (`/name`); when triggered, the user-defined instruction content is handed to the Agent. Commands persist to SQLite, are automatically registered into the DSH command table at startup, and adding/removing takes effect in real time

> Profile and rules are injected through a separate `[用户设置]` (User Settings) block (higher priority than the memory store), and are injected even when memories are empty.

### Vector Search (Semantic Search) 🔎

An optional capability: connect an OpenAI-compatible embeddings API so search can hit memories that are **literally different but semantically close**.

**Configuration**: official settings → "Memory Store Settings" → scroll to the bottom "Vector Search" section:

| Field | Description |
|------|------|
| `启用向量搜索` (Enable vector search) | Master switch; once on, a "Semantic" toggle appears in the memory panel |
| `API 地址 (Base URL)` | OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`; also supports SiliconFlow, Zhipu, local Ollama, etc. |
| `API Key` | The key for the corresponding service |
| `模型名` (Model name) | Embedding model, e.g. `text-embedding-3-small`, `text-embedding-v3`, `bge-m3`, etc. |

After saving, click "重建索引" (Rebuild Index) to backfill vectors for existing memories in bulk (newly written memories are embedded automatically). Then enter a query in the memory panel and click "语义" (Semantic) to recall semantically related results via vectors; if the vector service is unavailable, it automatically falls back to full-text search.

> ⚠️ The key is stored only in the local `user_settings` table of `~/.dsh/memory/memory.db`; it is never uploaded and never written into the code repository.
> You need an embedding model, not a rerank model: e.g. Alibaba Cloud's `text-embedding-v3` works, while `qwen3-vl-rerank` is a rerank model (it does not go through `/embeddings`).

### Semantic Enhancement 🧠

Since v0.2, a **fully offline semantic memory engine** (local models + reranking + clustering):

- **Local embedding**: three selectable backends — ONNX (`Xenova/bge-small-zh-v1.5`, offline) / Ollama / OpenAI-compatible; failures fall back level by level automatically, with keyword search as the last resort
- **Rerank fine-ranking**: `Xenova/bge-reranker-base` cross-encodes recalled candidates for reranking, improving Top-K accuracy
- **autoDream semantic enhancement**: clusters memory vectors (`clusterMemories`) to automatically discover topically similar / potentially contradictory memories, making consolidation more precise
- **Search pipeline**: hybrid recall (keywords + vectors) → Rerank → Top-K

Configuration only requires setting `embedProvider` in `cordis.patch.yml` (default `openai`, preserving v0.1 behavior; switch it to `local` for offline). Upgrading requires no data migration.

### Entity-Structured Memory (Entity Gene) 🧬

Since v0.3.0, a new **memory gene** layer: extracts **named entities**, **attributes with a timeline**, and **relations between entities** from memories, upgrading search from "literal keywords" to "precise recall by entity/attribute".

- **Three tables**: `entities` / `entity_attrs` (`valid_until` snapshot-style timeline) / `entity_relations`; opening an older database creates the tables automatically — idempotent, zero migration cost
- **Automatic extraction**: once `entityExtractionEnabled=true`, newly written memories fire-and-forget trigger LLM extraction (same-name entity dedup, attributes stored on the timeline, relations appended; failures never block writes)
- **Entity search** (`searchMemories` prefix routing, `entitySearchEnabled` on by default):
  - `entity:阿尔托` → memories precisely associated via attributes (`_score 1.0`) rank ahead of keyword mentions (`_score 0.7`)
  - `attr:国籍=芬兰` → memories exactly matching that attribute value
  - `attr:国籍` → **all** currently valid memories for that attribute key (empty-value contract)
- **autoDream integration**: `update` decisions write a `supersedes` self-reference (the attribute version is superseded); `merge` decisions migrate the loser's attribute ownership to the keeper (void if the keeper already has a current value for the same key)

> 📖 See also: [Entity-Structured Memory Design](docs/ENTITIES.md) · [Semantic Enhancement Architecture](docs/SEMANTIC.md) · [Local Model Deployment Guide](docs/LOCAL_MODEL.md) · [Upgrading from v0.1](docs/MIGRATION.md)

### Memory Quality Filter 🧼 (v0.4.6, on by default)

Before writing to the store, every memory receives a **heuristic quality score** (a pure function — no I/O, no shared state): meta-memory vocabulary (talking about the memory system itself), self-referential type tags, overly short content, high repetition, and near-duplication of recent memories all deduct points (0-100):

- `score ≥ 60`: stored normally
- `30 ≤ score < 60`: `quality_score` is persisted and injection ranking is down-weighted by `importance × quality/100` (degraded)
- `score < 30`: archived and flagged `low_quality` — still recallable via explicit search, but **never auto-injected**

`memoryQualityFilter.enabled` turns the feature off entirely; `archiveThreshold` / `degradeThreshold` / `minContentLength` are tunable.

### LLM Usage Audit 📊 (v0.4.6, on by default)

Every **background LLM call** (autoDream consolidation + summary, autoSummarize compression) is written to the `llm_audit_logs` table: `tokens` / `duration` / `status` / `source` (which trigger produced it). Failed calls are recorded as `status=error` and never block the feature itself; `retentionDays` (default 90) purges expired rows at startup. Two new read-only APIs:

- `GET /api/dsh-mneme/semantic/llm-audit?page=&pageSize=&source=` — paginated query + filter by source
- `GET /api/dsh-mneme/semantic/llm-audit/stats?days=` — budget aggregated by source over the last N days (tokens / calls / failures)

> Read-only endpoints; like list/search/semantic, they remain open even after `apiToken` is set.

## 🆕 Recent Release Highlights

> ⚠️ **Archival note**: pre-v0.7.12 rows below record experimental features later removed in the **v0.7.11** rewrite (Wiki-Link, tag system/directory/tag-boost, user/fact layered types, prefix-id resolution, /stats and /directory endpoints). v0.7.11 and v0.7.12 shipped the same day; historical docs credited v0.7.12, corrected here to v0.7.11. Unrecorded removals in the same rewrite: session lifecycle (`session_disposed_at` soft-hide), provenance birth-session tracking (`session_id`), and the decision-field normalizer (`normalizeDecisions`, superseded by strict prompt schema + `extractJsonArray`). They are version history only — **not current capability**. (The heat model was fully restored in v0.7.20 from v0.7.10, see below.) Current features are what this README's body and the [config table](#-configuration) describe.

| Version | Highlights |
|------|------|
| **v0.7.22** | Restored the v0.6.9 skipInvalid tolerant-validation path (issue #89 regression, lost in the v0.7.11 rewrite): `dreamSkipInvalid` (default true) skips individual invalid decisions, applies the valid subset, and marks the run degraded; `allowCrossTypeMerge` (default false) explicitly relaxes cross-type merging — weak models (e.g. qwen3.8-flash) with jittery schema compliance no longer fail the whole batch and burn LLM calls. Strict mode and the sleep path behave unchanged; global caps/coverage floors still reject the whole run (running over cap = broken model, not minor schema drift). New `dreamMinIntervalMinutes` (0–10080, default 0 = unlimited) minimum autoDream trigger interval — failed/degraded runs also consume the interval (throttling exists to stop back-to-back failing calls); feature_flags whitelist now 34 keys; 696 tests green |
| **v0.7.21** | Fixed autoDream/sleep effort fallback being dead code on the stream path (the catch-based retry from v0.7.16 never fired): dsh-llm rc.1 turns adapter-stage failures (incl. `UNSUPPORTED_REASONING_EFFORT`) into a terminal error finish chunk instead of a throw; `streamText` now captures the finish-chunk failure cause (`describeStreamFailure` normalizes `{code,message}`) + `withEffortFallback` gains a `getStreamError` accessor (retries without effort when rejected) + `runAuditedLlm` supports `spec.streamError` (audit `error_message` carries the real cause; `run.error` stays a stable `"llm failed"`); 688 tests green |
| **v0.7.20** | Heat model restored (issue #87): v0.7.0 self-evolving memory back (`src/heat.js` power-law decay `H=1/(1+λΔt)^α` + per-type half-lives), sleep demotion dual protection (cold time-window + heat<0.05 + importance<5), touchRecalled gating back on `heatEnabled`, entity heat projection (ego node heat → size/opacity), recall_runs recording on by default; **default OFF** (matches v0.7.12 behavior out of the box) + feature_flags whitelist rollback switch + lightMode linkage + sleep demotion audit counts exposed (workbench can show "N demoted") + phase-two frontend (/list heat projection, HeatBadge three-tier badge, self-gated status heat-distribution card, order=heat page-local sort, all self-gated); better-sidebar fix (issue #88: soft integration moved to an inner dynamic sub-plugin, no more startup failure without bs); 685 tests green |
| **v0.7.18** | Ecosystem step one + query convergence: better-sidebar soft integration (inject declaration + optional peer `dsh-better-sidebar` + registerTab reusing the four views, safe skip when absent; narrow-container `@container` adaptation) + `/list?deposited=only` view (receipt_chain ∪ source=dream) + deposited/archived filter chips in the library + status-page dashboard (server totals + view-all jumps) + drawer restore for archived memories; 667 tests green |
| **v0.7.17** | Panel polish: sidebar entry continuously aligned with the host (MutationObserver syncs the New-Session class + `width:100%` + native centering restored, resilient to async skin rewrites) + importance rendered as Lucide star glyphs (`ImportanceStars` filled/hollow component replacing text ★) + toolbar dropdown stacking fix (z-index moved to the container; export/import menu no longer painted under the sticky month header); 664 tests green |
| **v0.7.16** | Fixed autoDream empty-body failures on thinking models (`no json array in llm output`): restored config-first routing (settings "consolidation model" wins, Issue #25) + reasoningEffort auto-retry without effort on rejection + honest `llm_audit` error on parse failure; backfilled API-route tests (/delete, /entities, /external-api) + lib runtime smoke; 662 tests green |
| **v0.7.15** | Desktop adaptation: library panel redesign + 30-key feature-flag UI (features API) + status dashboard + import/export (mirror-isomorphic md golden loop) + token masking by default; 645 tests green |
| **v0.7.14** | Security fix (CWE-200): distillation no longer collects private `reasoning` blocks — only public `text`; 617 tests green |
| **v0.7.13** | Coding-memory distillation `codingRetrospect` (opt-in: full-transcript atomic memories, 3 new types) + 429 governor (global serial queue + exponential backoff); 616 tests green |
| **v0.7.12** | Near-rewrite: inlined panel replaced by a pure HTTP API (127.0.0.1:8790 Bearer auth) + standalone zero-dep CLI `dsh-mneme` + lightMode; memory TYPES narrowed 8→6 (user/fact dropped) |
| **v0.7.11** | Library panel redesign: monthly pagination + infinite scroll + global search + 30s silent refresh + two-step delete + issues #72/#59 fixes; 595 tests green |
| **v0.7.10** | Web panel UX: memory-type color dots + graph canvas pan/zoom + settings re-grouping + sidebar tab-conflict fix + read-only `/entities` endpoint; 815 tests green |
| **v0.7.9** | Issue #65 fix: the snapshotEvents shim only landed in src/, never the npm-loaded lib/ — synced lib + pre-publish src↔lib consistency gate (check-sync.js) + lib smoke tests; 815 tests green |
| **v0.7.8** | DSH 0.1.2-rc.1 compatibility (issues #58 #59): `Session.events` → `snapshotEvents()` shim; autoSummarize & hot-context injection restored; 812 tests green |
| **v0.7.5** | Layered memory types (user/fact) + Overview view + stats endpoint; 790 tests green |
| **v0.7.0** | Self-evolving memory: heat power-law decay + per-type half-life + sleep dual-protection + entity heat projection; 757 tests green |
| **v0.6.0** | Session lifecycle: `session_disposed_at` soft-hide (orthogonal to archived, recoverable) + `memory_delete` description delete; 628 tests green |
| **v0.5.0** | Recall fusion & memory graph: BM25 three-way recall fusion + ego-graph API + zero-dep SVG force-directed graph + hot memory; 593 tests green |
| **v0.4.2** | autoSummarize custom model: the `summarizeProvider`/`summarizeModel` config options let you independently designate a lightweight model (e.g. qwen3.6-plus) for session summaries, saving main-model tokens; 473 tests green |
| **v0.4.0** | System-level Sleep Mode: idle-triggered four-phase deep maintenance (conflict resolution / archival demotion / pattern discovery / relation completion), interruptible, serially safe, fail-safe; tiered compression releases cold memories; 471 tests green |
| **v0.3.9** | Fixed 4 FAILs from the third-party audit: CAS made atomic within the same transaction, mirror degraded-receipt passthrough, per-type physical terminal-state convergence, strict integer validation for generation and stabilized concurrent initialization |
| **v0.3.8** | All 6 runtime-blocking findings from the audit peer re-review fixed: desired generation atomically incremented within the same transaction (the crash window no longer skips silently), sync failures not silent, atomic generation increments (zero loss across processes), per-type committed/failed/pending receipts, explicit unknown on read failure, generation upper-bound/negative CHECK |
| **v0.3.7** | Startup race fix: vector rebuild failing after a restart following manual edits to the md mirror (backfill moved to after init readiness + scheduleEmbed readiness gate) |
| **v0.3.6** | Mirror sync state machine: generation/applied_generation debt modeling, F-NEW-03 mirror health status, persistent dirty + recoverMirror at startup |
| **v0.3.0** | Memory gene: entity/attribute/relation three tables + timeline + entity search + autoDream supersedes |

## 🗺️ Evolution Roadmap

| Version | Status | Theme | Description |
|------|------|------|------|
| v0.2.x | ✅ Done | Semantic enhancement + reflection updates | Local embedding/rerank/clustering, `failure_memories` failure tracking |
| v0.3.0 | ✅ Done | Memory gene | entities/attrs/relations three tables + timeline + entity search |
| v0.3.6–0.3.8 | ✅ Done | Mirror consistency + audit hardening | generation sync state machine, 6 audit-peer runtime-blocking fixes, 450 tests green |
| v0.3.9 | ✅ Done | Audit hardening A/B/D/F | compareAndUpdate same-transaction atomicity, degraded receipts, per-type physical terminal state, integer fail-closed, stable concurrent initialization |
| **v0.4.0** | ✅ Done | System-level Sleep Mode | Idle-triggered four-phase deep maintenance (conflict resolution / archival demotion / pattern discovery / relation completion), tiered compression, interruptible serial fail-safe; 471 tests green |
| **v0.4.2** | ✅ Done | autoSummarize custom model | `summarizeProvider`/`summarizeModel` config options, letting you independently designate a lightweight model (e.g. qwen3.6-plus) for session summaries and save main-model tokens; 473 tests green |
| **v0.4.3** | ✅ Done | autoDream large-memory fix | issue#9 B+A: `dreamMaxTokens` cap raised 32768→131072 + `dreamReasoningEffort`/`sleepReasoningEffort` reasoning toggles (`none` by default, main conversation unaffected); 478 tests green |
| **v0.4.4** | ✅ Done | autoDream decision coverage fix | issue#9 plan C: sliding window `dreamMaxSnapshotSize` (default 200, truncated by updated_at descending) + implicit keep `dreamImplicitKeep` (default true) + coverage floor `dreamMinExplicitCoverage` (default 50%) + fixed decision schema; 487 tests green |
| **v0.4.5** | ✅ Done | Epistemic trust + recall eval | Memory credibility grading `trustEpistemicWeighting` (observation>inferred>subjective: retrieval ranking favors high-credibility memories, injection tags `[verified]`, dream merge/conflict favors the more credible side; opt-in, off by default) + retrieval evaluation `evaluateRetrieval` persisted to `recall_evals` (`evalPersistTestResults` opt-in, off by default; production retrieval always goes through `recall_runs`, unconditionally isolated); 518 tests green |
| **v0.4.6** | ✅ Done | 8 fixes (vector pipeline + injection/quality/audit) | Vector pipeline fixes (embedSingle adaptation / `autoReindexOnBoot` backfill of existing data / `vector_meta` metadata) + injection semantic recall `hybridInject` + same-title append `content_history` + injection length caps (300 per item / 1500 per block) + memory quality filter `memoryQualityFilter` + LLM usage audit `llmAudit` (table + instrumentation + read-only APIs); 553 tests green |
| **v0.4.7** | ✅ Done | Idempotent schema migrations | When the same db is opened concurrently, the `PRAGMA table_info` check and ALTER are non-atomic and may repeat `ADD COLUMN`, failing with a duplicate column name; switched to an `addColumn` helper that swallows the race (try/catch), unifying all 12 migration sites |
| v0.5.0 | ✅ Done | Recall fusion & memory graph | BM25 three-way recall fusion + ego-graph API + zero-dep SVG force-directed graph + hot memory + recall benchmark; 593 tests green |
| v0.6.0 | ✅ Done | Session lifecycle | `session_disposed_at` soft-hide (orthogonal to archived, recoverable) + `memory_delete` description delete + event circuit-breaker; 628 tests green |
| v0.6.x | ✅ Done | Panel enhancements + fixes | 7 further 0.6.x releases: Wiki-Link/tag/directory experiments (later removed in v0.7.12), #25/#26 fixes, allowCrossTypeMerge, ID-exposure hardening, version-sync discipline; up to 735 tests green |
| v0.7.0 | ✅ Done | Self-evolving memory | heat power-law decay + per-type half-life + sleep dual-protection + entity heat projection + recall_runs marking + 90-day cleanup; 757 tests green (heat model later removed in v0.7.12) |
| v0.7.1–0.7.8 | ✅ Done | Issue fixes + graph backfill | tags↔entity_attrs bridge, inline-confirm delete, sidebar trigger toggle, brace escaping, user/fact layered types + stats endpoint (later removed), prefix-id resolution (later removed), sleep batch entity extraction, snapshotEvents() DSH compat; 764→812 tests green |
| v0.7.9 | ✅ Done | lib-sync gate | Issue #65: src-only shim silently killed the shipped lib — synced lib + pre-publish src↔lib consistency check + lib smoke tests; 815 tests green |
| v0.7.10–0.7.12 | ✅ Done | Panel redesign + near-rewrite | UX upgrades (color dots, pan/zoom, pagination, global search), then near-rewrite: inlined panel → pure HTTP API + standalone CLI + lightMode; TYPES narrowed 8→6 |
| v0.7.13–0.7.15 | ✅ Done | Distillation, security, desktop | codingRetrospect + 429 governor; private reasoning blocks dropped (CWE-200); desktop panel redesign + feature flags + status dashboard + import/export |
| v0.7.16 | ✅ Done | autoDream thinking-model fix | config-first routing restored (Issue #25) + reasoningEffort auto-retry + honest audit on parse failure; backfilled API-route & lib smoke tests; 662 tests green |
| v0.7.17 | ✅ Done | Panel polish | Sidebar entry continuously aligned with the host (MutationObserver syncs the New-Session class + `width:100%` + native centering, resilient to async skin rewrites) + Lucide star glyphs (`ImportanceStars`) + toolbar dropdown stacking fix; 664 tests green |
| v0.7.18 | ✅ Done | Ecosystem step one + query convergence | better-sidebar soft integration (inject declaration + optional peer + registerTab reusing the four views, safe skip when absent; narrow-container `@container`) + `/list?deposited=only` view + deposited/archived filter chips + status-page dashboard + drawer restore; 667 tests green |
| v0.7.20 | ✅ Done | Heat restore + phase-two frontend + better-sidebar fix | Heat model fully restored (issue #87, backported from v0.7.10: power-law decay + TYPE_DECAY + sleep heat-combined dual protection + entity heat projection) + acceptance checklist landed (heatEnabled default OFF / feature_flags 31 keys / lightMode linkage / sleep demotion audit / updated_at⊥last_accessed_at contract) + phase-two frontend (/list heat projection, HeatBadge three-tier, order=heat page-local sort) + better-sidebar fix (issue #88: inner dynamic sub-plugin); 685 tests green |
| v0.7.21 | ✅ Done | effort-fallback stream fix | Catch-based effort fallback was dead code on the stream path (dsh-llm rc.1 turns adapter failures into a terminal error finish chunk instead of a throw) → `streamText` captures the finish-chunk cause (`describeStreamFailure`) + `withEffortFallback` gains a `getStreamError` accessor (retries without effort when rejected) + `runAuditedLlm` supports `spec.streamError` (real cause in audit); 688 tests green |
| v0.7.22 | ✅ Done | skipInvalid tolerant-validation restore (issue #89) + autoDream throttle | Restored v0.6.9 skipInvalid dual-track structure (lost in the v0.7.11 rewrite): `dreamSkipInvalid` skips individual invalid decisions + applies the valid subset + marks the run degraded; `allowCrossTypeMerge` explicitly relaxes cross-type merging; weak models (qwen3.8-flash) with jittery schema compliance no longer fail the whole batch. New `dreamMinIntervalMinutes` (0–10080, default 0) minimum trigger interval — failed/degraded runs also consume it. Strict mode / sleep path unchanged; feature_flags whitelist 34 keys; 696 tests green |
| **v0.8.0** | 🚧 Planned (late Sep) | Graph enhancement | Interest-drift visualization + scope isolation (issue #17) + cross-workspace sharing |

> All new capabilities ship as **toggleable features** (enabled/disabled via configuration), conservatively on by default and never breaking existing behavior. The `failure_memories` table and the autoDream decision engine have already paved the way for future reflective growth.

## 📦 Installation

### Prerequisites

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
- Node 24+ (`node:sqlite`)

### Installation Steps

#### Option 1: npm install (recommended)

dsh-mneme is a **bundle** (it declares a `dsh.bundle` manifest); installation activates it automatically, no manual configuration required:

```bash
# 1. 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme

# 2. 重启
dsh web
```

> For custom configuration (thresholds, delays, etc.), override the defaults under `id: dsh-mneme` in `~/.dsh/profiles/web/cordis.patch.yml` (see the configuration table below).

#### Option 2: Install from source

```bash
git clone https://github.com/modusensus/dsh-mneme.git
cd dsh-mneme
dsh plugin --profile web add .
dsh web
```

#### Custom configuration (optional)

It works out of the box with the defaults. To adjust, override in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-mneme
  name: '@modusensus/dsh-mneme'
  config:
    memoryDir: ~/.dsh/memory
    autoInject: true
    autoSummarize: true
    maxInjectedItems: 5
    importanceThreshold: 3
    autoDream: true
    dreamThresholdCount: 10
    dreamThresholdChars: 5000
    dreamDelayMs: 2000
```

## ⚙️ Configuration

| Key | Default | Description |
|----|--------|------|
| `memoryDir` | `~/.dsh/memory` | Memory storage directory (SQLite + Markdown) |
| `autoInject` | `true` | Automatically inject memories at session start |
| `autoSummarize` | `true` | Automatically distill a summary at session end |
| `summarizeProvider` / `summarizeModel` | empty | LLM route override for summaries (empty = use the current session model); a lightweight model is recommended to save main-model tokens |
| `maxInjectedItems` | `5` | Maximum number of memories to inject |
| `importanceThreshold` | `3` | Minimum importance for injection (1-5) |
| `autoDream` | `true` | Automatic memory consolidation switch |
| `dreamThresholdCount` | `10` | Memory count threshold that triggers consolidation |
| `dreamThresholdChars` | `5000` | Total character threshold that triggers consolidation |
| `dreamDelayMs` | `2000` | Asynchronous consolidation delay (debounce) |
| `dreamProvider` / `dreamModel` | empty | Explicit dream LLM route — config wins over the agent's default model (config-first, v0.7.16); left empty, the agent's default model is used |
| `dreamMaxTokens` | `8192` | Maximum tokens per dream LLM call (cap 131072; increase for large memory stores — see the tuning guide below) |
| `dreamReasoningEffort` | `none` | Reasoning-effort passthrough for the dream LLM: `low` / `medium` / `high` / `none` (`none` = omit the field and use the model default; set `low` when a reasoning model exhausts its budget on reasoning and produces an empty body) |
| `apiToken` | empty | Optional API auth token; once set, write operations and key endpoints require `Authorization: Bearer <apiToken>` |
| `embedProvider` | `openai` | Semantic backend: `openai` (default, v0.1-compatible) / `local` (ONNX offline) / `ollama` |
| `localEmbedModel` | `Xenova/bge-small-zh-v1.5` | Local ONNX embedding model |
| `localEmbedDimension` | `512` | Local embedding vector dimension |
| `localEmbedDevice` | `cpu` | Local inference device: `cpu` / `gpu` |
| `localEmbedBatchSize` | `8` | Local embedding batch size (1-64) |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama service address |
| `ollamaModel` | `nomic-embed-text` | Ollama embedding model |
| `embedModelCacheDir` | empty | Model cache directory (empty = user-level `~/.dsh/mneme/models`) |
| `embedModelMirror` | `https://hf-mirror.com` | Mirror source for model downloads |
| `vectorSearchTopK` | `20` | Top-K returned by vector search |
| `vectorSearchThreshold` | `0.65` | Vector search similarity threshold |
| `hybridSearchVectorWeight` | `0.6` | Vector weight in hybrid search |
| `hybridSearchKeywordWeight` | `0.4` | Keyword weight in hybrid search |
| `rerankEnabled` | `false` | Whether to enable rerank fine-ranking (the local onnxruntime model loads only when explicitly enabled) |
| `rerankProvider` | `none` | Rerank backend: `local` / `none` (default `none`) |
| `rerankModel` | `Xenova/bge-reranker-base` | Rerank cross-encoding model |
| `rerankBatchSize` | `8` | Rerank batch size |
| `rerankMaxCandidates` | `30` | Maximum number of rerank candidates |
| `rerankScoreThreshold` | `0.1` | Rerank score threshold (candidates below it are dropped) |
| `reflectionUpdateEnabled` | `true` | Master switch for `update` decisions |
| `reflectionFailureTracking` | `true` | Master switch for failure tracking |
| `reflectionUpdateMaxPerRun` | `2` | Maximum `update` decisions per consolidation run |
| `reflectionUpdateMinAgeHours` | `24` | Protection period for newly created memories (hours) |
| `entityExtractionEnabled` | `false` | Master switch for entity extraction (v0.3.0; always available at the storage layer) |
| `entityExtractionModel` | empty | Dedicated extraction model (empty = use the agent's default model) |
| `entityExtractionMaxEntities` | `10` | Maximum entities per extraction |
| `entityExtractionMaxAttrs` | `20` | Maximum attributes per entity |
| `entitySearchEnabled` | `true` | Switch for `entity:` / `attr:` prefix search |
| `trustEpistemicWeighting` | `false` | Memory credibility weighting (v0.4.5, opt-in, off by default): memories are graded by source as `observation` > `inferred` > `subjective`; when enabled, retrieval ranking favors high-credibility memories, injection tags observation entries `[verified]`, and dream merge/conflict favors the more credible side; when off, `epistemic_status` is only persisted on save and does not participate in behavior |
| `evalPersistTestResults` | `false` | Retrieval evaluation persistence (v0.4.5, opt-in, off by default): when enabled, `evaluateRetrieval` writes precision/recall/mrr snapshots into `recall_evals`; when off it only returns them to the caller without persisting. Production `searchMemories` auditing always goes through `recall_runs`, unconditionally never touching `recall_evals` |
| `autoReindexOnBoot` | `true` | When existing memories lack embeddings and vectors are configured, a delayed, rate-limited background backfill rebuild starts after boot (set to `false` for manual rebuild only) |
| `hybridInject` | `true` | Semantic-recall-first injection (v0.4.6, Bug4): when `injectCandidates` receives a non-empty query, it first recalls candidates via the vector index semantically, then fills in/deduplicates with rule-based filtering; empty query / no vectors falls back to the old logic |
| `heatEnabled` | `false` | Heat-model master switch (v0.7.0 / restored in v0.7.20, **off by default** — v0.7.12+ users expect no-heat behavior): when on, provides heat fields / sleep heat-combined demotion protection / frontend heat projection without changing recall ranking; when off, skips all heat computation and touch, and sleep demotion reverts to pure time-tiering. Also on the feature_flags whitelist (panel-toggleable rollback switch); light-mode preset forces it off |
| `memoryQualityFilter` | `{enabled:true, archiveThreshold:30, degradeThreshold:60, minContentLength:10}` | Memory quality filter (v0.4.6, on by default): heuristic 0-100 scoring before write; meta-memory vocabulary/self-reference/overly short/duplicate/near-duplicate content deduct points; ≥60 stored normally, 30-60 down-weighted (injection ranked by importance×quality/100), <30 archived and flagged `low_quality` (still recallable via explicit search, never auto-injected) |
| `llmAudit` | `{enabled:true, retentionDays:90}` | LLM usage audit (v0.4.6, on by default): every background LLM call (autoDream/autoSummarize) writes `llm_audit_logs` (tokens/duration/status/source); failures are recorded as error without blocking; read-only APIs `/api/dsh-mneme/semantic/llm-audit` + `/llm-audit/stats` |

> 🔐 **API security**: DSH has no built-in authentication and by default listens only on `127.0.0.1`. The plugin API is open by default (so the web panel works out of the box). For protection (e.g. when exposed to a LAN), set `apiToken` in the configuration: write operations (profile/rules/commands) and key endpoints (`vector-config`, `vector-reindex`) require `Authorization: Bearer <token>` (the frontend settings panel accepts the same token), while the read-only `list` / `search` / `semantic` endpoints remain open. The `apiKey` returned by `/api/dsh-mneme/vector-config` is masked (`sk-***…`), while the stored plaintext is kept for actual calls; the frontend sending back an empty or masked value means "do not change the key".

## External API & CLI

Besides DSH's internal port, the plugin can also run a **standalone HTTP external API** (default `http://127.0.0.1:8790`, Bearer token auth) so other plugins, CLI scripts, or desktop tools can read and write memories without depending on DSH's internal port.

### Enabling & Authentication

- Enable the external API in the plugin settings (it listens on `127.0.0.1:8790` by default, local machine only);
- The access token can be found in the plugin settings / the panel under "Settings → External Access";
- Except for `GET /health` (no auth), all routes require an `Authorization: Bearer <token>` header; an invalid token returns `401 {"error":"unauthorized"}`.

Main routes:

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/health` | Health check (no auth), returns `{ok:true}` |
| `GET` | `/status` | Version, memory stats, entity count, uptime |
| `GET` | `/memories?limit&offset&type&minImportance&source&order=chrono` | List memories with pagination |
| `GET` | `/memories/:id` | A single memory |
| `POST` | `/memories` | Create a memory `{type,title,content,importance?,tags?,source?}` |
| `DELETE` | `/memories/:id` | Delete a memory |
| `GET` | `/search?q&mode=keyword\|vector\|auto&topK` | Search (keyword / vector / auto) |

### curl Examples

```bash
# Service status
curl -s -H "Authorization: Bearer $DSH_MNEME_TOKEN" http://127.0.0.1:8790/status

# List the 5 most recent memories
curl -s -H "Authorization: Bearer $DSH_MNEME_TOKEN" \
  "http://127.0.0.1:8790/memories?limit=5"

# Add a decision memory
curl -s -X POST http://127.0.0.1:8790/memories \
  -H "Authorization: Bearer $DSH_MNEME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"decision","title":"Adopt SQLite","content":"Storage layer uses node:sqlite","importance":4,"tags":["storage"]}'
```

### Installing the CLI

The plugin ships a zero-dependency CLI (published with the npm package):

```bash
npm i -g @modusensus/dsh-mneme
dsh-mneme --help
```

On first use, configure the server URL and token (you can also use the `DSH_MNEME_URL` / `DSH_MNEME_TOKEN` environment variables, or override temporarily with `--url` / `--token`):

```bash
dsh-mneme config set http://127.0.0.1:8790 <your-token>
```

### Common CLI Commands

```bash
dsh-mneme status                                     # Service status
dsh-mneme list --type project --limit 10             # List memories
dsh-mneme search "deploy pipeline" --mode vector --topk 5   # Semantic search
dsh-mneme add --type decision --title "Adopt SQLite" \
  --content "Storage layer uses node:sqlite" --importance 4 --tags storage
dsh-mneme get 42                                     # Show one memory
dsh-mneme delete 42                                  # Delete
dsh-mneme config show                                # Show current config (token masked)
```

> All read/write commands support `--json` for raw JSON output; `config path` prints the config file location (`~/.dsh-mneme/cli.json`).

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│  存储层：SQLite (archived/forgotten 状态)         │
│         + Markdown 镜像（人工可编辑，双向同步）    │
├─────────────────────────────────────────────────┤
│  服务层：saveWithDedupe / injectCandidates        │
│         / mergeHumanEdits / onWrite 钩子          │
├─────────────────────────────────────────────────┤
│  模型接口：7 个工具 + 自动注入 + 会话摘要          │
├─────────────────────────────────────────────────┤
│  autoDream：阈值调度 → LLM 决策清单               │
│            → 校验（fail-safe）→ 应用 → 摘要       │
├─────────────────────────────────────────────────┤
│  Web 面板：设置面板内嵌 + 浏览/搜索（含向量）    │
└─────────────────────────────────────────────────┘
```

**Source layout**:

```
src/
├── store.js          # SQLite 存储（CRUD、搜索、归档/遗忘、schema 迁移）
├── mirror.js         # Markdown 镜像（渲染/解析，人工优先）
├── service.js        # 领域逻辑（去重合并、注入筛选、写入钩子）
├── config.js         # schemastery 配置 schema
├── tools.js          # 7 个模型工具（defineTool）
├── inject.js         # systemPrompt.context 动态注入
├── summarize.js      # 会话结束 LLM 摘要
├── dream.js          # autoDream 调度 + runDream（LLM 决策 + 摘要）
├── dream/decisions.js# 决策校验（fail-safe）+ 决策应用
├── entities/extractor.js # 实体抽取器（v0.3.0：LLM JSON 抽取 + 去重 + fail-safe）
├── embedding.js      # OpenAI 兼容 embeddings 客户端 + 向量检索
├── api.js            # HTTP 路由（Web 面板数据通道）
└── index.js          # 插件接线
lib/
├── client.js         # Web 面板（手写 ModuleLoader bundle）
└── *.js              # src 的同步分发产物
test/                 # 662 node:test tests (audit + three-axis stress invariants)
scripts/              # e2e-dsh.js 端到端演示 · stress-dsh.js 三轴线压测 · sync-lib.js 同步
```

## 🧪 Development

```bash
cd dsh-mneme
npm install        # 安装 peer 依赖（以 devDependencies 形式，用于本地测试）
npm test           # 运行 662 个测试
npm run stress     # 三轴线压测：长会话检索 / 冲突仲裁 / 多 Agent 并发（离线 mock LLM）
npm run sync       # 把 src/ 同步到 lib/（发布时由 prepack 钩子自动执行）
```

> The stress test (`npm run stress`) covers three axes: **long-session retrieval** (Recall@k, stale-residual rate), **conflict adjudication** (a replayable adjudication set: audit snapshot hash + receipt + idempotent replay), and **multi-Agent concurrency** (lost updates, duplicate merges, transaction/crash recovery). Every autoDream run writes to the `dream_runs` audit table (input snapshot digest + decision list + per-id disposition + receipt), so silent errors can be pinpointed even when the pass rate is high.

> `lib/` is the synced distribution artifact of `src/` (`npm run sync`); `lib/client.js` is the hand-written web panel source and is unaffected by the sync.

## 📄 Design Documents

> Design documents live in `docs/` at the repository root; the links point there via the `../docs/` relative path (they resolve correctly on GitHub when opened from this directory).

- [Entity-Structured Memory Design](docs/ENTITIES.md)
- [Semantic Enhancement Architecture](docs/SEMANTIC.md)
- [Local Model Deployment Guide](docs/LOCAL_MODEL.md)
- [Upgrading from v0.1](docs/MIGRATION.md)

## 📜 License

MIT
