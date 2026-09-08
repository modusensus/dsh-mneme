import { createStore } from "./store.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { createService } from "./service.js";
import { createTools } from "./tools.js";
import { createInjector } from "./inject.js";
import { createSummarizer } from "./summarize.js";
import { createDreamScheduler } from "./dream.js";
import { createSleepScheduler, runSleep } from "./dream/sleep.js";
import { createApi } from "./api.js";
import { createStandaloneApi } from "./api-standalone.js";
import { createSettings } from "./settings.js";
import { createCommandManager } from "./commands.js";
import { createEmbedder } from "./embedding.js";
import { createEmbedderByProvider } from "./local-embedder.js";
import { LocalReranker } from "./reranker.js";
import { createVectorIndex } from "./vector-index.js";
import { Config, applyLightModePreset } from "./config.js";
import { extractEntities } from "./entities/extractor.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-mneme";
// webServer 为可选依赖（headless/无 UI 宿主兼容）：从 inject 声明中去掉，cordis
// 不再等待它激活；运行时 ctx.webServer 为空则跳过 API 注册（下方 if 守卫），
// 记忆工具/注入/dream 全部照常工作。
export const inject = ["tools", "systemPrompt", "llm", "agentDefaultModel", "commands"];
export { Config };

// Arrow (not function declaration): cordis 4 treats any apply with a
// prototype as a class constructor (`new apply(...)`) and discards its return
// value, so a `function apply` disposer would never run on unload. An arrow
// has no prototype, is called normally, and its returned disposer is collected
// and run by the fiber on unload.
export const apply = (ctx, config) => {
  const rawCfg = Config(config);

  // Resolve memoryDir: expand leading "~"
  const memoryDir = rawCfg.memoryDir.startsWith("~")
    ? join(homedir(), rawCfg.memoryDir.slice(1))
    : rawCfg.memoryDir;
  mkdirSync(memoryDir, { recursive: true });

  const store = createStore(join(memoryDir, "memory.db"));
  // Prune reflection failure rows older than 90 days on boot (best-effort, so
  // the failure table never grows unbounded).
  try {
    store.deleteOldFailures(new Date(Date.now() - 90 * 86400000).toISOString());
  } catch { /* non-fatal */ }
  // Bug8: enforce llm_audit_logs retention on boot (config.llmAudit.retentionDays,
  // default 90). Best-effort like the failure prune — the audit trail is
  // bookkeeping and a failed purge must never block plugin boot.
  try {
    if (rawCfg.llmAudit?.enabled !== false) {
      const retentionMs = Number.isInteger(rawCfg.llmAudit?.retentionDays) ? rawCfg.llmAudit.retentionDays : 90;
      store.deleteOldLlmAudits(new Date(Date.now() - retentionMs * 86400000).toISOString());
    }
  } catch { /* non-fatal */ }

  // User-configurable settings (profile, rules, panel mode, standalone API
  // token) share the same SQLite file in dedicated tables, isolated from
  // memories. Created before the config is finalized: the persisted
  // panel_mode participates in light-mode resolution below.
  const settings = createSettings(store.db);

  // Light mode (v0.7.12): the bundle config flag OR a persisted panel_mode of
  // "light" (the panel switch wins over the bundle config so it survives
  // config redeploys). applyLightModePreset turns every heavy background /
  // semantic feature off and keeps the core loop (autoInject, autoSummarize,
  // hot memory, quality filter).
  const lightMode = rawCfg.lightMode === true || settings.getPanelMode() === "light";
  // 功能开关合并顺序即优先级：用户显式开关（feature_flags kv，面板写入）>
  // 轻量预设（applyLightModePreset 批量置关的重型能力）> bundle 配置。预设必须
  // 先应用、用户开关后展开，否则 LIGHT_MODE_OFF 会把用户显式打开的开关再次
  // 压掉。合并结果只作用于本次启动：面板改开关后与 panel_mode 一样在下次
  // 启动生效。
  // 嵌套对象开关按首个点号拆开（kv 里平铺存的 "memoryQualityFilter.enabled" →
  // cfg.memoryQualityFilter.enabled），点号键不原样留在 cfg 顶层属性里。
  const flags = settings.getFeatureFlags();
  const flatFlags = {};
  const nestedFlags = {};
  for (const [key, value] of Object.entries(flags)) {
    const dot = key.indexOf(".");
    if (dot > 0) {
      const objKey = key.slice(0, dot);
      const subKey = key.slice(dot + 1);
      nestedFlags[objKey] = { ...(nestedFlags[objKey] ?? {}), [subKey]: value };
    } else {
      flatFlags[key] = value;
    }
  }
  const cfg = { ...applyLightModePreset({ ...rawCfg, lightMode }), ...flatFlags };
  for (const [objKey, sub] of Object.entries(nestedFlags)) {
    cfg[objKey] = { ...(cfg[objKey] ?? {}), ...sub };
  }

  const mirror = createMirror(memoryDir);
  const service = createService({ store, mirror, config: cfg, logger: ctx.logger });

  // F-NEW-03: if the mirror sync failed last run (persisted dirty state), retry
  // a safe re-render at boot so a stale mirror converges without needing a
  // business write. Bounded: single attempt; on failure dirty stays for the
  // next boot. Never throws.
  service.recoverMirror();

  // Recall-layer receipt: when searchMemories runs with recordRecall=true, the
  // retrieval scene (query/mode/topK/threshold + candidates) is persisted to
  // recall_runs for audit/replay — the sibling of the dream_runs judgment trail.
  // Best-effort: a failed recall write must never break the search.
  service.setRecallRecorder((recall) => {
    try {
      store.saveRecallRun({
        query: recall.query,
        mode: recall.mode,
        topK: recall.topK,
        threshold: recall.threshold ?? null,
        candidates: recall.candidates ?? [],
        created_at: recall.createdAt
      });
    } catch { /* non-fatal: recall recording is bookkeeping */ }
  });

  // Semantic pipeline: a local/ollama embedder when configured, otherwise the
  // legacy OpenAI-compatible embedder (settings-driven). The vector index wraps
  // the store's embedding column and tracks the active model fingerprint. A
  // slow embedder init (model download) never blocks plugin boot — failures
  // degrade to keyword search.
  const vectorIndex = createVectorIndex({ store, logger: ctx.logger });
  service.setVectorIndex(vectorIndex);

  // Human edits in mirror files win on every sync; merge them back first.
  // TYPE_FILE maps each memory type to its mirror filename. Read every type's
  // edits up front: mergeHumanEdits re-renders ALL mirror files on success, so
  // a per-type read-then-merge loop would overwrite edits in files not yet read
  // (e.g. preferences.md merging would clobber unsynced projects.md edits).
  const humanEdits = new Map();
  for (const type of Object.keys(TYPE_FILE)) {
    humanEdits.set(type, mirror.readHumanEdits(type));
  }
  const applyHumanEdits = () => {
    for (const [type, edits] of humanEdits) {
      if (edits.length) service.mergeHumanEdits(type, edits);
    }
  };

  let embedder = null;
  let reranker = null;
  if (lightMode) {
    // Light mode: the whole vector pipeline stays off — no embedder (nothing
    // pulls in ONNX/transformers), no reranker, no boot backfill (the preset
    // also cleared autoReindexOnBoot). Recall degrades to keyword search and
    // human mirror edits still merge on boot.
    applyHumanEdits();
  } else if (cfg.embedProvider === "openai") {
    // vectorIndex is passed so the legacy OpenAI embedder records the producing
    // model fingerprint after each successful embed (Bug3).
    embedder = createEmbedder({ store, settings, logger: ctx.logger, vectorIndex });
    service.setEmbedder(embedder);
    // legacy OpenAI embedder is immediately usable
    applyHumanEdits();
  } else {
    try {
      embedder = createEmbedderByProvider(cfg.embedProvider, {
        model: cfg.embedProvider === "ollama" ? cfg.ollamaModel : cfg.localEmbedModel,
        dimension: cfg.localEmbedDimension,
        device: cfg.localEmbedDevice,
        batchSize: cfg.localEmbedBatchSize,
        cacheDir: cfg.embedModelCacheDir,
        baseUrl: cfg.ollamaBaseUrl,
        logger: ctx.logger
      });
      service.setEmbedder(embedder);
      // issue #6: wait for extractor init before applying human edits, so
      // scheduled embeddings see a ready embedder.
      embedder.init()
        .then(() => applyHumanEdits())
        .catch((error) => {
          ctx.logger?.warn?.(`[dsh-mneme] embedder init failed, search degrades to keyword: ${String(error)}`);
          service.setEmbedder(null);
          applyHumanEdits();
        });
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mneme] embedder unavailable, search degrades to keyword: ${String(error)}`);
      applyHumanEdits();
    }
  }

  // Cross-encoder rerank over recall candidates. Best-effort: a failed model
  // load only disables reranking, never search itself. Explicit opt-in only
  // (rerankEnabled defaults to false): constructing LocalReranker is what pulls
  // in onnxruntime, so the default config never loads it (item ⑥).
  if (cfg.rerankEnabled && cfg.rerankProvider === "local") {
    try {
      reranker = new LocalReranker({
        model: cfg.rerankModel,
        batchSize: cfg.rerankBatchSize,
        maxCandidates: cfg.rerankMaxCandidates,
        scoreThreshold: cfg.rerankScoreThreshold,
        device: cfg.localEmbedDevice,
        cacheDir: cfg.embedModelCacheDir,
        logger: ctx.logger
      });
      service.setReranker(reranker);
      reranker.init().catch((error) => {
        ctx.logger?.warn?.(`[dsh-mneme] reranker init failed, rerank disabled: ${String(error)}`);
        service.setReranker(null);
      });
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mneme] reranker unavailable, rerank disabled: ${String(error)}`);
    }
  }

  // Bug2: lazy auto-backfill of missing embeddings on boot. When the vector API
  // is configured and rows still lack an embedding (e.g. written before vector
  // search was enabled) AND the vector_meta fingerprint is absent or stale, the
  // index is rebuilt in the background after a short delay. Gated on
  // cfg.autoReindexOnBoot; rate-limited in small batches so a large backlog
  // never floods the provider. Failures degrade silently — search stays keyword.
  function scheduleAutoReindex() {
    if (cfg.autoReindexOnBoot === false) return;
    const attempt = (tries) => {
      try {
        if (!embedder || typeof embedder.embedSingle !== "function") return;
        if ("ready" in embedder && embedder.ready !== true) {
          // Local/ollama embedders init asynchronously; give them a moment
          // before giving up on this boot (next boot retries).
          if (tries > 0) setTimeout(() => attempt(tries - 1), 2000);
          return;
        }
        if (!store.needsEmbedding(1).length) return; // nothing to backfill
        // Model fingerprint gate: vectors already produced by the same model
        // mean there is no drift and no rebuild needed.
        const current = embedder.modelHash;
        if (current && vectorIndex.modelHash?.() === current) return;
        const BATCH = 10;
        const MAX_TOTAL = 500; // bound boot-time work
        (async () => {
          let indexed = 0;
          for (let done = 0; done < MAX_TOTAL;) {
            const rows = store.needsEmbedding(BATCH);
            if (!rows.length) break;
            for (const row of rows) {
              try {
                const text = [row.title, row.content].filter(Boolean).join("\n");
                const vector = await embedder.embedSingle(text);
                if (vector?.length) {
                  store.setEmbedding(row.id, vector);
                  indexed++;
                }
              } catch { /* skip the bad row */ }
            }
            done += rows.length;
            // Rate limit: space out batches so the provider is not hammered.
            if (store.needsEmbedding(1).length) await new Promise((r) => setTimeout(r, 200));
          }
          if (indexed > 0 && current) vectorIndex.markModel?.(current, embedder.dimension);
          ctx.logger?.info?.(`[dsh-mneme] auto-reindex backfilled ${indexed} embeddings on boot`);
        })().catch((error) => {
          ctx.logger?.warn?.(`[dsh-mneme] auto-reindex failed: ${String(error)}`);
        });
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-mneme] auto-reindex failed: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(5), 5000);
  }
  scheduleAutoReindex();

  // Custom commands: register persisted commands into the DSH command registry
  // on boot; add/remove re-register live through the API.
  let commands = null;
  if (ctx.commands) {
    commands = createCommandManager({ ctx, settings, logger: ctx.logger });
    commands.sync();
  }

  // Dream scheduler: automatic consolidation + summary runs, triggered by
  // store growth. Writes through the service fire the dream hook, which asks
  // the scheduler to (re)schedule a run once absolute and since-last-run
  // thresholds are both exceeded. onRun is deferred through `dream` so the
  // closure sees the assigned scheduler; the null guard keeps a run safe even
  // if the hook fires before assignment or after dispose.
  let dream = null;
  if (cfg.autoDream) {
    dream = createDreamScheduler({
      thresholdCount: cfg.dreamThresholdCount,
      thresholdChars: cfg.dreamThresholdChars,
      delayMs: cfg.dreamDelayMs,
      minIntervalMs: (cfg.dreamMinIntervalMinutes ?? 0) * 60000,
      logger: ctx.logger,
      semantic: { embedder, vectorIndex },
      onRun: () => (dream ? dream.runDream(ctx, service, cfg) : Promise.resolve({ ok: true, skipped: true }))
    });
    service.setDreamHook(() => dream.maybeSchedule(service));
  }

  // Sleep scheduler (v0.4.0): idle-triggered deep maintenance. Fires when the
  // store has been quiet for sleepIdleMinutes and re-arms on every write via
  // noteWrite (hooked to the service's write path). Runs go through
  // service.enqueue so they serialize with autoDream — the two never overlap.
  // Abortable on user activity; audited into dream_runs with run_type='sleep'.
  let sleep = null;
  if (cfg.sleepModeEnabled) {
    sleep = createSleepScheduler({
      service,
      config: cfg,
      logger: ctx.logger,
      onRun: (signal) => (sleep ? runSleep(ctx, service, cfg, ctx.logger, { embedder, vectorIndex }, signal) : Promise.resolve({ ok: true, skipped: true }))
    });
    service.setSleepHook(() => sleep.noteWrite());
  }

  // Entity gene extraction (v0.3.0): wire the extractor into the service as a
  // hook so saveWithDedupe can fire-and-forget an extraction pass on fresh
  // writes. The service never sees ctx.llm — index.js adapts it here into the
  // callLLM(messages, options) => Promise<string> contract the extractor
  // expects, reusing the same ctx.llm.stream consumption pattern as dream.js.
  // Explicit opt-in only (entityExtractionEnabled defaults to false); any LLM
  // failure degrades inside the extractor to { ok:false }, never a write error.
  if (cfg.entityExtractionEnabled && ctx.llm) {
    const streamEntityText = async (messages, options = {}) => {
      let route = null;
      if (options.model) {
        route = { model: options.model };
      } else {
        try {
          const sel = ctx.agentDefaultModel?.currentSelection?.();
          if (sel?.provider && sel?.model) route = sel;
        } catch { /* fall through to no route */ }
      }
      let text = "";
      for await (const chunk of ctx.llm.stream({
        ...(route ?? {}),
        purpose: "entity-extract",
        maxTokens: 4096,
        messages
      })) {
        if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
        if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) return undefined;
      }
      return text;
    };
    service.setEntityExtractor((memory) =>
      extractEntities(memory, { store, config: cfg, callLLM: streamEntityText, logger: ctx.logger })
        .catch((err) => {
          ctx.logger?.warn?.(`[dsh-mneme] entity extraction failed: ${String(err)}`);
          return { ok: false, error: String(err) };
        })
    );
  }

  const disposers = [];

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (cfg.autoInject) disposers.push(createInjector(promptCtx, service, settings, cfg));
  });

  ctx.inject(["tools"], (toolsCtx) => {
    disposers.push(createTools(toolsCtx, service, cfg, embedder));
  });

  const summarizer = createSummarizer(ctx, service, cfg);
  disposers.push(summarizer.dispose);

  if (ctx.webServer) {
    const api = createApi(ctx, service, settings, commands ?? {
      add: () => { throw new Error("commands unavailable"); },
      remove: () => false,
      list: () => []
    }, embedder, { vectorIndex, reranker }, cfg.apiToken, cfg);
    disposers.push(api.dispose);
  }

  // Standalone external API (v0.7.12): plain node:http server for ecosystem
  // integrations outside the DSH host. Persisted external_api settings win
  // over the bundle config (enabled/port); the Bearer token lives in the same
  // kv and is auto-generated on first boot by createStandaloneApi. Binding a
  // non-loopback host is the operator's documented responsibility.
  if ((settings.getExternalApi?.()?.enabled ?? cfg.externalApiEnabled) === true) {
    const standalone = createStandaloneApi({ service, store, config: cfg, logger: ctx.logger, settings });
    disposers.push(() => standalone.server.close());
    standalone.ready.catch((error) => {
      ctx.logger?.warn?.(`[dsh-mneme] standalone API failed to start: ${String(error)}`);
    });
  }

  // Async disposer: cordis awaits the returned promise on unload (runDisposable),
  // so an in-flight dream run is allowed to finish before the SQLite store is
  // closed — dream.dispose() resolves only after its current run settles.
  return async () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
    commands?.dispose();
    if (dream) await dream.dispose();
    if (sleep) sleep.dispose();
    store.close();
  };
};
