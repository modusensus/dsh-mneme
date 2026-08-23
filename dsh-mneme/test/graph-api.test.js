import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

// Ego-graph read API (graph panel P1). The routes under test:
//   GET /api/dsh-mneme/semantic/graph/ego?entity=&depth=&limit=
//   GET /api/dsh-mneme/semantic/graph/entity-attrs?entity=
// Both are read-only: they must stay reachable without an apiToken, exactly
// like list/search/semantic.

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

function graphRoute(routes, path) {
  return routes.find((r) => r.path === path);
}

function buildChain(service, names, linkType = "related_to") {
  // names → entities; each consecutive pair gets one relation. Returns a
  // name→entity map so tests can assert on ids.
  const map = new Map();
  for (const n of names) map.set(n, service.createEntity({ name: n, type: "concept" }));
  for (let i = 0; i < names.length - 1; i++) {
    service.saveRelation({
      from_entity: map.get(names[i]).id,
      to_entity: map.get(names[i + 1]).id,
      relation_type: linkType
    });
  }
  return map;
}

test("ego route is registered and open without apiToken", async () => {
  const { routes } = setup("secret-token");
  const ego = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const attrs = graphRoute(routes, "/api/dsh-mneme/semantic/graph/entity-attrs");
  assert.ok(ego, "ego route must be registered");
  assert.ok(attrs, "entity-attrs route must be registered");
  // read-only: no 401 even with a token configured
  const res = new FakeRes();
  await ego.handler(req("/api/dsh-mneme/semantic/graph/ego"), res);
  assert.equal(res.statusCode, 400, "missing param is a 400, not a 401");
});

test("ego depth 1 returns root + direct neighbors with distances", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B", "C"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=1"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.root.name, "A");
  assert.equal(data.nodes.length, 2, "root + B only (C is 2 hops)");
  assert.equal(data.edges.length, 1);
  const b = data.nodes.find((n) => n.name === "B");
  assert.equal(b.distance, 1);
  assert.equal(data.nodes.find((n) => n.name === "A").distance, 0);
  // edge shape: ids + relation_type, memory_id nullable
  const edge = data.edges[0];
  assert.ok(edge.id && edge.from && edge.to);
  assert.equal(edge.relation_type, "related_to");
  assert.equal(edge.memory_id, null);
});

test("ego depth 2 includes 2-hop nodes, not 3-hop", async () => {
  const { routes, service } = setup();
  buildChain(service, ["A", "B", "C", "D"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=2"), res);
  const data = JSON.parse(res.body);
  const names = data.nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ["A", "B", "C"], "D is 3 hops away and must be excluded");
  assert.equal(data.nodes.find((n) => n.name === "C").distance, 2);
  assert.equal(data.edges.length, 2);
});

test("ego respects limit and keeps only in-graph edges", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B", "C"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=2&limit=2"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.length, 2, "limit caps node count");
  assert.equal(data.edges.length, 1, "edges to cut nodes are dropped");
});

test("ego reports 404 for unknown entity and 400 without entity", async () => {
  const { routes } = setup();
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=ghost"), res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "entity-not-found");
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "missing-entity");
});

test("entity-attrs returns current valid attrs only", async () => {
  const { routes, service } = setup();
  const mem = service.saveWithDedupe({ type: "project", title: "t", content: "c" });
  const entity = service.createEntity({ name: "X", type: "technology" });
  service.saveAttr({ entity_id: entity.id, attr_key: "version", attr_value: "1", memory_id: mem.id, confidence: 0.9 });
  // a second save of the same key invalidates the first: only one row stays valid
  service.saveAttr({ entity_id: entity.id, attr_key: "version", attr_value: "2", memory_id: mem.id, confidence: 0.8 });
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/entity-attrs");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs?entity=X"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.entity.name, "X");
  assert.equal(data.attrs.length, 1);
  assert.equal(data.attrs[0].value, "2", "latest valid attr wins");
  assert.equal(data.attrs[0].confidence, 0.8);
  // unknown / missing entity
  let r2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs?entity=nope"), r2);
  assert.equal(r2.statusCode, 404);
  r2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs"), r2);
  assert.equal(r2.statusCode, 400);
});

test("ego 2-hop over 100+ nodes stays under 50ms (spec §7)", async () => {
  const { routes, service } = setup();
  // star-of-stars: hub → 20 spokes, each spoke → 5 leaves = 121 nodes, 120 edges
  const hub = service.createEntity({ name: "hub", type: "project" });
  for (let i = 0; i < 20; i++) {
    const spoke = service.createEntity({ name: `spoke-${i}`, type: "technology" });
    service.saveRelation({ from_entity: hub.id, to_entity: spoke.id, relation_type: "uses" });
    for (let j = 0; j < 5; j++) {
      const leaf = service.createEntity({ name: `leaf-${i}-${j}`, type: "concept" });
      service.saveRelation({ from_entity: spoke.id, to_entity: leaf.id, relation_type: "related_to" });
    }
  }
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  const start = process.hrtime.bigint();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=hub&depth=2&limit=100"), res);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.length, 100, "limit caps the traversal");
  assert.ok(data.edges.length > 0);
  assert.ok(ms < 50, `2-hop query took ${ms.toFixed(1)}ms, spec budget is 50ms`);
});

test("ego node heat projects from linked memory heat (v0.7.0)", async () => {
  const { routes, service } = setup();
  const mem = service.saveWithDedupe({ type: "history", title: "test", content: "test entity heat", importance: 3 });
  const entity = service.createEntity({ name: "E", type: "project" });
  service.saveRelation({ from_entity: entity.id, to_entity: entity.id, relation_type: "evidence", memory_id: mem.memory.id });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/graph/ego");
  assert.ok(route, "ego route exists");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=E"), res);
  const data = JSON.parse(res.body);
  const node = data.nodes.find((n) => n.name === "E");
  assert.ok(typeof node.heat === "number" && node.heat >= 0 && node.heat <= 1, "entity node has a heat value");
  assert.equal(node.heat, 1, "fresh memory -> heat 1.0 -> entity heat 1.0");
});

test("ego node heat is null when heatEnabled=false (v0.7.0)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { heatEnabled: false } });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, "");
  const mem = service.saveWithDedupe({ type: "history", title: "关联记忆", content: "实体关联", importance: 3 });
  const entity = service.createEntity({ name: "F", type: "project" });
  service.saveRelation({ from_entity: entity.id, to_entity: entity.id, relation_type: "evidence", memory_id: mem.memory.id });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=F"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.find((n) => n.name === "F").heat, null, "heat disabled → entity heat is null");
  store.close();
});
