import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";

// 回归（issue #205）：注入位跨轮轮换。长会话（几十上百轮、注入位有限）中
// 同一批条目在相邻轮次反复出现——报告者 15.5 小时实测 86 次注入 93% 重复，
// 库总览一条 43/43 块全勤。新配置 injectRotationTurns（默认 0 = 关闭）：
// 同一条记忆在最近 N 个「不同用户查询」轮次注入过后，本轮不再优先——
// 新鲜者前置、不足按原序回填（槽位数不变）；同一查询的重复渲染（工具轮）
// 不推进窗口；会话边界自动重置。

function setup(configOver = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  const config = { maxInjectedItems: 2, importanceThreshold: 3, ...configOver };
  createInjector(ctx, service, settings, config);
  // 注入块是 contexts[0]（memory），user-settings 是 contexts[1]
  const render = (sessionId, query) => contexts[0].text({
    agent: { session: { id: sessionId, snapshotEvents: () => query ? [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: query }] } }
    ] : [] } }
  });
  const titles = (text) => [...text.matchAll(/- \[([^\]]+)\] ([^（(]*)/g)].map((m) => m[2].trim());
  return { store, service, render, titles };
}

function seedMemories(service, n = 4) {
  const saved = [];
  for (let i = 0; i < n; i++) {
    saved.push(service.saveWithDedupe({
      type: "preference",
      title: `偏好条目${i}`,
      content: `第 ${i} 条独立的用户偏好内容，主题互不相同`,
      importance: 5
    }).memory);
  }
  return saved;
}

test("#205: default (rotation off) repeats the same entries across turns", () => {
  const { store, service, render, titles } = setup({});
  seedMemories(service, 4);
  const turn1 = titles(render("s1", "第一个问题"));
  const turn2 = titles(render("s1", "第二个问题"));
  assert.equal(turn1.length, 2);
  assert.deepEqual(turn1, turn2, "rotation off → same entries repeat (current behavior)");
  store.close();
});

test("#205: rotation=1 swaps out previously injected entries, slots stay full", () => {
  const { store, service, render, titles } = setup({ injectRotationTurns: 1 });
  seedMemories(service, 4);
  const turn1 = titles(render("s1", "第一个问题"));
  const turn2 = titles(render("s1", "第二个问题"));
  assert.equal(turn2.length, 2, "slots stay full");
  for (const t of turn1) {
    assert.ok(!turn2.includes(t), `previously injected "${t}" must rotate out`);
  }
  store.close();
});

test("#205: entry becomes eligible again after leaving the window", () => {
  const { store, service, render, titles } = setup({ injectRotationTurns: 1 });
  seedMemories(service, 4);
  const turn1 = titles(render("s1", "q1"));
  const turn2 = titles(render("s1", "q2")); // window = [q1] → turn1 条目被换下
  const turn3 = titles(render("s1", "q3")); // window = [q2] → turn1 条目重新有资格
  for (const t of turn2) assert.ok(!turn3.includes(t), `"${t}" (injected at turn2) rotates out at turn3`);
  for (const t of turn1) assert.ok(turn3.includes(t), `"${t}" (turn1) is fresh again at turn3`);
  store.close();
});

test("#205: repeated renders within the same query do not advance the window", () => {
  const { store, service, render, titles } = setup({ injectRotationTurns: 1 });
  seedMemories(service, 4);
  const turn1a = titles(render("s1", "q1"));
  const turn1b = titles(render("s1", "q1")); // 同一查询：工具调用轮，不推进
  assert.deepEqual(turn1a, turn1b, "same query renders identically (window not advanced)");
  const turn2 = titles(render("s1", "q2"));
  for (const t of turn1a) assert.ok(!turn2.includes(t), "rotation happens on the next query only");
  store.close();
});

test("#205: a new session starts fresh", () => {
  const { store, service, render, titles } = setup({ injectRotationTurns: 1 });
  seedMemories(service, 4);
  const turn1 = titles(render("s1", "q1"));
  const other = titles(render("s2", "q1")); // 新会话：历史为空
  assert.deepEqual(other, turn1, "session boundary resets rotation history");
  store.close();
});

test("#205: backfill keeps slots full when fresh candidates run out", () => {
  const { store, service, render, titles } = setup({ injectRotationTurns: 1 });
  seedMemories(service, 2); // 候选恰等于槽位
  const turn1 = titles(render("s1", "q1"));
  const turn2 = titles(render("s1", "q2"));
  assert.equal(turn2.length, 2, "stale entries backfill when nothing fresh remains");
  assert.deepEqual(turn1, turn2, "no fresh candidates → original selection returned");
  store.close();
});
