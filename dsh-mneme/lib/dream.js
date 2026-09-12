import { validateDecisions, applyDecisions } from "./dream/decisions.js";
import { clusterMemories, findPotentialConflicts } from "./dream/clustering.js";
import { createHash, randomUUID } from "node:crypto";
import { STR, langOf } from "./lang.js";
export { validateDecisions, applyDecisions, withEffortFallback, describeStreamFailure, resolveDreamEffort, resolveRoute };


// Extract the first JSON array from LLM output, tolerating markdown fences,
// leading/trailing prose, and common wrapper noise. Returns an array or null.
function extractJsonArray(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```).
  let cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1");
  cleaned = cleaned.trim();

  // 2. Find the first '[' and the matching last ']' that yields valid JSON.
  const start = cleaned.indexOf("[");
  if (start === -1) return null;
  for (let end = cleaned.lastIndexOf("]"); end > start; end = cleaned.lastIndexOf("]", end - 1)) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Light repair: remove trailing commas before ] or }.
      try {
        const repaired = candidate.replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(repaired);
      } catch {
        // keep searching backwards
      }
    }
  }

  // 3. Fallback: a broader regex extraction.
  try {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // fall through
  }
  return null;
}
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
 * Content-addressed digest of the memories a verdict was decided against
 * (id + title + content + importance), sorted by id so identical inputs always
 * hash the same. This is the per-record "判定依据" fingerprint: a receipt whose
 * digest cannot be reproduced from the involved memories is a bare claim, and a
 * digest match with a divergent outcome pinpoints drift to the exact record.
 */
export function hashDecisionInput(memories) {
  const canon = (memories ?? [])
    .map((m) => [m.id, m.title, m.content, m.importance])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((p) => p.map((x) => String(x ?? "")).join(""))
    .join("");
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Build the per-record receipts for a run's actually-committed mutable verdicts
 * (merge/conflict/update) — one row per verdict in the receipt_chain. Inputs
 * are drawn from the run snapshot (what the LLM actually arbitrated against),
 * and the idempotency counters count_before → count_after come from the
 * committed sub-step, so replaying the same decision must reproduce the same
 * numbers. verdict starts "live"; a later policy_epoch upgrade will batch-mark
 * older verdicts "historical" (a receipt_chain rewrite driven by the store's
 * getLatestPolicyEpoch — out of scope for this pass), while "revoked" is
 * reserved for verdicts later overturned by an explicit human decision.
 */
function buildRecordReceipts({ runId, committed, snapshot, policyEpoch }) {
  const at = (id) => snapshot?.get?.(id);
  const receipts = [];
  for (const c of committed ?? []) {
    const base = {
      run_id: runId,
      verdict: "live",
      count_before: c.count_before,
      count_after: c.count_after,
      policy_epoch: policyEpoch,
      created_at: new Date().toISOString()
    };
    if (c.action === "merge") {
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.keepSource,
        kind: "merge",
        input_digest: hashDecisionInput((c.ids ?? []).map(at).filter(Boolean)),
        keep_source: c.keepSource,
        sources: c.ids
      });
    } else if (c.action === "conflict") {
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.winner,
        kind: "conflict",
        input_digest: hashDecisionInput([at(c.winner), at(c.loser)].filter(Boolean)),
        winner_id: c.winner,
        loser_id: c.loser
      });
    } else if (c.action === "update") {
      receipts.push({
        ...base,
        receipt_id: randomUUID(),
        record_id: c.ids[0],
        kind: "update",
        input_digest: hashDecisionInput([at(c.ids[0])].filter(Boolean))
      });
    }
  }
  return receipts;
}

/**
 * Consume an LLM stream and return the accumulated text. Direct text-delta
 * accumulation covers both the real protocol ({type:"text-delta", index, text})
 * and looser test doubles ({type:"text-delta", text}); a terminal error/abort
 * surfaces as undefined. The caller decides how to treat an empty result.
 * `onUsage` (optional, Bug8) receives any usage chunk for token accounting.
 */
async function streamText(ctx, options, onUsage, onStreamError) {
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    if (chunk.type === "usage" && typeof onUsage === "function") onUsage(chunk);
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      // dsh-llm rc.1 turns adapter-stage failures (unknown provider route,
      // UNSUPPORTED_REASONING_EFFORT from resolveCallWithInfo, …) into a
      // terminal finish chunk instead of a throw — the cause rides in
      // chunk.reason.failure {message, code}. Surface it, never swallow it.
      if (typeof onStreamError === "function") {
        try { onStreamError(chunk.reason); } catch { /* diagnostics only */ }
      }
      return undefined;
    }
  }
  return text;
}

/** One-line human-readable cause from a finish-chunk failure reason. */
function describeStreamFailure(reason) {
  const failure = reason?.failure ?? reason ?? {};
  const code = failure.code ? String(failure.code) : "";
  const message = String(failure.message ?? failure.error ?? "");
  if (code && message) return message.includes(code) ? message : `${code}: ${message}`;
  return code || message;
}

/**
 * Bug8: wrap a background LLM call so its token/time/status are recorded in the
 * llm_audit_logs table. Best-effort bookkeeping: a failure to WRITE the audit
 * row is swallowed (never blocks the LLM call), while a failure of the call
 * itself is captured as status='error' and re-thrown so the caller keeps its
 * existing error path. `spec` carries the static metadata (trigger_source,
 * operation_type, model_id, related_memory_ids); `body(reportUsage)` performs
 * the actual stream consumption and is handed a usage reporter for the chunks.
 */
async function runAuditedLlm(ctx, service, config, spec, body) {
  const audit = config?.llmAudit;
  if (audit?.enabled === false || typeof service?.saveLlmAudit !== "function") return body(() => {});
  const startedAt = Date.now();
  const timestamp = new Date(startedAt).toISOString();
  let inputTokens = 0;
  let outputTokens = 0;
  let status = "success";
  let errorMessage = null;
  let result;
  try {
    result = await body((usage) => {
      if (!usage) return;
      const i = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens;
      const o = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens;
      if (Number.isFinite(i)) inputTokens = i;
      if (Number.isFinite(o)) outputTokens = o;
    });
    if (result === undefined) {
      // stream aborted/errored: the caller treats undefined as a failed run;
      // record it as error here so the audit shows the truth. spec.streamError
      // (a getter) lets the caller attach the finish-chunk cause so the audit
      // row names it instead of a bare "aborted".
      status = "error";
      const streamErr = typeof spec.streamError === "function" ? String(spec.streamError() ?? "") : "";
      errorMessage = errorMessage ?? (streamErr ? `llm stream aborted or errored (${streamErr})` : "llm stream aborted or errored");
    } else if (typeof spec.auditError === "function") {
      // A stream that returned text but yields nothing usable is still a
      // failed call — record it as error, not the default success, so the
      // audit no longer contradicts a failed run (dream "no json array").
      const message = spec.auditError(result);
      if (message) {
        status = "error";
        errorMessage = message;
      }
    }
    return result;
  } catch (error) {
    status = "error";
    errorMessage = String(error?.message ?? error);
    throw error;
  } finally {
    try {
      service.saveLlmAudit({
        timestamp,
        trigger_source: spec.triggerSource,
        operation_type: spec.operationType,
        model_id: spec.modelId,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost_usd: 0,
        duration_ms: Date.now() - startedAt,
        status,
        error_message: errorMessage,
        related_memory_ids: spec.relatedMemoryIds ?? []
      });
    } catch (auditError) {
      ctx.logger?.warn?.(`dsh-mneme: llm audit write failed: ${String(auditError)}`);
    }
  }
}

/**
 * Reasoning-effort rejection fallback (v0.8.1): a configured dreamReasoningEffort
 * / sleepReasoningEffort may be rejected by the provider (volcano-engine returns
 * UNSUPPORTED_REASONING_EFFORT for values it does not accept — "off" is known
 * rejected there). When that happens, retry once WITHOUT the reasoning field
 * instead of hard-failing the run, so effort config is safe to experiment with:
 * accepted → reasoning capped; rejected → provider default (old behavior),
 * logged so the rejection is observable.
 */
async function withEffortFallback(ctx, effort, attempt, fallback, getStreamError) {
  if (!effort || effort === "none") return attempt();
  try {
    const result = await attempt();
    if (result === undefined) {
      // dsh-llm rc.1 streams a provider effort-rejection as a terminal error
      // finish chunk (adapterStream catches everything, never throws) — match
      // on the chunk's failure reason here or the retry below is dead code
      // for the stream path.
      const reason = String(getStreamError?.() ?? "");
      if (/reasoning[\s_]*effort|UNSUPPORTED_REASONING_EFFORT/i.test(reason)) {
        ctx.logger?.warn?.(`dsh-mneme dream: reasoningEffort "${effort}" rejected via stream (${reason}); retrying without it`);
        return fallback();
      }
    }
    return result;
  } catch (error) {
    const message = String(error?.message ?? error);
    // matches both "reasoning effort" (natural language) and the bare
    // "UNSUPPORTED_REASONING_EFFORT" error code (underscore).
    if (!/reasoning[\s_]*effort/i.test(message)) throw error;
    ctx.logger?.warn?.(`dsh-mneme dream: reasoningEffort "${effort}" rejected (${message}); retrying without it`);
    return fallback();
  }
}

/**
 * Resolve the reasoning effort to actually send for a dream/sleep route.
 *
 * Reasoning-effort config that the provider does not accept trips the harness's
 * UNSUPPORTED_REASONING_EFFORT, and the defaultEffort trap makes retrying
 * "without the field" useless: the harness substitutes `reasoning.defaultEffort`,
 * which may itself be unsupported (DSH Desktop volcano-engine adapter declares
 * defaultEffort=low that its model rejects). So instead of blind retries, ask
 * the harness for the model's declared capability and pick a value that is
 * actually accepted — or omit the field entirely when the model declares no
 * reasoning capability at all.
 *
 * Unset vs explicit 'none' (Issue #135 建议 4/5): these are different intents.
 * Explicit 'none' = the user asked to omit the field (provider default
 * applies). Unset is the out-of-the-box state — dream/sleep calls must produce
 * JSON, and omission lets the harness substitute the model's defaultEffort
 * (thinking-type models often default to high), which drains the token budget
 * and returns an empty body. So unset resolves to the LOWEST effort the model
 * declares instead of omitting; when the capability query is unavailable the
 * field stays omitted (fail-safe, retry guard unchanged).
 *
 * @returns a supported effort id, or null when no effort should be sent, or the
 *   configured value unchanged when the capability query is unavailable.
 */

// 常识档位排序（越靠前推理开销越低）；未知档位排最后（宁可交给显式配置）。
const EFFORT_RANK = { minimal: 0, off: 0, low: 1, medium: 2, high: 3, max: 4 };

function lowestSupportedEffort(reasoning) {
  const ids = (reasoning?.efforts ?? []).map((e) => e?.id).filter(Boolean);
  if (ids.length === 0) return null;
  return [...ids].sort((a, b) => (EFFORT_RANK[a] ?? 99) - (EFFORT_RANK[b] ?? 99))[0];
}

async function resolveDreamEffort(ctx, route, configuredEffort, logger) {
  // 显式 'none'：用户要求省略字段（服务商自带默认生效），照旧。
  if (configuredEffort === "none") return null;
  if (!configuredEffort) {
    // 未配置（开箱默认）：取模型声明的最低档，避免 defaultEffort 顶上（建议 4/5）。
    if (typeof ctx?.llm?.resolveModelInfo !== "function") return null;
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
      const reasoning = info?.reasoning;
      if (!reasoning) return null; // 无推理声明：省略即安全（无 defaultEffort 可顶上）
      const lowest = lowestSupportedEffort(reasoning);
      if (!lowest) return null;
      logger?.info?.(`dsh-mneme dream: no reasoningEffort configured for ${route.provider}:${route.model}; using lowest supported "${lowest}" instead of the model default "${reasoning.defaultEffort ?? "n/a"}"`);
      return lowest;
    } catch (error) {
      // 能力查询失败：省略字段（fail-safe），withEffortFallback 照旧兜底。
      logger?.warn?.(`dsh-mneme dream: resolveModelInfo failed (${String(error?.message ?? error)}); omitting reasoningEffort`);
      return null;
    }
  }
  // Capability query unavailable (older harness / minimal mocks): forward the
  // configured value as before — absence of the API proves nothing about the
  // model, and withEffortFallback still guards against rejection.
  if (typeof ctx?.llm?.resolveModelInfo !== "function") return configuredEffort;
  try {
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
    const reasoning = info?.reasoning;
    if (!reasoning) {
      // Model declares no reasoning capability: the harness rejects ANY
      // explicit effort for such a model, and omitting the field is safe
      // (no reasoning capability → no defaultEffort substitution).
      logger?.warn?.(`dsh-mneme dream: model ${route.provider}:${route.model} declares no reasoning capability; ignoring configured effort "${configuredEffort}"`);
      return null;
    }
    const supported = reasoning.efforts?.map((effort) => effort.id) ?? [];
    if (supported.includes(configuredEffort)) return configuredEffort;
    // Configured effort unsupported → pick defaultEffort if it is supported,
    // else the first declared effort, so the run never trips
    // UNSUPPORTED_REASONING_EFFORT (nor the defaultEffort trap: we always
    // pass an explicit value, so the harness never falls back to a poison
    // default).
    const picked = reasoning.defaultEffort && supported.includes(reasoning.defaultEffort)
      ? reasoning.defaultEffort
      : supported[0];
    if (picked) {
      logger?.warn?.(`dsh-mneme dream: model ${route.provider}:${route.model} does not support effort "${configuredEffort}" (supported: ${supported.join(", ")}); using "${picked}"`);
      return picked;
    }
    return null;
  } catch (error) {
    // Capability query failed — forward the configured value; withEffortFallback
    // still retries on rejection as before.
    logger?.warn?.(`dsh-mneme dream: resolveModelInfo failed (${String(error?.message ?? error)}); forwarding effort as configured`);
    return configuredEffort;
  }
}

/**
 * Resolve the LLM route (Issue #25): an explicit plugin config
 * (dreamProvider/dreamModel) is the user's declared override and wins; the
 * agent default model (deployment) is only a fallback when no config route is
 * set. In a standard DSH install agentDefaultModel always resolves, so without
 * this ordering the config route would be dead code and dreamProvider/dreamModel
 * could never take effect (v0.7.11 regressed this; README §config documents
 * config-first). Falls through to undefined when no route exists — runDream
 * then fails safe. A config→default switch is logged so it is observable.
 */
function resolveRoute(ctx, config, logger) {
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) {
      logger?.info?.("dsh-mneme dream: no dreamProvider/dreamModel config, falling back to agent default");
      return { provider: sel.provider, model: sel.model };
    }
    logger?.warn?.("dsh-mneme dream: agentDefaultModel unavailable, no config route either");
  } catch (error) {
    logger?.warn?.(`dsh-mneme dream: agentDefaultModel lookup failed: ${String(error)}`);
  }
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

export function createDreamScheduler({ onRun, thresholdCount = 10, thresholdChars = 5000, delayMs = 2000, minIntervalMs = 0, logger, semantic = null }) {
  let pendingTimer = null;
  let running = false;
  let disposed = false;
  let baseline = { count: 0, chars: 0 };
  let inFlight = null;
  // Issue #89（请求 2）：上一次实际开跑时刻。失败/degraded 的 run 也占用
  // 最小间隔——节流的目的正是防止失败调用连发；间隔内的触发静默跳过。
  let lastRunAt = 0;

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
    // Issue #89（请求 2）：最小触发间隔闸门。
    if (minIntervalMs > 0 && Date.now() - lastRunAt < minIntervalMs) return false;
    const { trigger, count, chars } = shouldTrigger(service);
    if (!trigger) return false;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      running = true;
      lastRunAt = Date.now();
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
    const language = langOf(config);
    const logger = ctx.logger;
    let memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    if (memories.length === 0) return { ok: true, applied: 0, skipped: true, summary: false };
    // v0.4.4 滑动窗口：只 consolidation 最近 dreamMaxSnapshotSize 条记忆，
    // 窗口外的旧记忆不进 snapshot（大记忆量下全量快照会撑爆 LLM 输入，配合
    // 隐式 keep 让 run 始终可收敛）。按 updated_at 倒序取前 maxSize 条。
    const maxSize = Number.isInteger(config.dreamMaxSnapshotSize) ? config.dreamMaxSnapshotSize : 200;
    memories = [...memories]
      .sort((a, b) => {
        const ta = String(a.updated_at ?? "");
        const tb = String(b.updated_at ?? "");
        if (ta < tb) return 1;
        if (ta > tb) return -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, Math.max(1, maxSize));
    const snapshot = new Map(memories.map((m) => [m.id, m]));
    const route = resolveRoute(ctx, config, logger);
    const runId = randomUUID();
    const snapshotHash = hashSnapshot([...snapshot.values()]);
    // Conflict freeze (opt-in): when enabled, conflict decisions are parked for
    // manual review instead of auto-adjudicated. Read once up front so the
    // prompt hint and the apply-split agree on the same gate.
    const freezeEnabled = config.conflictFreezeEnabled === true;
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
          // 裁决规则版本号：config.policyEpoch（默认 0）。规则升级后该行保留
          // 当时的 epoch，旧裁决据此降级为历史证据（store 层 getLatestPolicyEpoch
          // 只负责读取当前生效版本，写入由这里完成）。
          policy_epoch: config.policyEpoch ?? 0,
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
          receipt,
          // Issue #104：degraded（合法子集已应用）轮被跳过的决策明细。写成独立字段
          // 而非内联进 decisions——degraded 的 decisions 是合法子集，下游按「决策
          // 数组」消费，内联标记会污染其它读者（失败轮的 _validationFailed 是整单
          // 拒绝哨兵，语义与「部分应用」不同，也不复用）。
          skipped: result.skipped
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
            parts.push(STR.clusterHeader[language](ci + 1));
            for (const m of cluster) {
              parts.push(
                `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}` +
                (conflictIds.has(m.id) ? STR.conflictMark[language] : "")
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

    // Freeze-aware prompt: in freeze mode the conflict branch still outputs
    // winner/loser (validation requires them) but they are treated as tentative
    // candidates — the human makes the final call, not the model.
    const consolidationPrompt = freezeEnabled
      ? STR.prompts.consolidation[language] + STR.prompts.freezeSuffix[language]
      : STR.prompts.consolidation[language];
    let decisionText;
    // 加固（v0.8.1）：配置的 reasoningEffort 被 provider 拒收时回退重试一次
    // （不带该字段），避免 thinking 模型配置 low/medium 直接整单失败。解析放
    // 在 auditError 检查器里、闭包交回主流程，避免二次解析；解析失败同时如实
    // 记 audit error 并在日志带原始输出前 300 字节，便于定位"推理吞预算返回空体"。
    const effort = await resolveDreamEffort(ctx, route, config.dreamReasoningEffort, logger);
    let decisions = null;
    let streamFailure = "";
    const runConsolidation = (withEffort) => {
      streamFailure = "";
      return runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream",
      operationType: "dream_consolidate",
      modelId: `${route.provider}:${route.model}`,
      relatedMemoryIds: [...snapshot.keys()],
      streamError: () => streamFailure,
      auditError: (text) => {
        decisions = extractJsonArray(text);
        return Array.isArray(decisions) ? null : "no json array in llm output";
      }
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 4096,
      ...(withEffort && effort ? { reasoningEffort: effort } : {}),
      messages: [
        { role: "system", content: [{ type: "text", text: consolidationPrompt }] },
        { role: "user", content: [{ type: "text", text: listText }] }
      ]
    }, reportUsage, (reason) => { streamFailure = describeStreamFailure(reason); }));
    };
    try {
      // Bug8: the consolidation call is audited (tokens/time/status). A throw
      // re-propagates to the catch below; an aborted stream returns undefined
      // and is treated as a failed run after the check below.
      decisionText = await withEffortFallback(ctx, effort, () => runConsolidation(true), () => runConsolidation(false), () => streamFailure);
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: consolidation llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", summary: false });
    }
    if (decisionText === undefined) {
      logger?.warn?.(`dsh-mneme dream: consolidation llm stream aborted or errored${streamFailure ? ` (${streamFailure})` : ""}`);
      return finish({ ok: false, error: "llm failed", summary: false });
    }
    if (!Array.isArray(decisions)) {
      const head = (decisionText ?? "").slice(0, 300).replace(/\s+/g, " ").trim();
      logger?.warn?.(`dsh-mneme dream: no json array in llm output (raw length ${decisionText?.length ?? 0}; head: ${head})`);
      return finish({ ok: false, error: "no json array in llm output", summary: false });
    }
    const { ok, errors, skipped, resolvedShortIds } = validateDecisions(decisions, snapshot, {
      maxUpdatePerRun: config.reflectionUpdateMaxPerRun,
      minAgeHours: config.reflectionUpdateMinAgeHours,
      // v0.4.4 fix：显式透传，用户配 dreamImplicitKeep:false 时严格模式必须
      // 真正生效，dreamMinExplicitCoverage 决定隐式 keep 下的覆盖率下限。
      dreamImplicitKeep: config.dreamImplicitKeep,
      dreamMinExplicitCoverage: config.dreamMinExplicitCoverage,
      // Issue #89：v0.6.9（Issue #26）的宽容路径在 v0.7.11 重写中丢失——单条
      // 非法决策重新只跳过该条、合法子集照常应用（run 记为 degraded）。
      skipInvalid: config.dreamSkipInvalid !== false,
      allowCrossTypeMerge: config.allowCrossTypeMerge === true
    });
    // Issue #135：模型把 UUID 缩写成前缀时，唯一前缀已在校验前被解析回完整 id。
    // 解析量是模型输出质量的一个直接信号（>0 意味着模型在缩写 id），记一条 info
    // 便于事后从日志侧观察该行为的分布。
    if (resolvedShortIds > 0) {
      logger?.info?.(`[dsh-mneme] dream: resolved ${resolvedShortIds} short id prefix(es) to full ids`);
    }
    if (!ok) {
      // Issue #135（观测缺口）：失败轮的逐条校验明细此前既不落库也基本不可见——
      // skipped 的 warn 写在 return 之后（失败路径到不了），dream_runs.decisions
      // 落 NULL，上百轮失败零现场。这里把明细前置到日志，并把
      // { _validationFailed, errors, skipped } 随失败行持久化，事后可从审计行
      // 直接定位「模型输出了什么、为何逐条非法」。
      logger?.warn?.(`dsh-mneme dream: invalid decisions: ${errors.join("; ")}`);
      if (skipped.length > 0) {
        logger?.warn?.(`dsh-mneme dream: ${skipped.length} invalid decision(s) skipped: ${skipped.map((s) => `decision[${s.index}]: ${s.error}`).join("; ")}`);
      }
      return finish({
        ok: false,
        error: `invalid decisions: ${errors.length} errors`,
        summary: false,
        decisions: [{ _validationFailed: true, errors, skipped }]
      });
    }
    const skippedInvalid = skipped.length > 0;
    if (skippedInvalid) {
      logger?.warn?.(`dsh-mneme dream: ${skipped.length} invalid decision(s) skipped (run degrades): ${skipped.map((s) => s.error).join("; ")}`);
    }

    // Capture pre-update snapshots so the audit records what each update changed.
    const updateSnapshots = {};
    for (const d of decisions) {
      if (d.action === "update") {
        const mem = snapshot.get(d.ids[0]);
        if (mem) updateSnapshots[d.ids[0]] = { title: mem.title, content: mem.content, importance: mem.importance };
      }
    }

    // Conflict freeze (opt-in): when enabled, conflict decisions are not
    // auto-adjudicated — no winner kept, no loser archived. The pair is parked
    // in conflict_pending for human review instead. Best-effort: a store
    // failure here must never block the run (fail-safe — the memories are left
    // untouched and nothing is arbitrated). The cap (conflictFreezeMaxPending)
    // bounds the review queue; overflow is skipped with a warning.
    let frozenCount = 0;
    const frozenIds = [];
    const applyList = freezeEnabled ? decisions.filter((d) => d.action !== "conflict") : decisions;
    if (freezeEnabled) {
      const conflictsToFreeze = decisions.filter((d) => d.action === "conflict");
      if (conflictsToFreeze.length > 0) {
        try {
          const maxPending = Number.isInteger(config.conflictFreezeMaxPending) ? config.conflictFreezeMaxPending : 100;
          const pendingNow = service.countConflictPending();
          const budget = Math.max(0, maxPending - pendingNow);
          const toFreeze = conflictsToFreeze.slice(0, budget);
          if (conflictsToFreeze.length > budget) {
            logger?.warn?.(`dsh-mneme dream: conflict freeze queue full (${pendingNow}/${maxPending}), skipped ${conflictsToFreeze.length - budget} conflict(s)`);
          }
          for (const d of toFreeze) {
            try {
              service.saveConflictPending({ run_id: runId, memory_a: d.winner, memory_b: d.loser, reason: d.reason });
              frozenCount++;
              frozenIds.push(d.winner, d.loser);
            } catch (error) {
              logger?.warn?.(`dsh-mneme dream: failed to freeze conflict ${d.winner}/${d.loser}: ${String(error)}`);
            }
          }
        } catch (error) {
          logger?.warn?.(`dsh-mneme dream: conflict freeze lookup failed: ${String(error)}`);
        }
      }
    }

    // CAS-guarded, per-decision-transactional apply against the run snapshot:
    // a target changed during the LLM call is skipped and reported as a
    // conflict instead of being overwritten (item ①). Frozen conflicts are
    // excluded from this list (they are parked, not applied).
    const { applied, conflicts, failures, committed } = applyDecisions(applyList, service, logger, snapshot, config);
    // Per-record receipt chain: one row per actually-committed merge/conflict/
    // update verdict, stamped with the decision-basis digest + idempotency
    // counters (count_before → count_after). Written here, before the run audit
    // row, so the verdict trail always precedes the run trail it belongs to.
    // Bookkeeping: a write failure is logged and swallowed — it must never
    // block the consolidation flow.
    try {
      for (const r of buildRecordReceipts({ runId, committed, snapshot, policyEpoch: config.policyEpoch ?? 0 })) {
        service.saveReceipt(r);
      }
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: failed to write per-record receipt: ${String(error)}`);
    }
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
    // Frozen conflicts were not adjudicated: mark both sides pending in the
    // per-id outcome so the audit row shows they were parked, not skipped.
    if (frozenIds.length) {
      for (const id of frozenIds) outcome.byId[id] = "conflict-pending";
    }
    // Decisions validated but not fully committed → reconcile (not ok).
    const partial = conflicts.length > 0 || failures.length > 0;
    // No decision landed (all-keep, or every decision skipped as an idempotent
    // replay) → nothing substantive changed. Distinct from a success: such a
    // run must never be reported as ok, or the audit claims work that never
    // happened and the scheduler refreshes the baseline on a false positive.
    // Frozen conflicts are substantive output (parked for review), so a run
    // that only froze conflicts is not a noop.
    const noChange = frozenCount === 0 && applied === 0 && committed.every((c) => c.action === "keep");

    // Keep the vector index consistent with the post-dream store state.
    if (semantic?.embedder && semantic?.vectorIndex) {
      try {
        await maintainIndexAfterDream(applyList, service, semantic);
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] dream index maintenance failed: ${String(error)}`);
      }
    }

    // Summary generation (second LLM call). A throwing stream is reported as
    // a failed run; summary:false marks a run that produced no summary.
    let summaryText;
    let summaryStreamFailure = "";
    const runSummary = (withEffort) => {
      summaryStreamFailure = "";
      return runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream",
      operationType: "dream_summarize",
      modelId: `${route.provider}:${route.model}`,
      relatedMemoryIds: [],
      streamError: () => summaryStreamFailure
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 2048,
      ...(withEffort && effort ? { reasoningEffort: effort } : {}),
      messages: [
        { role: "system", content: [{ type: "text", text: STR.prompts.dreamSummary[language] }] },
        { role: "user", content: [{ type: "text", text: service.all().filter((m) => !m.archived && m.type !== "summary").map((m) => `- ${m.title}: ${m.content}`).join("\n") }] }
      ]
    }, reportUsage, (reason) => { summaryStreamFailure = describeStreamFailure(reason); }));
    };
    try {
      // Bug8: the summary call is audited too (operation dream_summarize).
      summaryText = await withEffortFallback(ctx, effort, () => runSummary(true), () => runSummary(false), () => summaryStreamFailure);
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: summary llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", applied, decisions: auditDecisions, outcome, frozen: frozenCount, summary: false });
    }
    let summaryStored = false;
    if (summaryText !== undefined && summaryText.trim()) {
      // Bug5 carve-out: the library overview is regenerated every run, so it
      // must REPLACE the previous overview (not append — that would grow the
      // summary unboundedly). `_overwrite` still archives the old overview into
      // content_history before replacing it.
      service.saveWithDedupe({ type: "summary", title: STR.summaryTitle[language], content: summaryText.trim(), importance: 5, source: "dream", _overwrite: true });
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
    //   degraded  — real consolidation landed but the run did not produce its
    //               full output: the summary came back empty/missing, or
    //               skipInvalid dropped individually-invalid decisions
    //               (Issue #89 — marked, not faked). The valid subset was
    //               absorbed (ok for the baseline).
    let status;
    let okResult;
    if (partial) {
      status = "reconcile";
      okResult = false;
    } else if (noChange) {
      status = summaryStored ? "ok" : "noop";
      okResult = summaryStored;
    } else {
      status = summaryStored && !skippedInvalid ? "ok" : "degraded";
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
      frozen: frozenCount,
      summary: summaryStored,
      // Issue #104：只有真发生跳过时才落库（degraded 也可能仅因 summary 为空），
      // ok 轮留 NULL，避免「空数组」与「无此字段」两种假明细占据审计行。
      skipped: skippedInvalid ? skipped : undefined
    });
  }

  return { maybeSchedule, runDream, dispose };
}
