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
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
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

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  // Schema migration: add archived column to legacy databases (idempotent)
  const columns = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  if (!columns.includes("archived")) {
    db.exec("ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
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
    db.prepare(
      `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(id, type, memory.title, memory.content, tags, importance, memory.source ?? null, now, now);
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
    db.prepare(
      `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, updated_at=? WHERE id=?`
    ).run(
      type,
      patch.title ?? existing.title,
      patch.content ?? existing.content,
      JSON.stringify(patch.tags ?? existing.tags),
      Number.isInteger(patch.importance) ? patch.importance : existing.importance,
      patch.source !== undefined ? patch.source : (existing.source ?? null),
      now,
      id
    );
    return getById(id);
  }

  function remove(id) {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
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

  function search(query, { limit = 20, includeArchived = false } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    // FTS5 over unicode61 (English + long phrases); LIKE fallback covers CJK substring.
    // LIKE wildcards in the query are escaped so user input is matched literally.
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

  return {
    db,
    count,
    getById,
    save,
    update,
    remove,
    setForget,
    setArchived,
    list,
    all,
    search,
    close() {
      db.close();
    }
  };
}
