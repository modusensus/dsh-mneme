import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";

function openMemory() {
  return createStore(":memory:");
}

test("createStore initializes schema and opens db", () => {
  const store = openMemory();
  const row = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
  ).get();
  assert.ok(row, "memories table exists");
  store.close();
});

test("save inserts a memory and returns it with id/created_at", () => {
  const store = openMemory();
  const saved = store.save({
    type: "preference",
    title: "语言",
    content: "用户用中文交流",
    tags: ["偏好"],
    importance: 5,
    source: "manual"
  });
  assert.ok(saved.id, "has id");
  assert.ok(saved.created_at, "has created_at");
  assert.equal(saved.type, "preference");
  assert.equal(store.count(), 1);
  store.close();
});

test("getById returns the memory", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const got = store.getById(saved.id);
  assert.equal(got.title, "t");
  assert.equal(got.content, "c");
  store.close();
});

test("update modifies fields and bumps updated_at", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const updated = store.update(saved.id, { content: "new content", importance: 4 });
  assert.equal(updated.content, "new content");
  assert.equal(updated.importance, 4);
  assert.notEqual(updated.updated_at, saved.updated_at);
  store.close();
});

test("remove deletes the memory", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.remove(saved.id);
  assert.equal(store.getById(saved.id), undefined);
  assert.equal(store.count(), 0);
  store.close();
});

test("list filters by type and paginates", () => {
  const store = openMemory();
  for (let i = 0; i < 5; i++) store.save({ type: "preference", title: `p${i}`, content: "c" });
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `j${i}`, content: "c" });
  assert.equal(store.list({ type: "preference" }).length, 5);
  assert.equal(store.list({ type: "project" }).length, 3);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ limit: 2, offset: 2 }).length, 2);
  store.close();
});

test("setForget toggles injection suppression", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 5 });
  store.setForget(saved.id, true);
  const got = store.getById(saved.id);
  // toRow maps SQLite 0/1 to boolean
  assert.equal(got.forgotten, true);
  store.close();
});

test("count excludes forgotten by default, includeForgotten opts in", () => {
  const store = openMemory();
  const a = store.save({ type: "project", title: "t1", content: "c" });
  store.save({ type: "project", title: "t2", content: "c" });
  store.save({ type: "preference", title: "p", content: "c" });
  store.setForget(a.id, true);
  assert.equal(store.count(), 2, "default excludes forgotten (matches list)");
  assert.equal(store.count("project"), 1);
  assert.equal(store.count("preference"), 1);
  assert.equal(store.count(undefined, { includeForgotten: true }), 3);
  assert.equal(store.count("project", { includeForgotten: true }), 2);
  store.close();
});

test("search matches title, content and tags", () => {
  const store = openMemory();
  store.save({ type: "project", title: "记忆插件", content: "c1", tags: [] });
  store.save({ type: "project", title: "t2", content: "用户用中文交流", tags: [] });
  store.save({ type: "preference", title: "t3", content: "c3", tags: ["偏好"] });
  assert.ok(store.search("记忆插件").some((m) => m.title === "记忆插件"));
  assert.ok(store.search("中文").some((m) => m.content === "用户用中文交流"));
  assert.ok(store.search("偏好").some((m) => m.tags.includes("偏好")));
  store.close();
});

test("search with empty query returns []", () => {
  const store = openMemory();
  store.save({ type: "project", title: "t", content: "c" });
  assert.deepEqual(store.search(""), []);
  assert.deepEqual(store.search("   "), []);
  store.close();
});

test("forgotten memories are excluded from list and search until un-forgotten", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "秘密", content: "c", importance: 5 });
  assert.ok(store.list().some((m) => m.id === saved.id));
  assert.ok(store.search("秘密").some((m) => m.id === saved.id));
  store.setForget(saved.id, true);
  assert.ok(!store.list().some((m) => m.id === saved.id));
  assert.ok(!store.search("秘密").some((m) => m.id === saved.id));
  store.setForget(saved.id, false);
  assert.ok(store.list().some((m) => m.id === saved.id));
  assert.ok(store.search("秘密").some((m) => m.id === saved.id));
  store.close();
});

test("search matches CJK substring", () => {
  const store = openMemory();
  store.save({ type: "project", title: "t", content: "用户用中文交流" });
  assert.equal(store.search("中文").length, 1);
  store.close();
});

test("search respects limit", () => {
  const store = openMemory();
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `m${i}`, content: "匹配词" });
  assert.equal(store.search("匹配词").length, 3);
  assert.equal(store.search("匹配词", { limit: 2 }).length, 2);
  store.close();
});

test("list sanitizes invalid limit/offset", () => {
  const store = openMemory();
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `t${i}`, content: "c" });
  assert.equal(store.list({ limit: -1 }).length, 3);
  assert.equal(store.list({ limit: 0 }).length, 3);
  assert.equal(store.list({ limit: 1.5 }).length, 3);
  assert.equal(store.list({ limit: 2, offset: -5 }).length, 2);
  store.close();
});

test("schema migration adds archived column to legacy database", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // Create a legacy db WITHOUT archived column
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.close();
    // Open with createStore → should ALTER TABLE
    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    assert.ok(cols.includes("archived"), "archived column added");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setArchived marks entry archived; list excludes it by default", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const archived = store.setArchived(saved.id, true);
  assert.equal(archived.archived, true);
  assert.equal(store.list().length, 0, "excluded from default list");
  assert.equal(store.list({ includeArchived: true }).length, 1, "included with flag");
  assert.equal(store.count(), 0, "excluded from default count");
  assert.equal(store.count(undefined, { includeArchived: true }), 1);
  store.close();
});

test("search excludes archived by default", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "secret", content: "hidden content", importance: 3 });
  store.setArchived(saved.id, true);
  assert.equal(store.search("secret").length, 0);
  assert.equal(store.search("secret", { includeArchived: true }).length, 1);
  store.close();
});

// --- vector search ---

test("save/update persist embedding vector and searchVector ranks by cosine", () => {
  const store = openMemory();
  const a = store.save({ type: "preference", title: "猫", content: "喜欢猫", embedding: [1, 0, 0] });
  const b = store.save({ type: "preference", title: "狗", content: "喜欢狗", embedding: [0, 1, 0] });
  const c = store.save({ type: "preference", title: "猫狗", content: "都养", embedding: [0.9, 0.1, 0] });

  const hits = store.searchVector([1, 0, 0], { limit: 3 });
  assert.deepEqual(hits.map((m) => m.id), [a.id, c.id, b.id]);
  assert.equal(hits[0].score, 1);
  assert.ok(hits[1].score > hits[2].score);

  // update re-stores embedding
  store.update(b.id, { embedding: [1, 1, 0] });
  const hits2 = store.searchVector([1, 1, 0], { limit: 3 });
  assert.equal(hits2[0].id, b.id);
  store.close();
});

test("searchVector only considers rows with an embedding and filters forgotten/archived", () => {
  const store = openMemory();
  const plain = store.save({ type: "project", title: "无向量", content: "x" });
  const withVec = store.save({ type: "project", title: "有向量", content: "y", embedding: [1, 0, 0] });
  store.setForget(withVec.id, true);
  assert.deepEqual(store.searchVector([1, 0, 0]).map((m) => m.id), []);
  store.setForget(withVec.id, false);
  store.setArchived(withVec.id, true);
  assert.deepEqual(store.searchVector([1, 0, 0]).map((m) => m.id), []);
  store.setArchived(withVec.id, false);
  assert.deepEqual(store.searchVector([1, 0, 0]).map((m) => m.id), [withVec.id]);
  assert.equal(plain.id, plain.id, "plain row keeps id");
  store.close();
});

test("setEmbedding, embeddedCount, needsEmbedding and threshold filtering", () => {
  const store = openMemory();
  const t1 = store.save({ type: "project", title: "t1", content: "c1" });
  const m2 = store.save({ type: "project", title: "t2", content: "c2" });
  assert.equal(store.embeddedCount(), 0);
  store.setEmbedding(m2.id, [0, 1]);
  assert.equal(store.embeddedCount(), 1);
  const missing = store.needsEmbedding(10);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, t1.id, "only the non-embedded row is listed");

  const t3 = store.save({ type: "project", title: "t3", content: "c3", embedding: [1, 1] });
  // threshold 0.99: only t3 (cos=1) survives; m2 ([0,1]) scores ~0.707.
  const near = store.searchVector([1, 1], { limit: 5, threshold: 0.99 });
  assert.deepEqual(near.map((m) => m.id), [t3.id]);
  store.close();
});

test("save/update preserve archived flag", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.setArchived(saved.id, true);
  const updated = store.update(saved.id, { content: "new" });
  assert.equal(updated.archived, true, "update keeps archived");
  store.close();
});

// --- compare-and-set update (item ①/③) ------------------------------------

test("compareAndUpdate applies when the version token still matches", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "count=0" });
  const before = store.getById(saved.id);
  const updated = store.compareAndUpdate(saved.id, before.updated_at, { content: "count=1" });
  assert.ok(updated, "CAS with the current version succeeds");
  assert.equal(updated.content, "count=1");
  assert.notEqual(updated.updated_at, before.updated_at, "version token advances");
  store.close();
});

test("compareAndUpdate rejects a stale version token without writing", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "count=0" });
  const stale = store.getById(saved.id).updated_at;
  store.update(saved.id, { content: "count=1" }); // concurrent write wins
  const result = store.compareAndUpdate(saved.id, stale, { content: "count=2" });
  assert.equal(result, undefined, "stale CAS is a miss");
  assert.equal(store.getById(saved.id).content, "count=1", "no lost update");
  store.close();
});

test("compareAndUpdate on unknown id throws like update", () => {
  const store = openMemory();
  assert.throws(() => store.compareAndUpdate("ghost", "any", { content: "x" }), /not found/);
  store.close();
});

// --- conflict freeze: pending manual review -------------------------------

test("saveConflictPending inserts and listConflictPending excludes resolved by default", () => {
  const store = openMemory();
  const a = store.save({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const b = store.save({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const pending = store.saveConflictPending({ run_id: "run-1", memory_a: a.id, memory_b: b.id, reason: "日期更新" });
  assert.ok(pending.id, "has id");
  assert.equal(pending.run_id, "run-1");
  assert.equal(pending.reason, "日期更新");
  assert.ok(pending.created_at);
  assert.equal(pending.resolved_at, undefined);

  const list = store.listConflictPending();
  assert.equal(list.length, 1);
  assert.ok([list[0].memory_a, list[0].memory_b].includes(a.id), "pair holds both sides");
  assert.ok([list[0].memory_a, list[0].memory_b].includes(b.id));

  const resolved = store.resolveConflictPending(pending.id, { winner: a.id });
  assert.ok(resolved.resolved_at, "resolution stamped");
  assert.equal(resolved.resolved_winner, a.id);
  assert.equal(store.listConflictPending().length, 0, "resolved excluded by default");
  const all = store.listConflictPending({ includeResolved: true });
  assert.equal(all.length, 1, "resolved visible with includeResolved");
  assert.equal(all[0].resolved_winner, a.id);
  store.close();
});

test("saveConflictPending dedupes the same pair regardless of order", () => {
  const store = openMemory();
  const a = store.save({ type: "decision", title: "截止", content: "x" });
  const b = store.save({ type: "decision", title: "截止2", content: "y" });
  const p1 = store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "r1" });
  const p2 = store.saveConflictPending({ memory_a: b.id, memory_b: a.id, reason: "r2" });
  assert.equal(p2.id, p1.id, "same pair re-detected returns the existing pending row");
  assert.equal(p2.reason, "r1", "original reason preserved");
  assert.equal(store.listConflictPending().length, 1, "never a duplicate queue entry");
  store.close();
});

test("countConflictPending counts unresolved rows only; resolve unknown id is undefined", () => {
  const store = openMemory();
  const a = store.save({ type: "decision", title: "a", content: "x" });
  const b = store.save({ type: "decision", title: "b", content: "y" });
  const c = store.save({ type: "decision", title: "c", content: "z" });
  store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "ab" });
  const p2 = store.saveConflictPending({ memory_a: b.id, memory_b: c.id, reason: "bc" });
  assert.equal(store.countConflictPending(), 2);
  store.resolveConflictPending(p2.id, { winner: b.id });
  assert.equal(store.countConflictPending(), 1, "resolved no longer pending");
  assert.equal(store.resolveConflictPending("ghost"), undefined, "unknown id resolves to undefined");
  store.close();
});

test("conflict_pending table persists across store reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-conflict-"));
  const path = join(dir, "memory.db");
  const s1 = createStore(path);
  s1.saveConflictPending({ run_id: "run-1", memory_a: "ma", memory_b: "mb", reason: "x" });
  s1.close();
  const s2 = createStore(path);
  const pending = s2.listConflictPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "x");
  s2.close();
});
