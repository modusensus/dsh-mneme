// System-level sleep (v0.4.0): an idle-triggered, LLM-assisted deep pass over
// the memory store. Four independent, fail-safe phases:
//   1. conflict resolution — high-similarity same-type pairs are either parked
//      for review (freeze mode) or adjudicated by the LLM (winner kept / loser
//      archived), reusing the dream conflict machinery. Strictness-graded.
//   2. archival demotion — memories unreferenced past sleepArchiveDays shrink
//      to a one-line summary with the full body moved to _full_content; past
//      sleepCompressDays they are archived outright.
//   3. pattern discovery — the LLM scans the most recent memories and mints
//      type=pattern entries carrying evidence id references.
//   4. relation completion — orphan entities (zero relations) get implied
//      relations completed from memory co-occurrence.
// Each phase is wrapped so one failure never aborts the others, and a missing
// LLM route / semantic embedder only skips the phases that need it. A run is
// abortable via an AbortController signal (user activity) — phases check the
// signal between batches so a running cycle yields promptly.
import { randomUUID, createHash } from "node:crypto";
import { validateDecisions, applyDecisions } from "./decisions.js";
import { findPotentialConflicts } from "./clustering.js";
import { buildReceipt } from "../dream.js";

const SUMMARY_MAX = 120;
// Conflict similarity threshold per strictness level (v0.4.0):
//   gentle     only high-confidence pairs (0.92) — first-time users
//   normal     standard dream-level (0.85) — default
//   aggressive low-confidence pairs too (0.75) — bloated stores
const CONFLICT_THRESHOLDS = { gentle: 0.92, normal: 0.85, aggressive: 0.75 };

const CONFLICT_PROMPT = `你是记忆库冲突仲裁助手。下面是检测到的高相似度记忆对，可能内容矛盾或重复。
对每一对输出一个 decision 对象：
- 两条确实矛盾/重复 → { "action": "conflict", "winner": <保留的id>, "loser": <归档的id>, "reason": "理由" }
- 两条只是主题相近、并无矛盾 → { "action": "keep", "ids": [<两个id>] }
规则：
- winner 应为信息更完整、更新或更可信的一条
- 只使用提供的 id，不要编造
- 每对必须输出一个 decision
- 只输出 JSON 数组，不要其他文字`;

const PATTERN_PROMPT = `你是记忆库模式发现助手。下面是最近的记忆条目（id、类型、标题、内容）。
请发现跨条目的稳定模式：用户偏好的规律、反复出现的主题、可复用的工作流或项目规律。
对每个模式输出一个 create decision：
{ "action": "create", "type": "pattern", "title": "模式一句话标题", "content": "模式详细描述（2-4句）", "importance": 1-5, "evidence": ["支持该模式的记忆id"] }
规则：
- 只输出有据可依的模式，宁缺毋滥
- evidence 必须是列表中真实存在的 id
- 最多输出 N 个模式
- 只输出 JSON 数组，不要其他文字`;

function parseJsonArray(text) {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Same stream consumption contract as dream.js. */
async function streamText(ctx, options) {
  if (!ctx?.llm?.stream) return undefined;
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      return undefined;
    }
  }
  return text;
}

/** LLM route: agent default model first, then sleepProvider/Model, then the
 *  dream route as a shared fallback. Sleep can pin a cheaper model for its
 *  bulk passes without disturbing the dream route. */
function resolveSleepRoute(ctx, config, logger) {
  try {
    const sel = ctx?.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
  } catch { /* fall through to config route */ }
  if (config.sleepProvider && config.sleepModel) return { provider: config.sleepProvider, model: config.sleepModel };
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  logger?.warn?.("dsh-mneme sleep: no llm route available");
  return undefined;
}

function makeSummary(m) {
  const text = (m.content ?? "").trim();
  if (!text) return (m.title ?? "").trim();
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX)}…`;
}

// ---------------------------------------------------------------- phases

/**
 * Phase 1 — conflict resolution. Needs a semantic embedder + vector index.
 * In freeze mode (conflictFreezeEnabled) conflicting pairs are parked in
 * conflict_pending for human review (no LLM). Otherwise the LLM adjudicates:
 * each pair → winner kept / loser archived. Returns a per-run summary.
 */
async function phaseConflicts(ctx, service, config, logger, runId, semantic = null, signal = null) {
  const embedder = semantic?.embedder;
  const vectorIndex = semantic?.vectorIndex;
  if (!embedder || !vectorIndex || typeof embedder.embed !== "function") {
    return { status: "skipped", reason: "no semantic embedder" };
  }
  const strictness = config.sleepConflictStrictness ?? "normal";
  const threshold = CONFLICT_THRESHOLDS[strictness] ?? CONFLICT_THRESHOLDS.normal;
  const memories = service.all().filter((m) => !m.archived && !m.forgotten && m.type !== "summary");
  if (memories.length < 2) return { status: "skipped", reason: "too few memories" };
  if (signal?.aborted) return { status: "aborted", reason: "user activity" };

  // Backfill + collect vectors for every eligible memory (best effort).
  const vectors = new Array(memories.length);
  const missing = [];
  for (let i = 0; i < memories.length; i++) {
    const cached = vectorIndex.getEmbedding?.(memories[i].id);
    if (cached) vectors[i] = cached;
    else missing.push(i);
  }
  if (missing.length) {
    try {
      const texts = missing.map((i) => [memories[i].title, memories[i].content].filter(Boolean).join("\n"));
      const rows = await embedder.embed(texts);
      missing.forEach((mi, j) => {
        if (rows[j]?.length) {
          vectors[mi] = rows[j];
          vectorIndex.saveEmbedding?.(memories[mi].id, rows[j]);
        }
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme sleep: conflict vector backfill failed: ${String(error)}`);
    }
  }
  const usable = [];
  for (let i = 0; i < memories.length; i++) {
    if (vectors[i]?.length) usable.push(i);
  }
  if (usable.length < 2) return { status: "skipped", reason: "no usable vectors" };
  const usableMemories = usable.map((i) => memories[i]);
  const usableVectors = usable.map((i) => vectors[i]);

  const pairs = findPotentialConflicts(usableMemories, usableVectors, threshold);
  if (pairs.length === 0) return { status: "skipped", reason: "no conflicts found" };

  // Dedupe: each memory participates in at most one pair, highest similarity
  // first — overlapping pairs would violate validateDecisions' "one claim".
  pairs.sort((a, b) => b.similarity - a.similarity);
  const used = new Set();
  const selected = [];
  for (const p of pairs) {
    if (used.has(p.a.id) || used.has(p.b.id)) continue;
    used.add(p.a.id);
    used.add(p.b.id);
    selected.push(p);
  }

  // Freeze mode: park pairs for manual review, no LLM required.
  if (config.conflictFreezeEnabled === true) {
    let frozen = 0;
    for (const p of selected) {
      try {
        service.saveConflictPending({ run_id: runId, memory_a: p.a.id, memory_b: p.b.id, reason: `相似度 ${p.similarity.toFixed(2)}` });
        frozen++;
      } catch (error) {
        logger?.warn?.(`dsh-mneme sleep: failed to freeze conflict ${p.a.id}/${p.b.id}: ${String(error)}`);
      }
    }
    return { status: frozen > 0 ? "ok" : "noop", frozen, pairs: selected.length };
  }

  // LLM adjudication.
  const route = resolveSleepRoute(ctx, config, logger);
  if (!route) return { status: "skipped", reason: "no llm route" };
  const snapshot = new Map();
  for (const p of selected) {
    snapshot.set(p.a.id, p.a);
    snapshot.set(p.b.id, p.b);
  }
  const listText = selected.map((p) =>
    `候选冲突：\nid=${p.a.id} | type=${p.a.type} | title=${p.a.title}\n${p.a.content}\n---\nid=${p.b.id} | type=${p.b.type} | title=${p.b.title}\n${p.b.content}\n（相似度 ${p.similarity.toFixed(2)}）`
  ).join("\n\n");
  const text = await streamText(ctx, {
    provider: route.provider,
    model: route.model,
    purpose: "sleep-conflict",
    maxTokens: 2048,
    ...(config.sleepReasoningEffort && config.sleepReasoningEffort !== "none"
      ? { reasoningEffort: config.sleepReasoningEffort }
      : {}),
    messages: [
      { role: "system", content: [{ type: "text", text: CONFLICT_PROMPT }] },
      { role: "user", content: [{ type: "text", text: listText }] }
    ]
  });
  if (text === undefined) return { status: "failed", error: "llm failed" };
  const decisions = parseJsonArray(text);
  if (!decisions) return { status: "failed", error: "invalid decisions json" };
  // validateDecisions 要求每个 snapshot id 恰好被 claim 一次。v0.4.4 起它本身
  // 就会为未覆盖的 id 自动补 keep（dreamImplicitKeep 默认开启），这里保留显式
  // 预填作为防御性双保险——漏判读作"未裁决冲突"而非"冲突阶段整体失败"。
  const covered = new Set();
  for (const d of decisions) {
    if (d?.action === "conflict") {
      if (typeof d?.winner === "string") covered.add(d.winner);
      if (typeof d?.loser === "string") covered.add(d.loser);
    } else if (Array.isArray(d?.ids)) {
      for (const id of d.ids) covered.add(id);
    }
  }
  for (const id of snapshot.keys()) {
    if (!covered.has(id)) decisions.push({ action: "keep", ids: [id] });
  }
  const { ok, errors } = validateDecisions(decisions, snapshot, {});
  if (!ok) return { status: "failed", error: `invalid decisions: ${errors.join("; ")}` };
  const { applied, failures, conflicts } = applyDecisions(decisions, service, logger, snapshot, config);
  return {
    status: applied > 0 ? "ok" : failures.length ? "failed" : "noop",
    pairs: selected.length,
    applied,
    failures,
    conflicts
  };
}

/**
 * Phase 2 — archival demotion. No LLM: tiering is time-based, summaries are
 * truncations, and the full body is preserved in _full_content so nothing is
 * lost. Deterministic and cheap, so it runs even with no LLM route.
 */
function phaseDemotion(service, config, logger, runId, signal = null) {
  const archiveDays = config.sleepArchiveDays ?? 30;
  const compressDays = config.sleepCompressDays ?? 90;
  const archiveCut = Date.now() - archiveDays * 86400000;
  const compressCut = Date.now() - compressDays * 86400000;
  const demoted = [];
  const archived = [];
  for (const m of service.all()) {
    if (signal?.aborted) break;
    if (m.archived || m.forgotten) continue;
    const ref = m.last_accessed_at ?? m.updated_at ?? m.created_at;
    if (!ref) continue;
    const t = new Date(ref).getTime();
    if (Number.isNaN(t)) continue;
    if (t < compressCut) {
      service.setArchived(m.id, true);
      archived.push(m.id);
    } else if (t < archiveCut) {
      // minRefTimeMs re-checks freshness inside demoteToSummary's transaction:
      // a recall touch landing after this snapshot must not demote the memory.
      service.demoteToSummary(m.id, makeSummary(m), { minRefTimeMs: archiveCut });
      demoted.push(m.id);
    }
  }
  return {
    status: demoted.length || archived.length ? "ok" : "noop",
    demoted,
    archived
  };
}

/**
 * Phase 3 — pattern discovery. The LLM scans the most recent memories and
 * mints type=pattern entries (create actions) with evidence references.
 * The empty snapshot is intentional: create claims no existing id, so the
 * "every id claimed" invariant is trivially satisfied for pure-create lists.
 */
async function phasePatterns(ctx, service, config, logger, runId, signal = null) {
  const route = resolveSleepRoute(ctx, config, logger);
  if (!route) return { status: "skipped", reason: "no llm route" };
  const limit = config.sleepPatternMinMemories ?? 100;
  const memories = service
    .list({ limit: 200, includeForgotten: false })
    .filter((m) => !m.archived && m.type !== "summary" && m.type !== "pattern")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, limit);
  if (memories.length === 0) return { status: "skipped", reason: "no memories to scan" };
  if (signal?.aborted) return { status: "aborted", reason: "user activity" };
  const listText = memories
    .map((m) => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`)
    .join("\n");
  const maxPatterns = config.sleepMaxPatternPerRun ?? 3;
  const text = await streamText(ctx, {
    provider: route.provider,
    model: route.model,
    purpose: "sleep-pattern",
    maxTokens: 2048,
    ...(config.sleepReasoningEffort && config.sleepReasoningEffort !== "none"
      ? { reasoningEffort: config.sleepReasoningEffort }
      : {}),
    messages: [
      { role: "system", content: [{ type: "text", text: PATTERN_PROMPT.replace("N", String(maxPatterns)) }] },
      { role: "user", content: [{ type: "text", text: listText }] }
    ]
  });
  if (text === undefined) return { status: "failed", error: "llm failed" };
  const decisions = parseJsonArray(text);
  if (!decisions || decisions.length === 0) return { status: "skipped", reason: "no patterns found" };
  // Evidence ids are provenance refs; an LLM-fabricated id would mint a dead
  // ev:tag pointing nowhere. Intersect evidence with the scanned set so only
  // real memory references survive.
  const scannedIds = new Set(memories.map((m) => m.id));
  for (const d of decisions) {
    if (d?.action === "create" && Array.isArray(d.evidence)) {
      d.evidence = d.evidence.filter((id) => typeof id === "string" && scannedIds.has(id));
    }
  }
  const snapshot = new Map();
  const { ok, errors } = validateDecisions(decisions, snapshot, {
    maxCreatePerRun: maxPatterns
  });
  if (!ok) return { status: "failed", error: `invalid decisions: ${errors.join("; ")}` };
  const { applied, failures, conflicts } = applyDecisions(decisions, service, logger, snapshot, config);
  return {
    status: applied > 0 ? "ok" : "noop",
    scanned: memories.length,
    applied,
    failures,
    conflicts
  };
}

/**
 * Phase 4 — entity relation completion. Detects orphan entities (zero
 * relations) and completes implied relations from memory co-occurrence:
 * entities named in the same memory → related_to; container kinds
 * (project/module) → part_of; tech-ish pairs → depends_on. Deterministic,
 * no LLM — cheap, so it runs even without a route. saveRelation is
 * bookkeeping (no write hook), so it never re-triggers the scheduler.
 */
function inferRelationType(a, b) {
  if ((a.type === "project" || a.type === "module") && a.type !== b.type) return "part_of";
  if ((b.type === "project" || b.type === "module") && b.type !== a.type) return "part_of";
  if (/npm|plugin|api|sdk|lib|framework|package|deps?|build/i.test(`${a.name} ${b.name}`)) return "depends_on";
  return "related_to";
}

function phaseRelations(service, config, logger, runId, signal = null) {
  const entities = service.listEntities({ limit: 1000 }) ?? [];
  if (entities.length < 2) return { status: "skipped", reason: "too few entities" };
  const orphans = entities.filter((e) => (service.getRelations(e.id) ?? []).length === 0);
  if (orphans.length === 0) return { status: "skipped", reason: "no orphan entities" };
  const memories = service.all().filter((m) => !m.archived && !m.forgotten);
  const seen = new Set();
  const related = [];
  const MAX_RELATIONS_PER_ORPHAN = 3;
  for (const o of orphans) {
    if (signal?.aborted) break;
    let made = 0;
    for (const m of memories) {
      if (signal?.aborted || made >= MAX_RELATIONS_PER_ORPHAN) break;
      const text = `${m.title ?? ""} ${m.content ?? ""}`;
      if (!text.includes(o.name)) continue;
      for (const other of entities) {
        if (other.id === o.id || other.name === o.name) continue;
        const key = [o.id, other.id].sort().join("|");
        if (seen.has(key)) continue;
        if (!text.includes(other.name)) continue;
        const relationType = inferRelationType(o, other);
        try {
          service.saveRelation({ from_entity: o.id, to_entity: other.id, relation_type: relationType, memory_id: m.id, metadata: { source: "sleep_relation_completion" } });
          seen.add(key);
          related.push({ from: o.id, to: other.id, type: relationType });
          made++;
        } catch (error) {
          logger?.warn?.(`dsh-mneme sleep: relation ${o.id}/${other.id} failed: ${String(error)}`);
        }
      }
    }
  }
  return {
    status: related.length > 0 ? "ok" : "noop",
    orphanCount: orphans.length,
    related
  };
}

// ---------------------------------------------------------------- run

function deriveStatus(phases) {
  const list = Object.values(phases);
  if (list.length === 0) return "noop";
  const anyError = list.some((p) => p.status === "failed" || p.status === "error");
  const anyWork = list.some((p) => p.status === "ok");
  if (anyWork && anyError) return "degraded";
  if (anyError) return "failed";
  if (anyWork) return "ok";
  return "noop";
}

/**
 * Run one full sleep cycle. Best-effort across all phases; writes a
 * run_type='sleep' audit row (same dream_runs table) so sleep activity is
 * observable alongside consolidation runs.
 */
export async function runSleep(ctx, service, config, logger, semantic = null, signal = null) {
  const runId = randomUUID();
  const phases = {};
  const attempt = async (name, fn) => {
    if (signal?.aborted) return; // user resumed activity — stop before next phase
    try {
      phases[name] = await fn();
    } catch (error) {
      phases[name] = { status: "failed", error: error?.message ?? String(error) };
      logger?.warn?.(`dsh-mneme sleep: ${name} phase failed: ${error?.message ?? error}`);
    }
  };
  await attempt("conflicts", () => phaseConflicts(ctx, service, config, logger, runId, semantic, signal));
  await attempt("demotion", () => phaseDemotion(service, config, logger, runId, signal));
  await attempt("patterns", () => phasePatterns(ctx, service, config, logger, runId, signal));
  await attempt("relations", () => phaseRelations(service, config, logger, runId, signal));

  const status = deriveStatus(phases);
  const route = resolveSleepRoute(ctx, config, logger);
  const totalApplied = Object.values(phases).reduce((n, p) => n + (Number.isInteger(p?.applied) ? p.applied : 0), 0);
  const snapshotHash = createHash("sha256").update(JSON.stringify(phases)).digest("hex");
  const receipt = buildReceipt({
    runId,
    status,
    snapshotHash,
    inputCount: 0,
    applied: totalApplied,
    summaryStored: false
  });
  try {
    service.saveDreamRun({
      id: runId,
      status,
      provider: route?.provider,
      model: route?.model,
      snapshot_hash: snapshotHash,
      input_count: 0,
      input: null,
      decisions: phases,
      outcome: phases,
      applied: totalApplied,
      summary_stored: false,
      receipt,
      policy_epoch: config.policyEpoch ?? 0,
      run_type: "sleep"
    });
  } catch (error) {
    logger?.warn?.(`dsh-mneme sleep: failed to record audit run: ${String(error)}`);
  }
  return { ok: status === "ok" || status === "degraded", status, runId, phases, receipt };
}

// ---------------------------------------------------------------- scheduler

/**
 * Idle-triggered scheduler. DSH plugins have no resident cron, so a sleep run
 * fires when: sleep is enabled, the store has been quiet for sleepIdleMinutes,
 * and the previous run is older than sleepMinIntervalHours. noteWrite() is
 * called on every store write and (re)arms an idle timer that re-checks at the
 * exact moment the idle window elapses — no polling, no cron.
 *
 * A `now` clock can be injected for tests; it defaults to Date.now.
 */
export function createSleepScheduler({
  service,
  config,
  logger,
  onRun = null,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  let lastWriteAt = now();
  let lastRunAt = 0;
  let running = false;
  let disposed = false;
  let idleTimer = null;
  let sleepAbort = null;

  function armIdleTimer() {
    if (disposed || idleTimer) return;
    if (config.sleepModeEnabled !== true) return;
    const idleMs = (config.sleepIdleMinutes ?? 5) * 60000;
    const delay = Math.max(0, idleMs - (now() - lastWriteAt)) + 1000;
    idleTimer = setTimeoutFn(async () => {
      idleTimer = null;
      await maybeSchedule();
    }, delay);
    idleTimer.unref?.();
  }

  function shouldRun(at = now()) {
    if (disposed || running) return false;
    if (config.sleepModeEnabled !== true) return false;
    if (at - lastWriteAt < (config.sleepIdleMinutes ?? 5) * 60000) return false;
    // lastRunAt === 0 means never ran — the min-interval check must not block
    // the very first cycle (a real run stamps a nonzero timestamp).
    if (lastRunAt > 0 && at - lastRunAt < (config.sleepMinIntervalHours ?? 8) * 3600000) return false;
    return true;
  }

  /** Called on writes: resets the idle clock and re-arms the fire timer. The
   *  pending timer is cleared first — a stale timer armed against the old idle
   *  window would otherwise fire early, fail shouldRun, and leave nothing armed
   *  for the next window (a missed trigger until the next write).
   *
   *  While a sleep run is executing (running=true) the in-flight AbortController
   *  is NOT aborted: the run's own writes (demoteToSummary / setArchived ride
   *  the normal write-hook path) would otherwise self-abort the cycle. External
   *  activity during the run still resets the idle clock here, so no new cycle
   *  fires until the store is quiet again. */
  function noteWrite() {
    lastWriteAt = now();
    if (!running && sleepAbort) {
      sleepAbort.abort(); // user resumed activity — interrupt an idle run
    }
    if (idleTimer) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    armIdleTimer();
  }

  async function maybeSchedule() {
    if (!shouldRun()) return false;
    running = true;
    const abort = new AbortController();
    sleepAbort = abort;
    try {
      lastRunAt = now();
      const result = await service.enqueue(() =>
        onRun ? onRun(abort.signal) : Promise.resolve({ ok: true, skipped: true })
      );
      return !!(result && result.ok);
    } catch (error) {
      logger?.warn?.(`dsh-mneme sleep: run failed: ${error?.message ?? error}`);
      return false;
    } finally {
      sleepAbort = null;
      running = false;
    }
  }

  async function dispose() {
    disposed = true;
    if (idleTimer) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    if (sleepAbort) {
      sleepAbort.abort();
      sleepAbort = null;
    }
  }

  return { noteWrite, maybeSchedule, shouldRun, dispose };
}
