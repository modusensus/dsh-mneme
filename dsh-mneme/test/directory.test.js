// v0.6.3 目录视图测试。
// 覆盖：store.getDirectory 按 tag 分组 / 组排序（tag 字典序）/
// 组内成员排序（importance DESC → updated_at DESC）/
// 无 tag 记忆进 untagged / disposed·archived·forgotten 过滤 /
// 多 tag 记忆出现在每个 tag 文件夹 / service.getDirectory 输出 wire DTO。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

function seed(store, title, { importance = 3, type = "preference", tags, session_id } = {}) {
  const mem = store.save({ type, title, content: `content of ${title}`, importance, session_id });
  if (tags && tags.length) store.setMemoryTags(mem.id, tags);
  return mem;
}

// Bump a row's updated_at directly so ordering assertions are deterministic
// (nowIso() has ~ms resolution and a same-ms save loses the tiebreaker to the
// random id).
function setUpdatedAt(store, id, iso) {
  store.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(iso, id);
}

// ============================================================ grouping

test("getDirectory groups live memories by their live tag set", () => {
  const { store } = setup();
  const a = seed(store, "Linux 笔记", { tags: ["linux"] });
  const b = seed(store, "考研计划", { tags: ["考研"] });
  const dir = store.getDirectory();
  assert.equal(dir.groups.length, 2);
  const linux = dir.groups.find((g) => g.tag === "linux");
  const exam = dir.groups.find((g) => g.tag === "考研");
  assert.deepEqual(linux.memories.map((m) => m.id), [a.id]);
  assert.deepEqual(exam.memories.map((m) => m.id), [b.id]);
  assert.deepEqual(dir.untagged, []);
  store.close();
});

test("getDirectory sorts groups by tag (locale-aware)", () => {
  const { store } = setup();
  seed(store, "B", { tags: ["zebra"] });
  seed(store, "A", { tags: ["alpha"] });
  seed(store, "C", { tags: ["æon"] });
  const dir = store.getDirectory();
  const tags = dir.groups.map((g) => g.tag);
  const sorted = [...tags].sort((x, y) => x.localeCompare(y));
  assert.deepEqual(tags, sorted, "groups must come back tag-sorted");
  store.close();
});

test("getDirectory orders group members by importance DESC then updated_at DESC", () => {
  const { store } = setup();
  // same importance → updated_at decides
  const older = seed(store, "older", { tags: ["linux"], importance: 2 });
  const newer = seed(store, "newer", { tags: ["linux"], importance: 2 });
  setUpdatedAt(store, older.id, "2026-01-01T00:00:00.000Z");
  setUpdatedAt(store, newer.id, "2026-08-01T00:00:00.000Z");
  // higher importance wins regardless of age
  const important = seed(store, "important", { tags: ["linux"], importance: 5 });
  setUpdatedAt(store, important.id, "2025-01-01T00:00:00.000Z");
  const dir = store.getDirectory();
  const linux = dir.groups.find((g) => g.tag === "linux");
  assert.deepEqual(
    linux.memories.map((m) => m.id),
    [important.id, newer.id, older.id],
    "importance DESC primary, updated_at DESC secondary"
  );
  store.close();
});

test("getDirectory collects untagged memories and orders them identically", () => {
  const { store } = setup();
  const a = seed(store, "untagged one", { importance: 1 });
  const b = seed(store, "untagged two", { importance: 4 });
  seed(store, "tagged", { tags: ["linux"], importance: 3 });
  const dir = store.getDirectory();
  assert.deepEqual(dir.untagged.map((m) => m.id), [b.id, a.id], "importance DESC inside untagged");
  assert.equal(dir.groups.some((g) => g.tag === "linux"), true);
  store.close();
});

test("getDirectory excludes forgotten, archived and session-disposed memories", () => {
  const { store } = setup();
  const forgotten = seed(store, "forgotten", { tags: ["linux"] });
  const archived = seed(store, "archived", { tags: ["linux"] });
  const disposed = seed(store, "disposed", { tags: ["linux"], type: "summary", session_id: "sess-disposed" });
  const keep = seed(store, "keep", { tags: ["linux"] });
  store.setForget(forgotten.id, true);
  store.setArchived(archived.id, true);
  store.setDisposedBySession(disposed.session_id, true);
  const dir = store.getDirectory();
  const linux = dir.groups.find((g) => g.tag === "linux");
  assert.deepEqual(linux.memories.map((m) => m.id), [keep.id], "only the live row survives");
  assert.deepEqual(dir.untagged, []);
  store.close();
});

test("getDirectory lists a multi-tag memory under every tag folder once each", () => {
  const { store } = setup();
  const multi = seed(store, "multi", { tags: ["linux", "bash"] });
  const single = seed(store, "single", { tags: ["linux"] });
  const dir = store.getDirectory();
  const linux = dir.groups.find((g) => g.tag === "linux");
  const bash = dir.groups.find((g) => g.tag === "bash");
  // `single` is written second → newer updated_at → ranks before `multi`.
  assert.deepEqual(linux.memories.map((m) => m.id), [single.id, multi.id]);
  assert.deepEqual(bash.memories.map((m) => m.id), [multi.id]);
  assert.equal(dir.untagged.length, 0);
  store.close();
});

// ============================================================ service

test("service.getDirectory returns the wire DTO shape with tags preserved", () => {
  const { store, service } = setup();
  const mem = seed(store, "笔记", { tags: ["linux"] });
  seed(store, "裸条目", { importance: 2 });
  const dir = service.getDirectory();
  assert.deepEqual(Object.keys(dir).sort(), ["groups", "untagged"]);
  const linux = dir.groups.find((g) => g.tag === "linux");
  assert.equal(linux.memories[0].id, mem.id);
  assert.equal(linux.memories[0].title, "笔记");
  assert.equal(typeof linux.memories[0].updated_at, "string", "DTO carries updated_at for the entry row");
  assert.equal(dir.untagged.length, 1);
  assert.equal(dir.untagged[0].title, "裸条目");
  store.close();
});
