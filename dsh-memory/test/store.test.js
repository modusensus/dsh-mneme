import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(got.forgotten, 1);
  store.close();
});
