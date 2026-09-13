import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

// v0.8.0 A3（issue #17）：strictScope 硬过滤 + agent 不对称可见性。
// 四象限公式：记忆可见 ⇔ (agent 维未标注或命中) AND (workspace 维未标注或命中)；
// 当前会话维度解析不到时该维度带标注的记忆不可见（fail-closed）。

function setup(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

test("visibility predicate: four-quadrant semantics", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const me = { agent_scope: "coder", workspace_scope: "D:\\p" };

  // 全局（未标注）对谁都可见。
  assert.equal(vis({}, me), true);
  // agent 专属：同 agent 任意 workspace 可见，他人不可见。
  assert.equal(vis({ agent_scope: "coder" }, me), true);
  assert.equal(vis({ agent_scope: "novelist" }, me), false);
  // workspace 专属：同 workspace 任意 agent 可见，别的 workspace 不可见。
  assert.equal(vis({ workspace_scope: "D:\\p" }, me), true);
  assert.equal(vis({ workspace_scope: "D:\\q" }, me), false);
  // 双标注：精确命中才可见。
  assert.equal(vis({ agent_scope: "coder", workspace_scope: "D:\\p" }, me), true);
  assert.equal(vis({ agent_scope: "coder", workspace_scope: "D:\\q" }, me), false);
  assert.equal(vis({ agent_scope: "novelist", workspace_scope: "D:\\p" }, me), false);
});

test("visibility predicate: anonymous session sees only unscoped rows (fail-closed)", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const anon = { agent_scope: null, workspace_scope: null };
  assert.equal(vis({}, anon), true);
  assert.equal(vis({ agent_scope: "coder" }, anon), false);
  assert.equal(vis({ workspace_scope: "D:\\p" }, anon), false);
});

test("searchMemories hard-filters foreign scopes when strictScope is on", async () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "project", title: "global needle", content: "x" });
  store.save({ type: "project", title: "mine needle", content: "x", agent_scope: "me" });
  store.save({ type: "project", title: "foreign needle", content: "x", agent_scope: "other" });

  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "me", workspace_scope: null }
  });
  // 他 scope 直接出局（区别于 A2 的降权保留可见）；未标注与命中行保留。
  assert.deepEqual(rows.map((m) => m.title).sort(), ["global needle", "mine needle"]);
});

test("strictScope off keeps A2 behavior: foreign rows demoted but visible", async () => {
  const { store, service } = setup({ scopeEnabled: true });
  store.save({ type: "project", title: "foreign needle", content: "x", agent_scope: "other" });
  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "me", workspace_scope: null }
  });
  assert.deepEqual(rows.map((m) => m.title), ["foreign needle"]);
});

test("store.list/count visibility option filters in SQL with consistent totals", () => {
  const { store } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "g", content: "x" });
  store.save({ type: "decision", title: "mine", content: "x", agent_scope: "me", workspace_scope: "D:\\p" });
  store.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other" });
  store.save({ type: "decision", title: "other-ws", content: "x", workspace_scope: "D:\\q" });

  const vis = { agentScope: "me", workspaceScope: "D:\\p" };
  const titles = store.list({ visibility: vis }).map((m) => m.title).sort();
  assert.deepEqual(titles, ["g", "mine"]);
  assert.equal(store.count("decision", { visibility: vis }), 2);

  // 匿名会话（维度解析不到）：只放行未标注行。
  const anonTitles = store.list({ visibility: { agentScope: null, workspaceScope: null } }).map((m) => m.title);
  assert.deepEqual(anonTitles, ["g"]);
});

test("injectCandidates hard-filters scoped rows when strictScope is on", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "global", content: "x", importance: 4 });
  store.save({ type: "decision", title: "foreign", content: "x", importance: 4, agent_scope: "other" });

  const injected = service.injectCandidates({
    maxItems: 5,
    threshold: 3,
    scope: { agent_scope: "me", workspace_scope: null }
  });
  assert.deepEqual(injected.map((m) => m.title), ["global"]);

  // flag 下（scope 不传）→ 他 scope 照常注入（A2 前行为）。
  const unscoped = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(unscoped.map((m) => m.title).sort(), ["foreign", "global"]);
});

function setupTools(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const registered = [];
  createTools(
    { tools: { register(def) { registered.push(def); return () => {}; } } },
    service,
    config
  );
  const pick = (name) => registered.find((def) => def.name === name);
  return { store, pick };
}

async function runHandler(def, args, exec) {
  const handler = def.execute.bind(def);
  return handler(args, exec);
}

const STRICT_EXEC = { agent: { session: { id: "s1", requestHeader: () => ({ agentPreset: "me", cwd: "D:\\p" }) } } };
const OTHER_EXEC = { agent: { session: { id: "s2", requestHeader: () => ({ agentPreset: "other", cwd: "D:\\q" }) } } };

test("memory_get hides foreign-scope rows under strictScope, resolvable for the owner", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  const mine = store.save({ type: "pitfall", title: "mine", content: "c", agent_scope: "me" });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other" });
  const get = pick("memory_get");

  const out = await runHandler(get, { id: mine.id }, STRICT_EXEC);
  assert.equal(out.memory.title, "mine");

  // 他 scope → 按不存在处理（无存在性泄漏）。
  await assert.rejects(() => runHandler(get, { id: theirs.id }, STRICT_EXEC), /memory not found/);
  // 行主人自己照常可取。
  const ownerOut = await runHandler(get, { id: theirs.id }, OTHER_EXEC);
  assert.equal(ownerOut.memory.title, "theirs");
});

test("memory_get without strictScope returns any row regardless of scope annotation", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other" });
  const get = pick("memory_get");
  const out = await runHandler(get, { id: theirs.id }, STRICT_EXEC);
  assert.equal(out.memory.title, "theirs");
});

test("memory_list filters rows and keeps total consistent under strictScope", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "g", content: "x" });
  store.save({ type: "decision", title: "mine", content: "x", agent_scope: "me" });
  store.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other" });
  const list = pick("memory_list");

  const out = await runHandler(list, { type: "decision" }, STRICT_EXEC);
  assert.deepEqual(out.items.map((m) => m.title).sort(), ["g", "mine"]);
  assert.equal(out.total, 2);

  // flag 关（A2 默认）：他 scope 的行照常出现在浏览视图。
  const { store: store2, pick: pick2 } = setupTools({ scopeEnabled: true });
  store2.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other" });
  const out2 = await runHandler(pick2("memory_list"), { type: "decision" }, STRICT_EXEC);
  assert.deepEqual(out2.items.map((m) => m.title), ["theirs"]);
  assert.equal(out2.total, 1);
});
