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
  source      TEXT,
  embedding   TEXT,
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
  receipt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_created ON dream_runs(created_at);

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
`;

const TYPES = new Set(["preference", "project", "decision", "history", "summary"]);

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
    source: row.source ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
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
    receipt: row.receipt
  };
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  // Schema migrations for legacy databases (idempotent).
  const columns = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  if (!columns.includes("archived")) {
    db.exec("ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("embedding")) {
    db.exec("ALTER TABLE memories ADD COLUMN embedding TEXT");
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

  function count(type, { includeForgotten = false, includeArchived = false } = {}) {
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
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT count(*) AS c FROM memories ${where}`).get(...params).c;
  }

  function getById(id) {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return toRow(row);
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
    db.prepare(
      `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, source, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(id, type, memory.title, memory.content, tags, importance, memory.source ?? null, embedding, now, now);
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
    db.prepare(
      `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, embedding=?, updated_at=? WHERE id=?`
    ).run(
      type,
      patch.title ?? existing.title,
      patch.content ?? existing.content,
      JSON.stringify(patch.tags ?? existing.tags),
      Number.isInteger(patch.importance) ? patch.importance : existing.importance,
      patch.source !== undefined ? patch.source : (existing.source ?? null),
      embedding,
      now,
      id
    );
    return getById(id);
  }

  function remove(id) {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
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
    const result = db.prepare(
      `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, embedding=?, updated_at=?
       WHERE id=? AND updated_at=?`
    ).run(
      type,
      patch.title ?? existing.title,
      patch.content ?? existing.content,
      JSON.stringify(patch.tags ?? existing.tags),
      Number.isInteger(patch.importance) ? patch.importance : existing.importance,
      patch.source !== undefined ? patch.source : (existing.source ?? null),
      embedding,
      now,
      id,
      expectedUpdatedAt
    );
    if (result.changes === 0) return undefined; // CAS miss: a concurrent write won
    return getById(id);
  }

  function setForget(id, forgotten) {
    db.prepare("UPDATE memories SET forgotten = ?, updated_at = ? WHERE id = ?")
      .run(forgotten === true || forgotten === 1 ? 1 : 0, nowIso(), id);
    return getById(id);
  }

  function setArchived(id, archived) {
    db.prepare("UPDATE memories SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, nowIso(), id);
    return getById(id);
  }

  function list({ type, limit = 50, offset = 0, includeForgotten = false, includeArchived = false } = {}) {
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

  function search(query, { limit = 20, includeArchived = false } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    // Plain LIKE substring scan over title/content/tags (wildcards escaped so
    // user input matches literally). No FTS5: CJK substring matching needs
    // LIKE, and typical memory stores are small enough that a scan is fine.
    const like = `%${escapeLike(q)}%`;
    const { limit: lim } = sanitizePage(limit, 0, 20);
    const archivedFilter = includeArchived ? "" : "archived = 0 AND ";
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE ${archivedFilter}forgotten = 0 AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
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
  function searchVector(vector, { limit = 20, includeArchived = false, threshold = 0 } = {}) {
    if (!Array.isArray(vector) || !vector.length) return [];
    const archivedFilter = includeArchived ? "" : "archived = 0 AND ";
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE ${archivedFilter}forgotten = 0 AND embedding IS NOT NULL AND embedding != ''`
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
    db.prepare(
      `INSERT INTO dream_runs (id, created_at, status, error, provider, model, snapshot_hash,
        input_count, input, decisions, outcome, applied, summary_stored, receipt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at=excluded.created_at, status=excluded.status, error=excluded.error,
         provider=excluded.provider, model=excluded.model, snapshot_hash=excluded.snapshot_hash,
         input_count=excluded.input_count, input=excluded.input, decisions=excluded.decisions,
         outcome=excluded.outcome, applied=excluded.applied, summary_stored=excluded.summary_stored,
         receipt=excluded.receipt`
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
      run.receipt
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
    list,
    all,
    search,
    setEmbedding,
    embeddedCount,
    needsEmbedding,
    searchVector,
    saveDreamRun,
    getDreamRun,
    listDreamRuns,
    saveFailure,
    listFailures,
    getFailureStats,
    deleteOldFailures,
    close() {
      db.close();
    }
  };
}
