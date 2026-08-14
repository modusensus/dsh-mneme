import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

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

function setup() {
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
  const api = createApi(ctx, service, settings, commands);
  return { store, service, routes, api, settings };
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
