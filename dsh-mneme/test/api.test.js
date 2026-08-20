import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { createVectorIndex } from "../src/vector-index.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET", body = null) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setup(embedder, apiToken = "") {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = {
    add: (def) => settings.addCommand(def),
    remove: (id) => settings.removeCommand(id),
    list: () => settings.listCommands()
  };
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const api = createApi(ctx, service, settings, commands, embedder, undefined, apiToken);
  return { store, service, routes, api, settings, apiToken };
}

function findHandler(routes, path) {
  const route = routes.find((r) => r.path === path || (r.kind === "prefix" && path.startsWith(r.path)));
  return route;
}

test("registers list, search, and get prefix routes", () => {
  const { routes } = setup();
  const paths = routes.map((r) => r.path);
  assert.ok(paths.includes("/api/dsh-mneme/list"));
  assert.ok(paths.includes("/api/dsh-mneme/search"));
  assert.ok(paths.includes("/api/dsh-mneme"));
});

test("GET /api/dsh-mneme/list returns memories as JSON", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?type=preference"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].title, "语言");
});

test("GET /api/dsh-mneme/search?q= returns matches", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite 中文搜索" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/search?q=%E4%B8%AD%E6%96%87"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
});

test("unknown route under prefix returns 404 json", async () => {
  const { routes } = setup();
  const route = findHandler(routes, "/api/dsh-mneme");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/nope"), res);
  assert.equal(res.statusCode, 404);
});

test("list total excludes forgotten entries", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "正常", content: "可见" });
  const forgotten = service.saveWithDedupe({ type: "preference", title: "遗忘", content: "隐藏" });
  service.saveWithDedupe({ type: "project", title: "项目", content: "其他类型" });
  service.setForget(forgotten.memory.id, true);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?type=preference"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.total, 1, "total matches visible items, forgotten excluded");
});

test("list honors limit/offset", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "a", content: "1" });
  service.saveWithDedupe({ type: "preference", title: "b", content: "2" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list?limit=1&offset=0"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.total, 2);
});

test("responses carry application/json content-type", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), res);
  assert.match(res.headers["Content-Type"], /application\/json/);
});

test("handler errors return 500 json instead of leaking to host", async () => {
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const service = {
    list() { throw new Error("boom"); },
    count() { throw new Error("boom"); },
    search() { throw new Error("boom"); },
    toApiList() { return []; }
  };
  createApi(ctx, service, {}, { add: () => { throw new Error("x"); }, remove: () => false, list: () => [] });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/list"), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: "internal" });
});

test("GET /api/dsh-mneme/profile returns stored profile", async () => {
  const { routes, settings } = setup();
  settings.setProfile("我是前端");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/profile");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/profile"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).profile, "我是前端");
});

test("PUT /api/dsh-mneme/profile saves profile", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/profile");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/profile", "PUT", { profile: "新画像" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).profile, "新画像");
  assert.equal(settings.getProfile(), "新画像");
});

test("GET /api/dsh-mneme/rules returns stored rules", async () => {
  const { routes, settings } = setup();
  settings.setRules(["规则1", "规则2"]);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/rules");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/rules"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).rules, ["规则1", "规则2"]);
});

test("PUT /api/dsh-mneme/rules saves rules", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/rules");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/rules", "PUT", { rules: ["a", "b"] }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(settings.getRules(), ["a", "b"]);
});

test("GET /api/dsh-mneme/commands lists commands", async () => {
  const { routes, settings } = setup();
  settings.addCommand({ name: "agenda", instruction: "x" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/commands");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/commands"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).commands.length, 1);
});

test("POST /api/dsh-mneme/commands adds a command; DELETE removes", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/commands");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/commands", "POST", { name: "fmt", description: "d", instruction: "格式化" }), res);
  assert.equal(res.statusCode, 200);
  const { command } = JSON.parse(res.body);
  assert.equal(command.name, "fmt");
  const del = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/commands?id=${command.id}`, "DELETE"), del);
  assert.equal(JSON.parse(del.body).removed, true);
});

test("POST /api/dsh-mneme/commands rejects invalid name with 400", async () => {
  const { routes } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/commands");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/commands", "POST", { name: "Bad Name", instruction: "x" }), res);
  assert.equal(res.statusCode, 400);
});

// --- vector search routes ---

function setupWithEmbedder(embedder) {
  const base = setup(embedder);
  base.settings.setVectorConfig({
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "text-embedding-v3"
  });
  return base;
}

test("vector-config defaults and round-trips through PUT/GET", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");

  const get1 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config"), get1);
  assert.equal(JSON.parse(get1.body).config.enabled, false);

  const put = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", { enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "text-embedding-3-small" }), put);
  assert.equal(JSON.parse(put.body).config.model, "text-embedding-3-small");
  assert.equal(settings.getVectorConfig().enabled, true);
});

test("search mode=vector merges vector results when embedder returns a vector", async () => {
  const embedder = {
    embed: async () => [1, 0, 0],
    reindexMissing: async () => ({ indexed: 0, skipped: 0 })
  };
  const { routes, store, service } = setupWithEmbedder(embedder);
  const v = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  store.setEmbedding(v.memory.id, [1, 0, 0]);
  service.saveWithDedupe({ type: "preference", title: "狗", content: "喜欢狗" });

  const route = routes.find((r) => r.path === "/api/dsh-mneme/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/search?q=%E7%8C%AB&mode=vector"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.mode, "vector");
  assert.equal(data.items.length, 1, "keyword hit + vector fill merged");
  assert.equal(data.items[0].title, "猫");
});

test("search falls back to keyword when embedder disabled or unavailable", async () => {
  // embedder that resolves null (disabled provider)
  const embedder = { embed: async () => null, reindexMissing: async () => ({ indexed: 0, skipped: 0 }) };
  const { routes, service } = setupWithEmbedder(embedder);
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/search?q=%E4%B8%AD%E6%96%87"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.mode, "keyword");
  assert.equal(data.items.length, 1);
});

test("vector-reindex calls embedder and returns counts", async () => {
  const embedder = { reindexMissing: async () => ({ indexed: 2, skipped: 1 }) };
  const { routes } = setupWithEmbedder(embedder);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-reindex");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-reindex"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.indexed, 2);
  assert.equal(data.skipped, 1);
});

test("vector-config masks apiKey; empty/masked key on PUT keeps existing", async () => {
  const { routes, settings } = setup();
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");

  // PUT stores the real key but responds masked
  const put = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", {
    enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-abcdefghijklmnop", model: "m1"
  }), put);
  const putBody = JSON.parse(put.body);
  assert.equal(putBody.config.apiKey, "sk-***mnop", "PUT response masked");
  assert.equal(settings.getVectorConfig().apiKey, "sk-abcdefghijklmnop", "storage keeps the real key");

  // GET returns masked key, other fields intact
  const get = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config"), get);
  const getBody = JSON.parse(get.body);
  assert.equal(getBody.config.apiKey, "sk-***mnop");
  assert.equal(getBody.config.baseUrl, "https://api.openai.com/v1");
  assert.equal(getBody.config.enabled, true);

  // PUT with empty apiKey keeps the previous key
  const put2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", {
    enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "", model: "m2"
  }), put2);
  assert.equal(settings.getVectorConfig().apiKey, "sk-abcdefghijklmnop", "empty key keeps existing");
  assert.equal(JSON.parse(put2.body).config.model, "m2");

  // PUT with a masked apiKey (client round-trip) also keeps the previous key
  const put3 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-config", "PUT", {
    enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-***mnop", model: "m3"
  }), put3);
  assert.equal(settings.getVectorConfig().apiKey, "sk-abcdefghijklmnop", "masked key keeps existing");
});

test("apiToken protects write/secret endpoints while read endpoints stay open", async () => {
  const { routes } = setup(undefined, "secret-token");
  const list = routes.find((r) => r.path === "/api/dsh-mneme/list");
  const profile = routes.find((r) => r.path === "/api/dsh-mneme/profile");
  const vec = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");
  const reindex = routes.find((r) => r.path === "/api/dsh-mneme/vector-reindex");

  // read-only endpoint stays open without a token
  const resList = new FakeRes();
  await list.handler(req("/api/dsh-mneme/list"), resList);
  assert.equal(resList.statusCode, 200, "list stays open");

  // secret endpoint without token → 401
  const resVec = new FakeRes();
  await vec.handler(req("/api/dsh-mneme/vector-config"), resVec);
  assert.equal(resVec.statusCode, 401, "vector-config GET requires token");

  // write endpoint without token → 401
  const resProfile = new FakeRes();
  await profile.handler(req("/api/dsh-mneme/profile", "PUT", { profile: "x" }), resProfile);
  assert.equal(resProfile.statusCode, 401, "profile PUT requires token");

  // reindex without token → 401
  const resReindex = new FakeRes();
  await reindex.handler(req("/api/dsh-mneme/vector-reindex"), resReindex);
  assert.equal(resReindex.statusCode, 401, "vector-reindex requires token");

  // with a Bearer token everything is allowed
  const authReq = (path, method = "GET", body = null) => {
    const r = req(path, method, body);
    r.headers = { authorization: "Bearer secret-token" };
    return r;
  };
  const resVecOk = new FakeRes();
  await vec.handler(authReq("/api/dsh-mneme/vector-config"), resVecOk);
  assert.equal(resVecOk.statusCode, 200, "vector-config GET with token");
  const resProfileOk = new FakeRes();
  await profile.handler(authReq("/api/dsh-mneme/profile", "PUT", { profile: "hi" }), resProfileOk);
  assert.equal(resProfileOk.statusCode, 200, "profile PUT with token");

  // wrong token → 401
  const bad = req("/api/dsh-mneme/vector-config");
  bad.headers = { authorization: "Bearer wrong" };
  const resBad = new FakeRes();
  await vec.handler(bad, resBad);
  assert.equal(resBad.statusCode, 401, "wrong token rejected");
});

test("no apiToken configured keeps all endpoints open", async () => {
  const { routes } = setup();
  const vec = routes.find((r) => r.path === "/api/dsh-mneme/vector-config");
  const res = new FakeRes();
  await vec.handler(req("/api/dsh-mneme/vector-config"), res);
  assert.equal(res.statusCode, 200, "open when apiToken is unset");
});

// --- Bug8: llm-audit API (pagination + stats) --------------------------------

test("GET /api/dsh-mneme/semantic/llm-audit returns paginated rows", async () => {
  const { routes, service } = setup();
  for (let i = 0; i < 5; i++) {
    service.saveLlmAudit({ trigger_source: "autoDream", operation_type: "dream_consolidate", model_id: "m1", input_tokens: 10, output_tokens: 5, status: "success", related_memory_ids: [] });
  }
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?page=2&pageSize=2"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 5);
  assert.equal(data.page, 2);
  assert.equal(data.pageSize, 2);
  assert.equal(data.items.length, 2, "second page of 2");
});

test("GET /api/dsh-mneme/semantic/llm-audit filters by source", async () => {
  const { routes, service } = setup();
  service.saveLlmAudit({ trigger_source: "autoDream", operation_type: "dream_consolidate", model_id: "m1", status: "success" });
  service.saveLlmAudit({ trigger_source: "autoSummarize", operation_type: "summarize_compress", model_id: "m2", status: "success" });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?source=autoSummarize"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].operation_type, "summarize_compress");
});

test("GET /api/dsh-mneme/semantic/llm-audit/stats aggregates tokens by source and status", async () => {
  const { routes, service } = setup();
  service.saveLlmAudit({
    trigger_source: "autoDream", operation_type: "dream_consolidate", model_id: "m1",
    input_tokens: 100, output_tokens: 50, total_tokens: 150, duration_ms: 12, status: "success", related_memory_ids: []
  });
  service.saveLlmAudit({
    trigger_source: "autoSummarize", operation_type: "summarize_compress", model_id: "m2",
    input_tokens: 20, output_tokens: 10, total_tokens: 30, duration_ms: 5, status: "error", error_message: "boom", related_memory_ids: []
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit/stats");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit/stats?days=7"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total_calls, 2);
  assert.equal(data.input_tokens, 120);
  assert.equal(data.output_tokens, 60);
  assert.equal(data.total_tokens, 180);
  assert.equal(data.total_duration_ms, 17);
  assert.ok(data.by_source.some((s) => s.source === "autoDream" && s.total_tokens === 150), "autoDream aggregate present");
  assert.ok(data.by_status.some((s) => s.status === "error" && s.c === 1), "error status counted");
});

// --- issue #10: vector-reindex with an embed-only OpenAI-compatible embedder --

test("Bug10: vector-reindex with an embed-only OpenAI-compatible embedder returns the real count and records the model fingerprint", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embed: async (text) => [0.1, 0.2, 0.3], // OpenAI-compatible single-text embed
    modelHash: "text-embedding-3#abc",
    dimension: 3
  };
  // A pre-index row written before the embedder is attached (so it still has no vector).
  service.saveWithDedupe({ type: "project", title: "待回填", content: "缺少向量的存量记忆" });
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add() {}, remove() {}, list() { return []; } }, embedder, { vectorIndex }, "");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/vector-reindex");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/vector-reindex"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.indexed, 1, "actual indexed count, not 0");
  assert.equal(data.skipped, 0);
  assert.equal(vectorIndex.modelHash(), "text-embedding-3#abc", "model_hash written to vector_meta");
  assert.equal(vectorIndex.dimension(), 3, "dimension written to vector_meta");
  assert.equal(vectorIndex.getEmbedding(service.all()[0].id).length, 3, "embedding persisted");
});

// --- memory tags (v0.6.2) ---------------------------------------------------

test("GET /api/dsh-mneme/memory/tags returns live tags and the manual gate", async () => {
  const { routes, service } = setup();
  const mem = service.saveWithDedupe({ type: "preference", title: "A", content: "x" }).memory;
  service.setMemoryTags(mem.id, ["bash", "考研"]);
  const route = routes.find((r) => r.path === "/api/dsh-mneme/memory/tags");
  const res = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/memory/tags?id=${mem.id}`), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.tags, ["bash", "考研"], "authoritative entity_attrs tags");
  assert.equal(data.manualTagEnabled, true, "gate defaults on");
});

test("POST /api/dsh-mneme/memory/tags overwrites the tag set", async () => {
  const { routes, service } = setup();
  const mem = service.saveWithDedupe({ type: "preference", title: "A", content: "x" }).memory;
  const route = routes.find((r) => r.path === "/api/dsh-mneme/memory/tags");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/memory/tags", "POST", { id: mem.id, tags: ["linux"] }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.deepEqual(data.tags, ["linux"]);
  assert.deepEqual(service.getMemoryTags(mem.id), ["linux"], "tag set persisted");
});

test("POST /api/dsh-mneme/memory/tags 409s when manualTagEnabled is off", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { manualTagEnabled: false } });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add() {}, remove() {}, list() { return []; } });
  const mem = service.saveWithDedupe({ type: "preference", title: "A", content: "x" }).memory;
  const route = routes.find((r) => r.path === "/api/dsh-mneme/memory/tags");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/memory/tags", "POST", { id: mem.id, tags: ["x"] }), res);
  assert.equal(res.statusCode, 409, "manual tag write rejected");
  assert.match(JSON.parse(res.body).error, /manualTagEnabled/);
  const get = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/memory/tags?id=${mem.id}`), get);
  assert.equal(JSON.parse(get.body).manualTagEnabled, false, "GET reports the gate off");
});
