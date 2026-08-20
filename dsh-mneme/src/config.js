import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  // Session lifecycle (v0.6.0): when enabled, deleting/disposing a session also
  // archives every memory that was born in it (treating the session as a save
  // point — entries stay recoverable via memory_archive/restoreBySession).
  // Default OFF: legacy behavior, a disposed session leaves its memories active.
  sessionLifecycleEnabled: z.boolean().default(false),
  // Optional model override for summarization. When both are non-empty, they
  // take priority over the session's current model. Empty = use the session's
  // active provider/model (same as before).
  summarizeProvider: z.string().default(""),
  summarizeModel: z.string().default(""),
  maxInjectedItems: z.natural().min(1).max(20).default(5),
  importanceThreshold: z.natural().min(1).max(5).default(3),
  autoDream: z.boolean().default(true),
  dreamThresholdCount: z.natural().min(1).max(1000).default(10),
  dreamThresholdChars: z.natural().min(100).max(100000).default(5000),
  dreamDelayMs: z.natural().min(0).max(60000).default(2000),
  dreamProvider: z.string(),
  dreamModel: z.string(),
  dreamMaxTokens: z.natural().min(256).max(131072).default(8192),
  // Pass-through reasoning effort for dream's LLM calls. 'none' (default)
  // omits the field so the provider's own default applies; 'off' explicitly
  // disables thinking — REQUIRED for thinking-type models (deepseek-v4-flash
  // etc.) that would otherwise drain the whole token budget into reasoning and
  // return an empty body ("no json array in llm output"); low/medium/high are
  // forwarded verbatim to cap reasoning spend.
  dreamReasoningEffort: z.union([
    z.const("off"),
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none"),
  // 滑动窗口上限（v0.4.4）：autoDream 每次只对最近 dreamMaxSnapshotSize 条
  // 记忆做 consolidation。大记忆量下全量快照会把 LLM 输入撑爆（636 记忆 →
  // 677 "missing" errors、applied=0），窗口外的旧记忆不进 snapshot。
  dreamMaxSnapshotSize: z.natural().min(1).max(1000).default(200),
  // 隐式 keep（v0.4.4）：LLM 未提及的 snapshot 记忆自动补 {action:"keep"}，
  // 避免"未覆盖即全拒"白白浪费整轮 run。设为 false 时保留旧的严格校验
  // （未覆盖即拒绝整单）。
  dreamImplicitKeep: z.boolean().default(true),
  // 显式决策覆盖率下限（v0.4.4 fix）：dreamImplicitKeep 开启时，LLM 输出被
  // 截断只显式 claim 少量 snapshot 记忆（claimed.size / snapshot.size < 该阈值）
  // → 整单拒绝，防止残缺输出被隐式 keep 洗白成 ok 后再被真实 apply。0-1，
  // 默认 0.5（至少显式覆盖一半 snapshot）。
  dreamMinExplicitCoverage: z.number().min(0).max(1).default(0.5),
  // Rule version for dream adjudication: when this bumps, older dream_runs
  // degrade to historical evidence (their receipts no longer drive live
  // decisions). Default 0 = no versioning in use yet.
  policyEpoch: z.natural().min(0).max(1000000).default(0),

  // --- API protection ------------------------------------------------------
  // Optional shared token for the plugin's HTTP API. Empty (default) keeps
  // the API open (DSH binds to 127.0.0.1 and has no built-in auth); when set,
  // sensitive endpoints (vector-config, vector-reindex, and all write ops on
  // profile/rules/commands) require `Authorization: Bearer <apiToken>` (or
  // `X-DSH-Mneme-Token`). Read-only list/search/semantic stay open so the
  // Web panel keeps working without the token.
  apiToken: z.string(),

  // --- semantic: local embedding provider (v0.2) --------------------------
  // "openai" keeps the legacy external-API path (settings vector config);
  // "local" runs an ONNX model in-process; "ollama" calls a local Ollama.
  embedProvider: z.union([z.const("openai"), z.const("local"), z.const("ollama")]).default("openai"),

  // Local ONNX embedder (transformers.js / onnxruntime).
  localEmbedModel: z.string().default("Xenova/bge-small-zh-v1.5"),
  localEmbedDimension: z.natural().default(512),
  localEmbedDevice: z.union([z.const("cpu"), z.const("gpu")]).default("cpu"),
  localEmbedBatchSize: z.natural().min(1).max(64).default(8),

  // Ollama embedder.
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  ollamaModel: z.string().default("nomic-embed-text"),

  // Model download/cache. When empty (default), models are cached under the
  // user-level path ~/.dsh/mneme/models (resolved in local-embedder/reranker);
  // a non-empty value is used verbatim.
  embedModelCacheDir: z.string().default(""),
  embedModelMirror: z.string().default("https://hf-mirror.com"),

  // Vector search tuning.
  vectorSearchTopK: z.natural().min(1).max(100).default(20),
  vectorSearchThreshold: z.number().min(0).max(1).default(0.65),
  hybridSearchVectorWeight: z.number().min(0).max(1).default(0.6),
  hybridSearchKeywordWeight: z.number().min(0).max(1).default(0.4),
  // Lazy auto-backfill of missing embeddings on boot (Bug2): when the vector
  // API is configured and rows still lack an embedding, the index is rebuilt
  // in the background after a short delay, rate-limited in batches. On by
  // default; set false to keep the backfill manual only.
  autoReindexOnBoot: z.boolean().default(true),
  // Semantic-first injection (Bug4): when enabled, injectCandidates with a
  // non-empty query recalls via the vector index first and falls back to the
  // rule-based pick to fill/dedupe. Empty query / no vector → legacy behavior.
  hybridInject: z.boolean().default(true),

  // --- recall optimization (v0.5.0) ----------------------------------------
  // BM25 third recall path beside vector + LIKE keyword (1.1): per-token IDF
  // scoring recalls rows whose query terms are scattered — identifiers, code
  // fragments, mixed CJK/ASCII — where substring LIKE cannot match.
  bm25SearchEnabled: z.boolean().default(true),
  // Query-aware vector cutoff (1.2) replacing the fixed 0.65: entity:/attr:
  // prefixes loosen to 0.5, short queries tighten to 0.7, long queries loosen
  // to 0.6, and a decisive top-1/top-5 score gap loosens to 0.5 so the tail
  // still reaches the reranker. Off = legacy fixed threshold behavior.
  adaptiveThresholdEnabled: z.boolean().default(true),
  // Session-scoped hot memory (1.3): the latest N dialogue rounds rendered
  // ahead of the long-term recall block — short-term context that never
  // enters the memory store.
  hotMemoryEnabled: z.boolean().default(true),
  hotMemoryRounds: z.natural().min(1).max(50).default(5),
  hotMemoryMaxTokens: z.natural().min(200).max(32000).default(2000),
  // Topic-ranked injection (2.2): when a query vector is available the whole
  // injection candidate list is re-ordered by similarity to the current
  // query instead of keeping the rule-based order.
  selectiveInjectEnabled: z.boolean().default(true),
  // Search-time semantic dedup (2.3): greedy pass over the merged candidate
  // list dropping rows whose embedding cosine-similarity to an already-kept
  // row exceeds the threshold — duplicates are filtered at recall time
  // instead of waiting for a dream consolidation. Opt-in aggressive mode:
  // small embedding models can collapse legitimately distinct rows, so the
  // default keeps every recalled row.
  searchSemanticDedup: z.boolean().default(false),
  searchSemanticDedupThreshold: z.number().min(0.5).max(1).default(0.95),

  // --- semantic: rerank layer (v0.2) --------------------------------------
  // Opt-in by default (item ⑥): the local cross-encoder pulls in onnxruntime
  // (transformers.js) at init, so a bare install must not load it. Only an
  // explicit rerankEnabled=true + rerankProvider="local" constructs LocalReranker.
  rerankEnabled: z.boolean().default(false),
  rerankProvider: z.union([z.const("local"), z.const("none")]).default("none"),
  rerankModel: z.string().default("Xenova/bge-reranker-base"),
  rerankBatchSize: z.natural().min(1).max(64).default(8),
  rerankMaxCandidates: z.natural().min(5).max(100).default(30),
  rerankScoreThreshold: z.number().min(0).max(1).default(0.1),

  // --- reflection: update decision + failure tracking (v0.2.1) ------------
  reflectionUpdateEnabled: z.boolean().default(true),
  reflectionFailureTracking: z.boolean().default(true),
  reflectionUpdateMaxPerRun: z.natural().min(0).max(5).default(2),
  reflectionUpdateMinAgeHours: z.natural().min(0).max(168).default(24),

  // --- conflict freeze: manual review for conflicting memories (v0.2.1) ---
  // Opt-in by default: when true, conflicting memories are not auto-merged
  // and are marked as pending manual review instead.
  conflictFreezeEnabled: z.boolean().default(false),
  // Maximum number of frozen conflicts to keep pending for manual review.
  conflictFreezeMaxPending: z.natural().min(1).max(1000).default(100),

  // --- entity gene (v0.3.0) -----------------------------------------------
  // Opt-in: when false (default) nothing in the pipeline extracts entities.
  // The storage layer (entities/entity_attrs/entity_relations tables + CRUD)
  // is always available regardless of this flag.
  entityExtractionEnabled: z.boolean().default(false),
  // Optional model override for entity extraction; empty = use the caller's
  // default provider/model.
  entityExtractionModel: z.string().default(""),
  // Cap on entities per extraction pass and attributes per entity.
  entityExtractionMaxEntities: z.natural().min(1).max(20).default(10),
  entityExtractionMaxAttrs: z.natural().min(1).max(50).default(20),
  // Prefix/semantic search over entity names (used by recall).
  entitySearchEnabled: z.boolean().default(true),

  // --- wiki-link: explicit cross-memory [[links]] (v0.6.1) ----------------
  // Opt-in, off by default. When enabled, saveWithDedupe/update fire-and-forget
  // a wiki-link resolution pass: [[target]] / [[显示|target]] markers in a
  // memory's content become links_to relations in entity_relations (idempotent,
  // deduped by the unique relation index). The storage layer + read APIs
  // (getBacklinks/getForwardLinks/resolveWikiLink) are always available
  // regardless of this flag.
  wikiLinkEnabled: z.boolean().default(false),

  // --- tag system (v0.6.2) ---------------------------------------------------
  // Opt-in: when autoTagEnabled is true, a light LLM pass runs after each
  // autoDream consolidation and extracts 1-3 tags per retained memory
  // (autoTagMaxPerRun bounds how many memories are tagged per run). The tag
  // storage layer (store.setMemoryTags/getMemoryTags + tag: search + mirror
  // `#tag` line) is always available regardless of this flag.
  autoTagEnabled: z.boolean().default(false),
  autoTagMaxPerRun: z.natural().min(1).max(100).default(10),
  // Manual tagging (service.setMemoryTags / memory tools) is on by default;
  // set false to disable the manual write path too.
  manualTagEnabled: z.boolean().default(true),

  // --- sleep mode: idle-triggered deep maintenance (v0.4.0) ---------------
  // Opt-in, off by default. Unlike autoDream (threshold-triggered, lightweight)
  // sleep fires when the store has been quiet for sleepIdleMinutes and deep-
  // maintains the whole library: conflict resolution, archival demotion,
  // pattern discovery and entity relation completion. Abortable on user
  // activity, audited into dream_runs (run_type='sleep'), and serialized with
  // autoDream so the two never overlap.
  sleepModeEnabled: z.boolean().default(false),
  // Quiet window before a cycle fires (minutes).
  sleepIdleMinutes: z.natural().min(1).max(60).default(5),
  // Minimum gap between two sleep runs (hours) — a second idle window within
  // this interval does not retrigger.
  sleepMinIntervalHours: z.natural().min(1).max(168).default(8),
  // Conflict adjudication strictness:
  //   gentle    only high-confidence conflicts (threshold 0.92) are resolved
  //   normal    standard dream-level (threshold 0.85)
  //   aggressive low-confidence pairs are also adjudicated (threshold 0.75)
  sleepConflictStrictness: z.union([
    z.const("gentle"),
    z.const("normal"),
    z.const("aggressive")
  ]).default("normal"),
  // Archival demotion tiering (days since last access):
  //   >= sleepArchiveDays  → shrink to summary, full body kept in _full_content
  //   >= sleepCompressDays → archived outright (entity relations preserved)
  sleepArchiveDays: z.natural().min(7).max(365).default(30),
  sleepCompressDays: z.natural().min(7).max(365).default(90),
  // Pattern discovery scan window (most recent memories to scan).
  sleepPatternMinMemories: z.natural().min(10).max(1000).default(100),
  // How far back pattern discovery considers entity attr changes (days).
  sleepPatternLookbackDays: z.natural().min(1).max(90).default(30),
  // Max pattern memories minted per run (0 = disabled).
  sleepMaxPatternPerRun: z.natural().min(0).max(10).default(3),
  // Optional LLM route override for sleep's bulk passes (empty = use dream
  // route / agent default model).
  sleepProvider: z.string().default(""),
  sleepModel: z.string().default(""),
  // Pass-through reasoning effort for sleep's LLM passes, same semantics as
  // dreamReasoningEffort: 'none' (default) omits the field; 'off' explicitly
  // disables thinking (thinking-type models would burn the whole budget on
  // reasoning); low/medium/high are forwarded verbatim.
  sleepReasoningEffort: z.union([
    z.const("off"),
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none"),

  // --- epistemic trust: memory source credibility (v0.4.5) -----------------
  // Distinguish memories by source: observation (measured / witnessed),
  // subjective (opinion / guess) and inferred (derived from other evidence).
  // Opt-in by default: when false (default) retrieval ranking, injection
  // marking and dream merge/conflict keepSource are untouched and
  // epistemic_status stays inert data (still written + inferred on save, just
  // never used to influence behavior).
  trustEpistemicWeighting: z.boolean().default(false),

  // --- memory quality filter (Bug7) ------------------------------------------
  // Heuristic gate on what deserves the injection/recall surface. When enabled,
  // saveWithDedupe scores each new memory after dedupe and before write:
  //   score >= degradeThreshold (60) → stored normally
  //   archiveThreshold (30) <= score < 60 → quality_score persisted and the
  //       injection sort re-ranks by importance * quality_score/100 (degraded)
  //   score < 30 → archived + tagged low_quality (still explicitly searchable)
  // Meta-memory markers, near-duplicates and repetitive filler lose points.
  memoryQualityFilter: z.object({
    enabled: z.boolean().default(true),
    archiveThreshold: z.natural().min(1).max(100).default(30),
    degradeThreshold: z.natural().min(1).max(100).default(60),
    minContentLength: z.natural().min(1).max(1000).default(10)
  }).default({}),

  // --- LLM audit trail (Bug8) ------------------------------------------------
  // Records every background LLM call (autoDream consolidation + summary,
  // autoSummarize compression) into llm_audit_logs: tokens, duration, status
  // and which trigger produced it. Failures are recorded as status=error and
  // never block the feature. retentionDays bounds the table: older rows are
  // purged on boot.
  llmAudit: z.object({
    enabled: z.boolean().default(true),
    retentionDays: z.natural().min(1).max(3650).default(90)
  }).default({}),

  // --- recall evaluation: test-result storage (v0.4.6, 方案 B) --------------
  // Separate retrieval evaluation snapshots from the production recall audit.
  // When false (default) evaluateRetrieval still computes precision/recall/mrr
  // and returns them to the caller, but writes nothing to recall_evals — the
  // eval table only grows when the operator opts in. Production searchMemories
  // audits to recall_runs and NEVER touches recall_evals, regardless of this
  // flag (production isolation is unconditional).
  evalPersistTestResults: z.boolean().default(false),
});
