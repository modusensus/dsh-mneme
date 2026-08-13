import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions, applyDecisions } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

function snapshot(ids) {
  return new Map(ids.map((id, i) => [id, { id, type: i % 2 ? "project" : "preference", title: `t${i}`, content: `c${i}`, importance: 3, archived: false, forgotten: false }]));
}

test("valid decision list passes", () => {
  const snap = snapshot(["a", "b", "c"]);
  const decisions = [
    { action: "keep", ids: ["a"], reason: "ok" },
    { action: "merge", ids: ["b", "c"], title: "bc", content: "merged", importance: 4, keepSource: "b" }
  ];
  const { ok, errors } = validateDecisions(decisions, snap);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("unknown id rejects whole list", () => {
  const snap = snapshot(["a"]);
  const { ok, errors } = validateDecisions([{ action: "archive", ids: ["zzz"], reason: "x" }], snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("zzz")));
});

test("invalid action rejects", () => {
  const snap = snapshot(["a"]);
  const { ok } = validateDecisions([{ action: "explode", ids: ["a"] }], snap);
  assert.equal(ok, false);
});

test("merge keepSource must be in ids", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([{ action: "merge", ids: ["a"], keepSource: "b", title: "t", content: "c" }], snap);
  assert.equal(ok, false);
});

test("conflict winner and loser must exist and differ", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([{ action: "conflict", winner: "a", loser: "a" }], snap);
  assert.equal(ok, false);
  const { ok: ok2 } = validateDecisions([{ action: "conflict", winner: "a", loser: "zzz" }], snap);
  assert.equal(ok2, false);
});

test("duplicate primary ids across decisions reject", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([
    { action: "archive", ids: ["a"] },
    { action: "keep", ids: ["a"] }
  ], snap);
  assert.equal(ok, false, "a claimed twice");
});

test("archived or summary entries cannot be decision targets", () => {
  const snap = new Map([["arch", { id: "arch", type: "project", title: "t", content: "c", importance: 3, archived: true, forgotten: false }]]);
  const { ok } = validateDecisions([{ action: "archive", ids: ["arch"] }], snap);
  assert.equal(ok, false);
});

test("empty decision list rejects", () => {
  const { ok, errors } = validateDecisions([], snapshot(["a"]));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("non-empty array")));
});

test("empty ids rejects", () => {
  const { ok } = validateDecisions([{ action: "archive", ids: [] }], snapshot(["a"]));
  assert.equal(ok, false);
});

test("merge requires non-empty title and content", () => {
  const snap = snapshot(["a"]);
  const base = { action: "merge", ids: ["a"], keepSource: "a" };
  for (const [title, content] of [["", "x"], ["t", ""], [undefined, "x"], ["t", undefined]]) {
    const { ok } = validateDecisions([{ ...base, title, content }], snap);
    assert.equal(ok, false, `title=${JSON.stringify(title)} content=${JSON.stringify(content)}`);
  }
});

test("summary entries cannot be decision targets", () => {
  const snap = new Map([["s", { id: "s", type: "summary", title: "t", content: "c", importance: 3, archived: false, forgotten: false }]]);
  const { ok } = validateDecisions([{ action: "archive", ids: ["s"] }], snap);
  assert.equal(ok, false);
});

test("every snapshot memory must be covered by a decision", () => {
  const snap = snapshot(["a", "b"]);
  const { ok, errors } = validateDecisions([{ action: "keep", ids: ["a"] }], snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing from decisions")));
});

test("duplicate ids within one decision reject", () => {
  const { ok } = validateDecisions([{ action: "keep", ids: ["a", "a"] }], snapshot(["a"]));
  assert.equal(ok, false);
});

function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("applyDecisions merges: keepSource updated, others archived", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const applied = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }
  ], service);
  assert.equal(applied, 1);
  const keeper = store.getById(b.id);
  assert.equal(keeper.content, "合并内容");
  assert.equal(keeper.title, "插件总览");
  assert.equal(keeper.importance, 5);
  assert.equal(store.getById(a.id).archived, true, "source archived");
});

test("applyDecisions conflict: winner kept, loser archived with provenance", () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  applyDecisions([{ action: "conflict", winner: w.id, loser: l.id, reason: "更新" }], service);
  assert.equal(store.getById(l.id).archived, true);
  const winner = store.getById(w.id);
  assert.ok(winner.content.includes("8月20日"), "winner content intact");
  assert.ok(winner.content.includes("已否决旧信息"), "provenance note appended");
});

test("applyDecisions archive and keep", () => {
  const { store, service } = dreamSetup();
  const { memory: k } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "废弃", content: "过时" });
  applyDecisions([
    { action: "keep", ids: [k.id] },
    { action: "archive", ids: [a.id], reason: "过时" }
  ], service);
  assert.equal(store.getById(k.id).archived, false);
  assert.equal(store.getById(a.id).archived, true);
});

test("applyDecisions returns count and never throws on unknown id (skip)", () => {
  const { store, service } = dreamSetup();
  const { memory: k } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const applied = applyDecisions([{ action: "archive", ids: ["ghost"], reason: "x" }], service);
  assert.equal(applied, 0);
  assert.equal(store.getById(k.id).archived, false);
});

test("applyDecisions catch path: throwing decision is skipped, logged, and later decisions still apply", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "会炸", content: "x" });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "正常", content: "y" });
  const originalSetArchived = service.setArchived;
  let calls = 0;
  service.setArchived = (id, archived) => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return originalSetArchived.call(service, id, archived);
  };
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };
  const applied = applyDecisions([
    { action: "archive", ids: [a.id], reason: "x" },
    { action: "archive", ids: [b.id], reason: "y" }
  ], service, logger);
  assert.equal(applied, 1, "throwing decision not counted, surviving decision counted");
  assert.equal(store.getById(a.id).archived, false, "throwing decision left no partial effect");
  assert.equal(store.getById(b.id).archived, true, "later decision still applied");
  assert.equal(warnings.length, 1, "logger called once");
  assert.match(warnings[0], /failed to apply archive at index 0: boom/);
});

test("applyDecisions conflict with missing loser skips cleanly", () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const applied = applyDecisions([{ action: "conflict", winner: w.id, loser: "ghost", reason: "x" }], service);
  assert.equal(applied, 0);
  assert.equal(store.getById(w.id).archived, false, "winner untouched");
  assert.ok(!store.getById(w.id).content.includes("已否决"), "no provenance note appended");
});

test("applyDecisions merge with missing keeper skips cleanly", () => {
  const { store, service } = dreamSetup();
  const applied = applyDecisions([
    { action: "merge", ids: ["ghost"], keepSource: "ghost", title: "t", content: "c" }
  ], service);
  assert.equal(applied, 0);
  assert.equal(store.getById("ghost"), undefined);
});

test("applyDecisions merge without importance falls back to max source importance", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const applied = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", keepSource: b.id }
  ], service);
  assert.equal(applied, 1);
  assert.equal(store.getById(b.id).importance, 4, "keeper keeps max of source importances");
  assert.equal(store.getById(a.id).archived, true, "source archived");
});
