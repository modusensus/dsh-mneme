const ACTIONS = new Set(["keep", "merge", "archive", "conflict", "update", "create"]);

/**
 * Validate a dream decision list against a snapshot of eligible memories.
 * @param decisions - LLM-produced decision list.
 * @param snapshot - Map<id, memory> of eligible (non-archived, non-summary) entries.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateDecisions(decisions, snapshot, options = {}) {
  const errors = [];
  const maxUpdatePerRun = options.maxUpdatePerRun ?? 2;
  const minAgeHours = options.minAgeHours ?? 24;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { ok: false, errors: ["decision list must be a non-empty array"] };
  }
  const claimed = new Set();
  for (const [index, d] of decisions.entries()) {
    const at = `decision[${index}]`;
    if (!d || typeof d !== "object" || !ACTIONS.has(d.action)) {
      errors.push(`${at}: invalid action ${JSON.stringify(d?.action)}`);
      continue;
    }
    const ids = d.action === "conflict" ? [d.winner, d.loser] : (d.ids ?? []);
    if (d.action === "conflict") {
      if (!d.winner || !d.loser || d.winner === d.loser) {
        errors.push(`${at}: conflict needs distinct winner and loser`);
        continue;
      }
    } else if (d.action === "create") {
      // Mint a fresh memory (sleep pattern discovery). Claims no existing id,
      // so it skips the claiming loop below; evidence is optional provenance
      // (already filtered to real ids by the caller) and is stored in content.
      if (typeof d.title !== "string" || !d.title.trim()) {
        errors.push(`${at}: create needs non-empty title`);
        continue;
      }
      if (typeof d.content !== "string" || !d.content.trim()) {
        errors.push(`${at}: create needs non-empty content`);
        continue;
      }
      if (d.importance !== undefined && (!Number.isInteger(d.importance) || d.importance < 1 || d.importance > 5)) {
        errors.push(`${at}: create importance must be an integer 1-5 when provided`);
      }
      if (typeof d.type !== "string" || !d.type.trim()) {
        errors.push(`${at}: create needs non-empty type`);
      }
      continue;
    } else if (!Array.isArray(d.ids) || d.ids.length === 0) {
      errors.push(`${at}: ${d.action} needs non-empty ids`);
      continue;
    }
    // update-specific field validation runs BEFORE claiming ids, so a failing
    // update never pollutes the claimed set (which drives the "every id must
    // appear in a decision" check below).
    if (d.action === "update") {
      // 只能更新单条
      if (!Array.isArray(d.ids) || d.ids.length !== 1) {
        errors.push(`${at}: update must target exactly one id`);
        continue;
      }
      // 必须产生实际变化
      const mem = snapshot.get(d.ids[0]);
      const hasChange = (d.title !== undefined && d.title !== mem?.title)
        || (d.content !== undefined && d.content !== mem?.content)
        || (d.importance !== undefined && d.importance !== mem?.importance);
      if (!hasChange) {
        errors.push(`${at}: update must change at least one field`);
        continue;
      }
      // 不能更新 summary
      if (mem?.type === "summary") {
        errors.push(`${at}: cannot update summary via update action`);
        continue;
      }
      // 保护期：新建记忆不可立即被 update（可配置）
      const ageHours = (Date.now() - new Date(mem?.created_at).getTime()) / 3600000;
      if (ageHours < minAgeHours) {
        errors.push(`${at}: memory too young (< ${minAgeHours}h)`);
        continue;
      }
    }
    for (const id of ids) {
      const mem = snapshot.get(id);
      if (!mem) {
        errors.push(`${at}: unknown id ${JSON.stringify(id)}`);
      } else if (mem.archived || mem.type === "summary") {
        errors.push(`${at}: id ${JSON.stringify(id)} is archived or summary (not eligible)`);
      }
      if (claimed.has(id)) {
        errors.push(`${at}: id ${JSON.stringify(id)} claimed by multiple decisions`);
      }
      claimed.add(id);
    }
    if (d.action === "merge") {
      if (!d.keepSource || !d.ids.includes(d.keepSource)) {
        errors.push(`${at}: merge keepSource must be one of ids`);
      }
      if (typeof d.title !== "string" || !d.title.trim() || typeof d.content !== "string" || !d.content.trim()) {
        errors.push(`${at}: merge needs non-empty title and content`);
      }
      if (d.importance !== undefined && (!Number.isInteger(d.importance) || d.importance < 1 || d.importance > 5)) {
        errors.push(`${at}: merge importance must be an integer 1-5 when provided`);
      }
      // Merging across types would blur preference/project/decision boundaries
      // in the injected context; the snapshot carries each entry's type.
      const mergeTypes = new Set(d.ids.map((id) => snapshot.get(id)?.type));
      if (mergeTypes.size > 1) {
        errors.push(`${at}: merge ids span multiple types (${[...mergeTypes].join(", ")})`);
      }
    }
  }
  // Cap update churn: too many edits in one cycle signals a runaway model
  const updateCount = decisions.filter((d) => d.action === "update").length;
  if (updateCount > maxUpdatePerRun) {
    errors.push(`too many update decisions: ${updateCount} > ${maxUpdatePerRun}`);
  }
  // Cap pattern minting per run (sleepMaxPatternPerRun passes through here).
  const createCount = decisions.filter((d) => d.action === "create").length;
  const maxCreatePerRun = options.maxCreatePerRun ?? 5;
  if (createCount > maxCreatePerRun) {
    errors.push(`too many create decisions: ${createCount} > ${maxCreatePerRun}`);
  }
  // v0.4.4: 隐式 keep。默认（dreamImplicitKeep !== false）下，未 claim 的
  // snapshot 记忆自动补 {action:"keep"}，而不是整体拒绝——大记忆量下 LLM 漏报
  // 一两条就全拒（636 记忆 → 677 errors）会白白浪费整轮 run。设 false 则保留
  // 旧的严格"全量覆盖"校验。补齐的 keep 直接 append 到 decisions，调用方
  // （runDream/applyDecisions/audit）复用同一数组即可覆盖全部 snapshot 记忆。
  if (options.dreamImplicitKeep !== false) {
    for (const id of snapshot.keys()) {
      if (!claimed.has(id)) decisions.push({ action: "keep", ids: [id] });
    }
  } else {
    for (const id of snapshot.keys()) {
      if (!claimed.has(id)) errors.push(`memory ${JSON.stringify(id)} missing from decisions`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Marker thrown when a decision target changed since the run snapshot. */
export class CasConflictError extends Error {
  constructor(action, ids, reason) {
    super(`cas conflict: ${action} targets changed since snapshot (${reason})`);
    this.name = "CasConflictError";
    this.action = action;
    this.ids = ids;
  }
}

function decisionIds(d) {
  return d.action === "conflict" ? [d.winner, d.loser] : (d.ids ?? []);
}

/**
 * CAS guard (item ①): every target memory must still match what the run
 * snapshot captured — otherwise the decision was computed against stale state
 * and applying it would overwrite a concurrent edit. Snapshotless replays skip
 * the guard entirely (per-action idempotency checks handle those). Throws
 * CasConflictError on the first mismatch; the caller's transaction rolls back.
 */
function casGuard(service, snapshot, ids) {
  if (!snapshot) return;
  for (const id of ids) {
    const expect = snapshot.get(id);
    if (!expect) continue; // not in snapshot: validated elsewhere, skip guard
    const current = service.getById(id);
    if (!current) {
      throw new CasConflictError("deleted", [id], `memory ${id} was removed`);
    }
    const changed = expect.updated_at !== undefined
      ? current.updated_at !== expect.updated_at
      : current.content !== expect.content || current.title !== expect.title;
    if (changed) {
      throw new CasConflictError(
        "changed",
        [id],
        `memory ${id} was concurrently modified (expected updated_at=${expect.updated_at}, got ${current.updated_at})`
      );
    }
  }
}

/**
 * Apply a validated decision list to the service. Caller must validate first.
 * Each decision runs inside its own SQLite transaction (item ②): the multi-step
 * mutation of a decision is atomic, so a merge can never leave "keeper updated
 * but source not archived" or vice versa — a throwing sub-step rolls the whole
 * decision back.
 *
 * @param decisions - validated decision list.
 * @param service - memory service (saveWithDedupe/getById/update/setArchived/transaction).
 * @param logger - optional logger ({ warn }); per-decision failures are logged.
 * @param snapshot - optional Map<id, memory> captured before the LLM call; when
 *   provided, every decision target is CAS-checked against it and a decision
 *   computed from stale state is skipped and reported as a conflict instead of
 *   overwriting concurrent writes (item ①).
 * @returns {{ applied: number, conflicts: Array, failures: Array, committed: Array }}
 *   applied    - number of decisions/memories actually committed (archive counts
 *                each archived memory as one, merge/conflict/update count one).
 *   conflicts  - decisions skipped because a target changed since the snapshot.
 *   failures   - decisions that threw mid-transaction (fully rolled back).
 *   committed  - the decisions that actually landed, for outcome/receipt based
 *                on real committed sub-steps rather than the raw LLM list.
 */
export function applyDecisions(decisions, service, logger = null, snapshot = null, config = {}) {
  let applied = 0;
  const conflicts = [];
  const failures = [];
  const committed = [];
  for (const [i, d] of decisions.entries()) {
    try {
      // keep is a confirmed no-op: it commits nothing but still records the
      // per-id disposition so the outcome covers every snapshot memory.
      if (d.action === "keep") {
        committed.push({ action: "keep", ids: d.ids });
        continue;
      }
      const outcome = applyOne(d, service, snapshot, config);
      if (outcome === "skipped") continue;
      applied += outcome.applied;
      committed.push(outcome.committed);
    } catch (error) {
      if (error instanceof CasConflictError) {
        conflicts.push({ index: i, action: d.action, ids: error.ids, reason: error.message });
        logger?.warn?.(`dsh-mneme dream: ${error.message}`);
      } else {
        failures.push({ index: i, action: d.action, ids: decisionIds(d), reason: error.message });
        logger?.warn?.(`dsh-mneme dream: failed to apply ${d.action} at index ${i}: ${error.message}`);
      }
    }
  }
  return { applied, conflicts, failures, committed };
}

function applyOne(d, service, snapshot, config = {}) {
  switch (d.action) {
    case "archive": return applyArchive(d, service, snapshot);
    case "merge": return applyMerge(d, service, snapshot, config);
    case "conflict": return applyConflict(d, service, snapshot);
    case "create": return applyCreate(d, service, config);
    default: return applyUpdate(d, service, snapshot, config);
  }
}

/**
 * Mint a fresh memory (pattern discovery). No existing target, so no CAS guard.
 * Evidence ids ride in the content so a pattern stays traceable to its source
 * memories. saveWithDedupe dedupes identical mints (idempotent replay-safe).
 */
function applyCreate(d, service, config = {}) {
  const title = String(d.title ?? "").trim();
  const content = String(d.content ?? "").trim();
  const importance = Number.isInteger(d.importance) ? d.importance : 3;
  const type = typeof d.type === "string" ? d.type : "pattern";
  const evidence = Array.isArray(d.evidence)
    ? d.evidence.filter((id) => typeof id === "string")
    : [];
  const body = evidence.length > 0
    ? `${content}\n\n[证据: ${evidence.join(", ")}]`
    : content;
  const created = service.saveWithDedupe({ type, title, content: body, importance });
  const memory = created?.memory;
  if (!memory) return "skipped"; // deduped/subsumed: nothing minted, clean no-op
  return { applied: 1, committed: { action: "create", id: memory.id, type } };
}

function applyArchive(d, service, snapshot) {
  const targets = d.ids.filter((id) => {
    const mem = service.getById(id);
    return mem && !mem.archived; // existing, not-yet-archived rows only
  });
  if (targets.length === 0) return "skipped"; // all already archived: idempotent replay
  service.transaction(() => {
    casGuard(service, snapshot, d.ids);
    for (const id of d.ids) {
      const mem = service.getById(id);
      if (mem && !mem.archived) service.setArchived(id, true);
    }
  });
  return { applied: targets.length, committed: { action: "archive", ids: targets } };
}

function applyMerge(d, service, snapshot, config = {}) {
  const sources = d.ids.filter((id) => id !== d.keepSource);
  // Idempotent replay: if every other source is already archived, this merge
  // already landed — skip so a replayed/concurrent decision never double-counts
  // or re-applies (guard against duplicate merges).
  if (sources.every((id) => service.getById(id)?.archived)) return "skipped";
  service.transaction(() => {
    casGuard(service, snapshot, d.ids);
    const keeper = service.getById(d.keepSource);
    if (!keeper || keeper.archived) return; // missing keeper: no write, still a clean commit
    service.update(d.keepSource, {
      title: d.title,
      content: d.content,
      importance: d.importance ?? Math.max(keeper.importance, ...d.ids.map((id) => service.getById(id)?.importance ?? 1))
    });
    for (const id of sources) {
      const mem = service.getById(id);
      if (mem && !mem.archived) service.setArchived(id, true);
    }
    // 4.3.2 迁移实体关联（opt-in）：将 loser（source）记忆关联的 entity_attrs 的
    // memory_id 迁移到 keeper；keeper 已有同 entity+key 的当前属性时 loser 行被
    // 失效。单个 source 迁移失败只告警，绝不能导致整个 merge 事务回滚（fail-safe）。
    if (config.entityExtractionEnabled && typeof service.migrateAttrsToMemory === "function") {
      for (const id of sources) {
        try {
          service.migrateAttrsToMemory(id, d.keepSource, new Date().toISOString());
        } catch (error) {
          logger?.warn?.(`dsh-mneme dream: failed to migrate attrs from ${id} to ${d.keepSource}: ${error.message}`);
        }
      }
    }
  });
  return {
    applied: 1,
    committed: { action: "merge", ids: d.ids, keepSource: d.keepSource, title: d.title, content: d.content, importance: d.importance, count_before: d.ids.length, count_after: 1 }
  };
}

function applyConflict(d, service, snapshot) {
  const winner = service.getById(d.winner);
  const loser = service.getById(d.loser);
  if (!winner || !loser) return "skipped";
  // Idempotent replay: an already-archived loser means the conflict was already
  // adjudicated — skip so the provenance note is never re-appended and the loser
  // is not re-archived.
  if (loser.archived) return "skipped";
  service.transaction(() => {
    casGuard(service, snapshot, [d.winner, d.loser]);
    const winnerNow = service.getById(d.winner);
    const loserNow = service.getById(d.loser);
    if (!winnerNow || !loserNow || loserNow.archived) return;
    service.update(d.winner, {
      content: `${winnerNow.content}\n\n（已否决旧信息：${[...loserNow.content].slice(0, 100).join("")}）`
    });
    service.setArchived(d.loser, true);
  });
  return { applied: 1, committed: { action: "conflict", winner: d.winner, loser: d.loser, count_before: 2, count_after: 1 } };
}

function applyUpdate(d, service, snapshot, config = {}) {
  const id = d.ids[0];
  const mem = service.getById(id);
  if (!mem || mem.archived) return "skipped";
  // 幂等检查：如果字段已与目标一致则跳过
  const same = (d.title === undefined || d.title === mem.title)
    && (d.content === undefined || d.content === mem.content)
    && (d.importance === undefined || d.importance === mem.importance);
  if (same) return "skipped";
  service.transaction(() => {
    casGuard(service, snapshot, [id]);
    const cur = service.getById(id);
    if (!cur || cur.archived) return;
    service.update(id, {
      title: d.title ?? cur.title,
      content: d.content ?? cur.content,
      importance: d.importance ?? cur.importance
    });
  });
  // 4.3.1 supersedes 关系（opt-in）：事务提交成功后，为该记忆关联的每条实体属性
  // 建立自引用 supersedes 关系，表示"此属性版本已被替代"。仅记录、绝不阻断主流程
  // （fail-safe）：记录失败只告警，update 本身照常生效。
  if (config.entityExtractionEnabled && typeof service.saveRelation === "function" && typeof service.getAttrsByMemory === "function") {
    try {
      const oldAttrs = service.getAttrsByMemory(id);
      for (const attr of oldAttrs) {
        if (!attr.entity_id) continue;
        service.saveRelation({
          from_entity: attr.entity_id,
          to_entity: attr.entity_id,
          relation_type: "supersedes",
          memory_id: id,
          metadata: JSON.stringify({ attr_key: attr.attr_key, old_value: attr.attr_value })
        });
      }
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: failed to record supersedes relations for ${id}: ${error.message}`);
    }
  }
  return { applied: 1, committed: { action: "update", ids: [id], title: d.title, content: d.content, importance: d.importance, count_before: 1, count_after: 1 } };
}
