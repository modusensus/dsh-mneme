import { createHash, randomUUID } from "node:crypto";
import { TYPE_FILE } from "./mirror.js";
import { evaluateMemoryQuality } from "./quality-filter.js";
import { createBM25Index } from "./search/bm25.js";
import { adaptiveThreshold } from "./search/adaptive.js";
import { parseWikiLinks } from "./parser/wiki-link.js";
import { extractQueryTags, applyTagBoost } from "./search/tag-boost.js";
import { computeHeat } from "./heat.js";

const INJECT_TYPES = new Set(["preference", "project", "decision", "summary", "user", "fact"]);

// Epistemic trust weights (v0.4.5): when config.trustEpistemicWeighting is on,
// each recall candidate's existing score is multiplied by the weight of its
// epistemic_status before ranking — measured facts outrank guesses. Missing /
// unknown statuses are unscaled (×1). Off by default, so nothing changes.
const EPISTEMIC_WEIGHTS = { observation: 1.0, inferred: 0.85, subjective: 0.7 };

// Bug5: content version history cap (FIFO — the newest 20 versions are kept,
// older ones dropped). Entries are {content, source, updated_at}; source marks
// how the version was superseded (auto_merge | human_override | overwrite).
const CONTENT_HISTORY_MAX = 20;

/** Prepend the previous content to a memory's content_history (FIFO capped). */
function pushContentHistory(existing, source) {
  const history = Array.isArray(existing?.content_history) ? existing.content_history : [];
  return [
    { content: existing?.content ?? "", source, updated_at: new Date().toISOString() },
    ...history
  ].slice(0, CONTENT_HISTORY_MAX);
}

/** Bug5: same-title merge appends the new content under a timestamped `---`
 *  separator instead of overwriting, so a re-noted memory never loses history.
 *  The `---` line is compatible with the mirror's readHumanEdits (which strips
 *  only the LAST structural `---` when parsing the human-editable file). */
function appendContent(oldContent, newContent) {
  const ts = new Date().toISOString();
  return `${oldContent}\n\n---\n[${ts}] ${newContent}`;
}

/**
 * Standard retrieval-quality metrics over the ordered candidate ids actually
 * returned vs the ids the evaluator marked relevant (方案 B). Pure + total, so
 * callers (and tests) get deterministic numbers without touching a store:
 *   precision = |relevant ∩ retrieved| / |retrieved|
 *   recall    = |relevant ∩ retrieved| / |expected|
 *   mrr       = 1 / rank of the first relevant doc (0 when none retrieved)
 * hit_count is the raw intersection size. Values are rounded to 4 decimals so
 * repeated divisions (e.g. 1/3) never surface binary-float noise.
 */
export function computeRetrievalMetrics(actualIds, expectedIds) {
  const expected = new Set(Array.isArray(expectedIds) ? expectedIds : []);
  const actual = Array.isArray(actualIds) ? actualIds : [];
  const relevant = actual.filter((id) => expected.has(id)).length;
  const round4 = (x) => Math.round(x * 10000) / 10000;
  let mrr = 0;
  for (let i = 0; i < actual.length; i++) {
    if (expected.has(actual[i])) { mrr = 1 / (i + 1); break; }
  }
  return {
    precision: round4(actual.length ? relevant / actual.length : 0),
    recall: round4(expected.size ? relevant / expected.size : 0),
    mrr: round4(mrr),
    hit_count: relevant
  };
}

export function createService({ store, mirror, config, onWrite, logger, settings }) {
  // Optional dream scheduler hook, installed via setDreamHook after creation
  // (the scheduler holds a reference back to the service, so it cannot be
  // passed in the constructor). Fired on the same write events as onWrite.
  let dreamHook = null;

  // Optional sleep scheduler hook (v0.4.0), installed via setSleepHook after
  // creation. Fired on the same write events as onWrite: it tells the sleep
  // scheduler the store just changed so the idle-detection clock resets.
  let sleepHook = null;

  // Optional vector embedder, installed via setEmbedder after creation. After
  // any content write it fire-and-forgets a re-embed of the row so vector
  // search stays in sync; failures are swallowed inside the embedder.
  let embedder = null;

  // Optional entity extractor, installed via setEntityExtractor after creation
  // (index.js injects it so the service never depends on the LLM directly).
  // After a new memory is saved it fire-and-forgets an extraction pass for the
  // entity gene (v0.3.0); failures are swallowed so a broken extraction never
  // surfaces as a write failure. Extraction only runs when
  // config.entityExtractionEnabled is true.
  let entityExtractor = null;
  let vectorIndex = null;
  let reranker = null;

  // Effective tag toggles (issue #31): the settings layer (Web panel switches,
  // persisted in user_settings) overrides the plugin config when explicitly
  // stored; unset keys fall back to the zod config default. This is the single
  // runtime source of truth for setMemoryTags' manual gate and the Web panel's
  // getTagConfig display — the panel toggle and the dream autoTag gate were
  // previously writing/reading two disconnected stores.
  const tagConfig = () => {
    const stored = settings?.getAutoTagConfig?.() ?? {};
    return {
      autoTagEnabled: typeof stored.autoTagEnabled === "boolean" ? stored.autoTagEnabled : (config.autoTagEnabled ?? false),
      manualTagEnabled: typeof stored.manualTagEnabled === "boolean" ? stored.manualTagEnabled : (config.manualTagEnabled ?? true)
    };
  };

  // App-wide effective config for the Web panel (/api/dsh-mneme/config): the
  // tag toggles plus UI preferences (issue #38). Settings overrides plugin
  // config when explicitly stored; unset keys fall back to the zod default.
  const appConfig = () => {
    const stored = settings?.getUiConfig?.() ?? {};
    return {
      ...tagConfig(),
      showSidebarTrigger: typeof stored.showSidebarTrigger === "boolean"
        ? stored.showSidebarTrigger
        : (config.showSidebarTrigger ?? true)
    };
  };

  // Optional recall recorder, installed via setRecallRecorder after creation.
  // When searchMemories is called with recordRecall=true it receives the
  // actual merged recall scene (candidates + scores + source + threshold) so
  // the retrieval layer can be audited/replayed — the sibling of the dream
  // judgment-layer audit trail (dream_runs).
  let recallRecorder = null;

  // Bug4: semantic recall cache for the injection path. The system-prompt
  // interpolator renders context synchronously, so injectCandidates cannot
  // fire a fresh async embed. The most recent searchMemories recall is cached
  // here (query + ordered candidates) and reused when the injection query
  // matches, giving semantic-first injection without breaking the sync render.
  let lastSemanticRecall = null;

  // Transaction nesting depth. Inside service.transaction the per-mutation side
  // effects (mirror render, write notify, re-embed) are deferred so a ROLLBACK
  // never leaves the mirror file diverged from the database; transaction()
  // replays them exactly once against the committed state.
  let txDepth = 0;

  // Serial task queue (sleep v0.4.0). Long-running background passes — dream
  // consolidation, sleep cycles — must never overlap: two sleep runs racing
  // would double-demote or double-mint patterns. enqueue chains the task onto
  // a promise tail so N callers can queue work that runs strictly one at a
  // time. A task that rejects doesn't poison the queue (the tail swallows the
  // rejection) but the rejection still propagates to that caller.
  let queueTail = Promise.resolve();
  function enqueue(fn) {
    const next = queueTail.then(fn, fn);
    queueTail = next.catch(() => {});
    return next;
  }

  // issue #6 (part 2): startup race defense. A local embedder (LocalEmbedder /
  // Ollama) exposes an async init(), so between `setEmbedder` and init()
  // resolving there is a window where embedSingle would throw "not initialized"
  // and the re-embed would be silently dropped. When the embedder carries a
  // `ready` flag we queue writes in embedPending until init sets ready=true,
  // then flush them through the embedder's real interface. Embedders without a
  // `ready` flag (legacy OpenAI, instantly usable) keep their old behavior.
  let embedPending = [];
  let embedReadyTimer = null;
  const EMBED_PENDING_MAX = 100; // bound the queue; drop oldest beyond this
  const EMBED_READY_POLL_MS = 100;
  const EMBED_READY_POLL_LIMIT = 30; // ~3s ceiling; never poll forever

  /** Flush the queued re-embeds once the embedder is ready. Fail-safe. */
  function flushEmbedPending() {
    if (!embedder || embedPending.length === 0) return;
    const batch = embedPending.splice(0, embedPending.length);
    for (const memory of batch) {
      try {
        if (!memory?.id) continue;
        if (typeof embedder.schedule === "function") {
          embedder.schedule(memory);
        } else if (typeof embedder.embedSingle === "function") {
          const text = [memory.title, memory.content].filter(Boolean).join("\n");
          if (!text) continue;
          embedder
            .embedSingle(text)
            .then((vec) => {
              if (Array.isArray(vec) && vec.length) {
                store.setEmbedding(memory.id, vec);
              }
            })
            .catch((err) => {
              logger?.warn?.("flushEmbedPending embedSingle failed:", err);
            });
        }
      } catch (err) {
        logger?.warn?.("flushEmbedPending failed:", err);
      }
    }
  }

  function stopEmbedReadyPolling() {
    if (embedReadyTimer) {
      clearInterval(embedReadyTimer);
      embedReadyTimer = null;
    }
  }

  function scheduleEmbed(memory) {
    try {
      if (txDepth > 0) return; // deferred to the transaction's commit
      if (!embedder || !memory?.id) return;

      // Readiness gate: embedder exposes `ready` (async init) and is not ready
      // yet — queue instead of firing embedSingle into a half-built extractor.
      const hasReady = "ready" in embedder;
      if (hasReady && embedder.ready !== true) {
        if (embedPending.length >= EMBED_PENDING_MAX) embedPending.shift();
        embedPending.push(memory);
        return;
      }

      if (typeof embedder.schedule === "function") {
        embedder.schedule(memory);
        return;
      }

      if (typeof embedder.embedSingle === "function") {
        const text = [memory.title, memory.content].filter(Boolean).join("\n");
        if (!text) return;

        embedder
          .embedSingle(text)
          .then((vec) => {
            if (Array.isArray(vec) && vec.length) {
              store.setEmbedding(memory.id, vec);
            }
          })
          .catch((err) => {
            logger?.warn?.("scheduleEmbed embedSingle failed:", err);
          });
      }
    } catch (err) {
      logger?.warn?.("scheduleEmbed failed:", err);
    }
  }

  /**
   * Fire-and-forget entity extraction for a freshly saved memory (entity gene
   * v0.3.0). Opt-in via config.entityExtractionEnabled; the extractor is
   * injected as a hook so the service never needs a direct LLM reference.
   * The hook itself is expected to resolve to { ok:boolean } and never throw;
   * a thrown rejection is swallowed here as a final fail-safe.
   */
  function scheduleEntityExtraction(memory) {
    if (txDepth > 0) return; // deferred to the transaction's commit
    if (!config.entityExtractionEnabled || !entityExtractor) return;
    try {
      entityExtractor(memory).catch((err) => {
        logger?.warn?.("entity extraction failed:", err);
      });
    } catch (err) {
      logger?.warn?.("entity extraction failed:", err);
    }
  }

  /**
   * Fire-and-forget wiki-link resolution for a freshly saved/updated memory
   * (v0.6.1). Opt-in via config.wikiLinkEnabled. Parses [[target]] /
   * [[显示|target]] markers out of the memory content and writes links_to
   * relations (idempotent via the unique relation index). Runs through
   * service.enqueue so it serializes with autoDream/sleep and never overlaps
   * another background pass. Fully fail-safe: parse/store errors are swallowed
   * and logged, never a write failure.
   */
  function scheduleWikiLinkResolve(memory) {
    if (txDepth > 0) return; // deferred to the transaction's commit
    if (!config.wikiLinkEnabled || !memory?.id) return;
    try {
      const links = parseWikiLinks(memory?.content ?? "");
      if (!links.length) return;
      const targets = [...new Set(links.map((l) => l.target).filter(Boolean))];
      enqueue(() => {
        try {
          store.saveWikiLinks({ memoryId: memory.id, title: memory.title, targets });
        } catch (err) {
          logger?.warn?.("wiki link resolve failed:", err);
        }
      }).catch((err) => {
        logger?.warn?.("wiki link resolve failed:", err);
      });
    } catch (err) {
      logger?.warn?.("wiki link resolve failed:", err);
    }
  }

  /**
   * Cross-encoder rerank over a candidate list (best effort). Reranker
   * failures degrade to the original candidate order — reranking is an
   * accuracy upgrade, never a correctness gate.
   */
  async function rerankCandidates(query, candidates, topK) {
    if (!reranker || !candidates.length) return candidates.slice(0, topK);
    try {
      const scored = await reranker.rerank(query, candidates.map((c) => ({ id: c.id, title: c.title, content: c.content })));
      if (!Array.isArray(scored)) return candidates.slice(0, topK);
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const out = [];
      for (const s of scored) {
        const c = byId.get(s.id);
        if (c) { out.push({ ...c, score: s.score, source: "rerank" }); if (out.length >= topK) break; }
      }
      return out.length ? out : candidates.slice(0, topK);
    } catch {
      return candidates.slice(0, topK);
    }
  }

  /**
   * Search for memories attached to a named entity (v0.3.0 Phase 3).
   * 合并优先级：entity_attrs.memory_id 精确关联 = 1.0 > 关键词提及 = 0.7；
   * attr 命中不覆盖，keyword 只补充召回，最后按 _score 降序取 topK。
   * @param {string} entityName
   * @param {object} [options]
   * @param {number} [options.topK=20]
   * @returns {any[]}
   */
  function searchByEntity(entityName, { topK = 20 } = {}) {
    const entity = store.findEntityByName(entityName);
    if (!entity) return [];
    const attrs = store.getCurrentAttrs(entity.id);
    const memoryIds = [...new Set(attrs.map((a) => a.memory_id).filter(Boolean))];
    const attrHits = memoryIds.map((id) => store.getById(id)).filter(Boolean);
    const keywordHits = store.search(entityName, { limit: topK });
    const merged = new Map();
    for (const mem of attrHits) merged.set(mem.id, { ...mem, _source: "entity_attr", _score: 1.0 });
    for (const mem of keywordHits) {
      if (!merged.has(mem.id)) merged.set(mem.id, { ...mem, _source: "keyword", _score: 0.7 });
    }
    const hits = Array.from(merged.values()).sort((a, b) => b._score - a._score).slice(0, topK);
    touchRecalled(hits);
    return hits;
  }

  /**
   * Search for memories by attribute key/value (v0.3.0 Phase 3).
   * value 为空时由 store.findMemoriesByAttr 返回该 key 的全部有效记忆。
   * @param {string} key
   * @param {string | undefined} value
   * @param {object} [options]
   * @param {number} [options.topK=20]
   * @returns {any[]}
   */
  function searchByAttr(key, value, { topK = 20 } = {}) {
    if (!key) return [];
    // value 可能为 undefined（attr:key 无 = 值）：归一为空串后交给
    // store.findMemoriesByAttr —— 空 value 契约 = 返回该 attr_key 的全部
    // 当前有效记忆（v0.3.0，store.js 已实现）。
    const rows = store.findMemoriesByAttr(key, value ?? "");
    const hits = rows.slice(0, topK);
    touchRecalled(hits);
    return hits;
  }

  /**
   * Search for memories carrying a given tag set (v0.6.2). Multiple tag:
   * tokens in one query use AND semantics — a memory must carry every tag.
   * Combinable with the leftover query: an entity:/attr: prefix is intersected
   * with the tag-matched set, and plain keyword text ranks it (only rows whose
   * keyword score > 0 survive). Tags are first-class recall, not entity-gated:
   * the tag match itself does not depend on config.entitySearchEnabled.
   * @param {string[]} tagTokens
   * @param {string} q — leftover query after tag: tokens were stripped
   * @param {object} [options]
   * @param {number} [options.topK=20]
   * @returns {any[]}
   */
  function searchByTags(tagTokens, q, options) {
    const { topK = 20 } = options;
    const tags = (Array.isArray(tagTokens) ? tagTokens : [])
      .map((t) => String(t).trim()).filter(Boolean);
    if (!tags.length) return [];
    let hits = store.findMemoriesByTags(tags);
    if (!hits.length) return [];
    // Intersect with entity:/attr: prefixes present in the leftover query.
    if (config?.entitySearchEnabled) {
      if (q.startsWith("entity:")) {
        const ids = new Set(searchByEntity(q.slice(7).trim(), { topK: 10000 }).map((m) => m.id));
        hits = hits.filter((m) => ids.has(m.id));
      }
      if (q.startsWith("attr:")) {
        const [key, value] = q.slice(5).split("=");
        const ids = new Set(searchByAttr(key, value, { topK: 10000 }).map((m) => m.id));
        hits = hits.filter((m) => ids.has(m.id));
      }
    }
    // Leftover plain text ranks the tag-matched set; only rows whose title or
    // content actually mentions the keyword survive (scoreKeyword's 0.3 base is
    // a non-match, so the containment check is the real gate); otherwise
    // preserve insertion order.
    const keywordOnly = q && !q.startsWith("entity:") && !q.startsWith("attr:");
    hits = keywordOnly
      ? hits
          .map((m) => ({ ...m, score: scoreKeyword(m, q), source: "tag" }))
          .filter((m) => (m.title ?? "").toLowerCase().includes(q.toLowerCase())
            || (m.content ?? "").toLowerCase().includes(q.toLowerCase()))
          .sort((a, b) => b.score - a.score)
      : hits.map((m) => ({ ...m, source: "tag" }));
    const result = hits.slice(0, topK);
    // Only count toward recall stats/forgetting when the caller asked for
    // recording — the panel's `tag:` search must not pollute the curve.
    if (options.recordRecall) touchRecalled(result);
    return result;
  }

  /**
   * Semantic-aware memory search: keyword recall (store.search) plus optional
   * vector recall + rerank. mode:
   *   auto    (default) keyword first, vector fills remaining slots (legacy)
   *   hybrid  vector first, keyword fills remaining slots
   *   vector  vector only, falls back to keyword when unavailable
   *   keyword text only, never touches the embedder
   * useRerank runs the cross-encoder over the merged list when a reranker is
   * installed; results carry an extra `score` when reranked.
   */
  // Weighted blend factor for hybrid search; exposed so callers can tune it.
  const DEFAULT_HYBRID_WEIGHTS = { vector: 0.6, keyword: 0.4 };

  // Cosine over two plain arrays (shared by the search-time semantic dedup).
  function cosineVec(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * BM25 third recall path (v0.5.0 1.1). Scores the query tokens against the
   * live non-archived rows and returns the top `limit` hits with scores
   * normalized to [0,1]. Failures degrade to [] — BM25 is a recall booster,
   * never a correctness gate.
   */
  function bm25Recall(q, limit) {
    if (config?.bm25SearchEnabled === false) return [];
    try {
      const docs = store.list({ limit: 500, includeForgotten: false }).filter((m) => !m.archived && !m.session_disposed_at);
      if (!docs.length) return [];
      return createBM25Index(docs).search(q, { limit });
    } catch {
      return [];
    }
  }

  /**
   * Search-time semantic dedup (v0.5.0 2.3): greedy pass dropping candidates
   * whose embedding similarity to an already-kept row exceeds the threshold.
   * Rows without a stored embedding are always kept (no signal = no drop).
   */
  function semanticDeduplicate(candidates) {
    // Opt-in aggressive mode (default off): collapsing near-duplicates can
    // drop legitimately distinct rows on small embedding models, so it ships
    // behind searchSemanticDedup=true.
    if (config?.searchSemanticDedup !== true || candidates.length < 2) return candidates;
    const threshold = config?.searchSemanticDedupThreshold ?? 0.95;
    try {
      const vecs = store.getEmbeddings(candidates.map((c) => c.id));
      if (vecs.size < 2) return candidates;
      const kept = [];
      for (const c of candidates) {
        const v = vecs.get(c.id);
        if (!v) { kept.push(c); continue; }
        const dup = kept.some((k) => {
          const kv = vecs.get(k.id);
          return kv && cosineVec(v, kv) > threshold;
        });
        if (!dup) kept.push(c);
      }
      return kept;
    } catch {
      return candidates;
    }
  }

  /**
   * Give a keyword-hit row a relevance score in [0,1]: title hits score
   * higher than content hits, then scaled by importance (1-5). This lets
   * keyword results participate in weighted hybrid blends.
   */
  function scoreKeyword(row, q) {
    const ql = q.toLowerCase();
    const title = (row.title ?? "").toLowerCase();
    const content = (row.content ?? "").toLowerCase();
    const titleHit = title.includes(ql);
    const base = titleHit ? 1 : content.includes(ql) ? 0.6 : 0.3;
    return base * (0.5 + (row.importance ?? 3) / 10);
  }

  /**
   * Recall touch (v0.7.0 数据前提): any memory surfaced by recall or
   * auto-injection gets its last_accessed_at bumped so the heat model has a
   * truthful access clock. Previously gated on config.sleepModeEnabled — now
   * gated on config.heatEnabled (default on) so heat data is collected
   * independently of sleep mode; sleep consumes it when it runs. Best-effort:
   * a touch failure must never break search/inject.
   */
  function touchRecalled(memories) {
    if (config?.heatEnabled === false || !Array.isArray(memories) || memories.length === 0) return;
    for (const m of memories) {
      if (!m?.id) continue;
      try {
        store.touchLastAccess(m.id);
      } catch { /* touch is best effort */ }
    }
  }

  async function searchMemories(query, options = {}) {
    // v0.7.0: recall_runs 记录默认开（config.recallRecordDefault，默认 true）；
    // 显式传 recordRecall:false 或配置 recallRecordDefault:false 可关。
    const {
      mode = "auto",
      topK = 20,
      threshold,
      useRerank = true,
      recordRecall = options.recordRecall ?? (config?.recallRecordDefault ?? true)
    } = options;
    const raw = String(query ?? "").trim();
    if (!raw) return [];

    // tag: 前缀（v0.6.2）。先把所有 tag: 令牌从 query 里剥出来，剩余的 q 仍可带
    // entity:/attr: 前缀或普通关键词 —— searchByTags 负责交集/排序。没有 tag:
    // 令牌则走下面的 entity:/attr:/文本原逻辑（完全向后兼容）。
    const tagTokens = [];
    const q = raw.replace(/\btag:([^\s]+)/g, (_, tok) => {
      if (tok) tagTokens.push(tok);
      return "";
    }).trim();
    if (tagTokens.length) return searchByTags(tagTokens, q, options);

    // entity:/attr: 前缀路由（v0.3.0 Phase 3）。entitySearchEnabled 关闭时走原逻辑。
    if (config?.entitySearchEnabled) {
      if (q.startsWith("entity:")) {
        return searchByEntity(q.slice(7).trim(), options);
      }
      if (q.startsWith("attr:")) {
        const [key, value] = q.slice(5).split("=");
        return searchByAttr(key, value, options);
      }
    }

    const lim = topK > 0 ? topK : 20;

    // Keyword results, decorated with a score so they can be weight-blended
    // with vector results and reported uniformly. source tracks where each
    // candidate came from for the recall layer receipt.
    const rawKeyword = store.search(q, { limit: lim });
    const keyword = rawKeyword.map((m) => ({ ...m, score: scoreKeyword(m, q), source: "keyword" }));
    const wantVector = mode === "vector" || mode === "hybrid" || (mode === "auto" && !!embedder);
    let vector = [];
    if (wantVector && embedder) {
      try {
        // Legacy embedders expose embed(query); local ones expose embedSingle.
        const embedSingle = typeof embedder.embedSingle === "function"
          ? embedder.embedSingle.bind(embedder)
          : embedder.embed.bind(embedder);
        const qv = await embedSingle(q);
        if (qv?.length) {
          // Adaptive threshold (v0.5.0 1.2): the fetch runs at the loosest
          // branch floor so the head-gap rule can still re-admit the tail;
          // the final cutoff is computed against the fetched score
          // distribution. Explicit `threshold` wins; disabled → legacy 0.
          const adaptive = config?.adaptiveThresholdEnabled !== false;
          const fetchThreshold = adaptive && threshold === undefined
            ? Math.min(0.5, adaptiveThreshold(q))
            : (threshold ?? 0);
          const search = vectorIndex
            ? vectorIndex.search(qv, { limit: lim * 2, threshold: fetchThreshold })
            : store.searchVector(qv, { limit: lim * 2, threshold: fetchThreshold });
          const finalThreshold = adaptive && threshold === undefined
            ? adaptiveThreshold(q, search)
            : (threshold ?? 0);
          vector = search
            .filter((m) => (m.score ?? 1) >= finalThreshold)
            .map((m) => ({ ...m, vector: true, source: "vector" }));
        }
      } catch { /* vector unavailable: keep keyword results */ }
    }

    // BM25 third path (v0.5.0 1.1): IDF-weighted token overlap recalls rows
    // whose query terms are scattered — the gap LIKE substring matching
    // cannot close. Scores are already normalized to [0,1].
    const bm25 = bm25Recall(q, lim).map((m) => ({ ...m, source: "bm25" }));
    // Loose blend weight: BM25 confirms and backfills, never dominates the
    // semantic signal. Same-memory overlap boosts, unseen ids backfill.
    const wb = 0.3;
    // Path bookkeeping for the boost rule below: which ids each semantic
    // recall path surfaced.
    const vectorIds = new Set(vector.map((m) => m.id));
    const keywordIds = new Set(keyword.map((m) => m.id));

    // Hybrid blending weights from config when provided.
    const wv = config?.hybridSearchVectorWeight ?? DEFAULT_HYBRID_WEIGHTS.vector;
    const wk = config?.hybridSearchKeywordWeight ?? DEFAULT_HYBRID_WEIGHTS.keyword;

    let merged;
    if (mode === "keyword") {
      merged = keyword;
    } else if (mode === "vector" || mode === "hybrid") {
      // semantic-first: vector recalls lead, keyword + BM25 fill remaining
      // slots. Weighted blend when sides scored the same memory; otherwise
      // vector order leads (it is the semantic signal), lexical paths
      // backfill.
      const byId = new Map();
      for (const m of vector) {
        const rec = byId.get(m.id);
        byId.set(m.id, rec ? { ...rec, score: Math.max(rec.score ?? 0, m.score ?? 0) } : m);
      }
      for (const m of keyword) {
        const rec = byId.get(m.id);
        if (rec) {
          // Same memory from both sides: blend the scores.
          byId.set(m.id, { ...rec, score: (rec.score ?? 0) * wv + (m.score ?? 0) * wk });
        } else {
          byId.set(m.id, m);
        }
      }
      for (const m of bm25) {
        const rec = byId.get(m.id);
        if (rec) {
          // Boost rule: a row the LIKE keyword path already hit carries the
          // query as a substring, so BM25 tokens are trivially present —
          // boosting it double-counts lexical evidence. Only vector-recalled
          // rows (lexical hit is genuinely new information) get the boost.
          if (keywordIds.has(m.id)) continue;
          byId.set(m.id, { ...rec, score: (rec.score ?? 0) + wb * (m.score ?? 0) });
        } else {
          byId.set(m.id, { ...m, score: wb * (m.score ?? 0) });
        }
      }
      const ranked = [...byId.values()]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map((r) => ({ ...r, score: Math.max(0, Math.min(1, r.score ?? 0)) }));
      // Tag boost (v0.6.4) needs the full ranked pool, not just the top-lim
      // slice, so a tagged candidate just below the line can be re-admitted
      // after the boost. Without boost this is the legacy lim truncation.
      merged = config.tagBoostEnabled === true ? ranked : ranked.slice(0, lim);
      if (merged.length < lim && !merged.length) {
        // Vector unavailable entirely: fall back to plain keyword.
        merged = keyword.slice(0, lim);
      }
    } else {
      // auto: keyword leads, vector + BM25 fill remaining slots (legacy
      // behavior, extended with the third path)
      merged = keyword.slice(0, lim);
      const seen = new Set(merged.map((m) => m.id));
      for (const m of vector) {
        if (merged.length >= lim) break;
        if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
      }
      for (const m of bm25) {
        if (merged.length >= lim) break;
        if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
      }
    }

    // Search-time semantic dedup (v0.5.0 2.3): near-duplicate rows are
    // dropped before the reranker sees them, so topK slots carry distinct
    // information instead of the same memory twice. Keyword mode is exempt —
    // it is the documented text-only path and must not be altered by
    // embedding state.
    merged = mode === "keyword" ? merged : semanticDeduplicate(merged);

    // Tag-weighted re-rank (v0.6.4): boost candidates whose tags overlap the
    // query tags or the current session's hot-memory tags — applied BEFORE the
    // final top-K cut so tagged candidates just below the line can be
    // re-admitted. Opt-in, and skipped entirely on the keyword-only path. When
    // a reranker is configured (opt-in), it remains the final authority on
    // order; the boost still shapes which candidates reach it.
    if (config.tagBoostEnabled === true && mode !== "keyword" && merged.length) {
      const ids = merged.map((m) => m.id);
      const tagsMap = store.getMemoryTagsMap(ids);
      const enriched = merged.map((m) => ({ ...m, tags: tagsMap.get(m.id) ?? [] }));
      const knownTags = [...tagsMap.values()].flat();
      const queryTags = extractQueryTags(q, knownTags);
      const sessionTags = Array.isArray(options?.sessionTags) ? options.sessionTags : [];
      if (queryTags.length || sessionTags.length) {
        merged = applyTagBoost(enriched, {
          queryTags,
          sessionTags,
          factor: config.tagBoostFactor,
          sessionFactor: config.sessionTagBoostFactor,
        }).map(({ tags, ...rest }) => rest);
      }
    }
    merged = merged.slice(0, lim);

    let result = useRerank && reranker && merged.length
      ? await rerankCandidates(q, merged, lim)
      : merged;
    // Epistemic trust (v0.4.5): opt-in re-weighting of the final candidate
    // scores by source credibility. When off (default) `result` is returned
    // untouched — exactly the legacy behavior.
    if (config.trustEpistemicWeighting === true) {
      result = result
        .map((m) => ({
          ...m,
          score: (m.score ?? 0) * (EPISTEMIC_WEIGHTS[m.epistemic_status] ?? 1)
        }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, lim);
    }

    // Recall layer receipt: with recordRecall on, hand the actual merged
    // candidate list (id/title/content/score/source) to the injected recorder
    // before returning, making the retrieval scene replayable — the sibling of
    // the dream judgment-layer audit trail. Recorder failures must never break
    // the search itself.
    if (recordRecall && recallRecorder) {
      try {
        recallRecorder({
          query: q,
          mode,
          topK: lim,
          threshold: threshold ?? null,
          // v0.7.0 recall-layer 强度标记：搜索帧一律 injected:false（被召回 =
          // 检索直接命中）；注入上下文帧由 injectCandidates 以 injected:true
          // 单独记账（被注入 = 替对话搭建上下文），两档强度可区分。
          candidates: result.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            source: m.source ?? "keyword",
            injected: false
          })),
          createdAt: new Date().toISOString()
        });
      } catch { /* recall receipt is best effort */ }
    }
    // Bug4: cache the latest semantic recall so the sync injection path can
    // reuse it when the injection query matches (no async embed available).
    lastSemanticRecall = { query: q, items: result };
    touchRecalled(result);
    return result;
  }

  /**
   * Retrieval evaluation (方案 B): run one search for `query`, compare the ids
   * it actually returned against `expectedIds`, and return the computed
   * metrics. When persistence is on (config.evalPersistTestResults, or an
   * explicit `persist` override per call) the snapshot is written to the
   * recall_evals table — a SEPARATE store from the recall_runs production audit,
   * so test/eval data never inflates the production trail.
   *
   * options:
   *   mode/topK/threshold/useRerank — passed through to searchMemories
   *   evalType                      — label for the snapshot (default 'manual')
   *   recordRecall                  — also write a recall_runs audit row for the
   *                                   same scene and link it via recall_run_id
   *                                   (default false: eval stays unlinked)
   *   recallRunId                   — explicit link to an existing recall_runs id
   *   persist                       — override the config gate for this call
   *
   * Returns { metrics, actualIds, expectedIds, recallRunId, persisted }.
   * Never throws on persistence failures: a broken eval write must not break
   * the retrieval quality measurement.
   */
  async function evaluateRetrieval(query, expectedIds, options = {}) {
    const q = String(query ?? "").trim();
    const expected = Array.isArray(expectedIds) ? expectedIds : [];
    const {
      mode = "auto",
      topK = 20,
      threshold,
      useRerank = true,
      evalType = "manual",
      recordRecall = false,
      recallRunId = null,
      persist = config.evalPersistTestResults === true
    } = options;
    if (!q) {
      const empty = computeRetrievalMetrics([], expected);
      return { metrics: empty, actualIds: [], expectedIds: expected, recallRunId: null, persisted: false };
    }

    const rows = await searchMemories(q, { mode, topK, threshold, useRerank, recordRecall: false });
    const actualIds = rows.map((m) => m.id);
    const metrics = computeRetrievalMetrics(actualIds, expected);

    // Optional recall_runs audit for the same scene; the eval row then links to
    // it. Kept separate from the production recorder (which fires only on
    // recordRecall=true inside searchMemories) — eval never double-records.
    // An explicit recallRunId wins; recordRecall only mints a NEW audit run when
    // the caller did not already link one (never clobber an existing link).
    let runId = recallRunId ?? null;
    if (recordRecall && runId === null) {
      try {
        const run = store.saveRecallRun({
          query: q,
          mode,
          topK,
          threshold: threshold ?? null,
          candidates: rows.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            source: m.source ?? "keyword"
          })),
          created_at: new Date().toISOString()
        });
        runId = run.id;
      } catch { /* non-fatal: the eval itself still succeeds */ }
    }

    let persisted = false;
    if (persist) {
      try {
        store.saveRecallEval({
          recall_run_id: runId,
          query: q,
          expected_ids: expected,
          actual_ids: actualIds,
          metrics,
          eval_type: evalType,
          created_at: new Date().toISOString()
        });
        persisted = true;
      } catch { /* non-fatal: measurement survives a failed eval write */ }
    }
    return { metrics, actualIds, expectedIds: expected, recallRunId: runId, persisted };
  }

  /**
   * Fire-and-forget write notification; errors are swallowed to keep write
   * paths clean. The store mutation has already committed, so a throwing
   * subscriber must not surface as a write failure. Archive/forget flags are
   * state toggles, not content writes, so they never notify.
   */
  function notifyWrite() {
    if (txDepth > 0) return; // deferred to the transaction's commit
    if (onWrite) {
      try { onWrite(); } catch { /* ignore */ }
    }
    if (dreamHook) {
      try { dreamHook(); } catch { /* ignore */ }
    }
    if (sleepHook) {
      try { sleepHook(); } catch { /* ignore */ }
    }
  }

  /**
   * Run several store mutations atomically (SQLite BEGIN/COMMIT/ROLLBACK) and
   * fire the deferred side effects once against the committed state. A throwing
   * body rolls the whole batch back — no partial writes, no diverged mirror.
   * Errors propagate to the caller. NOTE: the commit path re-renders the mirror
   * and notifies subscribers, but re-embedding is left to the caller (the dream
   * flow re-embeds through maintainIndexAfterDream).
   */
  function transaction(fn) {
    store.db.exec("BEGIN");
    txDepth++;
    try {
      const result = fn();
      store.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { store.db.exec("ROLLBACK"); } catch { /* store may be closed */ }
      throw error;
    } finally {
      txDepth--;
      // Sync failures are surfaced, not swallowed (peer blocker 2): the mirror
      // debt was already recorded by markMirrorDirty inside syncMirror, so a
      // restart recovers — but the operator must see it now, not after restart.
      const syncResult = syncMirror();
      if (!syncResult?.success && !syncResult?.deferred) {
        logger?.warn?.("mirror sync failed after transaction:", syncResult?.error);
      }
      notifyWrite();
    }
  }

  /**
   * Embed an arbitrary query text and return its vector (null on failure / no
   * embedder). Used by the injector to prefetch the semantic-first recall
   * vector for the current user message — the system-prompt render is
   * synchronous, so the vector must be cached in advance (Bug4).
   */
  async function embedQuery(query) {
    const q = String(query ?? "").trim();
    if (!q || !embedder) return null;
    try {
      const embedSingle = typeof embedder.embedSingle === "function"
        ? embedder.embedSingle.bind(embedder)
        : embedder.embed.bind(embedder);
      const vector = await embedSingle(q);
      return Array.isArray(vector) && vector.length ? vector : null;
    } catch {
      return null;
    }
  }

  /**
   * Save a memory, merging into an existing one when title matches within the same type.
   *
   * Bug5: a same-title merge no longer overwrites — the new content is appended
   * under a timestamped `---` separator (`旧内容\n\n---\n[时间戳] 新内容`) and the
   * previous content is archived into content_history (source: auto_merge, FIFO
   * capped at 20). importance takes the max of both (capped at 5). Callers that
   * truly replace a row (dream summary regeneration) pass `_overwrite: true` to
   * overwrite directly while still archiving the old version (source: overwrite).
   * mergeHumanEdits entry points pass `_humanEdited: true` — same direct
   * overwrite semantics, source: human_override.
   *
   * Bug7 (memory quality filter): when config.memoryQualityFilter.enabled, the
   * memory is scored after dedupe, before write:
   *   score >= degradeThreshold        → stored normally (score persisted)
   *   archiveThreshold <= score < 60   → persisted + ranked degraded
   *   score < archiveThreshold         → archived + tagged low_quality (still
   *                                      explicitly searchable via includeArchived)
   * @returns {{action: "created"|"merged", memory: object}}
   */
  function saveWithDedupe(memory) {
    // Bug7: score quality once (after dedupe lookup, before write). Failures
    // inside the evaluator are impossible (pure function), but the write that
    // records the score must never fail the save — wrap defensively.
    const qf = config.memoryQualityFilter;
    let quality = null;
    if (qf?.enabled === true) {
      try {
        const recentContents = store.all().slice(0, 20).map((m) => m.content ?? "");
        quality = evaluateMemoryQuality(memory, {
          minContentLength: qf.minContentLength ?? 10,
          recentContents
        });
      } catch { /* quality scoring is best-effort */ }
    }
    const existing = store
      .list({ type: memory.type, limit: 100 })
      .find((m) => m.title.trim() === String(memory.title).trim());
    if (existing) {
      const newContent = String(memory.content ?? "");
      if (!newContent.trim()) {
        // Nothing to merge: the row stays untouched.
        return { action: "merged", memory: existing };
      }
      const direct = memory._overwrite === true || memory._humanEdited === true;
      const content = direct
        ? newContent
        : appendContent(existing.content, newContent);
      const importance = Math.min(5, Math.max(existing.importance, memory.importance ?? existing.importance));
      const merged = store.update(existing.id, {
        content,
        importance,
        tags: memory.tags ?? existing.tags,
        title: memory.title ?? existing.title,
        content_history: pushContentHistory(existing, direct
          ? (memory._humanEdited === true ? "human_override" : "overwrite")
          : "auto_merge"),
        ...(quality ? { quality_score: quality.score } : {})
      });
      // Bug7: a degraded/archived result is applied on top of the merged row.
      const result = applyQualityDisposition(merged, quality, qf);
      // Bridge tool-passed tags (plus any quality signal tags) into the
      // entity_attrs tag store so directory / tag: recall / tagBoost see them
      // (issue #31). Must run before afterSync so the mirror re-render reads
      // the bridged row. Unconditional on the array (empty included): a merge
      // that clears tags must also invalidate any stale entity_attrs row from
      // an earlier save, or the directory keeps showing the old tag.
      if (Array.isArray(result.tags)) store.setMemoryTags(result.id, result.tags);
      afterSync("write");
      notifyWrite();
      scheduleEmbed(result);
      scheduleWikiLinkResolve(result);
      return { action: "merged", memory: result };
    }
    const created = store.save({
      type: memory.type,
      title: memory.title,
      content: memory.content,
      tags: memory.tags ?? [],
      importance: memory.importance ?? 3,
      source: memory.source ?? "manual",
      // Provenance (v0.5.x): birth session rides through the create path; the
      // merge path above preserves the original row's session_id untouched.
      session_id: memory.session_id ?? undefined,
      ...(quality ? { quality_score: quality.score } : {})
    });
    const result = applyQualityDisposition(created, quality, qf);
    // Bridge tool-passed tags (plus any quality signal tags) into the
    // entity_attrs tag store so directory / tag: recall / tagBoost see them
    // (issue #31). Must run before afterSync so the mirror re-render reads
    // the bridged row.
    if (Array.isArray(result.tags) && result.tags.length) store.setMemoryTags(result.id, result.tags);
    afterSync("write");
    notifyWrite();
    scheduleEmbed(result);
    scheduleEntityExtraction(result);
    scheduleWikiLinkResolve(result);
    return { action: "created", memory: result };
  }

  /**
   * Bug7: apply the quality verdict to a freshly written row. Below the archive
   * threshold the memory is archived + tagged low_quality (still searchable
   * explicitly via includeArchived); between archive and degrade thresholds the
   * score is already persisted and only the injection ranking is affected
   * (importance × score/100). Best-effort: a disposition write failure must
   * never fail the save. Returns the (possibly refreshed) memory row so callers
   * see the archived/tagged state, not the pre-disposition snapshot.
   */
  function applyQualityDisposition(memory, quality, qf) {
    if (!quality || qf?.enabled !== true) return memory;
    const archiveThreshold = qf.archiveThreshold ?? 30;
    // Signal tags (meta / repetitive / duplicate / short_content / low_quality)
    // are merged onto the stored row in every assessed band so the verdict is
    // observable, not just the numeric score. Below the archive threshold the
    // memory is additionally archived (still explicitly searchable).
    const tags = [...new Set([...(memory.tags ?? []), ...(quality.tags ?? [])])];
    if (tags.length === (memory.tags?.length ?? 0) && quality.score >= archiveThreshold) {
      return memory; // no tag drift and not archived → nothing extra to write
    }
    try {
      store.update(memory.id, { tags, quality_score: quality.score });
      if (quality.score < archiveThreshold) store.setArchived(memory.id, true);
      return store.getById(memory.id);
    } catch {
      return memory;
    }
  }

  /**
   * Candidate memories for automatic context injection:
   * summaries first, then all preferences, then non-forgotten items with
   * importance >= threshold. History is never auto-injected. Archived entries
   * are excluded (store.list already filters them by default; the extra
   * !m.archived check is kept as double insurance).
   *
   * Bug4 (hybridInject): when a non-empty `query` is available and a matching
   * semantic recall was cached by the last searchMemories, the vector hits
   * lead the selection (up to maxItems*2 candidates) and the rule-based pick
   * fills + dedupes the remaining slots. Empty query / no cached recall /
   * hybridInject off → pure legacy rule-based selection.
   */
  function injectCandidates({ query = "", maxItems = 5, threshold = 3, queryVector } = {}) {
    const q = String(query ?? "").trim();
    // Bug7: quality-weighted importance in the rule-based tier. Unassessed rows
    // (quality_score null) count as 100 (weight 1), so legacy stores keep their
    // exact summary>preference>importance ordering.
    const qualityWeight = (m) => (m.quality_score != null ? m.quality_score / 100 : 1);
    // summary/user/preference are injected regardless of importance (context
    // layers); every other INJECT_TYPES type (e.g. fact) only when
    // importance >= threshold — the frontend "常注入" badge maps to this split.
    const items = store.list({ limit: 200, includeForgotten: false })
      .filter((m) => !m.archived && INJECT_TYPES.has(m.type) && !m.forgotten &&
        (m.type === "summary" || m.type === "preference" || m.type === "user" || m.importance >= threshold))
      .sort((a, b) => {
        const pa = a.type === "summary" ? 0 : (a.type === "preference" || a.type === "user") ? 1 : 2;
        const pb = b.type === "summary" ? 0 : (b.type === "preference" || b.type === "user") ? 1 : 2;
        return pa - pb || (b.importance * qualityWeight(b)) - (a.importance * qualityWeight(a));
      });
    let candidates = items;
    if (config.hybridInject !== false && q) {
      // Bug4: semantic-first recall. Vector hits (queryVector, cached by the
      // injector's async prefetch) lead when present; otherwise the last
      // searchMemories recall for the exact same query is reused. Rule-based
      // items fill + dedupe the remaining slots. Empty query / no vector /
      // no cached recall → pure legacy rule-based selection.
      const semanticItems = [];
      if (Array.isArray(queryVector) && queryVector.length && vectorIndex) {
        try {
          const hits = vectorIndex.search(queryVector, { limit: maxItems * 2, threshold: 0 });
          for (const m of hits) {
            if (m && !m.archived && INJECT_TYPES.has(m.type) && !m.forgotten &&
              (m.type === "summary" || m.type === "preference" || m.type === "user" || m.importance >= threshold)) {
              semanticItems.push(m);
            }
          }
        } catch { /* vector unavailable: fall through to the recall cache */ }
      }
      if (!semanticItems.length && lastSemanticRecall?.query === q && lastSemanticRecall.items?.length) {
        for (const m of lastSemanticRecall.items) {
          if (m && !m.archived && INJECT_TYPES.has(m.type) && !m.forgotten) semanticItems.push(m);
        }
      }
      if (semanticItems.length) {
        const seen = new Set();
        const merged = [];
        const push = (m) => {
          if (seen.has(m.id)) return;
          seen.add(m.id);
          merged.push(m);
        };
        for (const m of semanticItems) {
          push(m);
          if (merged.length >= maxItems * 2) break;
        }
        for (const m of items) {
          if (merged.length >= maxItems * 2) break;
          push(m);
        }
        candidates = merged;
      }
    }
    // Topic-ranked selection (v0.5.0 2.2): when the current query's vector is
    // available the whole candidate list is re-ordered by similarity to that
    // vector, so the injected slots go to memories on the current topic
    // rather than to the rule-based order. Rows the index did not return
    // keep their relative order after the scored ones.
    if (config?.selectiveInjectEnabled !== false && Array.isArray(queryVector) && queryVector.length && vectorIndex) {
      try {
        const hits = vectorIndex.search(queryVector, { limit: 200, threshold: 0 });
        const sim = new Map(hits.map((m) => [m.id, m.score ?? 0]));
        if (sim.size) {
          candidates = [...candidates].sort((a, b) => (sim.get(b.id) ?? -1) - (sim.get(a.id) ?? -1));
        }
      } catch { /* topic re-rank unavailable: keep rule-based order */ }
    }
    const selected = candidates.slice(0, maxItems);
    // v0.7.0 recall-layer 强度标记：注入场景也走 recall_runs 记账（mode="inject"、
    // injected:true），与 searchMemories 的搜索帧（injected:false）互补，区分
    // "被召回"与"被注入上下文"两个消耗强度。与搜索侧同受 recallRecordDefault
    // 门控；记账失败绝不阻断注入本身。
    if (recallRecorder && config.recallRecordDefault !== false) {
      try {
        recallRecorder({
          query: q,
          mode: "inject",
          topK: selected.length,
          threshold: null,
          candidates: selected.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            // 注入帧的 source 固定为帧级标记 "inject"，与搜索帧的
            // keyword/vector/rerank 对齐（记忆行自带的 source 是来源列，
            // 与检索层级无关，不混入）。
            source: "inject",
            injected: true
          })),
          createdAt: new Date().toISOString()
        });
      } catch { /* recall receipt is best effort */ }
    }
    touchRecalled(selected);
    return selected;
  }

  /**
   * Merge human edits parsed from a mirror file back into the store.
   * Only content/title are taken; structure fields stay machine-owned.
   */
  function mergeHumanEdits(type, edits) {
    let applied = 0;
    for (const edit of edits) {
      if (!edit.id) continue; // corrupt/malformed edit: skip it, keep merging the rest
      const existing = store.getById(edit.id);
      if (!existing || existing.type !== type) continue;
      const patch = {};
      if (typeof edit.title === "string" && edit.title.trim()) patch.title = edit.title.trim();
      if (typeof edit.content === "string" && edit.content.trim()) patch.content = edit.content.trim();
      if (Object.keys(patch).length) {
        // 启动回灌（F-NEW-01）：digest 存在且匹配 = 文件自渲染后无人触碰（旧机器
        // 镜像），机器 wins，DB 的 New 必须保留，静默改回 Old 是 bug。
        const digestMatches = typeof edit.digest === "string"
          && typeof edit.title === "string"
          && typeof edit.content === "string"
          && createHash("sha256").update(`${edit.title}\x00${edit.content}`).digest("hex") === edit.digest;
        if (digestMatches) continue;
        // 文件 == store（无实际变化）时不覆盖，也不计入 applied。
        const hasDiff = (patch.title !== undefined && existing.title !== patch.title)
          || (patch.content !== undefined && existing.content !== patch.content);
        if (!hasDiff) continue;
        // 人工编辑回灌后触发 re-embed（issue #3 残留修复）：向量必须与
        // 新 title/content 一致。scheduleEmbed 为 fire-and-forget，
        // 内部 try/catch 吞错，失败不影响主流程。
        // Bug5: human edits overwrite directly, but the machine version is
        // archived into content_history (source: human_override) before being
        // replaced, so a manual correction never silently destroys the old value.
        const merged = store.update(edit.id, {
          ...patch,
          content_history: patch.content !== undefined && existing.content !== patch.content
            ? pushContentHistory(existing, "human_override")
            : existing.content_history
        });
        applied++;
        scheduleEmbed(merged);
      }
    }
    if (applied) {
      afterSync("write");
      notifyWrite();
    }
    return applied;
  }

  function toApiList(rows) {
    return rows.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      importance: m.importance,
      source: m.source,
      // session_id is optional on the wire: only carry it when present, so the
      // DTO stays a lossless JSON object (undefined would vanish on serialize).
      ...(m.session_id != null ? { session_id: m.session_id } : {}),
      // Disposed state rides along when set, so a restore flow is not a blind
      // op — the caller can see which entries are hidden before restoreBySession.
      ...(m.session_disposed_at != null ? { disposed: true } : {}),
      created_at: m.created_at,
      updated_at: m.updated_at
    }));
  }

  /**
   * Directory view (v0.6.3): group live memories by tag. Delegates to
   * store.getDirectory (tag-sorted groups, importance/updated DESC members,
   * live-only filtering) and maps every memory to the wire DTO so the result
   * is JSON-safe for the API endpoint.
   * @returns {{groups: {tag: string, memories: object[]}[], untagged: object[]}}
   */
  function getDirectory() {
    const { groups, untagged } = store.getDirectory();
    return {
      groups: groups.map((g) => ({ tag: g.tag, memories: toApiList(g.memories) })),
      untagged: toApiList(untagged)
    };
  }

  /**
   * Three-way merge of in-flight human mirror edits before a re-render.
   * Runs on every syncMirror, so a human edit made between two store writes is
   * never silently overwritten by the next sync (human priority is not limited
   * to startup). Per edited entry:
   *   - file changed only → human wins; the edit is merged back into the store.
   *   - file AND store changed → real three-way conflict: keep the human edit
   *     and append a marker preserving the store's concurrent version, so no
   *     side is dropped.
   *   - store changed only → store wins (the file is simply re-rendered).
   * Only title/content are taken (structure fields stay machine-owned, matching
   * mergeHumanEdits). Returns the memory list to render.
   */
  function reconcileHumanEdits(memories) {
    if (!mirror) return memories;
    const byType = new Map();
    for (const m of memories) {
      if (!byType.has(m.type)) byType.set(m.type, []);
      byType.get(m.type).push(m);
    }
    const result = [];
    for (const type of Object.keys(TYPE_FILE)) {
      const list = byType.get(type) ?? [];
      if (list.length === 0) continue;
      const editsById = new Map(mirror.readHumanEdits(type).map((e) => [e.id, e]));
      for (const m of list) {
        const edit = editsById.get(m.id);
        if (!edit) { result.push(m); continue; }
        const humanChanged = (typeof edit.title === "string" && edit.title !== m.title)
          || (typeof edit.content === "string" && edit.content !== m.content);
        if (!humanChanged) { result.push(m); continue; }
        // 判断文件是否被人工动过：digest 存在且匹配则无人触碰，否则视为人工动过。
        // digest 是渲染时对 sha256(title \x00 content) 的记录；机器 store 更新后
        // 镜像还没重渲染时读到旧内容，digest 仍匹配 → 机器 wins，不会误判为
        // 并发人工编辑导致机器写丢失 + 伪冲突标记。
        const digestMatches = typeof edit.digest === "string"
          && typeof edit.title === "string"
          && typeof edit.content === "string"
          && createHash("sha256").update(`${edit.title}\x00${edit.content}`).digest("hex") === edit.digest;
        if (digestMatches) {
          // 无人触碰，机器 wins，走原样
          result.push(m);
          continue;
        }
        // 人工动过（digest 不存在=老文件/手工文件保守视为人工动过），走三方合并
        // （保留现有 storeChanged 逻辑）
        const storeChanged = edit.updated_at !== undefined && m.updated_at !== edit.updated_at;
        if (storeChanged) {
          const marker = `\n\n> ⚠️ 并发冲突：人工编辑 vs 记忆库并发更新（${m.updated_at}）\n> 记忆库版本：${m.content}`;
          store.update(m.id, { title: edit.title, content: `${edit.content}${marker}` });
        } else {
          store.update(m.id, { title: edit.title, content: edit.content });
        }
        const merged = store.getById(m.id);
        scheduleEmbed(merged);
        result.push(merged);
      }
    }
    return result;
  }

  /**
   * Re-render the human-editable mirror after any store mutation, merging any
   * in-flight human edits first (never silently overwriting them). Only
   * non-forgotten memories are mirrored: forgotten entries must not reach the
   * human-editable file (a human "edit" could otherwise resurrect them).
   */
  // syncMirror: 同步 mirror，并在失败/成功时持久记录 dirty 状态；保证自身不抛出。
  // v0.3.6（audit peer 4 阻断）：
  //   - 开始时 incrementGeneration 绑定本次期望轮次 gen；成功用
  //     markMirrorCleanForGeneration(gen, now) CAS/fence 清 dirty——旧 worker
  //     （gen 已过期）不会误清另一 worker 未恢复的故障债务；
  //   - 失败写 markMirrorDirty（递增 desired 绑定新债务），下次 recover 恢复；
  //   - 逐 type 用 setTypeStatus 记录部分成功/失败（type_status JSON）；
  //   - 所有 store 状态写入各自 try/catch，失败只 warn，绝不向外抛（F-NEW-03）。
  function syncMirror() {
    if (txDepth > 0 || !mirror) return { success: true, deferred: true }; // deferred to the transaction's commit
    const now = new Date().toISOString();
    let gen;
    try {
      // desired generation 已在业务写事务中原子递增（peer blocker 1）；这里
      // 直接读当前值作为本次同步的目标轮次，不再自行 incrementGeneration。
      const state = store.getMirrorState();
      gen = state?.generation ?? 0;
    } catch (stateError) {
      logger?.warn?.("syncMirror: getMirrorState failed:", stateError);
      return { success: false, error: stateError?.message ?? String(stateError) };
    }
    // coveredTypes 提到 try 外初始化：即使 store.list 先抛错，catch 分支也有
    // 合法的空 Set 可迭代，保证 syncMirror 自身绝不抛（fail-safe）。
    const coveredTypes = new Set();
    try {
      // 预先获取本次要覆盖的 type 集合（只调一次 store.list）
      const list = store.list({ limit: 500, includeForgotten: false });
      for (const memory of list) {
        if (memory?.type && TYPE_FILE[memory.type]) {
          coveredTypes.add(memory.type);
        }
      }

      // Per-type physical outcome (audit peer D): mirror.sync writes each type
      // file independently and reports per-type success/failure. A type whose
      // file was physically committed must be marked committed even when a
      // sibling type errors — the old code batch-failed every type on any error,
      // leaving committed files mislabeled as failed and masking partial state.
      // Absent entries (a type with no memories) count as success: sync prunes
      // the stale file, which is itself a completed physical state.
      // v0.6.2: attach entity_attrs-backed tags (entityTags) after the human-edit
      // merge so renderMemory can draw the `#tag` line under each title. The
      // bulk map is a single query, and a missing row simply renders no line.
      const reconciled = reconcileHumanEdits(list);
      const tagsMap = store.getMemoryTagsMap(reconciled.map((m) => m.id));
      const tagged = reconciled.map((m) => ({ ...m, entityTags: tagsMap.get(m.id) ?? [] }));
      let allOk = true;
      const results = mirror.sync(tagged) ?? {};
      for (const type of Object.keys(TYPE_FILE)) {
        const r = results[type];
        const ok = !r || r.ok === true;
        if (!ok) allOk = false;
        try {
          if (ok) {
            store.setTypeStatus(type, { status: "committed", applied_gen: gen, last_error: null });
          } else {
            store.setTypeStatus(type, { status: "failed", last_error: r.error ?? "mirror sync failed" });
          }
        } catch (stateError) {
          logger?.warn?.(`syncMirror: setTypeStatus(${type}) failed:`, stateError);
        }
      }

      // 全部 type 物理收敛：CAS/fence 绑定到本地 gen，旧 worker（gen 已过期）会被
      // 拦截。此步失败说明核心 clean 状态没写成功，向上层报失败（不再静默）。
      if (allOk) {
        try {
          store.markMirrorCleanForGeneration(gen, now);
        } catch (stateError) {
          logger?.warn?.("syncMirror: markMirrorCleanForGeneration failed:", stateError);
          return { success: false, error: stateError?.message ?? String(stateError) };
        }
        return { success: true };
      }

      // 部分 type 失败：持久 dirty（债务绑定到新轮次），下次 recover 只补未收敛
      // 的 type。committed 的 type 已应用本轮 gen，不因兄弟失败被回滚。
      const failedTypes = Object.entries(results)
        .filter(([, r]) => r && r.ok === false)
        .map(([t]) => t);
      try {
        store.markMirrorDirty(`mirror sync failed for: ${failedTypes.join(", ")}`, now);
      } catch (stateError) {
        logger?.warn?.("syncMirror: markMirrorDirty failed:", stateError);
      }
      return { success: false, error: `mirror sync failed for: ${failedTypes.join(", ")}` };
    } catch (error) {
      const errMsg = error?.message ?? String(error);
      logger?.warn?.("syncMirror failed:", error);
      try {
        // 债务绑定到新的一轮（desired generation 原子递增；即便 dirty 写失败，
        // generation 已推进，recoverMirror 仍能捕获，不产生 false-clean）。
        store.markMirrorDirty(errMsg, now);
      } catch (stateError) {
        logger?.warn?.("syncMirror: markMirrorDirty failed:", stateError);
      }
      // 逐 type 标记为 failed（applied_gen 不动）
      for (const type of coveredTypes) {
        try {
          store.setTypeStatus(type, { status: "failed", last_error: errMsg });
        } catch (stateError) {
          logger?.warn?.(`syncMirror: setTypeStatus(${type}) failed:`, stateError);
        }
      }
      return { success: false, error: errMsg };
    }
  }

  // afterSync: run syncMirror and surface a failure to the operator instead of
  // swallowing it (peer blocker 2 + audit peer B). The mirror debt has already
  // been persisted by markMirrorDirty inside syncMirror, so a restart recovers —
  // but the calling write path must not report clean while the mirror is
  // known-stale. Returns the sync result so the caller can attach an explicit
  // degraded/pending receipt to its return value instead of faking success.
  function afterSync(label) {
    const r = syncMirror();
    if (!r?.success && !r?.deferred) {
      logger?.warn?.(`${label}: mirror sync failed (will recover on restart):`, r?.error);
    }
    return r;
  }

  // recoverMirror: 启动/手动 reconcile 时根据持久 dirty 状态决定是否恢复同步
  // （F-NEW-03 + v0.3.6）。触发条件不只是 dirty——还检查
  // generation > applied_generation（有未应用的债务），这样 COMMIT→dirty 崩溃
  // 窗口（DB 提交后、markMirrorDirty/clean 前进程退出 → dirty=false 但
  // generation 不一致）也能被捕获。有界重试（最多 3 次）重跑 syncMirror 收敛；
  // 某次成功后 dirty=false 且无更新债务（generation <= applied_generation）
  // 立即停止。返回 { recovered, error } 供 index.js 启动 / api.js health 判断。
  // 一切 fail-safe，绝不向外抛。
  function recoverMirror() {
    const MAX_ATTEMPTS = 3;
    let lastError = null;
    let recovered = false;

    try {
      const state = store.getMirrorState();
      // 崩溃窗口检测：dirty 或 generation > applied_generation（COMMIT→dirty 窗口）
      if (!state?.dirty && !(state.generation > state.applied_generation)) {
        // 本来就干净：无需恢复，视为成功
        return { recovered: true, error: null };
      }

      // 有 dirty 或有未应用债务：最多尝试 3 次 sync
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          syncMirror(); // syncMirror 内部已 catch，不会向外抛
          const currentState = store.getMirrorState();
          // 成功条件：dirty 为 false 且没有更新一轮的债务
          // （generation <= applied_generation，恢复后由 syncMirror 里
          //   markMirrorCleanForGeneration 自动把 applied 跟上）
          if (!currentState?.dirty && currentState.generation <= currentState.applied_generation) {
            recovered = true;
            lastError = null;
            break;
          }
          // 仍 dirty 或仍有更新债务：记录最后一次错误供重试耗尽后上报。
          // 注意：若别的 worker 又失败产生新债务（dirty 仍 true），这是"新债务"
          // 不是本次失败，继续重试直到耗尽次数。
          lastError = currentState.last_error || `Sync attempt ${attempt + 1} left mirror dirty or has pending debt`;
        } catch (syncError) {
          // syncMirror 理论不抛，fail-safe 兜底
          const errMsg = syncError?.message ?? String(syncError);
          logger?.warn?.("recoverMirror: sync attempt failed:", errMsg);
          lastError = errMsg;
        }
      }

      if (!recovered) {
        logger?.warn?.("dsh-mneme mirror: recover failed after", MAX_ATTEMPTS, "attempts");
      } else {
        logger?.warn?.("dsh-mneme mirror: recovered from dirty/pending state");
      }
    } catch (error) {
      // fail-safe：任何意外异常不向外抛
      lastError = error?.message ?? String(error);
      logger?.warn?.("dsh-mneme mirror: recover failed with unexpected error:", error);
    }

    return { recovered, error: recovered ? null : lastError };
  }

  // getMirrorHealth: 暴露 mirror 同步健康状态，供 api.js /health 使用
  // （F-NEW-03）。把 DB 的 dirty 0/1 转成 boolean；fail-safe，绝不向外抛。
  function getMirrorHealth() {
    try {
      const state = store.getMirrorState();
      if (!state) {
        // 无状态行：返回安全默认值
        return {
          dirty: false,
          last_error: null,
          last_attempt: null,
          success_at: null
        };
      }
      return {
        dirty: Boolean(state.dirty),
        last_error: state.last_error ?? null,
        last_attempt: state.last_attempt ?? null,
        success_at: state.success_at ?? null
      };
    } catch (error) {
      // fail-safe：状态读取失败也不向外抛，但必须显式表达"未知"而非伪装成
      // 干净（peer blocker 5：真实读取失败要显式 unknown，不得归一为 dirty:false）。
      logger?.warn?.("getMirrorHealth failed:", error);
      return {
        dirty: null,
        last_error: error?.message ?? String(error),
        last_attempt: null,
        success_at: null
      };
    }
  }

  /**
   * Forward links (v0.6.1): memories the given memory explicitly links to via
   * [[wiki-links]] in its content. Reads the links_to relations whose
   * from_entity is this memory's title and resolves each to_entity back to a
   * memory row (case-insensitive title match). Returns [{ target, relation }];
   * a target title with no matching memory surfaces as { target: null }.
   */
  function getForwardLinks(memoryId) {
    const memory = store.getById(memoryId);
    if (!memory) return [];
    const out = [];
    for (const rel of store.getRelations(memory.title) ?? []) {
      if (rel.relation_type !== "links_to" || rel.from_entity !== memory.title) continue;
      out.push({ target: store.findByTitle?.(rel.to_entity) ?? null, relation: rel });
    }
    return out;
  }

  /**
   * Back links (v0.6.1): memories that explicitly link TO the given memory
   * (their content carries a wiki-link whose target resolves to this memory's
   * title). Reads the links_to relations whose to_entity is this memory's
   * title; the linking memory is rel.memory_id (the source that wrote the
   * relation). Deduped per source memory; missing/self links are dropped.
   * Returns [{ source, relation }].
   */
  function getBacklinks(memoryId) {
    const memory = store.getById(memoryId);
    if (!memory) return [];
    const out = [];
    const seen = new Set();
    for (const rel of store.getRelations(memory.title) ?? []) {
      if (rel.relation_type !== "links_to" || rel.to_entity !== memory.title) continue;
      const source = rel.memory_id ? store.getById(rel.memory_id) : undefined;
      if (!source || source.id === memory.id || seen.has(source.id)) continue;
      seen.add(source.id);
      out.push({ source, relation: rel });
    }
    return out;
  }

  return {
    saveWithDedupe,
    getBacklinks,
    getForwardLinks,
    resolveWikiLink: (title) => store.findByTitle?.(title),
    recoverMirror,
    getMirrorHealth,
    getMirrorState: () => store.getMirrorState(),
    injectCandidates,
    mergeHumanEdits,
    toApiList,
    getDirectory,
    transaction,
    enqueue,
    setDreamHook(fn) { dreamHook = fn; },
    setSleepHook(fn) { sleepHook = fn; },
    setEmbedder(emb) {
      embedder = emb;
      if (!emb) {
        // embedder removed (init failed in index.js): stop polling and drop
        // queued re-embeds — search just degrades to keyword.
        stopEmbedReadyPolling();
        embedPending = [];
        return;
      }
      if (emb.ready === true) {
        flushEmbedPending();
        return;
      }
      // Async-initializing embedder: poll `ready` until it flips, then flush.
      if ("ready" in emb && embedReadyTimer === null) {
        let attempts = 0;
        embedReadyTimer = setInterval(() => {
          attempts++;
          if (emb.ready === true || attempts >= EMBED_READY_POLL_LIMIT) {
            stopEmbedReadyPolling();
            if (emb.ready === true) flushEmbedPending();
            else embedPending = []; // init never landed: drop the queue
          }
        }, EMBED_READY_POLL_MS);
      }
    },
    setEntityExtractor(fn) { entityExtractor = fn; },
    setVectorIndex(vi) { vectorIndex = vi; },
    setReranker(rn) { reranker = rn; },
    setRecallRecorder(fn) { recallRecorder = fn; },
    searchMemories,
    embedQuery,
    evaluateRetrieval,
    computeRetrievalMetrics,
    // passthroughs used by tools and api layers; mutations keep the mirror in sync
    search: (q, o) => store.search(q, o),
    searchVector: (v, o) => store.searchVector(v, o),
    embeddedCount: () => store.embeddedCount(),
    list: (o) => store.list(o),
    all: () => store.all(),
    count: (type, opts) => store.count(type, opts),
    stats: (opts) => store.stats(opts),
    getById: (id) => store.getById(id),
    remove: (id) => {
      store.remove(id);
      afterSync("write");
      notifyWrite();
    },
    // Session lifecycle (v0.6.0): mark/clear the session-disposed state on every
    // memory born in a given session. Uses the dedicated `session_disposed_at`
    // column, orthogonal to `archived` — restoring a session never resurrects
    // memories the user archived on purpose. Nothing is destroyed; a session
    // treated as a save point is fully recoverable via restoreBySession.
    disposeBySession: (sessionId) => {
      const disposed = store.setDisposedBySession(sessionId, true);
      if (disposed > 0) {
        afterSync("write");
        notifyWrite();
      }
      return { disposed };
    },
    restoreBySession: (sessionId) => {
      const restored = store.setDisposedBySession(sessionId, false);
      if (restored > 0) {
        afterSync("write");
        notifyWrite();
      }
      return { restored };
    },
    listBySession: (sessionId, opts = {}) => toApiList(store.listBySession(sessionId, opts)),
    update: (id, p, ctx = {}) => {
      const old = store.getById(id);
      const updated = store.update(id, p);
      // Bridge tag edits made through update (memory_update tool / panel) into
      // the entity_attrs tag store too (issue #31) — same convergence as
      // saveWithDedupe. An explicit empty array clears the live tag row, moving
      // the memory back to `untagged`.
      if (p?.tags !== undefined) store.setMemoryTags(updated.id, updated.tags);
      // Record a user correction when any meaningful field changed and the
      // reflection failure tracker is enabled. expected = what it became,
      // actual = what it was before; query (when provided) captures the
      // user's original intent so later reflection can reason about recall.
      const hasMeaningfulChange = old && updated && (
        old.content !== updated.content ||
        old.title !== updated.title ||
        old.importance !== updated.importance
      );
      if (hasMeaningfulChange && config.reflectionFailureTracking) {
        store.saveFailure({
          id: randomUUID(),
          query: ctx.query ?? null,
          expected: updated.content,
          actual: old.content,
          before: { title: old.title, content: old.content, importance: old.importance },
          failure_type: "user_correction",
          memory_id: id
        });
      }
      const sync = afterSync("write");
      notifyWrite();
      scheduleEmbed(updated);
      scheduleWikiLinkResolve(updated);
      // Audit peer B: when the mirror sync failed, the store write landed but
      // the mirror did not converge — return an explicit degraded receipt rather
      // than a plain success. Non-enumerable so existing deepEqual assertions on
      // the memory shape keep passing.
      if (!sync?.success && !sync?.deferred) {
        Object.defineProperty(updated, "_mirror", {
          value: { status: "degraded", error: sync?.error ?? "mirror sync failed" },
          enumerable: false,
          configurable: true
        });
      }
      return updated;
    },
    // Compare-and-set update: applies the patch only when the row still carries
    // `expectedUpdatedAt`. Returns undefined on a miss (no write) so the caller
    // can re-read and retry — the primitive that prevents lost updates across
    // concurrent read-modify-write (see scripts/stress-dsh.js axis 3).
    compareAndUpdate: (id, expectedUpdatedAt, patch, ctx = {}) => {
      const old = store.getById(id);
      const updated = store.compareAndUpdate(id, expectedUpdatedAt, patch);
      if (updated === undefined) return undefined; // CAS miss: no write, no side effects
      const hasMeaningfulChange = old && updated && (
        old.content !== updated.content ||
        old.title !== updated.title ||
        old.importance !== updated.importance
      );
      if (hasMeaningfulChange && config.reflectionFailureTracking) {
        store.saveFailure({
          id: randomUUID(),
          query: ctx.query ?? null,
          expected: updated.content,
          actual: old.content,
          before: { title: old.title, content: old.content, importance: old.importance },
          failure_type: "user_correction",
          memory_id: id
        });
      }
      const sync = afterSync("write");
      notifyWrite();
      scheduleEmbed(updated);
      // Audit peer B: mirror sync failure on a CAS write must surface too.
      if (!sync?.success && !sync?.deferred) {
        Object.defineProperty(updated, "_mirror", {
          value: { status: "degraded", error: sync?.error ?? "mirror sync failed" },
          enumerable: false,
          configurable: true
        });
      }
      return updated;
    },
    setForget: (id, f) => {
      const updated = store.setForget(id, f);
      afterSync("write");
      return updated;
    },
    setArchived: (id, f) => {
      const updated = store.setArchived(id, f);
      afterSync("write");
      return updated;
    },
    // sleep-mode storage (v0.4.0). demoteToSummary / restoreContent mutate
    // content so they ride the normal write-hook path (mirror re-renders).
    // touchLastAccess is a read-stamp — deliberately NO write hook (a recall
    // must not dirty the mirror). getUnrecalledSince is a pure read.
    demoteToSummary: (id, summary, opts) => {
      const updated = store.demoteToSummary(id, summary, opts);
      afterSync("write");
      return updated;
    },
    restoreContent: (id) => {
      const updated = store.restoreContent(id);
      afterSync("write");
      return updated;
    },
    touchLastAccess: (id, at) => store.touchLastAccess(id, at),
    getUnrecalledSince: (cutMs, opts) => store.getUnrecalledSince(cutMs, opts),
    // autoDream audit trail: passthroughs deliberately bypass write hooks —
    // an audit write is bookkeeping, and notifyWrite would loop back into the
    // dream scheduler that just recorded the run.
    saveDreamRun: (run) => store.saveDreamRun(run),
    getDreamRun: (id) => store.getDreamRun(id),
    listDreamRuns: (opts) => store.listDreamRuns(opts),
    // Per-record receipt chain (same bookkeeping semantics as saveDreamRun: an
    // audit write, never a write-hook-triggering memory mutation).
    saveReceipt: (r) => store.saveReceipt(r),
    getReceipt: (id) => store.getReceipt(id),
    listReceipts: (opts) => store.listReceipts(opts),
    // Conflict freeze bookkeeping (same semantics as the audit passthroughs
    // above: an audit write, never a write-hook-triggering memory mutation).
    saveConflictPending: (r) => store.saveConflictPending(r),
    listConflictPending: (opts) => store.listConflictPending(opts),
    resolveConflictPending: (id, o) => store.resolveConflictPending(id, o),
    countConflictPending: () => store.countConflictPending(),
    // Recall evaluation trail (方案 B): audit-bookkeeping semantics like the
    // dream/recall passthroughs above — a recall_evals write is a snapshot, not
    // a memory mutation, so it never triggers write hooks.
    saveRecallEval: (r) => store.saveRecallEval(r),
    getRecallEval: (id) => store.getRecallEval(id),
    listRecallEvals: (opts) => store.listRecallEvals(opts),
    // LLM audit trail (Bug8): bookkeeping semantics like the recall/dream
    // passthroughs — a saveLlmAudit write never triggers write hooks.
    saveLlmAudit: (entry) => store.saveLlmAudit(entry),
    listLlmAudits: (opts) => store.listLlmAudits(opts),
    countLlmAudits: (opts) => store.countLlmAudits(opts),
    getLlmAuditStats: (opts) => store.getLlmAuditStats(opts),
    deleteOldLlmAudits: (before) => store.deleteOldLlmAudits(before),
    // Entity gene (v0.3.0) passthroughs for the autoDream apply path
    // (applyDecisions): records supersedes relations after an update and
    // migrates entity_attrs on merge. Bookkeeping writes like the audit
    // passthroughs above — never write-hook-triggering memory mutations.
    saveRelation: (r) => store.saveRelation(r),
    saveWikiLinks: (r) => store.saveWikiLinks(r),
    listEntities: (o) => store.listEntities(o),
    getRelations: (id) => store.getRelations(id),
    // v0.7.0 实体热投影：实体热 = 关联记忆 heat 聚合（取 max）。无关联记忆
    // 或 heatEnabled=false 时返回 null；前端据此决定图谱节点大小/明暗。
    entityHeat: (entityId) => {
      if (config.heatEnabled === false) return null;
      const rels = store.getRelations(entityId) ?? [];
      let max = -Infinity;
      for (const rel of rels) {
        if (!rel.memory_id) continue;
        const mem = store.getById(rel.memory_id);
        if (!mem) continue;
        const h = computeHeat(mem, Date.now(), config);
        if (h > max) max = h;
      }
      return max === -Infinity ? null : max;
    },
    // Tag system (v0.6.2). setMemoryTags is the manual/user path: gated by
    // config.manualTagEnabled (default true), re-renders the mirror and fires
    // the write hook. applyMemoryTags is the raw write used by the autoDream
    // tag pass (gated by autoTagEnabled, wrapped in a transaction by the
    // extractor so the mirror re-renders exactly once).
    setMemoryTags: (memoryId, tags) => {
      if (tagConfig().manualTagEnabled === false) {
        return { ok: false, error: "manualTagEnabled is off" };
      }
      const stored = store.setMemoryTags(memoryId, tags);
      afterSync("write");
      notifyWrite();
      return { ok: true, tags: stored };
    },
    getMemoryTags: (memoryId) => store.getMemoryTags(memoryId),
    // Read-only gate flag so the Web panel can hide tag editing when the
    // manual path is disabled (default: manual tagging is on).
    manualTagEnabled: () => tagConfig().manualTagEnabled !== false,
    // Effective tag toggle pair (settings-over-config merge) for the panel
    // (/api/dsh-mneme/config GET/PUT).
    getTagConfig: tagConfig,
    getAppConfig: appConfig,
    applyMemoryTags: (memoryId, tags) => store.setMemoryTags(memoryId, tags),
    saveAttr: (r) => store.saveAttr(r),
    createEntity: (r) => store.createEntity(r),
    findEntityByName: (n) => store.findEntityByName(n),
    findEntityById: (id) => store.findEntityById(id),
    getAttrsByMemory: (id) => store.getAttrsByMemory(id),
    getCurrentAttrs: (id) => store.getCurrentAttrs(id),
    migrateAttrsToMemory: (fromId, toId, now) => store.migrateAttrsToMemory(fromId, toId, now)
  };
}
