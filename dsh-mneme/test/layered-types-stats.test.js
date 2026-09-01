import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { TYPE_FILE } from "../src/mirror.js";
import { parseSummaryJson } from "../src/summarize.js";

// v0.8.x: layered memory types (user / fact) + Web panel stats endpoint.
// user = user profile (background/identity), fact = atomic factual statement.
// Both ride the existing single-table `memories` design — only the type enum
// and downstream lists (mirror / tools / summarize / inject) were extended.

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
  const settings = createSettings(store.db);
  const service = createService({ store, mirror: null, config: {}, settings });
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = {
    webServer: {
      register(route) { routes.push(route); return () => {}; }
    }
  };
  createApi(ctx, service, settings, commands, undefined, undefined, "");
  const handler = (path) => routes.find((r) => r.path === path)?.handler;
  return { store, service, handler };
}

test("user/fact are valid memory types for saveWithDedupe", () => {
  const { service } = setup();
  const a = service.saveWithDedupe({ type: "user", title: "桉桉", content: "湖南工业大学学生，考研公共管理学", importance: 5 });
  const b = service.saveWithDedupe({ type: "fact", title: "服务器地址", content: "云服务器 Ubuntu 22.04", importance: 3 });
  assert.equal(a.memory.type, "user");
  assert.equal(b.memory.type, "fact");
  assert.equal(service.count("user"), 1);
  assert.equal(service.count("fact"), 1);
});

test("mirror TYPE_FILE covers user/fact layers", () => {
  assert.equal(TYPE_FILE.user, "user.md");
  assert.equal(TYPE_FILE.fact, "facts.md");
});

test("autoSummarize accepts user/fact types", () => {
  const parsed = parseSummaryJson(
    '[{"type":"user","title":"用户城市","content":"湖南株洲","importance":4},{"type":"fact","title":"端口","content":"23334","importance":3}]'
  );
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((i) => i.type), ["user", "fact"]);
  // legacy types still pass, unknown types rejected
  const mixed = parseSummaryJson(
    '[{"type":"preference","title":"语言","content":"中文","importance":2},{"type":"nonsense","title":"x","content":"y","importance":1}]'
  );
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].type, "preference");
});

test("GET /api/dsh-mneme/list?type=user filters the new layer", async () => {
  const { service, handler } = setup();
  service.saveWithDedupe({ type: "user", title: "桉桉", content: "用户画像", importance: 5 });
  service.saveWithDedupe({ type: "fact", title: "事实", content: "原子事实", importance: 3 });
  const res = new FakeRes();
  await handler("/api/dsh-mneme/list")?.({ url: "/api/dsh-mneme/list?type=user" }, res);
  const data = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].type, "user");
});

test("GET /api/dsh-mneme/stats returns byType distribution + recent trend", async () => {
  const { service, handler } = setup();
  service.saveWithDedupe({ type: "user", title: "桉桉", content: "用户画像", importance: 5 });
  service.saveWithDedupe({ type: "fact", title: "事实1", content: "原子事实", importance: 3 });
  service.saveWithDedupe({ type: "fact", title: "事实2", content: "另一个事实", importance: 2 });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 2 });
  const res = new FakeRes();
  await handler("/api/dsh-mneme/stats")?.({ url: "/api/dsh-mneme/stats?days=7" }, res);
  const data = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(data.byType.user, 1);
  assert.equal(data.byType.fact, 2);
  assert.equal(data.byType.preference, 1);
  assert.equal(data.total, 4);
  // 7-day trend covers today (the only day with live rows)
  assert.equal(data.recent.length, 7);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(data.recent[6].date, today);
  assert.equal(data.recent[6].count, 4);
});

test("stats excludes archived/forgotten memories", async () => {
  const { service, handler } = setup();
  const a = service.saveWithDedupe({ type: "user", title: "桉桉", content: "用户画像", importance: 5 });
  const b = service.saveWithDedupe({ type: "fact", title: "事实", content: "原子事实", importance: 3 });
  service.setArchived(a.memory.id, true);
  service.setForget(b.memory.id, true);
  const res = new FakeRes();
  await handler("/api/dsh-mneme/stats")?.({ url: "/api/dsh-mneme/stats?days=7" }, res);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 0);
});

test("stats clamps days to 1..30", async () => {
  const { handler } = setup();
  const res = new FakeRes();
  await handler("/api/dsh-mneme/stats")?.({ url: "/api/dsh-mneme/stats?days=999" }, res);
  const data = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(data.recent.length, 30);
});

test("stats coerces fractional days to integer (kimi S2)", async () => {
  const { service, handler } = setup();
  service.saveWithDedupe({ type: "fact", title: "事实", content: "原子事实", importance: 3 });
  const res = new FakeRes();
  await handler("/api/dsh-mneme/stats")?.({ url: "/api/dsh-mneme/stats?days=7.5" }, res);
  const data = JSON.parse(res.body);
  assert.equal(data.recent.length, 7); // floor(7.5) → 7, never a ragged 8
  assert.equal(data.days, 7);
  assert.equal(data.byType.fact, 1);
});
