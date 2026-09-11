import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../src/tools.js";

function setup(embedder, config = {}) {
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
  const tools = createTools(ctx, service, config, embedder);
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

test("registers nine tools with correct names", () => {
  const { registered } = setup();
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_archive", "memory_delete", "memory_forget", "memory_get", "memory_list", "memory_runtime", "memory_save", "memory_search", "memory_update"]);
});

test("compiled schemas pass the enforced DSH subset (defineTool projection)", () => {
  const { registered } = setup();
  assert.equal(registered.length, 9);
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

// Regression: memory_get.execute must live on the defineTool options (top
// level), NOT nested inside output — a misplaced execute silently becomes
// options.execute === undefined and every call throws "userExecute is not a
// function" while tests that only count tool names still pass.
test("memory_get returns the full body via execute and render", async () => {
  const { registered, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "decision", title: "t", content: "完整正文内容" });
  const get = registered.find((t) => t.name === "memory_get");
  const res = await get.execute({ id: memory.id });
  assert.equal(res.memory.id, memory.id);
  assert.equal(res.memory.content, "完整正文内容");
  assert.deepEqual(validateJsonSchemaValue(get.output.schema, res), []);
  const text = get.output.render({}, res)[0].text;
  assert.ok(text.includes("完整正文内容"), "full body in render");
  assert.ok(text.includes(memory.id) && text.includes("t"), "id + title in render");
});

test("memory_get on missing id rejects", async () => {
  const { registered } = setup();
  const get = registered.find((t) => t.name === "memory_get");
  await assert.rejects(() => get.execute({ id: "missing" }), /memory not found/);
});

// Render output is what hosts surface to the model (not the structured JSON),
// so it must embed titles + body previews, not just a hit count.
test("memory_search render embeds titles and body previews, not just a count", async () => {
  const { registered, service } = setup();
  service.saveWithDedupe({ type: "history", title: "旅行计划", content: "用户当前最苦恼时间安排与伦敦行程" });
  service.saveWithDedupe({ type: "project", title: "插件定位", content: "dsh-mneme 插件做记忆沉淀" });
  const search = registered.find((t) => t.name === "memory_search");
  const res = await search.execute({ query: "时间" });
  assert.ok(res.items.length >= 1, "search hit exists");
  const text = search.output.render({}, res)[0].text;
  assert.match(text, /Found \d+ memory entr/);
  assert.ok(text.includes("旅行计划"), "title embedded in render");
  assert.ok(text.includes("伦敦行程"), "body preview embedded in render");
  assert.ok(text.includes("ID: "), "id embedded");
});

test("memory_list render embeds titles and ids, not just counts", async () => {
  const { registered, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "昵称", content: "桉桉" });
  service.saveWithDedupe({ type: "project", title: "博客", content: "modusensus" });
  const list = registered.find((t) => t.name === "memory_list");
  const res = await list.execute({});
  const text = list.output.render({}, res)[0].text;
  assert.match(text, /\d+ memory entries \(of \d+\):/);
  assert.ok(text.includes("昵称") && text.includes("博客"), "titles embedded");
  assert.ok(text.includes("ID: "), "ids embedded");
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

test("memory_runtime：status 只读且带代价说明；两条来源都不可用时如实回报（不联网）", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-tool-rt-"));
  // 与 api 路由测试同一做法：镜像钉到必然拒绝连接的本地端口，避免测试真的去 registry 拉整套闭包。
  const { registered } = setup(undefined, { runtimeDir, runtimeMirror: "http://127.0.0.1:1/" });
  const tool = registered.find((t) => t.name === "memory_runtime");
  assert.ok(tool, "应当注册 memory_runtime");

  // status 是 agent 的入口：只读，而且必须带上代价，否则 agent 没法先告诉用户再动手。
  const status = await tool.execute({ action: "status" });
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, status), []);
  assert.equal(status.status, "missing", "临时目录里没有 payload");
  assert.match(status.cost, /hundreds of MB/, "代价说明要带上体积量级（刻意不写死具体数值：各平台不同、也会漂移）");
  assert.ok(status.summary.length > 0);

  // provision：仓库布局下推导出的源不是 node_modules，下载又被钉死 —— 如实回报，不抛异常。
  const provision = await tool.execute({ action: "provision" });
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, provision), []);
  assert.equal(provision.status, "failed");
  assert.match(provision.reason, /收编失败|下载失败/);
  assert.equal(existsSync(runtimeDir) ? readdirSync(runtimeDir).length : 0, 0, "失败后不该留下半份 payload");
});
