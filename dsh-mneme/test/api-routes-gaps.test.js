import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

// 覆盖 PR#73 删测后遗留的三个存活 API 空白（v0.7.16 回归补测）：
//   /api/dsh-mneme/delete         面板删记忆（POST + auth + 存在性 404）
//   /api/dsh-mneme/entities       实体目录（只读、limit 夹取）
//   /api/dsh-mneme/external-api   独立服务配置（GET 发 token / PUT 校验）
// 这三个路由在 src/api.js 里一直在跑，只是丢了测试。

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

function setup(apiToken = "") {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken);
  return { store, service, routes, settings };
}

function handler(routes, path) {
  return routes.find((r) => r.path === path);
}

// ---------------------------------------------------------------------------
// /api/dsh-mneme/delete
// ---------------------------------------------------------------------------
test("delete is auth-gated and rejects non-POST", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  // 未带 token → 401
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/delete", "POST", { id: "x" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "unauthorized");

  // 带 token 但 GET → 404
  res = new FakeRes();
  const ok = req("/api/dsh-mneme/delete", "GET");
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
});

test("delete validates id and reports missing/unknown 404", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  // 空 id → 400
  let res = new FakeRes();
  let ok = req("/api/dsh-mneme/delete", "POST", { id: "  " });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "missing-id");

  // 不存在的 id → 404（store.remove 静默，靠前置 getById 区分）
  res = new FakeRes();
  ok = req("/api/dsh-mneme/delete", "POST", { id: "no-such-memory" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "not-found");

  // 确认没被误删
  assert.equal(service.count(), 0);
});

test("delete removes an existing memory", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  const { memory } = service.saveWithDedupe({ type: "project", title: "要删的", content: "删掉我" });
  assert.ok(service.getById(memory.id));

  const res = new FakeRes();
  const ok = req("/api/dsh-mneme/delete", "POST", { id: memory.id });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(service.getById(memory.id), undefined);
  assert.equal(service.count(), 0);
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/entities
// ---------------------------------------------------------------------------
test("entities directory is read-only and returns empty list", async () => {
  const { routes } = setup();
  const route = handler(routes, "/api/dsh-mneme/entities");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/entities"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { entities: [], total: 0 });
});

test("entities lists seeded entities without auth", async () => {
  const { routes, service } = setup("secret-token"); // 有 token 但读路由不校验
  service.createEntity({ name: "SQLite", type: "technology" });
  service.createEntity({ name: "记忆", type: "concept" });

  const route = handler(routes, "/api/dsh-mneme/entities");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/entities"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 2);
  const names = data.entities.map((e) => e.name).sort();
  assert.deepEqual(names, ["SQLite", "记忆"]);
  for (const e of data.entities) {
    assert.ok(e.type, "each entity carries a type");
    assert.ok(Number.isInteger(e.mention_count));
  }
});

test("entities clamps limit to [1, 1000]", async () => {
  const { routes, service } = setup();
  for (let i = 0; i < 5; i++) service.createEntity({ name: `e${i}`, type: "concept" });
  const route = handler(routes, "/api/dsh-mneme/entities");

  // 夹取语义：NaN/0 先被 `|| 500` 兜底成 500（0 不再走 max(1,) 下限），
  // 负数才被夹到 1，超限（>1000）夹到 1000。断言按真实实现收紧。
  for (const [qs, want] of [["limit=abc", 5], ["limit=0", 5], ["limit=-10", 1], ["limit=5000", 5]]) {
    const res = new FakeRes();
    await route.handler(req(`/api/dsh-mneme/entities?${qs}`), res);
    const data = JSON.parse(res.body);
    assert.equal(data.entities.length, want, `${qs} → ${want} (got ${data.entities.length})`);
  }
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/external-api
// ---------------------------------------------------------------------------
test("external-api GET materializes and persists a token", async () => {
  const { routes, settings } = setup();
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res);
  assert.equal(res.statusCode, 200);
  const cfg = JSON.parse(res.body).config;
  assert.ok(typeof cfg.token === "string" && cfg.token.length >= 16, "token is generated");

  // 持久化后二次 GET 返回同一 token
  const res2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res2);
  assert.equal(JSON.parse(res2.body).config.token, cfg.token);
  assert.ok(settings.getExternalApi().token, "token persisted to settings kv");
});

test("external-api PUT requires auth and validates port/host", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  // 未带 token → 401
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api", "PUT", { enabled: true }), res);
  assert.equal(res.statusCode, 401);

  // 端口越界 → 400
  res = new FakeRes();
  let ok = req("/api/dsh-mneme/external-api", "PUT", { port: 70000 });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-port");

  // host 带协议 → 400
  res = new FakeRes();
  ok = req("/api/dsh-mneme/external-api", "PUT", { host: "https://example.com" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-host");
});

test("external-api PUT applies valid config and echoes it", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  const ok = req("/api/dsh-mneme/external-api", "PUT", { enabled: true, port: 8790, host: "127.0.0.1" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200);
  const cfg = JSON.parse(res.body).config;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.port, 8790);
  assert.equal(cfg.host, "127.0.0.1");
  assert.ok(typeof cfg.token === "string");
});
