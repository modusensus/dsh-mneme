import { createHash, randomUUID } from "node:crypto";
import { TYPE_FILE } from "./mirror.js";

const INJECT_TYPES = new Set(["preference", "project", "decision", "summary"]);

export function createService({ store, mirror, config, onWrite }) {
  // Optional dream scheduler hook, installed via setDreamHook after creation
  // (the scheduler holds a reference back to the service, so it cannot be
  // passed in the constructor). Fired on the same write events as onWrite.
  let dreamHook = null;

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

  // Optional recall recorder, installed via setRecallRecorder after creation.
  // When searchMemories is called with recordRecall=true it receives the
  // actual merged recall scene (candidates + scores + source + threshold) so
  // the retrieval layer can be audited/replayed — the sibling of the dream
  // judgment-layer audit trail (dream_runs).
  let recallRecorder = null;

  // Transaction nesting depth. Inside service.transaction the per-mutation side
  // effects (mirror render, write notify, re-embed) are deferred so a ROLLBACK
  // never leaves the mirror file diverged from the database; transaction()
  // replays them exactly once against the committed state.
  let txDepth = 0;

  function scheduleEmbed(memory) {
    if (txDepth > 0) return; // deferred to the transaction's commit
    if (embedder && memory?.id) {
      try { embedder.schedule(memory); } catch { /* ignore */ }
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
        console.warn("entity extraction failed:", err);
      });
    } catch (err) {
      console.warn("entity extraction failed:", err);
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
   * 合并优先级（桉桉确认）：entity_attrs.memory_id 精确关联 = 1.0 > 关键词提及 = 0.7；
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
    return Array.from(merged.values()).sort((a, b) => b._score - a._score).slice(0, topK);
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
    return rows.slice(0, topK);
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

  async function searchMemories(query, options = {}) {
    const { mode = "auto", topK = 20, threshold, useRerank = true, recordRecall = false } = options;
    const q = String(query ?? "").trim();
    if (!q) return [];

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
          const hits = vectorIndex
            ? vectorIndex.search(qv, { limit: lim * 2, threshold: threshold ?? 0 })
            : store.searchVector(qv, { limit: lim * 2, threshold: threshold ?? 0 });
          vector = hits.map((m) => ({ ...m, vector: true, source: "vector" }));
        }
      } catch { /* vector unavailable: keep keyword results */ }
    }

    // Hybrid blending weights from config when provided.
    const wv = config?.hybridSearchVectorWeight ?? DEFAULT_HYBRID_WEIGHTS.vector;
    const wk = config?.hybridSearchKeywordWeight ?? DEFAULT_HYBRID_WEIGHTS.keyword;

    let merged;
    if (mode === "keyword") {
      merged = keyword;
    } else if (mode === "vector" || mode === "hybrid") {
      // semantic-first: vector recalls lead, keyword fills remaining slots.
      // Weighted blend when both sides scored the same memory; otherwise
      // vector order leads (it is the semantic signal), keyword backfills.
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
      const ranked = [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      merged = ranked.slice(0, lim);
      if (merged.length < lim && !merged.length) {
        // Vector unavailable entirely: fall back to plain keyword.
        merged = keyword.slice(0, lim);
      }
    } else {
      // auto: keyword leads, vector fills remaining slots (legacy behavior)
      merged = keyword.slice(0, lim);
      const seen = new Set(merged.map((m) => m.id));
      for (const m of vector) {
        if (merged.length >= lim) break;
        if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
      }
    }

    merged = merged.slice(0, lim);
    const result = useRerank && reranker && merged.length
      ? await rerankCandidates(q, merged, lim)
      : merged;

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
          candidates: result.map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            score: m.score ?? null,
            source: m.source ?? "keyword"
          })),
          createdAt: new Date().toISOString()
        });
      } catch { /* recall receipt is best effort */ }
    }
    return result;
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
      try {
        syncMirror();
      } catch (error) {
        console.warn("syncMirror failed after transaction:", error);
      }
      notifyWrite();
    }
  }

  /**
   * Save a memory, merging into an existing one when title matches within the same type.
   * @returns {{action: "created"|"merged", memory: object}}
   */
  function saveWithDedupe(memory) {
    const existing = store
      .list({ type: memory.type, limit: 100 })
      .find((m) => m.title.trim() === String(memory.title).trim());
    if (existing) {
      const merged = store.update(existing.id, {
        content: memory.content ?? existing.content,
        importance: memory.importance ?? existing.importance,
        tags: memory.tags ?? existing.tags,
        title: memory.title ?? existing.title
      });
      syncMirror();
      notifyWrite();
      scheduleEmbed(merged);
      return { action: "merged", memory: merged };
    }
    const created = store.save({
      type: memory.type,
      title: memory.title,
      content: memory.content,
      tags: memory.tags ?? [],
      importance: memory.importance ?? 3,
      source: memory.source ?? "manual"
    });
    syncMirror();
    notifyWrite();
    scheduleEmbed(created);
    scheduleEntityExtraction(created);
    return { action: "created", memory: created };
  }

  /**
   * Candidate memories for automatic context injection:
   * summaries first, then all preferences, then non-forgotten items with
   * importance >= threshold. History is never auto-injected. Archived entries
   * are excluded (store.list already filters them by default; the extra
   * !m.archived check is kept as double insurance).
   */
  function injectCandidates({ maxItems = 5, threshold = 3 } = {}) {
    const items = store.list({ limit: 200, includeForgotten: false })
      .filter((m) => !m.archived && INJECT_TYPES.has(m.type) && !m.forgotten &&
        (m.type === "summary" || m.type === "preference" || m.importance >= threshold))
      .sort((a, b) => {
        const pa = a.type === "summary" ? 0 : a.type === "preference" ? 1 : 2;
        const pb = b.type === "summary" ? 0 : b.type === "preference" ? 1 : 2;
        return pa - pb || b.importance - a.importance;
      });
    return items.slice(0, maxItems);
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
        store.update(edit.id, patch);
        applied++;
      }
    }
    if (applied) {
      syncMirror();
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
      created_at: m.created_at,
      updated_at: m.updated_at
    }));
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
  function syncMirror() {
    if (txDepth > 0 || !mirror) return; // deferred to the transaction's commit
    try {
      mirror.sync(reconcileHumanEdits(store.list({ limit: 500, includeForgotten: false })));
    } catch (error) {
      console.warn("syncMirror failed:", error);
    }
  }

  return {
    saveWithDedupe,
    injectCandidates,
    mergeHumanEdits,
    toApiList,
    transaction,
    setDreamHook(fn) { dreamHook = fn; },
    setEmbedder(emb) { embedder = emb; },
    setEntityExtractor(fn) { entityExtractor = fn; },
    setVectorIndex(vi) { vectorIndex = vi; },
    setReranker(rn) { reranker = rn; },
    setRecallRecorder(fn) { recallRecorder = fn; },
    searchMemories,
    // passthroughs used by tools and api layers; mutations keep the mirror in sync
    search: (q, o) => store.search(q, o),
    searchVector: (v, o) => store.searchVector(v, o),
    embeddedCount: () => store.embeddedCount(),
    list: (o) => store.list(o),
    all: () => store.all(),
    count: (type, opts) => store.count(type, opts),
    getById: (id) => store.getById(id),
    remove: (id) => {
      store.remove(id);
      syncMirror();
      notifyWrite();
    },
    update: (id, p, ctx = {}) => {
      const old = store.getById(id);
      const updated = store.update(id, p);
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
      syncMirror();
      notifyWrite();
      scheduleEmbed(updated);
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
      syncMirror();
      notifyWrite();
      scheduleEmbed(updated);
      return updated;
    },
    setForget: (id, f) => {
      const updated = store.setForget(id, f);
      syncMirror();
      return updated;
    },
    setArchived: (id, f) => {
      const updated = store.setArchived(id, f);
      syncMirror();
      return updated;
    },
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
    // Entity gene (v0.3.0) passthroughs for the autoDream apply path
    // (applyDecisions): records supersedes relations after an update and
    // migrates entity_attrs on merge. Bookkeeping writes like the audit
    // passthroughs above — never write-hook-triggering memory mutations.
    saveRelation: (r) => store.saveRelation(r),
    getAttrsByMemory: (id) => store.getAttrsByMemory(id),
    migrateAttrsToMemory: (fromId, toId, now) => store.migrateAttrsToMemory(fromId, toId, now)
  };
}
