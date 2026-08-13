import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

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
    content: "正在开发 dsh-memory，SQLite+Markdown",
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
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "decision", title: "选型", content: "node:sqlite", importance: 3 });
  const dto = service.toApiList([saved]);
  assert.deepEqual(Object.keys(dto[0]).sort(), ["id", "type", "title", "content", "tags", "importance", "source", "created_at", "updated_at"].sort());
  assert.equal(dto[0].id, saved.id);
});
