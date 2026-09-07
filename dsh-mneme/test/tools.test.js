import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

function setup(embedder) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  const tools = createTools(ctx, service, {}, embedder);
  return { store, service, tools, registered };
}

// Collect authoring-DSL regressions in a compiled schema: property-level
// `required: true` (must be projected to a top-level required array by
// defineTool) and `minimum`/`maximum` (outside the enforced subset) are
// rejected by the real harness, so they must never appear post-compilation.
function walkSchema(node, path, problems) {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  if (typeof node.required === "boolean") {
    problems.push(`${path}.required must be an array (property-level required leaks through)`);
  }
  if (Object.hasOwn(node, "minimum") || Object.hasOwn(node, "maximum")) {
    problems.push(`${path} uses minimum/maximum, which the enforced JSON Schema subset rejects`);
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [key, value] of Object.entries(node.properties)) {
      walkSchema(value, `${path}.properties.${key}`, problems);
    }
  }
  if (node.items) walkSchema(node.items, `${path}.items`, problems);
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((branch, index) => walkSchema(branch, `${path}.oneOf[${index}]`, problems));
  }
}

test("registers seven tools with correct names", () => {
  const { registered } = setup();
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_archive", "memory_delete", "memory_forget", "memory_list", "memory_save", "memory_search", "memory_update"]);
});

test("compiled schemas pass the enforced DSH subset (defineTool projection)", () => {
  const { registered } = setup();
  assert.equal(registered.length, 7);
  for (const tool of registered) {
    assertSupportedJsonSchema(tool.parameters);
    assertSupportedJsonSchema(tool.output.schema);
    const problems = [];
    walkSchema(tool.parameters, `parameters(${tool.name})`, problems);
    walkSchema(tool.output.schema, `output.schema(${tool.name})`, problems);
    assert.deepEqual(problems, []);
  }
});

test("memory_save executes and stores", async () => {
  const { registered, store } = setup();
  const save = registered.find((t) => t.name === "memory_save");
  const result = await save.execute({ type: "preference", title: "语言", content: "中文", importance: 4 });
  assert.equal(result.action, "created");
  assert.equal(store.count(), 1);
});

test("memory_save merges on matching title within type", async () => {
  const { registered, store } = setup();
  const save = registered.find((t) => t.name === "memory_save");
  const first = await save.execute({ type: "preference", title: "语言", content: "中文" });
  const second = await save.execute({ type: "preference", title: "语言", content: "简体中文" });
  assert.equal(first.action, "created");
  assert.equal(second.action, "merged");
  assert.equal(first.id, second.id);
  assert.equal(store.count(), 1);
});

test("memory_search finds by CJK substring", async () => {
  const { registered, store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite 存储中文记忆", importance: 3 });
  const search = registered.find((t) => t.name === "memory_search");
  const result = await search.execute({ query: "中文" });
  assert.ok(result.items.length >= 1);
  assert.equal(result.items[0].title, "记忆插件");
});

test("memory_list filters by type", async () => {
  const { registered, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "a", content: "x" });
  service.saveWithDedupe({ type: "project", title: "b", content: "y" });
  const list = registered.find((t) => t.name === "memory_list");
  const result = await list.execute({ type: "project" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "b");
});

test("memory_list total reflects the type filter", async () => {
  const { registered, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "a", content: "x" });
  service.saveWithDedupe({ type: "preference", title: "b", content: "y" });
  service.saveWithDedupe({ type: "project", title: "c", content: "z" });
  const list = registered.find((t) => t.name === "memory_list");
  const projectRes = await list.execute({ type: "project" });
  assert.equal(projectRes.total, 1);
  const allRes = await list.execute({});
  assert.equal(allRes.total, 3);
});

test("memory_update modifies an entry", async () => {
  const { registered, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "decision", title: "t", content: "c" });
  const update = registered.find((t) => t.name === "memory_update");
  const result = await update.execute({ id: memory.id, content: "updated" });
  assert.equal(result.memory.content, "updated");
});

test("memory_update on missing id rejects", async () => {
  const { registered } = setup();
  const update = registered.find((t) => t.name === "memory_update");
  await assert.rejects(() => update.execute({ id: "missing", content: "x" }), /memory not found/);
});

test("memory_delete removes an entry", async () => {
  const { registered, service, store } = setup();
  const { memory } = service.saveWithDedupe({ type: "decision", title: "t", content: "c" });
  const del = registered.find((t) => t.name === "memory_delete");
  await del.execute({ id: memory.id });
  assert.equal(store.count(), 0);
});

test("memory_delete on missing id returns deleted:false", async () => {
  const { registered } = setup();
  const del = registered.find((t) => t.name === "memory_delete");
  const result = await del.execute({ id: "missing" });
  assert.equal(result.deleted, false);
});

test("memory_forget suppresses injection without deleting", async () => {
  const { registered, service, store } = setup();
  const { memory } = service.saveWithDedupe({ type: "project", title: "t", content: "c", importance: 5 });
  const forget = registered.find((t) => t.name === "memory_forget");
  const result = await forget.execute({ id: memory.id });
  assert.equal(result.memory.forgotten, true);
  assert.equal(store.count(undefined, { includeForgotten: true }), 1, "still stored but suppressed");
});

test("memory_forget on missing id rejects", async () => {
  const { registered } = setup();
  const forget = registered.find((t) => t.name === "memory_forget");
  await assert.rejects(() => forget.execute({ id: "missing" }), /memory not found/);
});

test("memory_forget restores with forgotten:false", async () => {
  const { registered, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "project", title: "t", content: "c", importance: 5 });
  const forget = registered.find((t) => t.name === "memory_forget");
  await forget.execute({ id: memory.id });
  const restored = await forget.execute({ id: memory.id, forgotten: false });
  assert.equal(restored.memory.forgotten, false);
});

test("execution results validate against their declared output schemas", async () => {
  const { registered, service } = setup();
  const byName = (n) => registered.find((t) => t.name === n);

  const saved = await byName("memory_save").execute({ type: "decision", title: "x", content: "y", tags: ["k"], source: "test" });
  assert.deepEqual(validateJsonSchemaValue(byName("memory_save").output.schema, saved), []);

  service.saveWithDedupe({ type: "project", title: "p", content: "q" });
  const searchRes = await byName("memory_search").execute({ query: "q" });
  assert.deepEqual(validateJsonSchemaValue(byName("memory_search").output.schema, searchRes), []);

  const listRes = await byName("memory_list").execute({});
  assert.deepEqual(validateJsonSchemaValue(byName("memory_list").output.schema, listRes), []);

  const updRes = await byName("memory_update").execute({ id: saved.id, content: "z" });
  assert.deepEqual(validateJsonSchemaValue(byName("memory_update").output.schema, updRes), []);

  const forgetRes = await byName("memory_forget").execute({ id: saved.id });
  assert.deepEqual(validateJsonSchemaValue(byName("memory_forget").output.schema, forgetRes), []);

  const delRes = await byName("memory_delete").execute({ id: saved.id });
  assert.deepEqual(validateJsonSchemaValue(byName("memory_delete").output.schema, delRes), []);
});

test("memory_search semantic mode merges vector recalls", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  const embedder = { embed: async () => [1, 0, 0] };
  createTools(ctx, service, {}, embedder);

  const v = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  store.setEmbedding(v.memory.id, [1, 0, 0]);
  service.saveWithDedupe({ type: "preference", title: "狗", content: "喜欢狗" });

  const search = registered.find((t) => t.name === "memory_search");
  // literal query matches only 猫; vector recall also surfaces it via embedding
  const res = await search.execute({ query: "猫", semantic: true });
  assert.ok(res.items.some((m) => m.title === "猫"), "vector + keyword merged result contains the hit");
  // mode=vector keeps keyword items too (dedup merge)
  const res2 = await search.execute({ query: "猫", mode: "vector" });
  assert.ok(res2.items.some((m) => m.title === "猫"));
});

test("memory_search falls back to keyword when embedder unavailable or returns null", async () => {
  // No embedder passed → plain keyword search still works.
  const { registered, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const search = registered.find((t) => t.name === "memory_search");
  const res = await search.execute({ query: "中文", semantic: true });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, "语言");

  // Embedder that resolves null (provider disabled) → keyword fallback.
  const store = createStore(":memory:");
  const service2 = createService({ store, mirror: null, config: {} });
  const registered2 = [];
  const ctx = { tools: { register(def) { registered2.push(def); return () => {}; } } };
  createTools(ctx, service2, {}, { embed: async () => null });
  service2.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const search2 = registered2.find((t) => t.name === "memory_search");
  const res2 = await search2.execute({ query: "中文", semantic: true });
  assert.equal(res2.items.length, 1);
});

// --- memory_archive (item ⑤: archive + verifiable recovery) ----------------

test("memory_archive hides an entry and memory_unarchive restores it", async () => {
  const { registered, service } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "project", title: "t", content: "c" });
  const archive = registered.find((t) => t.name === "memory_archive");
  const archived = await archive.execute({ id: m.id });
  assert.equal(archived.memory.archived, true);
  assert.ok(!service.list({ type: "project" }).some((x) => x.id === m.id), "archived hidden from default list");
  const restored = await archive.execute({ id: m.id, archived: false });
  assert.equal(restored.memory.archived, false);
  assert.ok(service.list({ type: "project" }).some((x) => x.id === m.id), "restored entry visible again");
});

test("memory_list include_archived lists hidden entries so they can be restored", async () => {
  const { registered, service } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "a", content: "x" });
  service.setArchived(m.id, true);
  const list = registered.find((t) => t.name === "memory_list");
  const hidden = await list.execute({ type: "preference", include_archived: true });
  assert.ok(hidden.items.some((x) => x.id === m.id), "archived entry discoverable");
  assert.equal(hidden.total, 1, "total counts the archived entry");
  const visible = await list.execute({ type: "preference" });
  assert.ok(!visible.items.some((x) => x.id === m.id), "archived entry hidden by default");
});

test("memory_archive on missing id rejects", async () => {
  const { registered } = setup();
  const archive = registered.find((t) => t.name === "memory_archive");
  await assert.rejects(() => archive.execute({ id: "missing" }), /memory not found/);
});
