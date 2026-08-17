import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
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

  // --- system-level sleep (v0.4.1) -----------------------------------------
  // Opt-in: when false (default) the plugin never runs a sleep cycle, so the
  // access-touch bookkeeping on recall/inject paths stays off too. Sleep is
  // three phases: conflict resolution (reuses the dream conflict machinery),
  // archival demotion (unrecalled memories tier down to summary then archive),
  // and pattern discovery (LLM scans recent memories and mints type=pattern
  // entries with evidence references).
  sleepEnabled: z.boolean().default(false),
  // A sleep run only fires when the store has been idle for this long and the
  // last run is older than sleepMinIntervalHours. Idle detection replaces a
  // cron-like schedule (DSH plugins have no resident crontab).
  sleepIdleMinutes: z.natural().min(1).max(1440).default(30),
  sleepMinIntervalHours: z.natural().min(1).max(168).default(8),
  // Unrecalled (COALESCE(last_accessed_at, updated_at, created_at)) beyond
  // sleepArchiveDays → demote: full body moves to _full_content, content
  // becomes a one-line summary. Beyond sleepDeepArchiveDays → archive.
  sleepArchiveDays: z.natural().min(1).max(365).default(30),
  sleepDeepArchiveDays: z.natural().min(1).max(3650).default(90),
  // How many most-recent memories the pattern-discovery pass scans.
  sleepPatternScanCount: z.natural().min(10).max(500).default(100),
  // Max patterns minted per sleep run (mirrors decisions maxCreatePerRun).
  sleepMaxPatterns: z.natural().min(1).max(20).default(5),
  // Optional LLM route override; empty = fall back to agentDefaultModel then
  // the dream route. Distinct from dreamProvider/dreamModel so the sleep pass
  // can pin a cheaper model for its bulk summarization.
  sleepProvider: z.string().default(""),
  sleepModel: z.string().default(""),
});
