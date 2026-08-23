import test from "node:test";
import assert from "node:assert/strict";
import { runSleep } from "../src/dream/sleep.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// v0.7.0 待办③ sleep 降级热联合判定：
//   降级需同时满足 时间窗 + heat<sleepHeatThreshold + importance<5 三条件；
//   λ=0 的免疫类型 heat 恒 1.0 天然豁免；importance≥5 紧要记忆无论多冷都保留。
// 默认 λ 下：history(0.006) 约 77 天后热值跌破 0.05，project(0.0008) 约 581 天，
// decision(0.002) 约 232 天 —— 整体取向保守，突出"冷但重要"与"热但低值"都不降级。

const DAY = 86400000;

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

function saveMemory(service, title, content, type = "project", importance = 3) {
  return service.saveWithDedupe({ type, title, content, importance }).memory;
}

function sleepConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,   // 30-90 天窗口 → 压缩为摘要
    sleepCompressDays: 90,  // >=90 天 → 直接归档
    sleepPatternMinMemories: 100, // 记忆数不足 → pattern 阶段跳过
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

function mockCtx() {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

async function run(memories, service, config) {
  const now = Date.now();
  for (const [mem, daysAgo] of memories) {
    service.touchLastAccess(mem.id, new Date(now - daysAgo * DAY).toISOString());
  }
  const result = await runSleep(mockCtx(), service, config, { warn: () => {}, info: () => {} }, null, null);
  return result.phases?.["demotion"];
}

test("cold low-importance history past the compress tier archives (heat gate open)", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "久远的会话记录", "早期讨论内容", "history", 2);
  const demotion = await run([[mem, 120]], service, sleepConfig());
  assert.ok(demotion, "demotion phase ran");
  assert.ok(demotion.archived.includes(mem.id), "120 天 ref + 热值≈0.03<0.05 + importance 2 → 归档");
  assert.equal(store.getById(mem.id).archived, true);
  store.close();
});

test("importance 5 protects a memory even when the heat is icy", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "关键决策", "不可丢失的重要结论", "decision", 5);
  const demotion = await run([[mem, 400]], service, sleepConfig());
  assert.ok(demotion, "demotion phase ran");
  // decision λ=0.002, 400 天热值≈0.03<0.05，但 importance=5 → 保护，绝不降级。
  assert.ok(!demotion.archived.includes(mem.id), "紧要记忆不被归档");
  assert.ok(!demotion.demoted.includes(mem.id), "紧要记忆不被压缩");
  assert.equal(store.getById(mem.id).archived, false);
  store.close();
});

test("immune preference (λ=0, heat=1.0) is never demoted even when ancient", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "用户偏好", "喜欢简洁的总结", "preference", 3);
  const demotion = await run([[mem, 400]], service, sleepConfig());
  assert.ok(!demotion.archived.includes(mem.id), "免疫类型不归档");
  assert.ok(!demotion.demoted.includes(mem.id), "免疫类型不压缩");
  assert.equal(store.getById(mem.id).archived, false);
  store.close();
});

test("slow-decay project stays heat-protected at the compress tier (λ=0.0008)", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "项目A", "慢衰减的进行中项目", "project", 2);
  const demotion = await run([[mem, 100]], service, sleepConfig());
  // 100 天已越过 90 天归档窗，但 project 热值≈0.28>0.05 → heat 闸拦下。
  assert.ok(!demotion.archived.includes(mem.id), "慢衰减类型热值仍高 → 不归档");
  assert.equal(store.getById(mem.id).archived, false);
  store.close();
});

test("demote tier (30-90d) fires when the type's λ is cold enough", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "中期会话摘要", "可压缩的历史碎片", "history", 2);
  // 调高 history 的 λ 到 0.05 → 40 天热值≈0.009<0.05，解锁 30-90 天压缩窗口。
  const config = sleepConfig({ heatTypeDecay: { history: 0.05 } });
  const demotion = await run([[mem, 40]], service, config);
  assert.ok(!demotion.archived.includes(mem.id), "40 天未到归档线");
  assert.ok(demotion.demoted.includes(mem.id), "热值足够冷 + importance 2 → 压缩为摘要");
  const after = store.getById(mem.id);
  assert.ok(after._full_content, "全文停放在 _full_content");
  store.close();
});