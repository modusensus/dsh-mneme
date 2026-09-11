import z from "@deepseek-ai/schemastery";
import { TYPE_DECAY_DEFAULTS } from "./heat.js";

export const Config = z.object({
  // 记忆语言：生成记忆、注入标题与后台 LLM 提示词所用语言；'zh'（默认，
  // 行为不变）/ 'en'。启动时读入，切换后重启生效。
  language: z.union([z.const("zh"), z.const("en")]).default("zh")
    .description("记忆语言：生成的记忆条目、注入标题与后台 LLM 提示词所用语言（zh=默认中文，en=英文）。"),
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  // Optional model override for summarization. When both are non-empty, they
  // take priority over the session's current model. Empty = use the session's
  // active provider/model (same as before).
  summarizeProvider: z.string().default(""),
  summarizeModel: z.string().default(""),
  // 蒸馏转录上限（字符）。借鉴 Codex「保留原始、替代压缩摘要」的思路：
  // 蒸馏把完整对话上下文交给 LLM 提炼，不硬裁到 8000 字就截断语义；默认
  // 24000 字符（约覆盖一整轮中等对话），需要更完整可调大。
  distillMaxChars: z.natural().min(1000).max(200000).default(24000),
  // 智能调速器（429 保护，默认开）：蒸馏 LLM 调用全局串行排队，相邻请求
  // 间隔 distillRateLimitIntervalMs（默认 1s 一次）；命中 429 限流时按
  // distillRateLimitBaseDelayMs 指数退避（1s→2s→4s…）自动重试
  // distillRateLimitRetries 次，全程对用户透明，不把 429 错误码抛给用户。
  distillRateLimitIntervalMs: z.natural().min(0).max(60000).default(1000),
  distillRateLimitRetries: z.natural().min(0).max(10).default(3),
  distillRateLimitBaseDelayMs: z.natural().min(100).max(60000).default(1000),
  maxInjectedItems: z.natural().min(1).max(20).default(5),
  importanceThreshold: z.natural().min(1).max(5).default(3),
  // 编码记忆蒸馏（codingRetrospect，opt-in，默认关）。开启时，turn/end 蒸馏
  // 额外提取三类编码专属记忆：rejected_solution（被否决方案）/ pitfall（踩坑）/
  // constraint（工程约束）。蒸馏上下文为整轮完整对话（用户输入 → 助手思考/回答
  // → 工具调用与结果 → 代码执行），不再只看用户消息，便于提炼踩坑根因。
  // 关闭时行为与之前完全一致。
  codingRetrospect: z.boolean().default(false),
  // 编码任务识别词表（读取侧门控用）：命中即视为编码类任务，编码记忆才注入。
  codingKeywords: z.array(z.string()).default([
    "代码", "编码", "写一个", "写个", "实现", "函数", "方法", "类",
    "接口", "bug", "调试", "报错", "错误", "异常", "堆栈", "脚本",
    "python", "javascript", "typescript", "node", "js", "ts",
    "sql", "sqlite", "数据库", "算法", "重构", "优化", "性能",
    "测试", "单测", "修复", "补丁", "依赖", "npm", "pip",
    "命令行", "shell", "配置", "配置文件", "yaml", "json",
    "插件", "开发", "编译", "构建", "部署", "git", "commit",
    "review", "前端", "后端", "页面", "组件", "dsh", "memos"
  ]),
  // 编码记忆注入加权系数：编码任务时对 rejected_solution/pitfall/constraint
  // 记忆的 importance 乘以该系数排序，让编码记忆在编码场景更靠前。
  codingBoostFactor: z.number().min(1).max(5).default(2),
  autoDream: z.boolean().default(true),
  dreamThresholdCount: z.natural().min(1).max(1000).default(10),
  dreamThresholdChars: z.natural().min(100).max(100000).default(5000),
  dreamDelayMs: z.natural().min(0).max(60000).default(2000),
  // autoDream 触发最小间隔（分钟，0 = 不限制，Issue #89 请求 2）：高频写入
  // 场景下防止巩固调用（含失败重试）连发刷爆配额。间隔从每次实际开跑时刻
  // 起算，失败/degraded 的 run 也占用间隔；间隔内的触发请求静默跳过，下一次
  // 写入事件会重新评估。
  dreamMinIntervalMinutes: z.natural().min(0).max(10080).default(0),
  // 巩固模型路由（settings panel「巩固模型」/ dreamProvider+dreamModel）：
  // dream 的记忆沉淀专用 LLM 路由，显式配置优先于 agent 默认模型（config-first，
  // Issue #25）。模型分类声明：
  //   - 非思考模型（推荐，如 glm-5-2 类）：无 reasoning 声明，effort 请求被 harness
  //     拒绝后 withEffortFallback 去掉字段重试即成功；空体/no json array 风险最低。
  //   - 思考模型（如 deepseek-v4-flash-ga 等 v4-flash-ga 系）：默认开推理，可能烧光
  //     token 预算返回空体；且部分（如 v4-flash-ga）在 harness 侧被声明为不接受任何
  //     reasoning effort —— 即使去掉 effort 重试，harness 的 defaultEffort 也会顶上来
  //     再次拒绝（UNSUPPORTED_REASONING_EFFORT），插件 fallback 无法绕开。
  //     选用时建议配 dreamReasoningEffort 并实测；不行就换非思考模型。
  dreamProvider: z.string().description("记忆巩固专用模型的服务商（settings「巩固模型」）。巩固反复失败时，优先改用官方非思考模型的服务商（如 deepseek / glm）。"),
  dreamModel: z.string().description("记忆巩固专用模型。建议选非思考模型（如 deepseek-chat、glm-5-2 类）：思考模型可能烧光 token 预算返回空体，导致巩固失败（UNSUPPORTED_REASONING_EFFORT）。"),
  dreamMaxTokens: z.natural().min(256).max(131072).default(32768),
  // Pass-through reasoning effort for dream's LLM calls. 'none' (default)
  // omits the field so the provider's own default applies; low/medium/high
  // are forwarded verbatim. Useful to cap reasoning spend on thinking-type
  // models that would otherwise drain the whole token budget and return an
  // empty body ("no json array in llm output").
  // Caveat: on some thinking models (e.g. v4-flash-ga) the harness declares NO
  // supported effort, so even the fallback retry (field stripped) is rejected
  // again via its defaultEffort — prefer a non-reasoning dreamProvider/dreamModel.
  dreamReasoningEffort: z.union([
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none").description("巩固模型的推理档位：'none'（默认）用服务商自带默认；low/medium/high 原样传递。模型不支持的值会自动换用其支持的档位（v0.7.26+）。"),
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
  // Issue #89：v0.6.9（Issue #26）的宽容路径回归。默认跳过单条非法决策
  // （未知 id / 跨类型合并等）、应用合法子集、run 记 degraded；设 false 恢复
  // 整单拒绝的严格模式。全局上限与覆盖率下限不受此开关影响、始终整单拒绝。
  dreamSkipInvalid: z.boolean().default(true),
  // 显式开启后放宽跨类型合并检查（类型边界由用户自行承担）；配合
  // dreamSkipInvalid 理解：关闭 skipInvalid 时跨类型 merge 直接整单拒绝。
  allowCrossTypeMerge: z.boolean().default(false),
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

  // Recall fusion recipe (plan #1): how the keyword/vector/BM25 ranked lists
  // are combined into the final ranking. `blend` (default) is the legacy
  // behavior — weighted sum for vector/hybrid, union backfill for auto —
  // unchanged. `rrf` (Reciprocal Rank Fusion) and `minmax` (min-max normalized
  // weighted sum) are rank/scale-aware recipes that fix the unit mismatch the
  // issue describes (raw cosine vs keyword score vs normalized IDF are added
  // directly). Off by default so existing behavior holds exactly.
  recallFusion: z.union([z.const("blend"), z.const("rrf"), z.const("minmax")]).default("blend"),
  // Attach a `signals` object { keyword, vector, bm25, final } to each search
  // result for transparency/debugging (plan #2). Default off; when on it only
  // decorates the returned rows, never changes the ranking.
  signalTransparency: z.boolean().default(false),

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
  // Optional provider override for entity extraction; empty = use the caller's
  // default provider/model. Combined with entityExtractionModel — provider
  // without model (or vice versa) falls through to the caller default.
  entityExtractionProvider: z.string().default(""),
  // Optional model override for entity extraction; empty = use the caller's
  // default provider/model.
  entityExtractionModel: z.string().default(""),
  // Reasoning effort for entity extraction (issue #109), mirrors
  // dreamReasoningEffort: 'none' (default) omits the field / provider default;
  // low/medium/high passed through. A provider that rejects the effort retries
  // once without it, so opting in is safe to experiment with.
  entityExtractionReasoning: z.union([
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none"),
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
  sleepProvider: z.string().default("").description("sleep 深维护专用模型服务商，留空用巩固模型或当前模型。"),
  sleepModel: z.string().default("").description("sleep 深维护专用模型，留空用巩固模型或当前模型；建议同巩固模型选非思考模型。"),
  // Pass-through reasoning effort for sleep's LLM passes, same semantics as
  // dreamReasoningEffort: 'none' (default) omits the field; low/medium/high
  // are forwarded verbatim.
  sleepReasoningEffort: z.union([
    z.const("low"),
    z.const("medium"),
    z.const("high"),
    z.const("none")
  ]).default("none").description("同 dreamReasoningEffort：sleep 各阶段 LLM 的推理档位，'none' 用服务商默认。"),

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

  // --- standalone external API (v0.7.12) ------------------------------------
  // A plain node:http server for ecosystem integrations that cannot reach the
  // DSH-internal webServer. Disabled by default; when enabled the Bearer token
  // is persisted in the settings kv ("external_api"), auto-generated on first
  // boot. Bind host: keep the loopback default — moving it to a non-loopback
  // address exposes the whole memory store to the network and is the
  // operator's responsibility.
  externalApiEnabled: z.boolean().default(false),
  externalApiPort: z.natural().default(8790),
  externalApiHost: z.string().default("127.0.0.1"),

  // --- light mode preset (v0.7.12) -------------------------------------------
  // One switch for low-resource setups: turns off every background/semantic
  // heavy path (dream consolidation, entity extraction, vector pipeline,
  // reranker, BM25, semantic dedup / selective inject, sleep mode) while
  // keeping the core loop (autoInject, autoSummarize, hot memory, quality
  // filter, keyword search). Applied by applyLightModePreset before the config
  // reaches any service; a persisted panel_mode="light" (settings kv) counts
  // as lightMode=true too and wins over the bundle config.
  lightMode: z.boolean().default(false),

  // --- heat: v0.7.0 self-evolution (heat + interest drift) ----------------
  // 总开关，默认关（v0.7.12+ 用户已习惯无 heat 行为，默认开=全员行为变更）。
  // 开启后：提供热度字段 / sleep 降级联合判定保护 / 前端热度投影，不改变
  // 召回排序。关闭则跳过所有 heat 计算与热度触达，sleep 降级退回纯时间分层。
  // 也走 feature_flags（FEATURE_FLAG_BOOLEANS 白名单），面板可启停=线上回滚开关。
  heatEnabled: z.boolean().default(false),
  // 幂律形状参数 α（heat = 1/(1+λΔt)^α），越大衰减越快。
  heatGlobalAlpha: z.number().min(0.1).max(5).default(1.2),
  // per-type 衰减因子 λ；λ=0 的类型免疫（热度恒 1.0，sleep 永不降级）。
  // 未知类型走默认 0.002。dict 的键为 type 字符串、值为数字 λ。
  heatTypeDecay: z.dict(z.number(), z.string()).default({ ...TYPE_DECAY_DEFAULTS }),
  // sleep 降级联合判定的热度下限：heat < 该值 且 importance<5 才允许降级。
  sleepHeatThreshold: z.number().min(0).max(1).default(0.05),
  // recordRecall 默认值（recall_runs 记录默认开；显式传 false 的调用方不受影响）。
  recallRecordDefault: z.boolean().default(true),
  // recall_runs 滚动清理保留天数。
  recallRetentionDays: z.natural().min(1).max(3650).default(90),
});

// Fields forced to false by the light-mode preset. Everything not listed here
// (autoInject, autoSummarize, hotMemory*, memoryQualityFilter, dream
// thresholds/delays, ...) is left untouched — those are the core loop.
const LIGHT_MODE_OFF = [
  "entityExtractionEnabled",
  "autoDream",
  "sleepModeEnabled",
  "rerankEnabled",
  "autoReindexOnBoot",
  "hybridInject",
  "searchSemanticDedup",
  "selectiveInjectEnabled",
  "bm25SearchEnabled",
  // 轻量模式不开热计算（heat 属于重型增强；关掉后 sleep 降级也退回纯时间分层）。
  "heatEnabled"
];

/**
 * Apply the light-mode preset to a resolved config object (pure function,
 * exported for tests). When cfg.lightMode is not exactly true the config is
 * returned unchanged; otherwise a shallow copy carries false for every heavy
 * feature. Idempotent and side-effect free.
 */
export function applyLightModePreset(cfg) {
  if (cfg?.lightMode !== true) return cfg;
  const preset = { ...cfg, lightMode: true };
  for (const key of LIGHT_MODE_OFF) preset[key] = false;
  return preset;
}
