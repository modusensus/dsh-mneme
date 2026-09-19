import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #218 v1：heat 作为注入排序的**同级内乘数**（issue #218 拍板口径）。
// 规则路 comparator 的层内权重 importance×quality 乘 heat；priority 分层
// （summary=0 / preference=1 / coding 同级 / 其余 2）与 store 的 order=chrono
// 分页序不动。heatEnabled=false（默认）时权重恒 1，排序与改动前一致——
// 本文件的关闭用例与 heat.test.js 的曲线断言共同锁住验收第 1 条。

const HOUR = 3600000;

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

const titles = (candidates) => candidates.map((c) => c.title);

test("heat off（默认）：层内维持 importance 序，与改动前一致", () => {
  const { store, service } = setup();
  const cold = service.saveWithDedupe({ type: "decision", title: "冷的高重要性决策", content: "旧", importance: 4 }).memory;
  service.saveWithDedupe({ type: "decision", title: "新的低重要性决策", content: "新", importance: 3 });
  service.touchLastAccess(cold.id, new Date(Date.now() - 3000 * HOUR).toISOString());
  // 新记忆不触达：ref 退 created_at（≈现在），heat≈1，不影响本用例
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(titles(picked), ["冷的高重要性决策", "新的低重要性决策"]);
  store.close();
});

test("heat on：同层内新鲜低重要性记忆越过冷的高重要性记忆", () => {
  const { store, service } = setup({ heatEnabled: true });
  const cold = service.saveWithDedupe({ type: "decision", title: "冷的高重要性决策", content: "旧", importance: 4 }).memory;
  service.saveWithDedupe({ type: "decision", title: "新的低重要性决策", content: "新", importance: 3 });
  service.touchLastAccess(cold.id, new Date(Date.now() - 3000 * HOUR).toISOString());
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  // λ=0.002、3000h → 冷记忆权重 4×e^-6≈0.01，新鲜记忆 3×≈1 → 反超
  assert.deepEqual(titles(picked), ["新的低重要性决策", "冷的高重要性决策"]);
  store.close();
});

test("heat on 且 λ=0（免疫类型）：乘数恒 1，importance 序不受影响", () => {
  const { store, service } = setup({ heatEnabled: true, heatTypeDecay: { decision: 0 } });
  const cold = service.saveWithDedupe({ type: "decision", title: "冷的高重要性决策", content: "旧", importance: 4 }).memory;
  service.saveWithDedupe({ type: "decision", title: "新的低重要性决策", content: "新", importance: 3 });
  service.touchLastAccess(cold.id, new Date(Date.now() - 3000 * HOUR).toISOString());
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.deepEqual(titles(picked), ["冷的高重要性决策", "新的低重要性决策"]);
  store.close();
});

test("heat 不跨层：再热的 decision 也不越过 summary 层", () => {
  const { store, service } = setup({ heatEnabled: true });
  service.saveWithDedupe({ type: "summary", title: "会话总览", content: "总览", importance: 2 });
  service.saveWithDedupe({ type: "decision", title: "滚烫决策", content: "新", importance: 3 });
  const picked = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.equal(picked[0].type, "summary", "priority 分层不被 heat 打破");
  store.close();
});
