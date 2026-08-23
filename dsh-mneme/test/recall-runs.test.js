import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// v0.7.0 recall-layer 强度标记 + 滚动清理：
//   - searchMemories 记搜索帧：candidates 打 injected:false（被召回）；
//   - injectCandidates 记注入帧：mode="inject"、candidates 打 injected:true
//     （被注入上下文）—— 两个消耗强度可分可查；
//   - 两路都受 recallRecordDefault 门控，注入帧记账失败绝不阻断注入；
//   - store.purgeRecallRunsOlderThan(days) 按 created_at 滚动清理防膨胀。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

function wireRecorder(service, seen) {
  service.setRecallRecorder((r) => seen.push(r));
}

test("search scene candidates carry injected:false", async () => {
  const { service } = setup();
  const seen = [];
  wireRecorder(service, seen);
  service.saveWithDedupe({ type: "preference", title: "量子计算", content: "入门", importance: 5 });
  const rows = await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.equal(rows.length, 1);
  assert.equal(seen[0].mode, "keyword");
  assert.equal(seen[0].candidates[0].injected, false, "搜索帧是被召回的帧，标记 false");
});

test("inject scene records mode=inject with injected:true on every candidate", async () => {
  const { service } = setup();
  const seen = [];
  wireRecorder(service, seen);
  const mem = service.saveWithDedupe({ type: "preference", title: "量子计算", content: "入门", importance: 5 }).memory;
  const injected = service.injectCandidates({ query: "量子", maxItems: 3 });
  assert.ok(injected.some((m) => m.id === mem.id), "注入选中的记忆在返回里");
  assert.equal(seen.length, 1, "注入帧记了 1 条 recall_runs");
  const rec = seen[0];
  assert.equal(rec.mode, "inject", "注入帧 mode 为 inject");
  assert.equal(rec.topK, injected.length);
  assert.ok(rec.candidates.length >= 1 && rec.candidates.every((c) => c.injected === true), "注入候选全部 injected:true");
  assert.ok(rec.candidates.every((c) => c.source === "inject"), "注入候选 source 标记 inject");
});

test("inject recording is gated off by recallRecordDefault=false, search stays explicit", async () => {
  const { service } = setup({ recallRecordDefault: false });
  const seen = [];
  wireRecorder(service, seen);
  service.saveWithDedupe({ type: "preference", title: "量子计算", content: "入门", importance: 5 });
  service.injectCandidates({ query: "量子", maxItems: 3 });
  assert.equal(seen.length, 0, "recallRecordDefault=false 时注入帧不上报");
  await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.equal(seen.length, 1, "显式 recordRecall:true 的搜索帧照常上报");
});

test("injected flag survives the store round-trip", async () => {
  const store = createStore(":memory:");
  store.saveRecallRun({
    query: "量子", mode: "inject", topK: 1, candidates: [{ id: "a", title: "量子", content: "入门", score: 0.8, source: "inject", injected: true }]
  });
  store.saveRecallRun({
    query: "量子", mode: "keyword", topK: 1, candidates: [{ id: "b", title: "量子计算", content: "叠加态", score: 0.9, source: "keyword", injected: false }]
  });
  const runs = store.listRecallRuns();
  assert.equal(runs.length, 2);
  const inject = runs.find((r) => r.mode === "inject");
  const search = runs.find((r) => r.mode === "keyword");
  assert.equal(inject.candidates[0].injected, true, "注入帧 injected 存得回来");
  assert.equal(search.candidates[0].injected, false, "搜索帧 injected 存得回来");
  assert.equal(store.getRecallRun(search.id).candidates[0].injected, false);
});

test("purgeRecallRunsOlderThan drops only rows past the retention window", async () => {
  const store = createStore(":memory:");
  const old = store.saveRecallRun({
    id: "old", query: "旧查询", mode: "keyword", topK: 5, candidates: [],
    created_at: new Date(Date.now() - 200 * 86400000).toISOString()
  });
  const fresh = store.saveRecallRun({
    id: "fresh", query: "新查询", mode: "inject", topK: 5, candidates: [],
    created_at: new Date().toISOString()
  });
  const deleted = store.purgeRecallRunsOlderThan(90);
  assert.equal(deleted, 1, "只有 200 天前的老行被清除");
  const runs = store.listRecallRuns();
  assert.deepEqual(runs.map((r) => r.id), ["fresh"], "新行保留");
  assert.equal(store.getRecallRun(old.id), undefined, "旧行不可再读");
  store.close();
});