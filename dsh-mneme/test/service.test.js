import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createMirror } from "../src/mirror.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("saveWithDedupe adds new memory when no similar exists", () => {
  const { store, service } = setup();
  const result = service.saveWithDedupe({
    type: "project",
    title: "记忆插件",
    content: "正在开发 dsh-mneme，SQLite+Markdown",
    importance: 4
  });
  assert.equal(result.action, "created");
  assert.equal(store.count(), 1);
});

test("saveWithDedupe merges into existing on exact title match", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "旧内容", importance: 3 });
  const result = service.saveWithDedupe({ type: "project", title: "记忆插件", content: "新内容", importance: 5 });
  assert.equal(result.action, "merged");
  assert.equal(store.count(), 1);
  const all = store.all();
  assert.equal(all[0].content, "新内容");
  assert.equal(all[0].importance, 5);
});

test("injectCandidates returns preferences + high-importance items within limit", () => {
  const { service } = setup();
  for (let i = 0; i < 3; i++) service.saveWithDedupe({ type: "preference", title: `p${i}`, content: "偏好" });
  service.saveWithDedupe({ type: "project", title: "low", content: "低", importance: 2 });
  service.saveWithDedupe({ type: "project", title: "high", content: "高", importance: 5 });
  service.saveWithDedupe({ type: "history", title: "h", content: "历史", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 4 });
  const types = candidates.map((c) => c.type);
  assert.ok(types.includes("preference"), "preferences included");
  assert.ok(types.includes("project"), "high-importance project included");
  assert.ok(!types.includes("history"), "history excluded by default");
  assert.ok(candidates.length <= 5, "respects maxItems");
});

test("mergeHumanEdits applies human content over machine", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
  const edits = [{ id: saved.memory.id, title: "语言", content: "人类编辑内容" }];
  service.mergeHumanEdits("preference", edits);
  const got = store.getById(saved.memory.id);
  assert.equal(got.content, "人类编辑内容");
});

test("toApiList maps store rows to wire DTOs", () => {
  const { service } = setup();
  const saved = service.saveWithDedupe({ type: "decision", title: "选型", content: "node:sqlite", importance: 3 });
  const dto = service.toApiList([saved.memory]);
  assert.deepEqual(Object.keys(dto[0]).sort(), ["id", "type", "title", "content", "tags", "importance", "source", "created_at", "updated_at"].sort());
  assert.equal(dto[0].id, saved.memory.id);
  assert.equal(dto[0].type, "decision");
  assert.equal(dto[0].title, "选型");
  assert.equal(dto[0].content, "node:sqlite");
  assert.equal(dto[0].importance, 3);
});

test("mergeHumanEdits skips edits without id and keeps applying the rest", () => {
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
  const second = service.saveWithDedupe({ type: "preference", title: "主题", content: "机器内容" });
  const edits = [
    { content: "缺少 id 的损坏条目" },
    { id: first.memory.id, title: "语言", content: "人类编辑内容" },
    { id: second.memory.id, title: "主题", content: "第二个人类编辑" }
  ];
  const applied = service.mergeHumanEdits("preference", edits);
  assert.equal(applied, 2, "returns count of applied edits, not input length");
  assert.equal(store.getById(first.memory.id).content, "人类编辑内容");
  assert.equal(store.getById(second.memory.id).content, "第二个人类编辑");
});

test("mutations through passthroughs sync mirror; forgotten entries stay out of it", () => {
  const store = createStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-service-"));
  const mirror = createMirror(dir);
  const service = createService({ store, mirror, config: {} });
  try {
    const saved = service.saveWithDedupe({ type: "project", title: "A", content: "a", importance: 4 });
    assert.ok(existsSync(join(dir, "projects.md")), "mirror written on save");

    service.update(saved.memory.id, { content: "a2" });
    assert.match(readFileSync(join(dir, "projects.md"), "utf8"), /a2/, "update re-syncs mirror");

    service.setForget(saved.memory.id, true);
    assert.ok(!existsSync(join(dir, "projects.md")), "forgotten entry removed from mirror");

    const second = service.saveWithDedupe({ type: "project", title: "B", content: "b", importance: 2 });
    assert.ok(existsSync(join(dir, "projects.md")), "mirror rewritten after re-save");
    service.remove(second.memory.id);
    assert.ok(!existsSync(join(dir, "projects.md")), "remove re-syncs mirror");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveWithDedupe created branch keeps forgotten entries out of mirror", () => {
  const store = createStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-service-"));
  const mirror = createMirror(dir);
  const service = createService({ store, mirror, config: {} });
  try {
    const a = service.saveWithDedupe({ type: "project", title: "A", content: "a", importance: 4 });
    service.setForget(a.memory.id, true);
    service.saveWithDedupe({ type: "project", title: "B", content: "b", importance: 2 });
    const text = readFileSync(join(dir, "projects.md"), "utf8");
    assert.ok(!text.includes(a.memory.id), "forgotten A must not reappear in mirror");
    assert.ok(!text.includes("## A"), "forgotten A entry absent from mirror");
    assert.match(text, /## B/, "non-forgotten B present in mirror");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injectCandidates excludes archived entries", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "preference", title: "旧偏好", content: "old", importance: 5 });
  store.setArchived(saved.memory.id, true);
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.ok(!candidates.some((c) => c.id === saved.memory.id), "archived excluded");
});

test("summary memory is a candidate at top priority", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "总览内容", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.equal(candidates[0]?.type, "summary", "summary first even with competing high-importance preference");
});

test("write methods invoke onWrite hook when provided", () => {
  const { store } = setup();
  let called = 0;
  const svc = createService({ store, mirror: null, config: {}, onWrite: () => { called++; } });
  svc.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(called, 1, "saveWithDedupe hooks");
  svc.update(svc.all()[0].id, { content: "y" });
  assert.equal(called, 2, "update hooks");
  svc.setArchived(svc.all()[0].id, true);
  assert.equal(called, 2, "setArchived does not hook (not a content write)");
});
