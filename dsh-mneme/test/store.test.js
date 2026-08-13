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

test("save/update preserve archived flag", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.setArchived(saved.id, true);
  const updated = store.update(saved.id, { content: "new" });
  assert.equal(updated.archived, true, "update keeps archived");
  store.close();
});
