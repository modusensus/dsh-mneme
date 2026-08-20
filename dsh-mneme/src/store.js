import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  importance  INTEGER NOT NULL DEFAULT 3,
  forgotten   INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  session_disposed_at TEXT,
  source      TEXT,
  session_id  TEXT,
  content_history TEXT,
  embedding   TEXT,
  epistemic_status TEXT NOT NULL DEFAULT 'subjective',
  last_accessed_at  TEXT,
  _full_content     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);

-- autoDream audit trail: one row per consolidation run, capturing the exact
-- input snapshot digest + the LLM decision list + per-id outcome + a compact
-- receipt. This makes every decision replayable so silent consolidation errors
-- (high pass rate but wrong merge/conflict) can be located after the fact.
CREATE TABLE IF NOT EXISTS dream_runs (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL,          -- ok | noop | degraded | reconcile | failed
  error          TEXT,
  provider       TEXT,
  model          TEXT,
  snapshot_hash  TEXT NOT NULL,
  input_count    INTEGER NOT NULL,
  input          TEXT,                   -- JSON: full input snapshot (id/type/title/content/importance/updated_at)
  decisions      TEXT,                   -- JSON: raw LLM decision list
  outcome        TEXT,                   -- JSON: { byId: {id: action} }
  applied        INTEGER NOT NULL DEFAULT 0,
  summary_stored INTEGER NOT NULL DEFAULT 0,
  receipt        TEXT NOT NULL,
  policy_epoch   INTEGER NOT NULL DEFAULT 0,  -- 裁决规则版本：规则升级后旧裁决降级为历史证据
  run_type       TEXT NOT NULL DEFAULT 'auto'  -- auto | sleep：睡眠周期的审计区分
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_created ON dream_runs(created_at);

-- recall_runs: recall-layer receipt. One row per retrieval scene — the query,
-- mode, top-k, threshold and the exact candidate list (id/title/content/score/
-- source) that was returned — so retrieval behavior can be audited and
-- replayed after the fact. Sibling of the dream judgment-layer audit trail.
CREATE TABLE IF NOT EXISTS recall_runs (
  id          TEXT PRIMARY KEY,
  query       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  top_k       INTEGER,
  threshold   REAL,
  candidates  TEXT NOT NULL,   -- JSON: 召回候选数组（含 id/title/content/score/source）
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_runs_created ON recall_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_recall_runs_query ON recall_runs(query);

-- recall_evals: retrieval evaluation/test snapshots, kept SEPARATE from the
-- recall_runs production audit so test runs never inflate the production trail.
-- One row per evaluateRetrieval call that opted into persistence
-- (config.evalPersistTestResults): the query, the expected ids the operator
-- marked relevant, the actual ids retrieval returned, and the computed
-- metrics (precision/recall/mrr). recall_run_id optionally links to the
-- recall_runs audit row that captured the same retrieval scene (null when the
-- eval did not also record a run). Bookkeeping like the other audit tables: it
-- never triggers write hooks.
CREATE TABLE IF NOT EXISTS recall_evals (
  id            TEXT PRIMARY KEY,
  recall_run_id TEXT,                -- FK → recall_runs.id (optional linkage)
  query         TEXT NOT NULL,
  expected_ids  TEXT NOT NULL,       -- JSON: relevant ids expected by the evaluator
  actual_ids    TEXT NOT NULL,       -- JSON: ids actually retrieved
  metrics       TEXT NOT NULL,       -- JSON: { precision, recall, mrr, hit_count }
  eval_type     TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (recall_run_id) REFERENCES recall_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_recall_evals_created ON recall_evals(created_at);
CREATE INDEX IF NOT EXISTS idx_recall_evals_run ON recall_evals(recall_run_id);

-- failure_memories: records user corrections / reflection failures. Captures
-- what a memory was (actual) vs what the user changed it to (expected)
-- so later reflection passes can mine recurring correction patterns.
-- before holds a JSON snapshot of the pre-change title/content/importance,
-- so a title-only or importance-only correction is still traceable.
CREATE TABLE IF NOT EXISTS failure_memories (
  id           TEXT PRIMARY KEY,
  query        TEXT,
  expected     TEXT,
  actual       TEXT,
  before       TEXT,
  failure_type TEXT NOT NULL,
  memory_id    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failure_memories_created ON failure_memories(created_at);
CREATE INDEX IF NOT EXISTS idx_failure_memories_type ON failure_memories(failure_type);

-- receipt_chain: per-record receipt chain. One row per mutable verdict
-- (merge/conflict/update), carrying the input digest (the basis of the
-- decision, content-addressed) and the idempotency check counters
-- count_before → count_after. Replaying the same decision must reproduce the
-- same result; a digest match with a divergent outcome pinpoints drift to the
-- specific record/run. Sibling of the run-level dream audit trail.
CREATE TABLE IF NOT EXISTS receipt_chain (
  receipt_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- merge | conflict | update
  input_digest TEXT NOT NULL,
  winner_id    TEXT,
  loser_id     TEXT,
  keep_source  TEXT,
  sources      TEXT,                  -- JSON: merge 全部参与 id 数组
  verdict      TEXT NOT NULL,         -- live | revoked | historical
  count_before INTEGER NOT NULL,
  count_after  INTEGER NOT NULL,
  policy_epoch INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_chain_record ON receipt_chain(record_id);
CREATE INDEX IF NOT EXISTS idx_receipt_chain_run ON receipt_chain(run_id);

-- conflict_pending: conflicts parked for manual review (conflict freeze mode,
-- opt-in via config.conflictFreezeEnabled). When enabled, the dream layer does
-- NOT auto-adjudicate winner/loser — the conflicting pair is parked here until
-- a human reviews it. resolveConflictPending stamps resolved_at (plus the chosen
-- winner) so the review action stays auditable. Like the other audit tables this
-- is bookkeeping: it never triggers write hooks.
CREATE TABLE IF NOT EXISTS conflict_pending (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  memory_a        TEXT NOT NULL,
  memory_b        TEXT NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_winner TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflict_pending_unresolved ON conflict_pending(resolved_at);

-- llm_audit_logs: every background LLM call (autoDream consolidation + summary,
-- autoSummarize compression) is recorded here — tokens in/out, duration, status
-- and the trigger that caused it (Bug8). Failures are captured as status='error'
-- and never block the calling feature. retentionDays is enforced by a boot-time
-- purge (deleteOldLlmAudits). Bookkeeping like the other audit tables: it never
-- triggers write hooks.
CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp         TEXT NOT NULL,
  trigger_source    TEXT NOT NULL,          -- autoDream | autoSummarize | manual ...
  operation_type    TEXT NOT NULL,          -- dream_consolidate | dream_summarize | summarize_compress ...
  model_id          TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,          -- success | error | skipped
  error_message     TEXT,
  related_memory_ids TEXT,                  -- JSON: ids the call operated on
  metadata          TEXT                    -- JSON: free-form extras
);
CREATE INDEX IF NOT EXISTS idx_llm_audit_timestamp ON llm_audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_audit_source ON llm_audit_logs(trigger_source);

-- entity gene (v0.3.0): named entities mentioned across memories, with
-- time-boxed attributes (valid_from → valid_until) and typed relations.
-- Attributes follow the snapshot style: saveAttr invalidates the previous
-- value for the same entity+key before inserting a new row, so the current
-- value is always the row with valid_until IS NULL.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  mention_count INTEGER DEFAULT 1,
  canonical_memory_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS entity_attrs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  attr_key TEXT NOT NULL,
  attr_value TEXT NOT NULL,
  memory_id TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  confidence REAL DEFAULT 1.0,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_attrs_entity ON entity_attrs(entity_id);
CREATE INDEX IF NOT EXISTS idx_attrs_key ON entity_attrs(attr_key);
CREATE INDEX IF NOT EXISTS idx_attrs_valid ON entity_attrs(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_attrs_memory ON entity_attrs(memory_id);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  memory_id TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to ON entity_relations(to_entity);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(relation_type);

-- mirror 渲染状态 (F-NEW-03): 单行持久记录 mirror 同步失败/成功状态，使
-- syncMirror 失败不再只靠瞬时 console.warn —— dirty=1 提示镜像脏了需重渲染，
-- last_error/last_attempt 记录失败原因与最近尝试，success_at 记录最近成功。
-- 上层可据此在启动时重试、提供人工 reconcile 入口与健康状态查询。
-- v0.3.6: 新增 generation/applied_generation/type_status —— desired-applied
-- 建模镜像债务：generation 是期望同步轮次，applied_generation 是已成功应用
-- 轮次（成功清 dirty 必须 CAS/fence 到具体轮次，旧 worker 不能清新故障），
-- type_status 逐 type 记录部分成功状态。旧库经 PRAGMA table_info 检查后
-- ALTER 补列，幂等且不丢数据。
CREATE TABLE IF NOT EXISTS mirror_state (
  id TEXT PRIMARY KEY,               -- 单一状态行（用 'main'）
  dirty INTEGER NOT NULL DEFAULT 0,  -- 1=镜像脏了需重渲染
  last_error TEXT,                   -- 最近失败原因
  last_attempt TEXT,                 -- 最近尝试时间（ISO）
  success_at TEXT,                   -- 最近成功时间（ISO）
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991 AND generation = CAST(generation AS INTEGER)),         -- 期望的同步轮次（desired）
  applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (applied_generation >= 0 AND applied_generation <= 9007199254740991 AND applied_generation = CAST(applied_generation AS INTEGER)), -- 已成功应用的轮次
  type_status TEXT                               -- JSON: 逐 type 状态 {type: {dirty, applied_gen, last_error}}
);
`;

const TYPES = new Set(["preference", "project", "decision", "history", "summary", "pattern"]);

// Epistemic status: what kind of evidence a memory rests on. Defaults to
// 'subjective' so legacy rows (and rows without any signal) stay compatible.
const EPISTEMIC_STATUSES = new Set(["observation", "subjective", "inferred"]);
// Rule-based inference markers, checked in priority order (observation >
// inferred > subjective). The default fallback is 'subjective'.
const OBSERVATION_RE = /实测|观察到|观测|测得|测量|结果表明|数据显示|实验|统计|结果/;
const INFERRED_RE = /推断|推测出|推导|推论|由此可|据此|综上|意味着|所以|因此/;
const SUBJECTIVE_RE = /我推测|我猜|我觉得|我感觉|可能|大概|也许|认为|猜想|似乎|猜测|感觉/;

/**
 * Heuristically infer a memory's epistemic status from its content (and the
 * AI-generated types). summary/pattern entries are always 'inferred' (derived
 * from other memories); otherwise content markers decide. Pure rule-based, so
 * it never throws and always returns a value in EPISTEMIC_STATUSES.
 */
function inferEpistemicStatus(memory) {
  if (memory.type === "summary" || memory.type === "pattern") return "inferred";
  const text = `${memory.title ?? ""} ${memory.content ?? ""}`;
  if (OBSERVATION_RE.test(text)) return "observation";
  if (INFERRED_RE.test(text)) return "inferred";
  if (SUBJECTIVE_RE.test(text)) return "subjective";
  return "subjective";
}

/** Resolve a requested epistemic_status: explicit valid value wins, otherwise
 *  re-infer from (possibly updated) content. Never returns an invalid value. */
function resolveEpistemicStatus(memory, patch) {
  if (patch?.epistemic_status !== undefined) {
    return EPISTEMIC_STATUSES.has(patch.epistemic_status) ? patch.epistemic_status : "subjective";
  }
  // Re-infer whenever any signal that feeds the heuristic changed: content
  // (marker words), title (marker words), or type (summary/pattern are always
  // inferred). Otherwise keep the stored status.
  const changed = ["content", "title", "type"].some(
    (k) => patch?.[k] !== undefined && patch[k] !== memory?.[k]
  );
  if (changed) {
    return inferEpistemicStatus({ ...memory, ...patch });
  }
  return memory?.epistemic_status ?? "subjective";
}

// Per-type mirror sync receipts (peer blocker 4): a type is either committed
// (file written + fence applied), failed (last sync round errored for it), or
// pending (still owed a write).
const VALID_TYPE_STATUS = new Set(["committed", "failed", "pending"]);

// Pure helpers: no shared module state.

function sanitizePage(limit, offset, defaultLimit) {
  const lim = Number.isInteger(limit) && limit > 0 ? limit : defaultLimit;
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  return { limit: lim, offset: off };
}

function escapeLike(q) {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    importance: row.importance,
    forgotten: row.forgotten === 1,
    archived: row.archived === 1,
    session_disposed_at: row.session_disposed_at ?? undefined,
    source: row.source ?? undefined,
    session_id: row.session_id ?? undefined,
    content_history: parseJsonArray(row.content_history),
    quality_score: row.quality_score !== null && row.quality_score !== undefined ? Number(row.quality_score) : undefined,
    epistemic_status: row.epistemic_status ?? "subjective",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at ?? undefined,
    _full_content: row._full_content ?? undefined
  };
}

function toDreamRun(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    created_at: row.created_at,
    status: row.status,
    error: row.error ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    snapshot_hash: row.snapshot_hash,
    input_count: row.input_count,
    input: row.input ? JSON.parse(row.input) : undefined,
    decisions: row.decisions ? JSON.parse(row.decisions) : undefined,
    outcome: row.outcome ? JSON.parse(row.outcome) : undefined,
    applied: row.applied,
    summary_stored: row.summary_stored === 1,
    receipt: row.receipt,
    policy_epoch: row.policy_epoch ?? 0,
    run_type: row.run_type ?? "auto"
  };
}

function toReceipt(row) {
  if (!row) return undefined;
  return {
    receipt_id: row.receipt_id,
    run_id: row.run_id,
    record_id: row.record_id,
    kind: row.kind,
    input_digest: row.input_digest,
    winner_id: row.winner_id ?? undefined,
    loser_id: row.loser_id ?? undefined,
    keep_source: row.keep_source ?? undefined,
    sources: parseJsonArray(row.sources),
    verdict: row.verdict,
    count_before: row.count_before,
    count_after: row.count_after,
    policy_epoch: row.policy_epoch ?? 0,
    created_at: row.created_at
  };
}

function toConflictPending(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    run_id: row.run_id ?? undefined,
    memory_a: row.memory_a,
    memory_b: row.memory_b,
    reason: row.reason ?? undefined,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? undefined,
    resolved_winner: row.resolved_winner ?? undefined
  };
}

function toRecallRun(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    query: row.query,
    mode: row.mode,
    topK: row.top_k,
    threshold: row.threshold,
    candidates: parseJsonArray(row.candidates),
    created_at: row.created_at
  };
}

function toRecallEval(row) {
  if (!row) return undefined;
  let metrics;
  if (row.metrics != null) {
    try { metrics = JSON.parse(row.metrics); } catch { metrics = undefined; }
  }
  return {
    id: row.id,
    recall_run_id: row.recall_run_id ?? undefined,
    query: row.query,
    expected_ids: parseJsonArray(row.expected_ids),
    actual_ids: parseJsonArray(row.actual_ids),
    metrics,
    eval_type: row.eval_type,
    created_at: row.created_at
  };
}

function toEntity(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type ?? undefined,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    mention_count: row.mention_count,
    canonical_memory_id: row.canonical_memory_id ?? undefined
  };
}

function toAttr(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    entity_id: row.entity_id,
    attr_key: row.attr_key,
    attr_value: row.attr_value,
    memory_id: row.memory_id ?? undefined,
    valid_from: row.valid_from,
    valid_until: row.valid_until ?? undefined,
    confidence: row.confidence,
    source: row.source ?? undefined
  };
}

function toRelation(row) {
  if (!row) return undefined;
  let metadata;
  if (row.metadata != null) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = row.metadata;
    }
  }
  return {
    id: row.id,
    from_entity: row.from_entity,
    to_entity: row.to_entity,
    relation_type: row.relation_type,
    memory_id: row.memory_id ?? undefined,
    created_at: row.created_at,
    metadata
  };
}

function toLlmAudit(row) {
  if (!row) return undefined;
  let metadata;
  if (row.metadata != null) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = row.metadata;
    }
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    trigger_source: row.trigger_source,
    operation_type: row.operation_type,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    cost_usd: row.cost_usd,
    duration_ms: row.duration_ms,
    status: row.status,
    error_message: row.error_message ?? undefined,
    related_memory_ids: parseJsonArray(row.related_memory_ids),
    metadata
  };
}

function toMirrorState(row) {
  if (!row) {
    return {
      dirty: false,
      last_error: null,
      last_attempt: null,
      success_at: null,
      generation: 0,
      applied_generation: 0,
      type_status: {}
    };
  }
  let typeStatus = {};
  if (row.type_status) {
    try {
      typeStatus = JSON.parse(row.type_status) || {};
    } catch {
      typeStatus = {};
    }
  }
  return {
    id: row.id,
    dirty: row.dirty === 1,
    last_error: row.last_error,
    last_attempt: row.last_attempt,
    success_at: row.success_at,
    generation: Number(row.generation) || 0,
    applied_generation: Number(row.applied_generation) || 0,
    type_status: typeStatus
  };
}

function parseJsonArray(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  // Set busy_timeout BEFORE the journal-mode switch (audit peer: 8-process WAL
  // init). Switching a fresh DB to WAL takes an exclusive lock; when several
  // processes open the same path simultaneously, that lock can fail with
  // SQLITE_BUSY before the timeout is armed. With the timeout installed first,
  // the WAL transition (and every later write) blocks and retries instead of
  // failing outright, so concurrent init converges to a stable 447/447.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  // Wiki-link dedup (v0.6.1): a (from_entity, to_entity) pair is unique only for
  // relation_type='links_to'. This is a PARTIAL index scoped to links_to, so the
  // append-only semantics of all other relation types (uses/depends_on/part_of/
  // related_to/supersedes — the extractor and autoDream write these per-run
  // without global dedup, and supersedes rows carry distinct metadata like
  // attr_key/old_value) are preserved. Idempotent (IF NOT EXISTS), atomic, and
  // race-safe. Legacy DBs have no links_to rows yet, so the index builds cleanly
  // everywhere and never breaks plugin startup (a full-table UNIQUE index would
  // fail on legacy duplicates).
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_wikilink ON entity_relations(from_entity, to_entity, relation_type) WHERE relation_type = 'links_to'");

  // Schema migrations for legacy databases (idempotent). Each ADD COLUMN is
  // also race-safe: two concurrently-opening processes can both pass the
  // PRAGMA table_info check before either ALTERs, so the ALTER itself is
  // guarded against the "duplicate column name" error SQLite raises when the
  // other process won the race (SQLite has no ADD COLUMN IF NOT EXISTS).
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      try {
        db.exec(ddl);
      } catch (e) {
        if (!/duplicate column name/i.test(String(e?.message ?? e))) throw e;
      }
    }
  };

  addColumn("memories", "archived", "ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  addColumn("memories", "session_disposed_at", "ALTER TABLE memories ADD COLUMN session_disposed_at TEXT");
  addColumn("memories", "embedding", "ALTER TABLE memories ADD COLUMN embedding TEXT");
  addColumn("memories", "last_accessed_at", "ALTER TABLE memories ADD COLUMN last_accessed_at TEXT");
  addColumn("memories", "_full_content", "ALTER TABLE memories ADD COLUMN _full_content TEXT");
  addColumn("memories", "epistemic_status", "ALTER TABLE memories ADD COLUMN epistemic_status TEXT NOT NULL DEFAULT 'subjective'");
  addColumn("memories", "content_history", "ALTER TABLE memories ADD COLUMN content_history TEXT");
  addColumn("memories", "quality_score", "ALTER TABLE memories ADD COLUMN quality_score REAL");
  addColumn("memories", "session_id", "ALTER TABLE memories ADD COLUMN session_id TEXT");

  // Composite index for session-lifecycle queries (dispose/restore/listBySession).
  // Created post-migration, NOT in SCHEMA: on legacy DBs both columns arrive via
  // ADD COLUMN above, so the index would fail at db.exec(SCHEMA) time. CREATE
  // INDEX IF NOT EXISTS is atomic, so the two-process race is safe here.
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id, session_disposed_at)");

  // Legacy dream_runs without policy_epoch → backfill with the default epoch.
  addColumn("dream_runs", "policy_epoch", "ALTER TABLE dream_runs ADD COLUMN policy_epoch INTEGER NOT NULL DEFAULT 0");
  addColumn("dream_runs", "run_type", "ALTER TABLE dream_runs ADD COLUMN run_type TEXT NOT NULL DEFAULT 'auto'");

  // Legacy mirror_state without v0.3.6 generation columns → add each missing
  // column idempotently (old DBs open cleanly, no data loss).
  addColumn("mirror_state", "generation", "ALTER TABLE mirror_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  addColumn("mirror_state", "applied_generation", "ALTER TABLE mirror_state ADD COLUMN applied_generation INTEGER NOT NULL DEFAULT 0");
  addColumn("mirror_state", "type_status", "ALTER TABLE mirror_state ADD COLUMN type_status TEXT");

  // Audit peer F: a legacy DB may hold a non-integer generation/applied_generation
  // (pre-v0.3.9 the JS gate truncated with Math.trunc and SQLite's CHECK only
  // enforced >= 0). Such a value is ambiguous — it cannot map to a real applied
  // round — so surface it as a hard error on open instead of silently reading it
  // as a coherent generation. Fail-closed: the operator must repair or reset the
  // state row rather than continue with a lie.
  for (const col of ["generation", "applied_generation"]) {
    const bad = db.prepare(
      `SELECT id FROM mirror_state WHERE ${col} IS NOT NULL AND ${col} != CAST(${col} AS INTEGER) LIMIT 1`
    ).get();
    if (bad) {
      throw new RangeError(
        `mirror_state.${col} holds a non-integer value (legacy dirty state); ` +
        `repair or reset the row before opening this database`
      );
    }
  }

  // Per-instance monotonic timestamp guard: consecutive writes within the same
  // millisecond must still produce strictly increasing timestamps (test asserts
  // updated_at != created_at). State lives in the store closure, not module scope.
  let lastTs = "";
  function nowIso() {
    let ts = new Date().toISOString();
    if (lastTs && ts <= lastTs) {
      const d = new Date(lastTs);
      d.setMilliseconds(d.getMilliseconds() + 1);
      ts = d.toISOString();
    }
    lastTs = ts;
    return ts;
  }

  function count(type, { includeForgotten = false, includeArchived = false, includeDisposed = false } = {}) {
    const clauses = [];
    const params = [];
    if (type !== undefined) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (!includeForgotten) {
      clauses.push("forgotten = 0");
    }
    if (!includeArchived) {
      clauses.push("archived = 0");
    }
    if (!includeDisposed) {
      clauses.push("session_disposed_at IS NULL");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT count(*) AS c FROM memories ${where}`).get(...params).c;
  }

  function getById(id) {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return toRow(row);
  }

  /**
   * Case-insensitive exact title lookup (v0.6.1 wiki-link). COLLATE NOCASE
   * folds ASCII case (CJK titles are inherently case-free, so they match
   * verbatim). Returns the first matching memory or undefined. Best-effort —
   * used by wiki-link target resolution and the read APIs.
   */
  function findByTitle(title) {
    if (typeof title !== "string" || !title.trim()) return undefined;
    return toRow(db.prepare(
      "SELECT * FROM memories WHERE title = ? COLLATE NOCASE LIMIT 1"
    ).get(title.trim()));
  }

  function save(memory) {
    const id = memory.id ?? randomUUID();
    const type = memory.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    if (memory.tags !== undefined && !Array.isArray(memory.tags)) {
      throw new Error("tags must be an array");
    }
    const now = nowIso();
    const tags = JSON.stringify(memory.tags ?? []);
    const importance = Number.isInteger(memory.importance) ? memory.importance : 3;
    const embedding = Array.isArray(memory.embedding) && memory.embedding.length
      ? JSON.stringify(memory.embedding)
      : null;
    // Explicit valid status wins; otherwise infer from content/type. Falls back
    // to 'subjective' (the column default) so legacy callers never break.
    const epistemicStatus = EPISTEMIC_STATUSES.has(memory.epistemic_status)
      ? memory.epistemic_status
      : inferEpistemicStatus(memory);
    runAtomically(() => {
      db.prepare(
        `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, session_id, content_history, quality_score, embedding, epistemic_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        type,
        memory.title,
        memory.content,
        tags,
        importance,
        memory.archived ? 1 : 0,
        memory.source ?? null,
        memory.session_id ?? null,
        JSON.stringify(memory.content_history ?? []),
        Number.isFinite(memory.quality_score) ? memory.quality_score : null,
        embedding,
        epistemicStatus,
        now,
        now
      );
      // desired generation bumped in the same transaction as the write: once
      // this commits, generation > applied_generation, so a crash right after
      // (before syncMirror) is caught by recoverMirror on restart (peer
      // blocker 1). ROLLBACK on error rolls this back with the write.
      incrementGeneration();
    });
    return getById(id);
  }

  function update(id, patch) {
    const existing = getById(id);
    if (!existing) throw new Error(`memory not found: ${id}`);
    const type = patch.type ?? existing.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
      throw new Error("tags must be an array");
    }
    const now = nowIso();
    const embedding = patch.embedding !== undefined
      ? (Array.isArray(patch.embedding) && patch.embedding.length ? JSON.stringify(patch.embedding) : null)
      : existing.embedding ?? null;
    const epistemicStatus = resolveEpistemicStatus(existing, patch);
    const contentHistory = Array.isArray(patch.content_history)
      ? JSON.stringify(patch.content_history)
      : (Array.isArray(existing.content_history) ? JSON.stringify(existing.content_history) : null);
    const qualityScore = patch.quality_score !== undefined && Number.isFinite(patch.quality_score)
      ? patch.quality_score
      : (existing.quality_score ?? null);
    runAtomically(() => {
      db.prepare(
        `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, content_history=?, quality_score=?, embedding=?, epistemic_status=?, updated_at=? WHERE id=?`
      ).run(
        type,
        patch.title ?? existing.title,
        patch.content ?? existing.content,
        JSON.stringify(patch.tags ?? existing.tags),
        Number.isInteger(patch.importance) ? patch.importance : existing.importance,
        patch.source !== undefined ? patch.source : (existing.source ?? null),
        contentHistory,
        qualityScore,
        embedding,
        epistemicStatus,
        now,
        id
      );
      // Desired generation bumped in the same transaction as the update (peer
      // blocker 1: crash between write and sync must still be recoverable).
      incrementGeneration();
    });
    return getById(id);
  }

  function remove(id) {
    runAtomically(() => {
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      // Mirror sync must reflect the deletion; bump desired generation so a
      // crash between the delete and syncMirror leaves a recoverable debt.
      incrementGeneration();
    });
  }

  /**
   * Atomic compare-and-set update: applies `patch` only when the row still
   * carries `expectedUpdatedAt` (the version token read by the caller). Returns
   * the updated memory on success, or undefined when the row changed since the
   * caller read it — the caller must re-read and retry. The version guard lives
   * in the UPDATE's WHERE clause, so a concurrent read-modify-write across
   * connections cannot silently overwrite a newer value (lost update).
   */
  function compareAndUpdate(id, expectedUpdatedAt, patch) {
    const existing = getById(id);
    if (!existing) throw new Error(`memory not found: ${id}`);
    const type = patch.type ?? existing.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
      throw new Error("tags must be an array");
    }
    const now = nowIso();
    const embedding = patch.embedding !== undefined
      ? (Array.isArray(patch.embedding) && patch.embedding.length ? JSON.stringify(patch.embedding) : null)
      : existing.embedding ?? null;
    const epistemicStatus = resolveEpistemicStatus(existing, patch);
    const contentHistory = Array.isArray(patch.content_history)
      ? JSON.stringify(patch.content_history)
      : (Array.isArray(existing.content_history) ? JSON.stringify(existing.content_history) : null);
    const qualityScore = patch.quality_score !== undefined && Number.isFinite(patch.quality_score)
      ? patch.quality_score
      : (existing.quality_score ?? null);
    // The CAS UPDATE and the desired-generation bump must commit together (audit
    // peer A): if the UPDATE autocommits first and the process dies before the
    // increment, the store is mutated while generation == applied_generation and
    // dirty == false — recoverMirror sees no debt and the mirror stays stale.
    // Wrapping both in one transaction means a CAS miss rolls back cleanly too
    // (no write, no generation bump).
    let applied = false;
    runAtomically(() => {
      const result = db.prepare(
        `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, content_history=?, quality_score=?, embedding=?, epistemic_status=?, updated_at=?
         WHERE id=? AND updated_at=?`
      ).run(
        type,
        patch.title ?? existing.title,
        patch.content ?? existing.content,
        JSON.stringify(patch.tags ?? existing.tags),
        Number.isInteger(patch.importance) ? patch.importance : existing.importance,
        patch.source !== undefined ? patch.source : (existing.source ?? null),
        contentHistory,
        qualityScore,
        embedding,
        epistemicStatus,
        now,
        id,
        expectedUpdatedAt
      );
      if (result.changes === 0) return; // CAS miss: a concurrent write won
      // Only bump desired generation on a successful CAS — a miss writes nothing.
      incrementGeneration();
      applied = true;
    });
    if (!applied) return undefined;
    return getById(id);
  }

  function setForget(id, forgotten) {
    runAtomically(() => {
      db.prepare("UPDATE memories SET forgotten = ?, updated_at = ? WHERE id = ?")
        .run(forgotten === true || forgotten === 1 ? 1 : 0, nowIso(), id);
      incrementGeneration();
    });
    return getById(id);
  }

  function setArchived(id, archived) {
    runAtomically(() => {
      db.prepare("UPDATE memories SET archived = ?, updated_at = ? WHERE id = ?")
        .run(archived ? 1 : 0, nowIso(), id);
      incrementGeneration();
    });
    return getById(id);
  }

  // --- session lifecycle (v0.6.0) ------------------------------------------
  // Session dispose is orthogonal to `archived`: memory_archive is the user/AI
  // choosing to keep an entry long-term-but-quiet, while session_disposed_at
  // marks entries hidden because the session they were born in was deleted
  // (a reversible "undo" — restoreBySession clears it). They never clobber each
  // other: restoreBySession must not resurrect user-archived memories.
  // Mirrors list/search: disposed rows are hidden by default. A consumer that
  // needs to see the full picture (e.g. a restore flow that tells the user
  // "these N entries were hidden") opts in via includeDisposed.
  function listBySession(sessionId, { includeDisposed = false } = {}) {
    const disposedFilter = includeDisposed ? "" : "AND session_disposed_at IS NULL";
    const rows = db.prepare(
      `SELECT * FROM memories WHERE session_id = ? ${disposedFilter} ORDER BY updated_at DESC`
    ).all(sessionId);
    return rows.map(toRow);
  }

  // Idempotent by state guard, not timestamp compare (nowIso() differs every
  // call, so a fresh-timestamp re-dispose would spuriously count): dispose only
  // touches rows that are NOT yet disposed; restore only touches rows that ARE.
  // updated_at is deliberately left alone — this is a lifecycle flag, not
  // content — so a true flip is the sole trigger for a mirror generation.
  function setDisposedBySession(sessionId, disposed) {
    const at = disposed ? nowIso() : null;
    let affected = 0;
    runAtomically(() => {
      const result = disposed
        ? db.prepare(
            "UPDATE memories SET session_disposed_at = ? WHERE session_id = ? AND session_disposed_at IS NULL"
          ).run(at, sessionId)
        : db.prepare(
            "UPDATE memories SET session_disposed_at = NULL WHERE session_id = ? AND session_disposed_at IS NOT NULL"
          ).run(sessionId);
      affected = result.changes;
      if (affected > 0) incrementGeneration();
    });
    return affected;
  }

  // --- sleep-mode storage support (v0.4.0) ---------------------------------
  // touchLastAccess stamps the read time on recall/inject paths. It deliberately
  // does NOT bump the mirror generation: reads must not mark the mirror dirty.
  function touchLastAccess(id, at) {
    if (!getById(id)) return false;
    db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
      .run(at ?? nowIso(), id);
    return true;
  }

  // Shrink an aged memory to `summary`, parking its full body in _full_content.
  // Idempotent: an already-demoted memory (non-null _full_content) is left
  // untouched. minRefTimeMs guards the fast path — if last_accessed_at moved
  // after the caller's snapshot (>= minRefTimeMs), the memory is hot again and
  // is skipped. Returns the updated memory, or undefined when skipped/absent.
  function demoteToSummary(id, summary, { minRefTimeMs } = {}) {
    let changed = false;
    runAtomically(() => {
      const row = db.prepare("SELECT last_accessed_at, content, _full_content FROM memories WHERE id = ?").get(id);
      if (!row || row._full_content) return;
      if (minRefTimeMs !== undefined && row.last_accessed_at) {
        const lastMs = Date.parse(row.last_accessed_at);
        if (lastMs >= minRefTimeMs) return; // touched after snapshot — still hot
      }
      db.prepare(
        "UPDATE memories SET content = ?, _full_content = ?, updated_at = ? WHERE id = ?"
      ).run(summary, row.content, nowIso(), id);
      incrementGeneration();
      changed = true;
    });
    return changed ? getById(id) : undefined;
  }

  // Undo demoteToSummary: pull the parked body back into content.
  function restoreContent(id) {
    let changed = false;
    runAtomically(() => {
      const row = db.prepare("SELECT content, _full_content FROM memories WHERE id = ?").get(id);
      if (!row || !row._full_content) return;
      db.prepare(
        "UPDATE memories SET content = ?, _full_content = NULL, updated_at = ? WHERE id = ?"
      ).run(row._full_content, nowIso(), id);
      incrementGeneration();
      changed = true;
    });
    return changed ? getById(id) : undefined;
  }

  // Live memories that have not been touched since `cutMs` (never-touched ones
  // fall back to created_at). Ordered by last access ascending — the coldest
  // first. Used by sleep phase 2 to pick archival-demotion candidates.
  function getUnrecalledSince(cutMs, { limit = 500 } = {}) {
    const cutIso = new Date(cutMs).toISOString();
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE forgotten = 0 AND archived = 0
         AND session_disposed_at IS NULL
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       ORDER BY COALESCE(last_accessed_at, created_at) ASC, id
       LIMIT ?`
    ).all(cutIso, limit);
    return rows.map(toRow);
  }

  function list({ type, limit = 50, offset = 0, includeForgotten = false, includeArchived = false, includeDisposed = false } = {}) {
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (!includeForgotten) {
      clauses.push("forgotten = 0");
    }
    if (!includeArchived) {
      clauses.push("archived = 0");
    }
    if (!includeDisposed) {
      clauses.push("session_disposed_at IS NULL");
    }
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM memories ${where} ORDER BY importance DESC, updated_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toRow);
  }

  function all() {
    const rows = db.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all();
    return rows.map(toRow);
  }

  /** Set (or clear with null) the embedding vector of a memory. */
  function setEmbedding(id, vector) {
    const json = Array.isArray(vector) && vector.length ? JSON.stringify(vector) : null;
    db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(json, id);
  }

  /** Batch fetch stored embeddings by id (v0.5.0 search-time semantic dedup).
   *  Returns a Map(id → number[]); rows without a parseable embedding are
   *  simply absent from the map. */
  function getEmbeddings(ids) {
    const out = new Map();
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const rows = db.prepare(
        `SELECT id, embedding FROM memories
         WHERE embedding IS NOT NULL AND embedding != ''
           AND id IN (${chunk.map(() => "?").join(",")})`
      ).all(...chunk);
      for (const row of rows) {
        try {
          const vec = JSON.parse(row.embedding);
          if (Array.isArray(vec) && vec.length) out.set(row.id, vec);
        } catch { /* corrupt row: skip */ }
      }
    }
    return out;
  }

  function embeddedCount() {
    return db.prepare(
      "SELECT count(*) AS c FROM memories WHERE embedding IS NOT NULL AND embedding != ''"
    ).get().c;
  }

  /** Candidate rows still missing an embedding, for incremental re-indexing. */
  function needsEmbedding(limit = 50) {
    return db.prepare(
      `SELECT id, title, content FROM memories
       WHERE embedding IS NULL OR embedding = ''
       ORDER BY updated_at DESC LIMIT ?`
    ).all(limit);
  }

  function search(query, { limit = 20, includeArchived = false, includeDisposed = false } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    // Plain LIKE substring scan over title/content/tags (wildcards escaped so
    // user input matches literally). No FTS5: CJK substring matching needs
    // LIKE, and typical memory stores are small enough that a scan is fine.
    const like = `%${escapeLike(q)}%`;
    const { limit: lim } = sanitizePage(limit, 0, 20);
    const archivedFilter = includeArchived ? "" : "archived = 0 AND ";
    const disposedFilter = includeDisposed ? "" : "session_disposed_at IS NULL AND ";
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE ${archivedFilter}${disposedFilter}forgotten = 0 AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
       ORDER BY
         CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
         importance DESC,
         updated_at DESC,
         id
       LIMIT ?`
    ).all(like, like, like, like, lim);
    return rows.map(toRow);
  }

  // --- vector search ------------------------------------------------------

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Brute-force cosine similarity over embedded rows. Returns rows decorated
   * with a `score` (0..1). Only rows with a stored embedding participate.
   */
  function searchVector(vector, { limit = 20, includeArchived = false, includeDisposed = false, threshold = 0 } = {}) {
    if (!Array.isArray(vector) || !vector.length) return [];
    const archivedFilter = includeArchived ? "" : "archived = 0 AND ";
    const disposedFilter = includeDisposed ? "" : "session_disposed_at IS NULL AND ";
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE ${archivedFilter}${disposedFilter}forgotten = 0 AND embedding IS NOT NULL AND embedding != ''`
    ).all();
    const scored = [];
    for (const row of rows) {
      let v;
      try {
        v = JSON.parse(row.embedding);
      } catch {
        continue;
      }
      const score = cosine(vector, v);
      if (score >= threshold) scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const { limit: lim } = sanitizePage(limit, 0, 20);
    return scored.slice(0, lim).map(({ row, score }) => ({ ...toRow(row), score }));
  }

  // --- autoDream audit trail ----------------------------------------------

  /**
   * Persist one autoDream run. The audit row is machine-verifiable but never
   * triggers write hooks (it is bookkeeping, not a memory mutation): dream
   * records its own runs, and a notify here would loop back into the dream
   * scheduler. Writes are idempotent on run id (replay overwrites, never
   * duplicates) so the same logical run can be re-applied for verification.
   */
  function saveDreamRun(run) {
    const id = run.id ?? randomUUID();
    const now = nowIso();
    const policyEpoch = Number.isInteger(run.policy_epoch) ? run.policy_epoch : 0;
    const runType = run.run_type ?? "auto";
    db.prepare(
      `INSERT INTO dream_runs (id, created_at, status, error, provider, model, snapshot_hash,
        input_count, input, decisions, outcome, applied, summary_stored, receipt, policy_epoch, run_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at=excluded.created_at, status=excluded.status, error=excluded.error,
         provider=excluded.provider, model=excluded.model, snapshot_hash=excluded.snapshot_hash,
         input_count=excluded.input_count, input=excluded.input, decisions=excluded.decisions,
         outcome=excluded.outcome, applied=excluded.applied, summary_stored=excluded.summary_stored,
         receipt=excluded.receipt, policy_epoch=excluded.policy_epoch, run_type=excluded.run_type`
    ).run(
      id,
      run.created_at ?? now,
      run.status,
      run.error ?? null,
      run.provider ?? null,
      run.model ?? null,
      run.snapshot_hash,
      run.input_count,
      run.input !== undefined ? JSON.stringify(run.input) : null,
      run.decisions !== undefined ? JSON.stringify(run.decisions) : null,
      run.outcome !== undefined ? JSON.stringify(run.outcome) : null,
      run.applied ?? 0,
      run.summary_stored ? 1 : 0,
      run.receipt,
      policyEpoch,
      runType
    );
    return getDreamRun(id);
  }

  function getDreamRun(id) {
    const row = db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(id);
    return toDreamRun(row);
  }

  function listDreamRuns({ limit = 50, offset = 0 } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const rows = db.prepare(
      "SELECT * FROM dream_runs ORDER BY created_at DESC, id LIMIT ? OFFSET ?"
    ).all(lim, off);
    return rows.map(toDreamRun);
  }

  /**
   * Latest ruling-rule version seen on the audit trail. policy_epoch is a config
   * value stamped onto each run by the caller; reading the newest row's epoch
   * gives the current effective version, falling back to 0 (default) when the
   * trail is empty. Rules upgrades leave older runs with their original epoch,
   * so those decisions can be demoted to historical evidence.
   */
  function getLatestPolicyEpoch() {
    const row = db.prepare(
      "SELECT policy_epoch FROM dream_runs ORDER BY created_at DESC, id LIMIT 1"
    ).get();
    return row ? (row.policy_epoch ?? 0) : 0;
  }

  // --- per-record receipt chain --------------------------------------------

  /**
   * Persist one per-record receipt (a single merge/conflict/update verdict).
   * The run-level dream audit trail answers "did this run happen and with what
   * input"; the receipt chain drills down to each mutable verdict, carrying the
   * input digest (decision basis) plus count_before → count_after idempotency
   * checkpoints so replay drift can be located to the exact record/run. Like
   * the dream trail this is bookkeeping: it never triggers write hooks. Writes
   * are idempotent on receipt id (replay overwrites, never duplicates).
   */
  function saveReceipt(run) {
    const id = run.receipt_id ?? randomUUID();
    const now = nowIso();
    const policyEpoch = Number.isInteger(run.policy_epoch) ? run.policy_epoch : 0;
    db.prepare(
      `INSERT INTO receipt_chain (receipt_id, run_id, record_id, kind, input_digest,
        winner_id, loser_id, keep_source, sources, verdict, count_before, count_after,
        policy_epoch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(receipt_id) DO UPDATE SET
         run_id=excluded.run_id, record_id=excluded.record_id, kind=excluded.kind,
         input_digest=excluded.input_digest, winner_id=excluded.winner_id,
         loser_id=excluded.loser_id, keep_source=excluded.keep_source,
         sources=excluded.sources, verdict=excluded.verdict,
         count_before=excluded.count_before, count_after=excluded.count_after,
         policy_epoch=excluded.policy_epoch, created_at=excluded.created_at`
    ).run(
      id,
      run.run_id,
      run.record_id,
      run.kind,
      run.input_digest,
      run.winner_id ?? null,
      run.loser_id ?? null,
      run.keep_source ?? null,
      JSON.stringify(run.sources ?? []),
      run.verdict,
      run.count_before,
      run.count_after,
      policyEpoch,
      run.created_at ?? now
    );
    return getReceipt(id);
  }

  function getReceipt(id) {
    const row = db.prepare("SELECT * FROM receipt_chain WHERE receipt_id = ?").get(id);
    return toReceipt(row);
  }

  function listReceipts({ limit = 50, offset = 0, run_id } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (run_id) {
      clauses.push("run_id = ?");
      params.push(run_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM receipt_chain ${where} ORDER BY created_at DESC, receipt_id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toReceipt);
  }

  // --- recall-layer audit trail -------------------------------------------

  /**
   * Persist one recall run (the retrieval scene: query/mode/top-k/threshold +
   * the exact candidate list handed to the caller). Like the dream audit trail
   * this is bookkeeping, so it never triggers write hooks — a notify here would
   * loop back into search itself. Writes are idempotent on run id (replay
   * overwrites, never duplicates), matching saveDreamRun.
   */
  function saveRecallRun(run) {
    const id = run.id ?? randomUUID();
    db.prepare(
      `INSERT INTO recall_runs (id, query, mode, top_k, threshold, candidates, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         query=excluded.query, mode=excluded.mode, top_k=excluded.top_k,
         threshold=excluded.threshold, candidates=excluded.candidates,
         created_at=excluded.created_at`
    ).run(
      id,
      run.query,
      run.mode,
      run.topK ?? null,
      run.threshold ?? null,
      JSON.stringify(run.candidates ?? []),
      run.created_at ?? nowIso()
    );
    return getRecallRun(id);
  }

  function getRecallRun(id) {
    const row = db.prepare("SELECT * FROM recall_runs WHERE id = ?").get(id);
    return toRecallRun(row);
  }

  function listRecallRuns({ limit = 50, offset = 0, query } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (query) {
      clauses.push("query LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(String(query))}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM recall_runs ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toRecallRun);
  }

  // --- recall evaluation trail (方案 B: separate from the production audit) -

  /**
   * Persist one retrieval-evaluation snapshot into recall_evals — the test/eval
   * sibling of recall_runs, deliberately stored apart so eval snapshots never
   * inflate the production recall audit. Like the other audit tables this is
   * bookkeeping: it never triggers write hooks. Writes are idempotent on id
   * (replay overwrites, never duplicates), matching saveRecallRun. recall_run_id
   * optionally links the eval to the recall_runs row that captured the same
   * retrieval scene (FK-referenced, null when no run was recorded).
   */
  function saveRecallEval(evalRow) {
    const id = evalRow.id ?? randomUUID();
    db.prepare(
      `INSERT INTO recall_evals (id, recall_run_id, query, expected_ids, actual_ids, metrics, eval_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         recall_run_id=excluded.recall_run_id, query=excluded.query,
         expected_ids=excluded.expected_ids, actual_ids=excluded.actual_ids,
         metrics=excluded.metrics, eval_type=excluded.eval_type,
         created_at=excluded.created_at`
    ).run(
      id,
      evalRow.recall_run_id ?? null,
      evalRow.query,
      JSON.stringify(evalRow.expected_ids ?? []),
      JSON.stringify(evalRow.actual_ids ?? []),
      JSON.stringify(evalRow.metrics ?? {}),
      evalRow.eval_type ?? "manual",
      evalRow.created_at ?? nowIso()
    );
    return getRecallEval(id);
  }

  function getRecallEval(id) {
    const row = db.prepare("SELECT * FROM recall_evals WHERE id = ?").get(id);
    return toRecallEval(row);
  }

  function listRecallEvals({ limit = 50, offset = 0, query } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (query) {
      clauses.push("query LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(String(query))}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM recall_evals ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toRecallEval);
  }

  // --- llm audit trail (Bug8) ---------------------------------------------

  /**
   * Persist one LLM audit row (a background call's token/time/status receipt).
   * Bookkeeping like the other audit tables: it never triggers write hooks, so
   * recording a call can never loop back into the scheduler that made it. The
   * call itself is wrapped so a failure is captured (status='error') instead of
   * blocking the feature — only a throwing saveLlmAudit is swallowed, never the
   * LLM call.
   */
  function saveLlmAudit(entry) {
    const now = nowIso();
    const inTokens = Number.isFinite(entry.input_tokens) ? entry.input_tokens : 0;
    const outTokens = Number.isFinite(entry.output_tokens) ? entry.output_tokens : 0;
    db.prepare(
      `INSERT INTO llm_audit_logs (timestamp, trigger_source, operation_type, model_id,
        input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, status,
        error_message, related_memory_ids, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.timestamp ?? now,
      entry.trigger_source,
      entry.operation_type,
      entry.model_id,
      inTokens,
      outTokens,
      Number.isFinite(entry.total_tokens) ? entry.total_tokens : inTokens + outTokens,
      Number.isFinite(entry.cost_usd) ? entry.cost_usd : 0,
      Number.isFinite(entry.duration_ms) ? entry.duration_ms : 0,
      entry.status ?? "success",
      entry.error_message ?? null,
      JSON.stringify(entry.related_memory_ids ?? []),
      entry.metadata !== undefined
        ? (typeof entry.metadata === "string" ? entry.metadata : JSON.stringify(entry.metadata))
        : null
    );
    return toLlmAudit(db.prepare("SELECT * FROM llm_audit_logs ORDER BY id DESC LIMIT 1").get());
  }

  function listLlmAudits({ limit = 50, offset = 0, source } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (source) {
      clauses.push("trigger_source = ?");
      params.push(source);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM llm_audit_logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toLlmAudit);
  }

  function countLlmAudits({ source } = {}) {
    const clauses = [];
    const params = [];
    if (source) {
      clauses.push("trigger_source = ?");
      params.push(source);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT count(*) AS c FROM llm_audit_logs ${where}`).get(...params).c;
  }

  /**
   * Aggregate LLM spend over the last `days`: total calls/tokens/duration/cost,
   * broken down by trigger_source and by status. Used by the API's
   * /llm-audit/stats endpoint so the Web panel can show where budget goes.
   */
  function getLlmAuditStats({ days = 7 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const total = db.prepare(
      `SELECT count(*) AS c,
              COALESCE(SUM(input_tokens), 0) AS i,
              COALESCE(SUM(output_tokens), 0) AS o,
              COALESCE(SUM(total_tokens), 0) AS t,
              COALESCE(SUM(duration_ms), 0) AS d,
              COALESCE(SUM(cost_usd), 0) AS cst
       FROM llm_audit_logs WHERE timestamp >= ?`
    ).get(since);
    const bySource = db.prepare(
      `SELECT trigger_source AS source, count(*) AS c,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM llm_audit_logs WHERE timestamp >= ?
       GROUP BY trigger_source ORDER BY total_tokens DESC`
    ).all(since);
    const byStatus = db.prepare(
      "SELECT status, count(*) AS c FROM llm_audit_logs WHERE timestamp >= ? GROUP BY status"
    ).all(since);
    return {
      days,
      since,
      total_calls: total.c,
      input_tokens: total.i,
      output_tokens: total.o,
      total_tokens: total.t,
      total_duration_ms: total.d,
      total_cost_usd: Number(total.cst),
      by_source: bySource,
      by_status: byStatus
    };
  }

  /** Delete audit rows older than `before` (ISO string). Returns count removed. */
  function deleteOldLlmAudits(before) {
    return db.prepare("DELETE FROM llm_audit_logs WHERE timestamp < ?").run(before).changes;
  }

  // --- failure memories ----------------------------------------------------

  /**
   * Persist one failure record (user correction, failed expectation, etc.).
   * Like the dream audit trail this is bookkeeping: it never triggers write
   * hooks, so reflection mining of failures cannot loop back into the writer.
   */
  function saveFailure({ id, query, expected, actual, before, failure_type, memory_id }) {
    const now = nowIso();
    const beforeJson = before && typeof before === "object" ? JSON.stringify(before) : (before ?? null);
    db.prepare(
      `INSERT INTO failure_memories (id, query, expected, actual, before, failure_type, memory_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id ?? randomUUID(), query ?? null, expected ?? null, actual ?? null, beforeJson, failure_type, memory_id ?? null, now);
    return { id, query, expected, actual, before: before ?? null, failure_type, memory_id, created_at: now };
  }

  function listFailures({ limit = 50, offset = 0, since, memory_id, failure_type } = {}) {
    const clauses = [];
    const params = [];
    if (since) { clauses.push("created_at >= ?"); params.push(since); }
    if (memory_id) { clauses.push("memory_id = ?"); params.push(memory_id); }
    if (failure_type) { clauses.push("failure_type = ?"); params.push(failure_type); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Number.isInteger(limit) && limit > 0 ? limit : 50;
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    return db.prepare(`SELECT * FROM failure_memories ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).all(...params, lim, off)
      .map((row) => {
        let before;
        try { before = row.before ? JSON.parse(row.before) : null; } catch { before = null; }
        return { ...row, before };
      });
  }

  /** Delete failure rows older than `before` (ISO string). Returns count removed. */
  function deleteOldFailures(before) {
    return db.prepare("DELETE FROM failure_memories WHERE created_at < ?").run(before).changes;
  }

  // --- conflict freeze: pending manual review ------------------------------

  /**
   * Park a detected conflict for human review (conflict freeze mode). The pair
   * order is normalized (sorted by id) so the same two memories are only ever
   * pending once — a re-detection in a later dream run is a no-op, never a
   * duplicate queue entry. Returns the pending row (freshly inserted, or the
   * existing unresolved row when the pair is already pending).
   */
  function saveConflictPending({ run_id, memory_a, memory_b, reason }) {
    const [a, b] = [memory_a, memory_b].sort();
    const existing = db.prepare(
      "SELECT * FROM conflict_pending WHERE memory_a = ? AND memory_b = ? AND resolved_at IS NULL LIMIT 1"
    ).get(a, b);
    if (existing) return toConflictPending(existing);
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO conflict_pending (id, run_id, memory_a, memory_b, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, run_id ?? null, a, b, reason ?? null, now);
    return toConflictPending(db.prepare("SELECT * FROM conflict_pending WHERE id = ?").get(id));
  }

  /**
   * List pending conflicts, newest first. Unresolved rows only by default;
   * pass includeResolved to include resolved ones (audit view).
   */
  function listConflictPending({ limit = 50, offset = 0, includeResolved = false } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (!includeResolved) clauses.push("resolved_at IS NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM conflict_pending ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toConflictPending);
  }

  /**
   * Mark a pending conflict as reviewed. winner (optional) records which side
   * the human chose, keeping the resolution auditable. Returns the updated row,
   * or undefined for an unknown id.
   */
  function resolveConflictPending(id, { winner } = {}) {
    const row = db.prepare("SELECT * FROM conflict_pending WHERE id = ?").get(id);
    if (!row) return undefined;
    db.prepare("UPDATE conflict_pending SET resolved_at = ?, resolved_winner = ? WHERE id = ?")
      .run(nowIso(), winner ?? null, id);
    return toConflictPending(db.prepare("SELECT * FROM conflict_pending WHERE id = ?").get(id));
  }

  /** Number of unresolved (awaiting review) pending conflicts. */
  function countConflictPending() {
    return db.prepare(
      "SELECT count(*) AS c FROM conflict_pending WHERE resolved_at IS NULL"
    ).get().c;
  }

  function getFailureStats({ since } = {}) {
    const clause = since ? "WHERE created_at >= ?" : "";
    const params = since ? [since] : [];
    const rows = db.prepare(
      `SELECT failure_type, count(*) AS c FROM failure_memories ${clause} GROUP BY failure_type`
    ).all(...params);
    const stats = {};
    for (const row of rows) stats[row.failure_type] = row.c;
    return stats;
  }

  // --- entity gene: named entities + time-boxed attrs + relations (v0.3.0) --

  /**
   * Create a named entity. A fresh mention always records first_seen = now;
   * repeated sightings should call updateEntity (which bumps mention_count and
   * refreshes last_seen) rather than creating duplicate rows.
   */
  function createEntity({ name, type }) {
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO entities (id, name, type, first_seen, last_seen, mention_count, canonical_memory_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, type ?? null, now, now, 1, null);
    return toEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(id));
  }

  function findEntityByName(name) {
    return toEntity(db.prepare("SELECT * FROM entities WHERE name = ?").get(name));
  }

  function findEntityById(id) {
    return toEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(id));
  }

  /**
   * Apply a partial update to an entity, always refreshing last_seen. The
   * mention counter increments on every sighting unless the caller overrides
   * it explicitly via patch.mention_count (e.g. to correct a count).
   */
  function updateEntity(id, patch) {
    const old = findEntityById(id);
    if (!old) return undefined;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const name = has("name") ? patch.name : old.name;
    const type = has("type") ? patch.type : old.type;
    const canonical_memory_id = has("canonical_memory_id")
      ? patch.canonical_memory_id
      : old.canonical_memory_id;
    const mention_count = has("mention_count")
      ? patch.mention_count
      : (old.mention_count ?? 1) + 1;
    const now = nowIso();
    db.prepare(
      `UPDATE entities SET name = ?, type = ?, last_seen = ?, mention_count = ?, canonical_memory_id = ? WHERE id = ?`
    ).run(name, type ?? null, now, mention_count, canonical_memory_id ?? null, id);
    return findEntityById(id);
  }

  /**
   * Record an attribute value for an entity. The previous value for the same
   * entity+key is invalidated (valid_until = now) before the new row is
   * inserted, so exactly one row per entity+key is current (valid_until IS NULL).
   */
  function saveAttr({ entity_id, attr_key, attr_value, memory_id, confidence, source }) {
    const now = nowIso();
    invalidateOldAttr(entity_id, attr_key, now);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO entity_attrs (id, entity_id, attr_key, attr_value, memory_id, valid_from, valid_until, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity_id, attr_key, attr_value, memory_id ?? null, now, null, confidence ?? 1.0, source ?? null);
    return toAttr(db.prepare("SELECT * FROM entity_attrs WHERE id = ?").get(id));
  }

  /** Mark every currently-valid attr row for entityId+attrKey as expired. Returns rows changed. */
  function invalidateOldAttr(entityId, attrKey, now) {
    return db.prepare(
      `UPDATE entity_attrs SET valid_until = ? WHERE entity_id = ? AND attr_key = ? AND valid_until IS NULL`
    ).run(now, entityId, attrKey).changes;
  }

  /** Only the live value per attr_key (valid_until IS NULL). */
  function getCurrentAttrs(entityId) {
    return db.prepare(
      "SELECT * FROM entity_attrs WHERE entity_id = ? AND valid_until IS NULL"
    ).all(entityId).map(toAttr);
  }

  /** Full history per attr_key, oldest first. */
  function getAttrHistory(entityId) {
    return db.prepare(
      "SELECT * FROM entity_attrs WHERE entity_id = ? ORDER BY valid_from"
    ).all(entityId).map(toAttr);
  }

  /**
   * All attr rows carrying a reference to the given memory (any valid state),
   * oldest first. Used by autoDream's update path to record what an update
   * superseded (v0.3.0 Phase 4 / 4.3.1).
   */
  function getAttrsByMemory(memoryId) {
    return db.prepare(
      "SELECT * FROM entity_attrs WHERE memory_id = ? ORDER BY valid_from ASC"
    ).all(memoryId).map(toAttr);
  }

  /**
   * Memories carrying a currently-valid attr matching key=value (deduped).
   * When value is empty/undefined, the attr_value filter is dropped and every
   * currently-valid memory for that attr_key is returned — the "attr:key"
   * (no =value) contract, v0.3.0. Only live rows (valid_until IS NULL) with a
   * memory reference participate, and each memory appears at most once.
   */
  function findMemoriesByAttr(key, value) {
    const empty = value === undefined || value === null || value === "";
    const sql = empty
      ? `SELECT DISTINCT memory_id FROM entity_attrs
         WHERE attr_key = ? AND valid_until IS NULL
           AND memory_id IS NOT NULL AND memory_id != ''`
      : `SELECT DISTINCT memory_id FROM entity_attrs
         WHERE attr_key = ? AND attr_value = ? AND valid_until IS NULL
           AND memory_id IS NOT NULL AND memory_id != ''`;
    const params = empty ? [key] : [key, value];
    const rows = db.prepare(sql).all(...params);
    const memories = [];
    const stmt = db.prepare("SELECT * FROM memories WHERE id = ?");
    for (const { memory_id } of rows) {
      const row = stmt.get(memory_id);
      if (row) memories.push(toRow(row));
    }
    return memories;
  }

  /**
   * Record a typed relation between two entities. metadata (optional) is a
   * free-form JSON blob describing the relation. Relations are append-only —
   * callers that need idempotency (e.g. wiki-links, via saveWikiLinks) guard
   * with their own existence check plus the partial links_to unique index
   * (idx_relations_wikilink) as a race backstop.
   */
  function saveRelation({ from_entity, to_entity, relation_type, memory_id, metadata }) {
    const id = randomUUID();
    const now = nowIso();
    const metaStr = metadata === undefined
      ? null
      : typeof metadata === "string"
        ? metadata
        : JSON.stringify(metadata);
    db.prepare(
      `INSERT INTO entity_relations (id, from_entity, to_entity, relation_type, memory_id, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, from_entity, to_entity, relation_type, memory_id ?? null, now, metaStr);
    return toRelation(db.prepare(
      "SELECT * FROM entity_relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ? LIMIT 1"
    ).get(from_entity, to_entity, relation_type));
  }

  /**
   * Record wiki-link relations (v0.6.1). For each target title, resolve the
   * target memory (case-insensitive title match via findByTitle) and write a
   * links_to relation:
   *   from_entity = source memory title, to_entity = canonical target memory
   *   title, relation_type = 'links_to', memory_id = source memory id.
   * Using the canonical resolved title keeps the graph case-consistent
   * ([[beta]] and [[Beta]] collapse onto the same to_entity), so backlink
   * lookups never fight the way a target was typed.
   * Fail-safe: a target with no matching memory is skipped (never an error).
   * Idempotent: an already-existing triple is a silent no-op (existence check
   * here + the idx_relations_wikilink partial unique index as a race backstop),
   * so `saved` only counts newly written relations. Returns { saved, skipped }.
   */
  function saveWikiLinks({ memoryId, title, targets }) {
    const saved = [];
    const skipped = [];
    const seen = new Set(); // canonical (lowercased) targets already handled
    const existsStmt = db.prepare(
      "SELECT id FROM entity_relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?"
    );
    const list = Array.isArray(targets)
      ? targets.filter((t) => typeof t === "string" && t.trim())
      : [];
    for (const raw of list) {
      const target = raw.trim();
      const key = target.toLowerCase();
      if (seen.has(key)) continue; // dedupe within a single call (case-insensitive)
      seen.add(key);
      const targetMem = findByTitle(target);
      if (!targetMem) {
        skipped.push(target); // 目标不存在 → 跳过（Fail-safe）
        continue;
      }
      const toEntity = targetMem.title;
      if (existsStmt.get(title, toEntity, "links_to")) continue; // already linked → no-op
      saved.push(saveRelation({
        from_entity: title,
        to_entity: toEntity,
        relation_type: "links_to",
        memory_id: memoryId,
        metadata: { target_memory_id: targetMem.id }
      }));
    }
    return { saved, skipped };
  }

  /**
   * Re-point every attr row whose memory_id is fromMemoryId to toMemoryId
   * (autoDream merge migration, v0.3.0 Phase 4 / 4.3.2). When the keeper
   * already carries a live attr for the same entity+key, the source row is
   * superseded and invalidated instead (the keeper's value wins). Returns
   * { migrated, invalidated }.
   */
  function migrateAttrsToMemory(fromMemoryId, toMemoryId, now) {
    let migrated = 0;
    let invalidated = 0;
    const attrs = db.prepare(
      "SELECT * FROM entity_attrs WHERE memory_id = ?"
    ).all(fromMemoryId);
    for (const attr of attrs) {
      // 仅当 keeper 已有同 entity+key 的当前有效属性才视为被替代（限定 memory_id，
      // 避免把 loser 自身的 live 行误判为 keeper 行）。
      const keeperLive = db.prepare(
        "SELECT id FROM entity_attrs WHERE entity_id = ? AND attr_key = ? AND valid_until IS NULL AND memory_id = ?"
      ).get(attr.entity_id, attr.attr_key, toMemoryId);
      if (keeperLive) {
        db.prepare(
          "UPDATE entity_attrs SET valid_until = ? WHERE id = ?"
        ).run(now, attr.id);
        invalidated++;
      } else {
        db.prepare(
          "UPDATE entity_attrs SET memory_id = ? WHERE id = ?"
        ).run(toMemoryId, attr.id);
        migrated++;
      }
    }
    return { migrated, invalidated };
  }

  /** Relations where the entity appears on either side (from or to). */
  function getRelations(entityId) {
    return db.prepare(
      "SELECT * FROM entity_relations WHERE from_entity = ? OR to_entity = ?"
    ).all(entityId, entityId).map(toRelation);
  }

  /** All entities (optionally name-filtered, newest first). Used by sleep phase 4
   *  orphan detection: an entity with zero relations is a candidate for relation
   *  completion. */
  function listEntities({ limit = 1000 } = {}) {
    const rows = db.prepare(
      "SELECT * FROM entities ORDER BY last_seen DESC, name ASC LIMIT ?"
    ).all(limit);
    return rows.map(toEntity);
  }

  // --- mirror sync state (F-NEW-03) -----------------------------------------

  /**
   * Upsert the single mirror_state row (id='main'). patch accepts
   * {dirty?, last_error?, last_attempt?, success_at?, generation?,
   * applied_generation?, type_status?} — only the keys present on the object
   * are written, everything else is left untouched (partial upsert). type_status
   * is stored as JSON text (objects are serialized on write), generation /
   * applied_generation are coerced to non-negative integers. Returns the freshly
   * read state row (default shape when absent).
   */
  function setMirrorState(patch) {
    const ALLOWED = new Set([
      "dirty",
      "last_error",
      "last_attempt",
      "success_at",
      "generation",
      "applied_generation",
      "type_status"
    ]);
    const keys = Object.keys(patch).filter(
      (key) => ALLOWED.has(key) && Object.prototype.hasOwnProperty.call(patch, key)
    );
    if (keys.length === 0) {
      db.prepare(
        "INSERT INTO mirror_state (id) VALUES ('main') ON CONFLICT(id) DO NOTHING"
      ).run();
      return getMirrorState();
    }
    // 列同时出现在 INSERT 与 ON CONFLICT 里（excluded.*），保证首次插入也写入
    // patch 值，而不只是默认值；未传入的列保持不变（partial upsert）。
    const cols = [];
    const values = [];
    const updates = [];
    for (const key of keys) {
      let value = patch[key];
      if (key === "dirty") {
        value = value ? 1 : 0;
      } else if (key === "generation" || key === "applied_generation") {
        // Fail-closed integer enforcement (audit peer F): never truncate. A
        // fractional value like 1.5 previously passed the JS gate via
        // Math.trunc while SQLite's CHECK (>= 0) silently accepted it too, so a
        // dirty legacy row could carry a non-integer generation that reads as a
        // coherent applied round. Reject non-integers outright — the caller must
        // pass a whole number, and a stale dirty value stays visible instead of
        // being "repaired" into a misleading clean integer.
        value = Number(value);
        if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
          throw new RangeError(`mirror_state.${key} out of range: ${value}`);
        }
      } else if (key === "type_status" && value != null && typeof value !== "string") {
        value = JSON.stringify(value);
      }
      cols.push(key);
      values.push(value);
      updates.push(`${key} = excluded.${key}`);
    }
    const placeholders = cols.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO mirror_state (id, ${cols.join(", ")}) VALUES ('main', ${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`
    ).run(...values);
    return getMirrorState();
  }

  /** Current mirror state; default {dirty:0, last_error:null, last_attempt:null, success_at:null, generation:0, applied_generation:0, type_status:{}} when absent. */
  function getMirrorState() {
    const row = db.prepare("SELECT * FROM mirror_state WHERE id = 'main'").get();
    return toMirrorState(row);
  }

  /**
   * Mark the mirror dirty after a failed sync (dirty=1 + last_error +
   * last_attempt). v0.3.6: also bumps the desired generation so the debt is
   * bound to a specific sync round; applied_generation is left untouched
   * (the round was NOT applied). A stale worker that started earlier cannot
   * clear this newer debt — only a clean fenced to a generation at least as
   * recent as this one may.
   */
  function markMirrorDirty(error, now) {
    // Bump the desired generation atomically first — the new debt must be bound
    // to a fresh round so a stale worker cannot fence-clean it. Even if this
    // write fails (peer blocker 2), generation still advanced, so recoverMirror
    // sees generation > applied_generation and retries rather than false-clean.
    incrementGeneration();
    return setMirrorState({
      dirty: 1,
      last_error: error,
      last_attempt: now ?? nowIso()
    });
  }

  /**
   * Fenced clean (CAS): mark the mirror clean for a specific generation.
   * First records that generation `gen` has been applied
   * (applied_generation = MAX(applied_generation, gen)), then clears dirty only
   * when the current desired generation has not advanced past gen — a stale
   * worker cleaning an older round must not wipe a newer failure's debt.
   * Returns the resulting state (dirty stays set when the fence holds).
   */
  function markMirrorCleanForGeneration(gen, now) {
    const current = getMirrorState();
    const applied = Math.max(current.applied_generation || 0, gen);
    const patch = { applied_generation: applied };
    if (applied >= gen && (current.generation || 0) <= gen) {
      patch.dirty = 0;
      patch.last_error = null;
      patch.success_at = now ?? nowIso();
    }
    return setMirrorState(patch);
  }

  /** Convenience: mark the mirror clean for the current desired generation (backward-compatible with pre-v0.3.6 callers). */
  function markMirrorClean(now) {
    const current = getMirrorState();
    return markMirrorCleanForGeneration(current.generation || 0, now);
  }

  /** Convenience: clear only the dirty flag + last_error, leaving success_at untouched (manual reconcile / retry path). */
  function clearMirrorDirty() {
    return setMirrorState({ dirty: 0, last_error: null });
  }

  /**
   * Record per-type mirror status (partial success bookkeeping). `status` is a
   * patch {status: 'committed'|'failed'|'pending', applied_gen?, last_error?}
   * replacing the entry for `type` (other types untouched). Standardizing on an
   * explicit status gives per-type committed/failed/pending receipts — a type
   * whose file was written while a sibling failed is recorded as such, not
   * collapsed into a bulk "dirty" (peer blocker 4). Returns the updated state.
   */
  function setTypeStatus(type, status) {
    if (!VALID_TYPE_STATUS.has(status?.status)) {
      throw new TypeError(`setTypeStatus: status must be one of committed|failed|pending, got ${status?.status}`);
    }
    const current = getMirrorState();
    const statuses = current.type_status || {};
    statuses[type] = {
      status: status.status,
      ...(status.applied_gen !== undefined ? { applied_gen: status.applied_gen } : {}),
      ...(status.last_error !== undefined ? { last_error: status.last_error } : {})
    };
    return setMirrorState({ type_status: JSON.stringify(statuses) });
  }

  /** Per-type mirror status map {type: {dirty, applied_gen, last_error}}, {} when unset. */
  function getTypeStatus() {
    const current = getMirrorState();
    return current.type_status || {};
  }

  /** Run fn atomically: when the connection is already inside a transaction
   *  (service.transaction's BEGIN), just run it — the outer COMMIT covers us.
   *  Otherwise wrap in BEGIN/COMMIT so a memory write and its desired-generation
   *  bump commit together: a crash between them can never leave a mutated store
   *  with generation == applied (audit peer blocker 1, "crash window"). */
  function runAtomically(fn) {
    if (db.isTransaction) return fn();
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* connection may be closed */ }
      throw error;
    }
  }

  /** Bump the desired generation atomically (SQLite single-statement increment,
   *  no SELECT-then-UPSERT race: peer blocker 3 lost 10 of 91 concurrent
   *  increments under an 8-process probe). Returns the new mirror state.
   *  Guards the upper bound: generation must stay within MAX_SAFE_INTEGER so
   *  reads never hit ERR_OUT_OF_RANGE (peer blocker 6). */
  function incrementGeneration() {
    return runAtomically(() => {
      // Ensure the singleton row exists before incrementing (UPDATE alone would
      // match nothing on a fresh DB).
      db.prepare("INSERT OR IGNORE INTO mirror_state (id) VALUES ('main')").run();
      const row = db.prepare(
        "UPDATE mirror_state SET generation = generation + 1 WHERE id = 'main' AND generation < ? RETURNING generation"
      ).get(Number.MAX_SAFE_INTEGER);
      if (!row) throw new RangeError("mirror_state.generation exceeded MAX_SAFE_INTEGER");
      return getMirrorState();
    });
  }

  return {
    db,
    count,
    getById,
    save,
    update,
    compareAndUpdate,
    remove,
    setForget,
    setArchived,
    listBySession,
    setDisposedBySession,
    touchLastAccess,
    demoteToSummary,
    restoreContent,
    getUnrecalledSince,
    list,
    all,
    search,
    setEmbedding,
    getEmbeddings,
    embeddedCount,
    needsEmbedding,
    searchVector,
    saveDreamRun,
    getDreamRun,
    listDreamRuns,
    getLatestPolicyEpoch,
    saveReceipt,
    getReceipt,
    listReceipts,
    saveRecallRun,
    getRecallRun,
    listRecallRuns,
    saveRecallEval,
    getRecallEval,
    listRecallEvals,
    saveLlmAudit,
    listLlmAudits,
    countLlmAudits,
    getLlmAuditStats,
    deleteOldLlmAudits,
    saveFailure,
    listFailures,
    getFailureStats,
    deleteOldFailures,
    saveConflictPending,
    listConflictPending,
    resolveConflictPending,
    countConflictPending,
    createEntity,
    findEntityByName,
    findEntityById,
    listEntities,
    updateEntity,
    saveAttr,
    invalidateOldAttr,
    getCurrentAttrs,
    getAttrHistory,
    getAttrsByMemory,
    findMemoriesByAttr,
    saveRelation,
    saveWikiLinks,
    findByTitle,
    migrateAttrsToMemory,
    getRelations,
    setMirrorState,
    getMirrorState,
    markMirrorDirty,
    markMirrorClean,
    markMirrorCleanForGeneration,
    clearMirrorDirty,
    setTypeStatus,
    getTypeStatus,
    incrementGeneration,
    close() {
      db.close();
    }
  };
}
