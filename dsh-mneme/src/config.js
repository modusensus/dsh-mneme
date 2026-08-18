import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
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
  dreamMaxTokens: z.natural().min(256).max(32768).default(4096),
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
});
