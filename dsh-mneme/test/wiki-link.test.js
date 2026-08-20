// v0.6.1 Wiki-Link（显式跨记忆链接）测试。
// 覆盖：解析器 parseWikiLinks（正常/显示文本/未闭合/空/多链接/非法）/
// resolveWikiLink 大小写匹配 / 存储幂等（同对只写一条、目标不存在跳过）/
// links_to 的 partial 唯一索引（仅 links_to 去重，其余 relation 保持 append-only）/
// saveWikiLinks 幂等 / service 三 API（getBacklinks/getForwardLinks/
// resolveWikiLink）与 saveWithDedupe 的 wikiLinkEnabled hook / 三个只读 HTTP 端点。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { parseWikiLinks } from "../src/parser/wiki-link.js";

function openStore() {
  return createStore(":memory:");
}

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

/** Let fire-and-forget enqueue tasks (wiki-link resolve) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function seed(service, title, content, type = "preference") {
  return service.saveWithDedupe({ type, title, content, importance: 3 }).memory;
}

// ============================================================ parser

test("parseWikiLinks: plain [[target]] returns display=target", () => {
  assert.deepEqual(parseWikiLinks("看看 [[Alpha]] 这篇"), [
    { display: "Alpha", target: "Alpha" }
  ]);
});

test("parseWikiLinks: [[显示|target]] keeps display text separate from target", () => {
  assert.deepEqual(parseWikiLinks("参考 [[精彩解读|Alpha]] 一文"), [
    { display: "精彩解读", target: "Alpha" }
  ]);
});

test("parseWikiLinks: unclosed [[ marker is ignored", () => {
  assert.deepEqual(parseWikiLinks("这里有个没闭合的 [[Alpha"), []);
  assert.deepEqual(parseWikiLinks("[[Alpha] 只有一个括号"), []);
});

test("parseWikiLinks: empty targets are ignored", () => {
  assert.deepEqual(parseWikiLinks("[[]]"), []);
  assert.deepEqual(parseWikiLinks("[[   ]]"), []);
  assert.deepEqual(parseWikiLinks("[[显示|]]"), []);
  assert.deepEqual(parseWikiLinks("[[|]]"), []);
});

test("parseWikiLinks: multiple links are all returned in order", () => {
  const links = parseWikiLinks("[[A]] 与 [[B]] 以及 [[C|D]]");
  assert.deepEqual(links, [
    { display: "A", target: "A" },
    { display: "B", target: "B" },
    { display: "C", target: "D" }
  ]);
});

test("parseWikiLinks: multi-pipe and bracket-nested markers are illegal", () => {
  assert.deepEqual(parseWikiLinks("[[a|b|c]]"), [], "multi-pipe skipped");
  assert.deepEqual(parseWikiLinks("[[a [[b]] c]]"), [
    { display: "b", target: "b" }
  ], "only the well-formed inner [[b]] is kept");
});

test("parseWikiLinks: non-string / empty content returns []", () => {
  assert.deepEqual(parseWikiLinks(""), []);
  assert.deepEqual(parseWikiLinks(undefined), []);
  assert.deepEqual(parseWikiLinks(null), []);
  assert.deepEqual(parseWikiLinks("没有链接的普通文本"), []);
});

test("parseWikiLinks: display falls back to target when the display side is empty", () => {
  assert.deepEqual(parseWikiLinks("[[|Beta]]"), [
    { display: "Beta", target: "Beta" }
  ]);
});

// ============================================================ storage

test("partial unique index on links_to (from_entity,to_entity) is created", () => {
  const store = openStore();
  const idx = store.db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_relations_wikilink'"
  ).get();
  assert.ok(idx, "idx_relations_wikilink exists");
  assert.match(idx.sql, /WHERE relation_type = 'links_to'/i,
    "index is partial — scoped to links_to only");
  const fullUnique = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_relations_unique'"
  ).get();
  assert.ok(!fullUnique, "no full-table unique index (keeps other types append-only)");
  store.close();
});

test("saveWikiLinks: same target pair writes exactly one row (idempotent)", () => {
  const store = openStore();
  const a = store.save({ type: "preference", title: "Alpha", content: "c", tags: [] });
  store.save({ type: "project", title: "Beta", content: "c", tags: [] });
  const r1 = store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["Beta"] });
  const r2 = store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["Beta"] });
  assert.equal(r1.saved.length, 1);
  assert.equal(r2.saved.length, 0, "second call is a no-op");
  assert.deepEqual(r2.skipped, []);
  const rels = store.getRelations(a.title).filter((r) => r.relation_type === "links_to");
  assert.equal(rels.length, 1, "one links_to row total");
  assert.equal(rels[0].from_entity, "Alpha");
  assert.equal(rels[0].to_entity, "Beta");
  assert.equal(rels[0].memory_id, a.id);
  store.close();
});

test("saveWikiLinks: missing target is skipped, not an error (fail-safe)", () => {
  const store = openStore();
  const a = store.save({ type: "preference", title: "Alpha", content: "c", tags: [] });
  store.save({ type: "project", title: "Beta", content: "c", tags: [] });
  const r = store.saveWikiLinks({
    memoryId: a.id,
    title: a.title,
    targets: ["不存在", "Beta"]
  });
  assert.equal(r.saved.length, 1);
  assert.deepEqual(r.skipped, ["不存在"]);
  store.close();
});

test("saveWikiLinks: target title matches case-insensitively", () => {
  const store = openStore();
  const a = store.save({ type: "preference", title: "Alpha", content: "c", tags: [] });
  const b = store.save({ type: "project", title: "Beta", content: "c", tags: [] });
  const r = store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["BETA"] });
  assert.equal(r.saved.length, 1, "lowercase target resolves the mixed-case title");
  assert.equal(r.skipped.length, 0);
  const rel = store.getRelations(a.title).find((x) => x.relation_type === "links_to");
  assert.ok(rel, "relation written");
  // resolved target memory carried in metadata
  assert.equal(rel.metadata?.target_memory_id, b.id);
  store.close();
});

test("saveRelation stays append-only for non-links_to (preserves extractor/dream semantics)", () => {
  const store = openStore();
  store.saveRelation({ from_entity: "X", to_entity: "Y", relation_type: "uses" });
  store.saveRelation({ from_entity: "X", to_entity: "Y", relation_type: "uses" });
  // two rows — not deduped. (saveRelation's return is a SELECT LIMIT 1, so it
  // always yields the first matching row; the row count is the real signal.)
  assert.equal(store.getRelations("X").filter((r) => r.relation_type === "uses").length, 2);
  store.close();
});

test("partial unique index dedups links_to at the DB level", () => {
  const store = openStore();
  store.saveRelation({ from_entity: "A", to_entity: "B", relation_type: "links_to" });
  assert.throws(
    () => store.saveRelation({ from_entity: "A", to_entity: "B", relation_type: "links_to" }),
    /UNIQUE constraint failed/,
    "second links_to for the same pair is rejected by idx_relations_wikilink"
  );
  store.close();
});

// ============================================================ service read APIs

test("service.getForwardLinks returns target memories the memory links to", () => {
  const { store, service } = makeService({ wikiLinkEnabled: true });
  const a = seed(service, "Alpha", "参见 [[Beta]]", "preference");
  const b = seed(service, "Beta", "正文", "project");
  const rel = store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["Beta"] });
  assert.equal(rel.saved.length, 1);
  const links = service.getForwardLinks(a.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].target.id, b.id);
  assert.equal(links[0].target.title, "Beta");
  assert.equal(links[0].relation.relation_type, "links_to");
  store.close();
});

test("service.getBacklinks returns source memories that link to a memory", () => {
  const { store, service } = makeService({ wikiLinkEnabled: true });
  const a = seed(service, "Alpha", "参见 [[Beta]]", "preference");
  const b = seed(service, "Beta", "正文", "project");
  store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["beta"] }); // case-insensitive resolve
  const backlinks = service.getBacklinks(b.id);
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0].source.id, a.id);
  assert.equal(backlinks[0].source.title, "Alpha");
  store.close();
});

test("service.resolveWikiLink matches titles case-insensitively", () => {
  const { store, service } = makeService();
  store.save({ type: "project", title: "Beta", content: "c", tags: [] });
  const mem = service.resolveWikiLink("BETA");
  assert.ok(mem, "resolved");
  assert.equal(mem.title, "Beta");
  assert.equal(service.resolveWikiLink("不存在"), undefined);
  store.close();
});

// ============================================================ service hook

test("saveWithDedupe resolves [[wiki-links]] when wikiLinkEnabled=true", async () => {
  const { store, service } = makeService({ wikiLinkEnabled: true });
  seed(service, "Beta", "正文", "project");
  seed(service, "Alpha", "参见 [[Beta]] 和 [[不存在]]", "preference");
  await flush(); // fire-and-forget enqueue task settles
  const rels = store.getRelations("Alpha").filter((r) => r.relation_type === "links_to");
  assert.equal(rels.length, 1, "Beta resolved; 不存在 skipped");
  assert.equal(rels[0].to_entity, "Beta");
  store.close();
});

test("saveWithDedupe writes no links_to when wikiLinkEnabled=false (default)", async () => {
  const { store, service } = makeService();
  seed(service, "Beta", "正文", "project");
  seed(service, "Alpha", "参见 [[Beta]]", "preference");
  await flush();
  assert.equal(store.getRelations("Alpha").filter((r) => r.relation_type === "links_to").length, 0);
  store.close();
});

test("service.update re-resolves [[wiki-links]] for edited content", async () => {
  const { store, service } = makeService({ wikiLinkEnabled: true });
  seed(service, "Beta", "正文", "project");
  const a = seed(service, "Alpha", "暂无链接", "preference");
  service.update(a.id, { content: "现在指向 [[Beta]]" });
  await flush();
  const rels = store.getRelations("Alpha").filter((r) => r.relation_type === "links_to");
  assert.equal(rels.length, 1);
  assert.equal(rels[0].to_entity, "Beta");
  store.close();
});

// ============================================================ HTTP endpoints

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path) {
  const r = new EventEmitter();
  r.url = path;
  r.method = "GET";
  r.headers = {};
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
  return { store, service, routes };
}

function wikiRoute(routes, path) {
  return routes.find((r) => r.path === path);
}

test("three wiki-link endpoints are registered and open without apiToken", async () => {
  const { routes } = setup("secret-token");
  for (const p of [
    "/api/dsh-mneme/wikilinks/backlinks",
    "/api/dsh-mneme/wikilinks/forward",
    "/api/dsh-mneme/wikilinks/resolve"
  ]) {
    assert.ok(wikiRoute(routes, p), `${p} registered`);
  }
  // read-only: missing param is a 400, never a 401
  const back = wikiRoute(routes, "/api/dsh-mneme/wikilinks/backlinks");
  const res = new FakeRes();
  await back.handler(req("/api/dsh-mneme/wikilinks/backlinks"), res);
  assert.equal(res.statusCode, 400);
});

test("GET backlinks returns linking source memories", async () => {
  const { routes, store, service } = setup();
  const a = seed(service, "Alpha", "参见 [[Beta]]", "preference");
  const b = seed(service, "Beta", "正文", "project");
  store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["Beta"] });
  const route = wikiRoute(routes, "/api/dsh-mneme/wikilinks/backlinks");
  const res = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/wikilinks/backlinks?id=${b.id}`), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.memoryId, b.id);
  assert.equal(data.backlinks.length, 1);
  assert.equal(data.backlinks[0].title, "Alpha");
  assert.equal(data.backlinks[0].id, a.id);
});

test("GET forward links returns target memories", async () => {
  const { routes, store, service } = setup();
  const a = seed(service, "Alpha", "参见 [[Beta]]", "preference");
  const b = seed(service, "Beta", "正文", "project");
  store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["Beta"] });
  const route = wikiRoute(routes, "/api/dsh-mneme/wikilinks/forward");
  const res = new FakeRes();
  await route.handler(req(`/api/dsh-mneme/wikilinks/forward?id=${a.id}`), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.links.length, 1);
  assert.equal(data.links[0].title, "Beta");
  assert.equal(data.links[0].id, b.id);
});

test("GET resolve matches title case-insensitively and 404s when absent", async () => {
  const { routes, store, service } = setup();
  store.save({ type: "project", title: "Beta", content: "c", tags: [] });
  const route = wikiRoute(routes, "/api/dsh-mneme/wikilinks/resolve");
  const ok = new FakeRes();
  await route.handler(req("/api/dsh-mneme/wikilinks/resolve?title=BETA"), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).memory.title, "Beta");
  const missing = new FakeRes();
  await route.handler(req("/api/dsh-mneme/wikilinks/resolve?title=nope"), missing);
  assert.equal(missing.statusCode, 404);
});
