// #231：agent 主动整理接口——dryRun 比对报告 → agent 判断 → apply；筛除项进归档
// 不删；调用全程复用 dream_runs 的 receipt 语义（不新建审计面）。维护者口径：
// 功能本体落在 service 层并带测试，不进工具列表、不加独立 opt-in 开关。

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createOrganizer } from "../src/organize.js";
import { parseReceipt } from "../src/dream.js";

const preference = (title, content = "内容", extra = {}) =>
  ({ type: "preference", title, content, importance: 5, ...extra });

/** 单元级 organizer：假 embedQuery 隔离向量档，写路径复用真 service。 */
function makeOrganizer(embedQuery = async () => null, config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const finalizeCalls = [];
  const { organize } = createOrganizer({
    store,
    embedQuery,
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction,
    finalize: (rows) => finalizeCalls.push(rows)
  });
  return { store, service, organize, finalizeCalls };
}

test("#231: dryRun writes no memory and leaves one organize receipt", async () => {
  const { store, service, organize } = makeOrganizer();
  const seeded = service.saveWithDedupe(preference("偏好X", "既有内容")).memory;
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("偏好X", "同一标题的新内容"), { type: "decision", title: "全新决定", content: "库里没有" }]
  });
  assert.equal(report.items[0].verdict, "exact");
  assert.equal(report.items[0].match.id, seeded.id);
  assert.equal(report.items[1].verdict, "new");
  assert.equal(report.counts.total, 2);
  // 比对是报告不是动作：记忆表仍然只有种子那一行。
  assert.equal(store.list({ limit: null }).length, 1);
  const run = store.getDreamRun(report.run_id);
  assert.equal(run.run_type, "organize");
  assert.equal(run.status, "ok");
  assert.equal(run.applied, 0);
  assert.equal(parseReceipt(run.receipt).runId, report.run_id, "receipt 复用 dream 的既有格式");
});

test("#231: dryRun reports near duplicates with similarity (vector layer)", async () => {
  const { store, service, organize } = makeOrganizer(async () => [0.99, 0.1, 0]);
  const seeded = service.saveWithDedupe({ type: "decision", title: "令牌桶限流方案", content: "旧记录" }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const report = await organize({
    mode: "dryRun",
    candidates: [{ type: "decision", title: "限流方案选型", content: "内容相近但换了标题" }]
  });
  assert.equal(report.items[0].verdict, "near");
  assert.equal(report.items[0].match.id, seeded.id);
  assert.ok(report.items[0].match.sim > 0.9, "相似度带回报告，供 agent 判断");
  assert.equal(report.counts.near, 1);
});

test("#231: apply refuses to write without a real dryRun report", async () => {
  const { store, organize } = makeOrganizer();
  await assert.rejects(() => organize({ mode: "apply", decisions: [] }), /run_id is required/);
  await assert.rejects(() => organize({ mode: "apply", run_id: "nope", decisions: [] }), /unknown organize run/);
  assert.equal(store.list({ limit: null }).length, 0, "拒绝路径零写入");
});

test("#231: apply saves kept candidates, records discards, archives instead of deleting", async () => {
  const { store, service, organize } = makeOrganizer();
  const stale = service.saveWithDedupe({ type: "project", title: "被取代的状态", content: "过时" }).memory;
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("新偏好"), { type: "decision", title: "被丢掉的决定", content: "不落库" }]
  });
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "discard", index: 1 },
      { action: "archive", id: stale.id }
    ]
  });
  assert.equal(outcome.saved, 1);
  assert.equal(outcome.discarded, 1);
  assert.equal(outcome.archived, 1);
  assert.equal(outcome.status, "ok");
  // 筛除 = 归档（可恢复），不是删除。
  assert.equal(store.getById(stale.id).archived, true, "archived row still exists");
  const titles = store.list({ limit: null }).map((m) => m.title);
  assert.ok(titles.includes("新偏好"), "kept candidate landed");
  assert.ok(!titles.includes("被丢掉的决定"), "discarded candidate was not written");
  // 审计链：apply 回执指向它依据的那份报告。
  const applyRun = store.getDreamRun(outcome.run_id);
  assert.equal(applyRun.outcome.dry_run_id, report.run_id);
  assert.equal(applyRun.applied, 2);
  assert.equal(parseReceipt(applyRun.receipt).status, "ok");
});

test("#231: apply tolerates bad decisions — legal subset lands, run is degraded", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("能落的")] });
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "save", index: 9 },           // 越界
      { action: "archive", id: "m_missing" }, // 未知 id
      { action: "explode", index: 0 }         // 未知动作
    ]
  });
  assert.equal(outcome.saved, 1, "legal subset applied");
  assert.equal(outcome.skipped.length, 3);
  assert.equal(outcome.status, "degraded");
  assert.equal(outcome.degraded, true);
  assert.equal(store.getDreamRun(outcome.run_id).skipped.length, 3, "逐条跳过明细进审计");
});

test("#231: dryRun refuses document candidates (registerDocument is the only mint)", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [{ type: "document", title: "长文", content: "摘要" }] });
  assert.equal(report.counts.total, 0);
  assert.equal(report.status, "degraded");
  assert.match(report.skipped[0].error, /registerDocument/);
});

test("#231: dryRun bounds the batch and reports the truncation", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    candidates: Array.from({ length: 55 }, (_, i) => preference(`偏好${i}`))
  });
  assert.equal(report.counts.total, 50);
  assert.equal(report.counts.truncated, 5);
});

test("#231: single entry point with a mode parameter, exported through the service barrel", async () => {
  const { service, organize } = makeOrganizer();
  await assert.rejects(() => organize({ mode: "wat" }), /unknown mode/);
  assert.equal(typeof service.organize, "function", "service 层 barrel 出口（调用方零改动）");
  const report = await service.organize({ mode: "dryRun", candidates: [preference("走 service 的")] });
  assert.equal(report.counts.total, 1);
});

// --- 以下为 CodeRabbit #267 复核后补的边界：报告的索引/scope 必须与落库严格一致 ---

test("#231: payload-level scope travels with the snapshot into the write", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    agent_scope: "agent-a",
    candidates: [preference("带 scope 的偏好")]
  });
  const run = store.getDreamRun(report.run_id);
  assert.equal(run.input[0].agent_scope, "agent-a", "审计存的是带 scope 的规范化快照");
  assert.equal(run.input[0].index, 0, "快照保留原始索引，apply 才能按索引重放");
  assert.equal(run.input[0].type, "preference");
  await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(store.list({ limit: null })[0].agent_scope, "agent-a", "比对用的 scope 就是落地用的 scope");
});

test("#231: apply cannot land an index the dryRun never accepted", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("合法的"), { type: "document", title: "长文", content: "摘要" }]
  });
  assert.equal(report.counts.skipped, 1);
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [{ action: "save", index: 1 }] // dryRun 当时就拒了这一条
  });
  assert.equal(outcome.saved, 0);
  assert.equal(outcome.status, "degraded");
  assert.match(outcome.skipped[0].error, /not accepted by this dryRun/);
  assert.equal(store.list({ limit: null }).length, 0, "被跳过的候选没有资格落库");
});

test("#231: apply refuses an apply receipt as its dryRun reference", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("第一条")] });
  const first = await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  // 两者共用 run_type='organize'，只有 outcome.dry_run_id 能把回执与报告分开。
  await assert.rejects(
    () => organize({ mode: "apply", run_id: first.run_id, decisions: [{ action: "save", index: 0 }] }),
    /apply receipt/
  );
});

test("#231: a throwing embedder fails the dryRun, audits it and rethrows", async () => {
  const { store, service, organize } = makeOrganizer(async () => {
    throw new Error("embedder offline");
  });
  const seeded = service.saveWithDedupe({ type: "preference", title: "已有向量", content: "内容" }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const seen = [];
  const observed = createOrganizer({
    store: { ...store, saveDreamRun: (row) => { seen.push(row); return store.saveDreamRun(row); } },
    embedQuery: async () => {
      throw new Error("embedder offline");
    },
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction
  });
  await assert.rejects(() => observed.organize({ mode: "dryRun", candidates: [preference("新的一条")] }), /embedder offline/);
  assert.equal(seen.at(-1).status, "failed", "基础设施错误留 failed 回执，不降级成「全是新条目」");
  assert.match(seen.at(-1).error, /embedder offline/);
  assert.equal(store.list({ limit: null }).length, 1, "失败路径零写入");
});

test("#231: an infrastructure write error rolls back and reports applied 0", async () => {
  const { store, service, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("会写失败的")] });
  const seen = [];
  const failing = createOrganizer({
    store: { ...store, saveDreamRun: (row) => { seen.push(row); return store.saveDreamRun(row); } },
    embedQuery: async () => null,
    saveWithDedupe: () => {
      throw new Error("database is locked");
    },
    transaction: service.transaction
  });
  await assert.rejects(
    () => failing.organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }),
    /database is locked/
  );
  assert.equal(store.list({ limit: null }).length, 0, "整批回滚，零写入");
  const failed = seen.at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.applied, 0, "回滚后不得虚报 applied");
  assert.deepEqual(failed.outcome.byId, {});
});

test("#231: a failing success audit rolls the writes back with it", async () => {
  const { store, service, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("回执写不进去")] });
  let auditFailures = 0;
  const audited = {
    ...store,
    saveDreamRun: (row) => {
      if (row.run_type === "organize" && row.status === "ok" && row.id !== report.run_id) {
        auditFailures++;
        throw new Error("audit table is full");
      }
      return store.saveDreamRun(row);
    }
  };
  const { organize: proxied } = createOrganizer({
    store: audited,
    embedQuery: async () => null,
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction
  });
  await assert.rejects(
    () => proxied({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }),
    /audit table is full/
  );
  assert.equal(auditFailures, 1);
  assert.equal(store.list({ limit: null }).length, 0, "成功回执与数据同事务：回执写不进去 → 数据也回滚");
});

test("#231: finalize runs after commit with the saved rows, and not for empty batches", async () => {
  const { store, organize, finalizeCalls } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("要重嵌入的")] });
  await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(finalizeCalls.length, 1, "提交后补一次重嵌入（transaction 里被 txDepth 挡掉）");
  assert.equal(finalizeCalls[0][0].id, store.list({ limit: null })[0].id);
  const discardsOnly = await organize({ mode: "dryRun", candidates: [preference("只丢弃")] });
  await organize({ mode: "apply", run_id: discardsOnly.run_id, decisions: [{ action: "discard", index: 0 }] });
  assert.equal(finalizeCalls.length, 1, "noop 批次不触发 finalize");
});

test("#231: archive honours the hidden-id set from the trusted caller, not the payload", async () => {
  const { store, service, organize } = makeOrganizer();
  const outOfScope = service.saveWithDedupe({ type: "project", title: "看不见的项目", content: "内容" }).memory;
  const report = await organize({ mode: "dryRun", candidates: [preference("占位")] });
  // opts 是第二参数（document 的 hiddenEvidenceIds 同款契约）：payload 里的同名字段
  // 一律不认——那是调用方可自选的内容，不是授权。
  const outcome = await service.organize(
    { mode: "apply", run_id: report.run_id, decisions: [{ action: "archive", id: outOfScope.id }] },
    { hiddenIds: [outOfScope.id] }
  );
  assert.equal(outcome.archived, 0);
  assert.match(outcome.skipped[0].error, /out of scope/);
  assert.equal(store.getById(outOfScope.id).archived, false, "看不见的行按不存在处理，不归档");
});
