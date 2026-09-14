import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

// v0.8.0 A3（issue #17）→ v0.8.1 第 3 步（issue #170 4.3，作者已确认）：
// strictScope 硬过滤只认显式声明。可见性公式收窄为：记忆可见 ⇔ 对每一维
// （该维标注存在且来源=explicit 时：命中当前会话）AND。
//   - explicit 行为硬墙：他者维度不可见（含 memory_get 无存在性泄漏）；
//   - auto / 存量 NULL 来源（v0.8.0 自动标注）不进硬过滤，只吃 A2 软加权
//     （foreign ×0.5 保留可见）；
//   - 当前会话维度解析不到 → 该维 explicit 行一律不可见（fail-closed 收窄）。

function setup(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

test("visibility predicate: explicit rows keep four-quadrant semantics", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const me = { agent_scope: "coder", workspace_scope: "D:\\p" };
  const E = "explicit";

  // 全局（未标注）对谁都可见。
  assert.equal(vis({}, me), true);
  // agent 专属：同 agent 任意 workspace 可见，他人不可见。
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: E }, me), true);
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: E }, me), false);
  // workspace 专属：同 workspace 任意 agent 可见，别的 workspace 不可见。
  assert.equal(vis({ workspace_scope: "D:\\p", workspace_scope_source: E }, me), true);
  assert.equal(vis({ workspace_scope: "D:\\q", workspace_scope_source: E }, me), false);
  // 双标注：精确命中才可见。
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: E, workspace_scope: "D:\\p", workspace_scope_source: E }, me), true);
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: E, workspace_scope: "D:\\q", workspace_scope_source: E }, me), false);
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: E, workspace_scope: "D:\\p", workspace_scope_source: E }, me), false);
});

test("visibility predicate: auto and legacy rows are NOT hard walls (soft only)", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const me = { agent_scope: "coder", workspace_scope: "D:\\p" };

  // auto（v0.8.1 载体自动标注）与存量 NULL 来源（v0.8.0 自动标注）他者维度
  // 也可见——硬过滤只认 explicit。
  assert.equal(vis({ agent_scope: "novelist" }, me), true, "legacy NULL source");
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: "auto" }, me), true);
  assert.equal(vis({ workspace_scope: "D:\\q", workspace_scope_source: "auto" }, me), true);
  // 混合：agent 维 auto + workspace 维 explicit → 只 workspace 维构成硬墙。
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: "auto", workspace_scope: "D:\\q", workspace_scope_source: "explicit" }, me), false);
  assert.equal(vis({ agent_scope: "novelist", agent_scope_source: "explicit", workspace_scope: "D:\\q", workspace_scope_source: "auto" }, me), false);
});

test("visibility predicate: anonymous session fail-closes only explicit rows", () => {
  const { service } = setup({ scopeEnabled: true, strictScope: true });
  const vis = service.isVisibleInScope;
  const anon = { agent_scope: null, workspace_scope: null };
  assert.equal(vis({}, anon), true);
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: "explicit" }, anon), false);
  assert.equal(vis({ workspace_scope: "D:\\p", workspace_scope_source: "explicit" }, anon), false);
  // auto/存量行照常可见（不冒认，但也不因身份缺失误杀软标注）。
  assert.equal(vis({ agent_scope: "coder" }, anon), true);
  assert.equal(vis({ agent_scope: "coder", agent_scope_source: "auto" }, anon), true);
});

test("searchMemories: explicit foreign filtered, auto/legacy foreign stay visible under strictScope", async () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "project", title: "global needle", content: "x" });
  store.save({ type: "project", title: "mine needle", content: "x", agent_scope: "me", agent_scope_source: "explicit" });
  store.save({ type: "project", title: "explicit foreign needle", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "project", title: "auto foreign needle", content: "x", agent_scope: "other", agent_scope_source: "auto" });
  store.save({ type: "project", title: "legacy foreign needle", content: "x", agent_scope: "other" });

  const rows = await service.searchMemories("needle", {
    mode: "keyword",
    scope: { agent_scope: "me", workspace_scope: null }
  });
  // explicit 他者出局；auto/存量他者保留（A2 降权仍可见）；未标注与命中行保留。
  assert.deepEqual(rows.map((m) => m.title).sort(), [
    "auto foreign needle", "global needle", "legacy foreign needle", "mine needle"
  ]);
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

test("store.list/count visibility: explicit hard wall + auto/legacy pass, consistent totals", () => {
  const { store } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "g", content: "x" });
  store.save({ type: "decision", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit", workspace_scope: "D:\\p", workspace_scope_source: "explicit" });
  store.save({ type: "decision", title: "theirs-explicit", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "theirs-auto", content: "x", agent_scope: "other", agent_scope_source: "auto" });
  store.save({ type: "decision", title: "theirs-legacy", content: "x", agent_scope: "other" });
  store.save({ type: "decision", title: "other-ws-explicit", content: "x", workspace_scope: "D:\\q", workspace_scope_source: "explicit" });

  const vis = { agentScope: "me", workspaceScope: "D:\\p" };
  const titles = store.list({ visibility: vis }).map((m) => m.title).sort();
  assert.deepEqual(titles, ["g", "mine", "theirs-auto", "theirs-legacy"]);
  assert.equal(store.count("decision", { visibility: vis }), 4);

  // 匿名会话：explicit 行全出局，auto/存量/未标注放行。
  const anonTitles = store.list({ visibility: { agentScope: null, workspaceScope: null } }).map((m) => m.title).sort();
  assert.deepEqual(anonTitles, ["g", "theirs-auto", "theirs-legacy"]);
  assert.equal(store.count("decision", { visibility: { agentScope: null, workspaceScope: null } }), 3);
});

test("injectCandidates hard-filters explicit foreign rows when strictScope is on", () => {
  const { store, service } = setup({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "global", content: "x", importance: 4 });
  store.save({ type: "decision", title: "foreign", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "auto-foreign", content: "x", importance: 4, agent_scope: "other", agent_scope_source: "auto" });

  const injected = service.injectCandidates({
    maxItems: 5,
    threshold: 3,
    scope: { agent_scope: "me", workspace_scope: null }
  });
  assert.deepEqual(injected.map((m) => m.title).sort(), ["auto-foreign", "global"]);

  // flag 下（scope 不传）→ 他 scope 照常注入（A2 前行为）。
  const unscoped = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(unscoped.map((m) => m.title).sort(), ["auto-foreign", "foreign", "global"]);
});

test("memory_update/memory_delete hide explicit foreign-scope rows under strictScope (review item 4, aligned with memory_get)", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  const autoTheirs = store.save({ type: "pitfall", title: "auto-theirs", content: "c", agent_scope: "other", agent_scope_source: "auto" });
  const update = pick("memory_update");
  const del = pick("memory_delete");

  // explicit 他 scope：update 按不存在拒绝、delete 视作不存在——不能凭 id 直改直删。
  await assert.rejects(() => runHandler(update, { id: theirs.id, content: "tampered" }, STRICT_EXEC), /memory not found/);
  assert.equal(store.getById(theirs.id).content, "c", "row untouched by the rejected update");
  const delOut = await runHandler(del, { id: theirs.id }, STRICT_EXEC);
  assert.equal(delOut.deleted, false, "delete treats invisible rows as absent (no existence leak)");
  assert.ok(store.getById(theirs.id), "row NOT deleted");

  // auto 他 scope：不构成硬墙，照常可改（与 get 的可见性口径一致）。
  const updAuto = await runHandler(update, { id: autoTheirs.id, content: "updated" }, STRICT_EXEC);
  assert.equal(updAuto.memory.id, autoTheirs.id);

  // 行主人自己照常可改。
  const ownerOut = await runHandler(update, { id: theirs.id, content: "owner edit" }, OTHER_EXEC);
  assert.equal(ownerOut.memory.id, theirs.id);

  // strictScope 关：update/delete 不做可见性校验（管理语义回归）。
  const { store: store2, pick: pick2 } = setupTools({ scopeEnabled: true });
  const t2 = store2.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  await runHandler(pick2("memory_update"), { id: t2.id, content: "edited" }, STRICT_EXEC);
  assert.equal(store2.getById(t2.id).content, "edited");
  const del2 = await runHandler(pick2("memory_delete"), { id: t2.id }, STRICT_EXEC);
  assert.equal(del2.deleted, true);
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

const STRICT_EXEC = { agent: { session: { id: "s1", header: { agentPreset: "me", cwd: "D:\\p" } } } };
const OTHER_EXEC = { agent: { session: { id: "s2", header: { agentPreset: "other", cwd: "D:\\q" } } } };

test("memory_get hides explicit foreign-scope rows under strictScope, resolvable for the owner", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  const mine = store.save({ type: "pitfall", title: "mine", content: "c", agent_scope: "me", agent_scope_source: "explicit" });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  const autoTheirs = store.save({ type: "pitfall", title: "auto-theirs", content: "c", agent_scope: "other", agent_scope_source: "auto" });
  const get = pick("memory_get");

  const out = await runHandler(get, { id: mine.id }, STRICT_EXEC);
  assert.equal(out.memory.title, "mine");

  // explicit 他 scope → 按不存在处理（无存在性泄漏）。
  await assert.rejects(() => runHandler(get, { id: theirs.id }, STRICT_EXEC), /memory not found/);
  // auto 他 scope → 可见（软加权不进硬过滤）。
  const autoOut = await runHandler(get, { id: autoTheirs.id }, STRICT_EXEC);
  assert.equal(autoOut.memory.title, "auto-theirs");
  // 行主人自己照常可取。
  const ownerOut = await runHandler(get, { id: theirs.id }, OTHER_EXEC);
  assert.equal(ownerOut.memory.title, "theirs");
});

test("memory_get without strictScope returns any row regardless of scope annotation", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true });
  const theirs = store.save({ type: "pitfall", title: "theirs", content: "c", agent_scope: "other", agent_scope_source: "explicit" });
  const get = pick("memory_get");
  const out = await runHandler(get, { id: theirs.id }, STRICT_EXEC);
  assert.equal(out.memory.title, "theirs");
});

test("memory_list filters explicit rows and keeps total consistent under strictScope", async () => {
  const { store, pick } = setupTools({ scopeEnabled: true, strictScope: true });
  store.save({ type: "decision", title: "g", content: "x" });
  store.save({ type: "decision", title: "mine", content: "x", agent_scope: "me", agent_scope_source: "explicit" });
  store.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const list = pick("memory_list");

  const out = await runHandler(list, { type: "decision" }, STRICT_EXEC);
  assert.deepEqual(out.items.map((m) => m.title).sort(), ["g", "mine"]);
  assert.equal(out.total, 2);

  // flag 关（A2 默认）：他 scope 的行照常出现在浏览视图。
  const { store: store2, pick: pick2 } = setupTools({ scopeEnabled: true });
  store2.save({ type: "decision", title: "theirs", content: "x", agent_scope: "other", agent_scope_source: "explicit" });
  const out2 = await runHandler(pick2("memory_list"), { type: "decision" }, STRICT_EXEC);
  assert.deepEqual(out2.items.map((m) => m.title), ["theirs"]);
  assert.equal(out2.total, 1);
});
