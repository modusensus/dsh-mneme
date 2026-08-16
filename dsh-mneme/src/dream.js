import { validateDecisions, applyDecisions } from "./dream/decisions.js";
import { clusterMemories, findPotentialConflicts } from "./dream/clustering.js";
import { createHash, randomUUID } from "node:crypto";
export { validateDecisions, applyDecisions };

const SUMMARY_PROMPT = `你是记忆库摘要助手。根据整理后的记忆，生成一段 150-200 字的记忆库总览，覆盖：用户偏好、活跃项目、关键决策。之后作为会话上下文注入。只输出摘要文本，不要其他内容。`;

const CONSOLIDATION_PROMPT = `你是记忆库整理助手。下面是全部记忆条目（id、类型、标题、内容、重要性、更新时间）。
请执行记忆巩固（consolidation）：
1. 识别主题相近的条目 → 输出 merge（合并为更精炼的摘要，保留信息最完整的 id 作为 keepSource）
2. 识别重复/过时信息 → 输出 archive
3. 识别内容矛盾的条目 → 输出 conflict（根据时间新旧、来源完整性、信息具体程度判断 winner/loser）
4. 发现单条记忆中的信息已过时、错误或遗漏 → 输出 update（直接修正内容）
   - update 的 ids 只能包含一个 id
   - 必须提供修正后的 title 和/或 content
   - 仅当内容确实需要修正时才使用，不要滥用
   - 每次整理最多输出 2 个 update
   - 24 小时内新建的记忆不可 update
5. 无问题的条目 → 输出 keep

规则：
- 每条记忆至少出现在一个决策中
- merge 的 keepSource 必须是 ids 之一
- 仅合并同类型条目（type 相同）
- 不要编造 ids；只使用提供的 id
- 重要性 1-5，合并后取最高
- update 只能改一条，且要有实际变化
- 只输出 JSON 数组，不要其他文字`;

function totalChars(memories) {
  return memories.reduce((sum, m) => sum + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0);
}

// ---------------------------------------------------------------- audit

/**
 * Canonical digest of the consolidation input snapshot. Built from stable
 * fields sorted by id, so identical inputs always yield the same hash — the
 * basis for replaying/verifying a recorded decision (receipt check).
 */
export function hashSnapshot(memories) {
  const canon = memories
    .map((m) => [m.id, m.type, m.title, m.content, m.importance, m.updated_at])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((parts) => parts.map((p) => String(p ?? "")).join("\u0001"))
    .join("\u0002");
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Compact machine-verifiable receipt for one autoDream run. Format:
 *   dsh-mneme:run:<runId>:<status>:<snapshotHash(12)>:<inputCount>:<applied>:<summaryFlag>
 * Enough to correlate a run with its persisted audit row and to spot silent
 * drift (same snapshot hash + same decisions must reproduce the same outcome).
 */
export function buildReceipt({ runId, status, snapshotHash, inputCount, applied, summaryStored }) {
  return `dsh-mneme:run:${runId}:${status}:${snapshotHash.slice(0, 12)}:${inputCount}:${applied}:${summaryStored ? 1 : 0}`;
}

/**
 * Parse a receipt back into fields; returns undefined for malformed input.
 */
export function parseReceipt(receipt) {
  if (typeof receipt !== "string") return undefined;
  const parts = receipt.split(":");
  if (parts.length !== 8 || parts[0] !== "dsh-mneme" || parts[1] !== "run") return undefined;
  const [, , runId, status, snapshotHash, inputCount, applied, summaryStored] = parts;
  // reconcile = decisions validated but one or more did not commit (CAS
  // conflict / transaction rollback) — the store diverges from the decision
  // list and the run must be reconciled, never reported as a fake ok.
  if (!runId || !/^(ok|noop|degraded|reconcile|failed)$/.test(status)) return undefined;
  const count = Number(inputCount);
  const appliedN = Number(applied);
  if (!Number.isInteger(count) || !Number.isInteger(appliedN)) return undefined;
  return { runId, status, snapshotHash, inputCount: count, applied: appliedN, summaryStored: summaryStored === "1" };
}

/**
 * Derive the per-id disposition (keep / merge-keep / merge-archived /
 * archived / conflict-winner / conflict-archived) from a validated decision
 * list. Stored in the audit row so a run can be replayed without re-running
 * the LLM.
 */
export function buildOutcome(decisions) {
  const byId = {};
  for (const d of decisions ?? []) {
    if (d.action === "keep") {
      for (const id of d.ids) byId[id] = "keep";
    } else if (d.action === "archive") {
      for (const id of d.ids) byId[id] = "archived";
    } else if (d.action === "merge") {
      for (const id of d.ids) byId[id] = id === d.keepSource ? "merge-keep" : "merge-archived";
    } else if (d.action === "conflict") {
      byId[d.winner] = "conflict-winner";
      byId[d.loser] = "conflict-archived";
    } else if (d.action === "update") {
      for (const id of d.ids) byId[id] = "updated";
    }
  }
  return { byId };
}

/**
 * Consume an LLM stream and return the accumulated text. Direct text-delta
 * accumulation covers both the real protocol ({type:"text-delta", index, text})
 * and looser test doubles ({type:"text-delta", text}); a terminal error/abort
 * surfaces as undefined. The caller decides how to treat an empty result.
 */
async function streamText(ctx, options) {
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      return undefined;
    }
  }
  return text;
}

/**
 * Resolve the LLM route: agent default model (deployment) first, plugin config
 * (dreamProvider/dreamModel) as fallback. Falls through to undefined when no
 * route exists — runDream then fails safe. Fallback is logged so a silent
 * route switch is observable.
 */
function resolveRoute(ctx, config, logger) {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
    logger?.warn?.("dsh-mneme dream: agentDefaultModel unavailable, falling back to config route");
  } catch (error) {
    logger?.warn?.(`dsh-mneme dream: agentDefaultModel lookup failed, falling back to config route: ${String(error)}`);
  }
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  return undefined;
}

// ------------------------------------------------------- semantic enhancement
// Best-effort: any failure here degrades to plain consolidation. The dream
// path must never be broken by an unavailable embedder/index.

/** Backfill + return vectors for every memory; null when impossible. */
async function collectVectors(memories, semantic) {
  const { embedder, vectorIndex } = semantic;
  if (!embedder || !vectorIndex || typeof embedder.embedSingle !== "function") return null;
  const vectors = new Array(memories.length);
  const missing = [];
  for (let i = 0; i < memories.length; i++) {
    const cached = vectorIndex.getEmbedding?.(memories[i].id);
    if (cached) vectors[i] = cached;
    else missing.push(i);
  }
  if (missing.length) {
    const texts = missing.map((i) => [memories[i].title, memories[i].content].filter(Boolean).join("\n"));
    const rows = await embedder.embed(texts);
    missing.forEach((mi, j) => {
      if (rows[j]?.length) {
        vectors[mi] = rows[j];
        vectorIndex.saveEmbedding(memories[mi].id, rows[j]);
      }
    });
  }
  return vectors.some((v) => !v) ? null : vectors;
}

/**
 * Rebuild the vector index after dream decisions so the store and the index
 * stay in sync: merged-away/archived/conflict-loser rows lose their vectors,
 * the merge keeper gets a fresh one.
 */
async function maintainIndexAfterDream(decisions, service, semantic) {
  const { embedder, vectorIndex } = semantic;
  if (!embedder || !vectorIndex || typeof embedder.embedSingle !== "function") return;
  const rebuild = new Map();
  for (const d of decisions ?? []) {
    if (d.action === "merge") {
      for (const id of d.ids ?? []) {
        if (id !== d.keepSource) vectorIndex.deleteEmbedding(id);
      }
      if (d.keepSource) {
        const keeper = service.getById(d.keepSource);
        if (keeper) rebuild.set(keeper.id, [keeper.title, keeper.content].filter(Boolean).join("\n"));
      }
    } else if (d.action === "archive" || d.action === "conflict") {
      for (const id of d.ids ?? [d.loser]) vectorIndex.deleteEmbedding(id);
    } else if (d.action === "update") {
      const id = d.ids[0];
      const mem = service.getById(id);
      if (mem) {
        vectorIndex.deleteEmbedding(id);
        try {
          const text = [mem.title, mem.content].filter(Boolean).join("\n");
          const v = await embedder.embedSingle(text);
          if (v?.length) vectorIndex.saveEmbedding(id, v);
        } catch { /* best-effort */ }
      }
    }
  }
  for (const [id, text] of rebuild) {
    try {
      const v = await embedder.embedSingle(text);
      if (v?.length) vectorIndex.saveEmbedding(id, v);
    } catch { /* best-effort */ }
  }
  if (embedder.modelHash) vectorIndex.markModel?.(embedder.modelHash, embedder.dimension);
}

export function createDreamScheduler({ onRun, thresholdCount = 10, thresholdChars = 5000, delayMs = 2000, logger, semantic = null }) {
  let pendingTimer = null;
  let running = false;
  let disposed = false;
  let baseline = { count: 0, chars: 0 };
  let inFlight = null;

  function shouldTrigger(service) {
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    const count = memories.length;
    const chars = totalChars(memories);
    const overBase = count >= baseline.count + thresholdCount || chars >= baseline.chars + thresholdChars;
    const overAbs = count >= thresholdCount || chars >= thresholdChars;
    return { trigger: overAbs && overBase, count, chars };
  }

  function maybeSchedule(service) {
    if (disposed || running || pendingTimer) return false;
    const { trigger, count, chars } = shouldTrigger(service);
    if (!trigger) return false;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      running = true;
      // Defer the onRun invocation so a synchronous throw cannot escape the
      // timer callback (which would crash the process) and skip the teardown.
      // Errors are logged, never swallowed silently. inFlight lets dispose()
      // await the running consolidation before the caller closes the store.
      inFlight = Promise.resolve()
        .then(() => (onRun ? onRun() : Promise.resolve({ ok: true, skipped: true })))
        .then((result) => {
          // Refresh the baseline only for a successful run (design §5.3: an
          // LLM failure must not move the baseline, so the next write can
          // immediately re-trigger a retry). A `{ok:false}` result or a throw
          // keeps the old baseline. A run that reports nothing is treated as
          // completed without failure (no-op hooks / minimal test doubles).
          if (result && result.ok) {
            try {
              baseline = shouldTrigger(service);
            } catch (error) {
              // Store closed mid-flight: keep the last known baseline.
              logger?.warn?.(`dsh-mneme dream: baseline refresh failed: ${String(error)}`);
            }
          }
        })
        .catch((error) => {
          logger?.warn?.(`dsh-mneme dream: run failed: ${error?.message ?? error}`);
          // Failed runs do not refresh the baseline.
        })
        .finally(() => {
          running = false;
          inFlight = null;
        });
    }, delayMs);
    return true;
  }

  async function dispose() {
    disposed = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    // An in-flight run is left to complete naturally (its LLM calls are
    // already paid for and aborting would discard the work). Await it so the
    // caller can close the store only after every write has landed.
    if (inFlight) await inFlight.catch(() => {});
  }

  async function runDream(ctx, service, config) {
    const logger = ctx.logger;
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    if (memories.length === 0) return { ok: true, applied: 0, skipped: true, summary: false };
    const snapshot = new Map(memories.map((m) => [m.id, m]));
    const route = resolveRoute(ctx, config, logger);
    const runId = randomUUID();
    const snapshotHash = hashSnapshot([...snapshot.values()]);
    // Every exit (success or failure) funnels through `finish`, which writes
    // the audit row + receipt. A record failure is logged, never thrown —
    // auditing must not break the consolidation path. Failed runs still
    // capture their decisions/outcome when the LLM produced a validated list
    // (e.g. summary step failed after consolidation), so the partial write is
    // replayable too.
    const finish = (result) => {
      // status is derived from what actually committed: ok only when the full
      // decision list landed (or a summary was refreshed); noop when nothing
      // changed; degraded when real changes landed without a summary;
      // reconcile when decisions were validated but some did not commit (CAS
      // conflict / rollback); failed on any LLM/validation error. No fake "ok"
      // for an empty or partial run.
      const status = result.status ?? (result.ok ? "ok" : "failed");
      const applied = result.applied ?? 0;
      const summaryStored = result.summary ?? false;
      const receipt = buildReceipt({ runId, status, snapshotHash, inputCount: snapshot.size, applied, summaryStored });
      try {
        service.saveDreamRun({
          id: runId,
          status,
          error: result.error,
          provider: route?.provider,
          model: route?.model,
          snapshot_hash: snapshotHash,
          input_count: snapshot.size,
          // Full input snapshot (canonical fields) so the exact arbitration
          // input can be rebuilt offline from the audit row alone — the
          // digest + decisions + outcome triple makes silent errors locatable
          // even after the store has moved on.
          input: [...snapshot.values()].map((m) => ({
            id: m.id,
            type: m.type,
            title: m.title,
            content: m.content,
            importance: m.importance,
            updated_at: m.updated_at
          })),
          decisions: result.decisions,
          outcome: result.outcome,
          applied,
          summary_stored: summaryStored,
          receipt
        });
      } catch (error) {
        logger?.warn?.(`dsh-mneme dream: failed to record audit run: ${String(error)}`);
      }
      return { ...result, runId, receipt, snapshotHash };
    };
    if (!route) {
      logger?.warn?.("dsh-mneme dream: no llm route available");
      return finish({ ok: false, error: "no llm route", summary: false });
    }

    let listText;
    if (semantic?.embedder && semantic?.vectorIndex) {
      try {
        const vectors = await collectVectors(memories, semantic);
        if (vectors) {
          const k = Math.min(10, Math.max(1, Math.floor(Math.sqrt(memories.length / 2))));
          const clusters = clusterMemories(memories, vectors, k);
          const conflicts = findPotentialConflicts(memories, vectors, 0.85);
          const conflictIds = new Set(conflicts.flatMap((c) => [c.a.id, c.b.id]));
          const parts = [];
          clusters.forEach((cluster, ci) => {
            parts.push(`# 聚类 ${ci + 1}`);
            for (const m of cluster) {
              parts.push(
                `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}` +
                (conflictIds.has(m.id) ? " | [潜在冲突]" : "")
              );
            }
          });
          listText = parts.join("\n");
          logger?.info?.(`[dsh-mneme] dream semantic pre-group: ${clusters.length} clusters, ${conflicts.length} conflict pairs`);
        }
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] dream semantic pre-group failed: ${String(error)}`);
      }
    }
    if (!listText) {
      listText = [...snapshot.values()].map((m) =>
        `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`
      ).join("\n");
    }

    let decisionText;
    try {
      decisionText = await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        purpose: "compaction",
        maxTokens: config.dreamMaxTokens ?? 4096,
        messages: [
          { role: "system", content: [{ type: "text", text: CONSOLIDATION_PROMPT }] },
          { role: "user", content: [{ type: "text", text: listText }] }
        ]
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: consolidation llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", summary: false });
    }
    if (decisionText === undefined) {
      logger?.warn?.("dsh-mneme dream: consolidation llm stream aborted or errored");
      return finish({ ok: false, error: "llm failed", summary: false });
    }

    let decisions;
    try {
      const start = decisionText.indexOf("[");
      const end = decisionText.lastIndexOf("]");
      if (start === -1 || end <= start) {
        logger?.warn?.("dsh-mneme dream: no json array in llm output");
        return finish({ ok: false, error: "no json array in llm output", summary: false });
      }
      decisions = JSON.parse(decisionText.slice(start, end + 1));
    } catch {
      logger?.warn?.("dsh-mneme dream: invalid decisions json");
      return finish({ ok: false, error: "invalid decisions json", summary: false });
    }
    const { ok, errors } = validateDecisions(decisions, snapshot, {
      maxUpdatePerRun: config.reflectionUpdateMaxPerRun,
      minAgeHours: config.reflectionUpdateMinAgeHours
    });
    if (!ok) {
      logger?.warn?.(`dsh-mneme dream: invalid decisions: ${errors.join("; ")}`);
      return finish({ ok: false, error: `invalid decisions: ${errors.length} errors`, summary: false });
    }

    // Capture pre-update snapshots so the audit records what each update changed.
    const updateSnapshots = {};
    for (const d of decisions) {
      if (d.action === "update") {
        const mem = snapshot.get(d.ids[0]);
        if (mem) updateSnapshots[d.ids[0]] = { title: mem.title, content: mem.content, importance: mem.importance };
      }
    }

    // CAS-guarded, per-decision-transactional apply against the run snapshot:
    // a target changed during the LLM call is skipped and reported as a
    // conflict instead of being overwritten (item ①).
    const { applied, conflicts, failures, committed } = applyDecisions(decisions, service, logger, snapshot);
    // Attach the pre-update snapshot to the audit copy of each update decision
    // so the recorded row shows the before/after delta, not just the target.
    const auditDecisions = decisions.map((d) =>
      d.action === "update" && updateSnapshots[d.ids[0]]
        ? { ...d, _before: updateSnapshots[d.ids[0]] }
        : d
    );
    // Outcome is derived from the ACTUALLY committed sub-steps, never from the
    // raw LLM decision list — a merge whose archive step rolled back must not
    // claim "merge-archived" (item ②). Conflicts/failures ride along so the
    // audit row records why the run diverged.
    const outcome = { ...buildOutcome(committed), conflicts, failures };
    // Decisions validated but not fully committed → reconcile (not ok).
    const partial = conflicts.length > 0 || failures.length > 0;
    // No decision landed (all-keep, or every decision skipped as an idempotent
    // replay) → nothing substantive changed. Distinct from a success: such a
    // run must never be reported as ok, or the audit claims work that never
    // happened and the scheduler refreshes the baseline on a false positive.
    const noChange = applied === 0 && committed.every((c) => c.action === "keep");

    // Keep the vector index consistent with the post-dream store state.
    if (semantic?.embedder && semantic?.vectorIndex) {
      try {
        await maintainIndexAfterDream(decisions, service, semantic);
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] dream index maintenance failed: ${String(error)}`);
      }
    }

    // Summary generation (second LLM call). A throwing stream is reported as
    // a failed run; summary:false marks a run that produced no summary.
    let summaryText;
    try {
      summaryText = await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        purpose: "compaction",
        maxTokens: config.dreamMaxTokens ?? 2048,
        messages: [
          { role: "system", content: [{ type: "text", text: SUMMARY_PROMPT }] },
          { role: "user", content: [{ type: "text", text: service.all().filter((m) => !m.archived && m.type !== "summary").map((m) => `- ${m.title}: ${m.content}`).join("\n") }] }
        ]
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: summary llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", applied, decisions: auditDecisions, outcome, summary: false });
    }
    let summaryStored = false;
    if (summaryText !== undefined && summaryText.trim()) {
      service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: summaryText.trim(), importance: 5, source: "dream" });
      summaryStored = true;
      // Re-embed the fresh summary so the index stays in sync with the store.
      if (semantic?.embedder && semantic?.vectorIndex) {
        try {
          const summary = service.all().find((m) => m.type === "summary");
          if (summary) {
            const v = await semantic.embedder.embedSingle([summary.title, summary.content].filter(Boolean).join("\n"));
            if (v?.length) semantic.vectorIndex.saveEmbedding(summary.id, v);
            if (semantic.embedder.modelHash) semantic.vectorIndex.markModel?.(semantic.embedder.modelHash, semantic.embedder.dimension);
          }
        } catch { /* best-effort */ }
      }
    }
    // Honest status assignment (never a fake ok):
    //   reconcile — some decisions validated but did not commit (CAS/rollback).
    //   noop      — nothing changed and no summary persisted: truly an empty
    //               run. ok:false keeps the scheduler from moving the baseline.
    //   ok        — either real changes landed, or a fresh summary was stored
    //               (all-keep + summary is a substantive summary refresh).
    //   degraded  — real consolidation landed but the summary came back empty/
    //               missing: the store was absorbed (ok for the baseline) but
    //               the run did not produce its full output (marked, not faked).
    let status;
    let okResult;
    if (partial) {
      status = "reconcile";
      okResult = false;
    } else if (noChange) {
      status = summaryStored ? "ok" : "noop";
      okResult = summaryStored;
    } else {
      status = summaryStored ? "ok" : "degraded";
      okResult = true;
    }
    return finish({
      ok: okResult,
      status,
      applied,
      decisions: auditDecisions,
      outcome,
      conflicts,
      failures,
      summary: summaryStored
    });
  }

  return { maybeSchedule, runDream, dispose };
}
