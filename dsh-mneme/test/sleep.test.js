import test from "node:test";
import assert from "node:assert/strict";
import { createSleepScheduler, runSleep } from "../src/dream/sleep.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// Mock embedder: every query maps to [1,0,0] so vectors are identical unless a
// test pre-seeds a custom vector via vectorIndex.saveEmbedding.
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

// Deterministic LLM: onConsolidation(userText) => decisions JSON string.
function mockCtx(onConsolidation, selection = { provider: "mock", model: "sleep-model" }) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        const reply = onConsolidation ? onConsolidation(userText) : "[]";
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 100,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

// v0.7.0 热联合判定：慢衰减类型（project λ=0.0008）默认受热闸保护——40 天热值
// ≈0.5、100 天 ≈0.28，始终高于 sleepHeatThreshold(0.05)，demotion 不触发。
// 降级语义测试把 project 的 λ 调快到 0.02（40 天热值≈0.03），复现"时间窗冷态
// 即降级"的旧路径；默认保守语义由 sleep-heat.test.js 单独覆盖。
function demotionConfig(overrides = {}) {
  return baseConfig({ heatTypeDecay: { project: 0.02 }, ...overrides });
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function makeMemory(service, title, content, type = "project") {
  return service.saveWithDedupe({ type, title, content, importance: 3 }).memory;
}

// ------------------------------------------------------------ scheduler

test("sleep: scheduler does not run when disabled", () => {
  const { service, store } = setup();
  const sched = createSleepScheduler({
    service, config: baseConfig({ sleepModeEnabled: false }), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(1_000_000 + 60 * 60000), false, "disabled never schedules");
  store.close();
});

test("sleep: scheduler fires once idle window elapses", () => {
  const { service, store } = setup();
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(1_000_000 + 4 * 60000), false, "still within idle window");
  assert.equal(sched.shouldRun(1_000_000 + 6 * 60000), true, "idle window elapsed");
  store.close();
});

test("sleep: noteWrite resets the idle clock (stale-timer guard)", () => {
  const { service, store } = setup();
  let now = 1_000_000;
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => now, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(now + 6 * 60000), true, "idle after 6min");
  now = 1_000_000 + 6 * 60000;
  sched.noteWrite();
  assert.equal(sched.shouldRun(now), false, "write resets idle clock");
  assert.equal(sched.shouldRun(now + 4 * 60000), false, "still idle-pending after reset");
  assert.equal(sched.shouldRun(now + 6 * 60000), true, "idle again after fresh window");
  store.close();
});

test("sleep: first-ever run is not blocked by min interval (lastRunAt=0)", () => {
  const { service, store } = setup();
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(1_000_000 + 6 * 60000), true, "first run allowed");
  store.close();
});

test("sleep: min interval blocks a re-run within the window, allows after", async () => {
  const { service, store } = setup();
  let now = 1_000_000;
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => now, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  now = 1_000_000 + 6 * 60000; // idle satisfied
  const ok = await sched.maybeSchedule();
  assert.equal(ok, true, "first run executed");
  assert.equal(sched.shouldRun(now + 1 * 3600000), false, "1h later still inside 8h min interval");
  assert.equal(sched.shouldRun(now + 9 * 3600000), true, "9h later past min interval → allowed");
  store.close();
});

test("sleep: maybeSchedule enqueues via service and serializes with other work", async () => {
  const { service, store } = setup();
  const config = baseConfig();
  let now = 1_000_000;
  let order = [];
  const sched = createSleepScheduler({
    service, config, logger: { warn: () => {} },
    onRun: async () => { order.push("sleep"); return { ok: true, applied: 7 }; },
    now: () => now, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  now = 1_000_000 + 6 * 60000;
  const p1 = service.enqueue(async () => { order.push("a"); });
  const p2 = sched.maybeSchedule();
  await p1;
  const result = await p2;
  assert.equal(result, true, "run result propagated through enqueue");
  assert.deepEqual(order, ["a", "sleep"], "sleep run serialized behind queued work");
  store.close();
});

test("sleep: dispose clears the timer and prevents further runs", async () => {
  const { service, store } = setup();
  let cleared = false;
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => { cleared = true; }
  });
  sched.noteWrite(); // arm the idle timer so dispose has something to clear
  assert.equal(cleared, false, "timer armed, not yet cleared");
  await sched.dispose();
  assert.equal(cleared, true, "idle timer cleared on dispose");
  assert.equal(sched.shouldRun(1_000_000 + 6 * 60000), false, "disposed never runs");
  store.close();
});

// ------------------------------------------------------------ runSleep phases

test("sleep: demotion shrinks cold memory to summary, keeps _full_content", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "原内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  const after = service.getById(m.id);
  assert.equal(result.status, "ok");
  assert.ok(after._full_content && after._full_content.length > 0, "full body preserved");
  assert.ok(after.content.length < "原内容".repeat(60).length, "content shrank to summary");
  assert.equal(after.archived, false, "not fully archived at 40 days");
  store.close();
});

test("sleep: demotion fully archives memory past sleepCompressDays", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "ancient", "很老的记忆", "project");
  service.touchLastAccess(m.id, new Date(now - 100 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  const after = service.getById(m.id);
  assert.equal(result.status, "ok");
  assert.equal(after.archived, true, "past compress days → archived");
  store.close();
});

test("sleep: demoteToSummary minRefTimeMs skips a memory touched after snapshot", () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "touched", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const snapshotCut = now - 1 * 86400000;
  service.touchLastAccess(m.id, new Date(snapshotCut + 60000).toISOString());
  const updated = service.demoteToSummary(m.id, "摘要", { minRefTimeMs: snapshotCut });
  assert.equal(updated, undefined, "touched-after-snapshot memory is not demoted");
  assert.equal(service.getById(m.id)._full_content ?? null, null, "no demotion happened");
  store.close();
});

test("sleep: demotion demotes a memory still cold after snapshot", () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "stillcold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const snapshotCut = now - 1 * 86400000;
  const updated = service.demoteToSummary(m.id, "摘要", { minRefTimeMs: snapshotCut });
  assert.ok(updated && updated._full_content, "cold memory demoted to summary");
  store.close();
});

test("sleep: pattern discovery filters fabricated evidence ids", async () => {
  const { service, store } = setup();
  const a = makeMemory(service, "模式A", "反复出现的模式A", "project");
  const b = makeMemory(service, "模式B", "反复出现的模式B", "project");
  const ctx = mockCtx(() =>
    JSON.stringify([
      { action: "create", type: "pattern", title: "真模式", content: "从 a 和 b 提取", importance: 3, evidence: [a.id, "fake-zzz", b.id] }
    ])
  );
  const result = await runSleep(ctx, service, baseConfig({ sleepPatternMinMemories: 10 }), ctx.logger, null, null);
  assert.ok(!JSON.stringify(result.phases.patterns).includes("fake-zzz"), "fabricated evidence filtered before apply");
  const pattern = service.all().find((x) => x.type === "pattern");
  assert.ok(pattern, "pattern minted");
  store.close();
});

test("sleep: relation completion links orphan entities co-occurring in a memory", async () => {
  const { service, store } = setup();
  const alpha = service.createEntity({ name: "Alpha", type: "project" });
  const beta = service.createEntity({ name: "Beta", type: "project" });
  makeMemory(service, "协作", "Alpha 与 Beta 一起干活", "project");
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
  assert.equal(result.phases.relations.status, "ok", "relations phase ran");
  const rels = service.getRelations(alpha.id);
  assert.ok(rels.length >= 1, "orphan Alpha gained a relation");
  assert.ok(rels.some((r) => r.to_entity === beta.id || r.from_entity === beta.id), "relation targets Beta");
  store.close();
});

test("sleep: runSleep writes an audit receipt with run_type='sleep'", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
  const runs = service.listDreamRuns();
  const last = runs[runs.length - 1];
  assert.equal(last.run_type, "sleep", "audit row tagged sleep");
  assert.equal(result.runId, last.id, "run id matches audit row");
  assert.ok(typeof result.receipt === "string" && result.receipt.startsWith("dsh-mneme:run:"), "receipt is the audit string");
  store.close();
});

test("sleep: a failing phase does not block the others (fail-safe)", async () => {
  const { service, store } = setup();
  service.setEmbedder({
    embed: async () => { throw new Error("embed down"); },
    embedSingle: async () => { throw new Error("embed down"); },
    modelHash: "x", dimension: 3
  });
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  assert.equal(result.phases.conflicts.status, "skipped", "conflicts phase degraded gracefully (no usable vectors)");
  assert.equal(result.phases.demotion.status, "ok", "demotion still ran");
  assert.equal(result.status, "ok", "overall run still ok despite conflicts degrading");
  assert.ok(service.getById(m.id)._full_content, "cold memory still demoted despite conflicts failure");
  store.close();
});

test("sleep: no LLM route skips LLM phases but demotion still runs", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]", null); // currentSelection() → null, no route
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  assert.equal(result.phases.conflicts.status, "skipped", "no llm route → conflicts skipped");
  assert.equal(result.phases.patterns.status, "skipped", "no llm route → patterns skipped");
  assert.equal(result.phases.demotion.status, "ok", "demotion is LLM-free and runs");
  store.close();
});

// ------------------------------------------------------------ conflict strictness

function seedConflictPair(service, vectorIndex, sim) {
  const a = makeMemory(service, "主题X", "内容A 关于主题X", "project");
  const b = makeMemory(service, "主题X副本", "内容B 关于主题X", "project");
  const sin = Math.sqrt(Math.max(0, 1 - sim * sim));
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [sim, sin, 0]);
  return { a, b };
}

test("sleep: conflict strictness gentle ignores sim 0.88 pairs", async () => {
  const { service, store, vectorIndex } = setup();
  seedConflictPair(service, vectorIndex, 0.88);
  const config = baseConfig({ sleepConflictStrictness: "gentle", conflictFreezeEnabled: true });
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "skipped", "0.88 below gentle 0.92 → no conflicts");
  store.close();
});

test("sleep: conflict strictness normal resolves sim 0.88 pairs", async () => {
  const { service, store, vectorIndex } = setup();
  seedConflictPair(service, vectorIndex, 0.88);
  const config = baseConfig({ sleepConflictStrictness: "normal", conflictFreezeEnabled: true });
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "0.88 above normal 0.85 → conflicts found");
  assert.ok(result.phases.conflicts.frozen >= 1, "pairs frozen for review");
  store.close();
});

test("sleep: conflict strictness aggressive adjudicates low-confidence pairs", async () => {
  const { service, store, vectorIndex } = setup();
  seedConflictPair(service, vectorIndex, 0.80);
  const config = baseConfig({ sleepConflictStrictness: "aggressive", conflictFreezeEnabled: true });
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "0.80 above aggressive 0.75 → conflicts found");
  assert.ok(result.phases.conflicts.frozen >= 1, "pairs frozen");
  store.close();
});

test("sleep: conflict LLM arbitration applies winner/loser", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const ctx = mockCtx(() =>
    JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
  );
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "conflict resolved");
  assert.equal(service.getById(b.id).archived, true, "loser archived by arbitration");
  store.close();
});

test("sleep: runSleep is abortable via signal between phases", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctrl = new AbortController();
  ctrl.abort(); // pre-aborted
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, ctrl.signal);
  assert.equal(result.phases.conflicts, undefined, "aborted before any phase ran");
  store.close();
});

// ------------------------------------------------ entity extraction (issue #23)

// Write-path extractor is gated on entityExtractionEnabled (default off), so
// default installs never accumulate entities → ego-graph panel blank. This
// sleep phase backfills it; these tests cover gating, idempotence and
// fail-safe batching.
const ENTITY_LLM_JSON = JSON.stringify({
  entities: [{ name: "X", type: "concept", attrs: [{ key: "k", value: "v" }] }],
  relations: []
});

test("sleep: entity extraction skips when disabled", async () => {
  const { service, store } = setup();
  makeMemory(service, "记忆A", "内容A", "history");
  const ctx = mockCtx(() => ENTITY_LLM_JSON, { provider: "p", model: "m" });
  const result = await runSleep(
    ctx, service,
    baseConfig({ sleepEntityExtractionEnabled: false }),
    ctx.logger, null, null
  );
  assert.equal(result.phases["entity-extraction"].status, "skipped", "disabled → skipped");
  store.close();
});

test("sleep: extracted memories are stamped and not re-extracted", async () => {
  const { service, store } = setup();
  const mem = makeMemory(service, "记忆B", "内容B", "history");
  const ctx = mockCtx(() => ENTITY_LLM_JSON, { provider: "p", model: "m" });
  const config = baseConfig({ sleepEntityExtractionEnabled: true });
  // First cycle backfills → memory gets entity_extracted_at stamped.
  const first = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(first.phases["entity-extraction"].status, "ok", "first cycle extracts");
  assert.ok(service.getById(mem.id).metadata?.entity_extracted_at, "stamp written");
  // Second cycle has nothing un-stamped left → skipped.
  const second = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(second.phases["entity-extraction"].status, "skipped", "nothing left to extract");
  store.close();
});

test("sleep: entity-less extracts are stamped so they are not re-queued forever", async () => {
  const { service, store } = setup();
  const mem = makeMemory(service, "无实体记忆", "这里没有任何实体", "history");
  // LLM legitimately returns no entities — must still be stamped, else every
  // sleep cycle re-extracts the same text forever (issue #23 regression).
  const ctx = mockCtx(() => JSON.stringify({ entities: [], relations: [] }), { provider: "p", model: "m" });
  const config = baseConfig({ sleepEntityExtractionEnabled: true });
  const first = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(first.phases["entity-extraction"].status, "ok", "empty extract counts as handled");
  assert.equal(first.phases["entity-extraction"].extracted, 1);
  assert.ok(service.getById(mem.id).metadata?.entity_extracted_at, "stamp written even with no entities");
  const second = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(second.phases["entity-extraction"].status, "skipped", "stamped → not re-queued");
  store.close();
});

test("sleep: entity extraction backfills entities for un-extracted memories", async () => {
  const { service, store } = setup();
  const mem = makeMemory(service, "记忆C", "内容C", "history");
  const ctx = mockCtx(() => ENTITY_LLM_JSON, { provider: "p", model: "m" });
  const result = await runSleep(
    ctx, service,
    baseConfig({ sleepEntityExtractionEnabled: true }),
    ctx.logger, null, null
  );
  const phase = result.phases["entity-extraction"];
  assert.equal(phase.status, "ok");
  assert.equal(phase.extracted, 1);
  assert.ok(store.listEntities().length > 0, "entity minted");
  assert.ok(service.getAttrsByMemory(mem.id).length > 0, "memory now carries entity attrs");
  store.close();
});

test("sleep: a failing extraction does not abort the batch and retries next cycle", async () => {
  const { service, store } = setup();
  const bad = makeMemory(service, "坏记忆", "bad 内容", "history");
  const good = makeMemory(service, "好记忆", "good 内容", "history");
  const ctx = mockCtx(
    (user) => (String(user).includes("bad") ? "这不是合法JSON{{{" : ENTITY_LLM_JSON),
    { provider: "p", model: "m" }
  );
  const config = baseConfig({ sleepEntityExtractionEnabled: true });
  const first = await runSleep(ctx, service, config, ctx.logger, null, null);
  const phase = first.phases["entity-extraction"];
  assert.equal(phase.extracted, 1, "good memory extracted");
  assert.equal(phase.failed, 1, "bad memory counted as failed");
  assert.equal(phase.status, "ok", "partial success is ok");
  assert.ok(store.listEntities().length > 0, "at least one entity minted");
  // Good memory stamped; bad one not → second cycle retries only the bad one.
  assert.ok(service.getById(good.id).metadata?.entity_extracted_at, "good memory stamped");
  assert.equal(service.getById(bad.id).metadata?.entity_extracted_at, undefined, "failed memory not stamped");
  const second = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(second.phases["entity-extraction"].extracted, 0, "bad memory still fails");
  assert.equal(second.phases["entity-extraction"].failed, 1, "failed memory retried");
  store.close();
});

test("sleep: metadata merge keeps unrelated fields when stamping (review #4)", async () => {
  const { service, store } = setup();
  const mem = makeMemory(service, "记忆M", "内容M", "history");
  service.setMemoryMetadata(mem.id, { custom_flag: "keep-me" });
  const ctx = mockCtx(() => ENTITY_LLM_JSON, { provider: "p", model: "m" });
  await runSleep(ctx, service, baseConfig({ sleepEntityExtractionEnabled: true }), ctx.logger, null, null);
  const meta = service.getById(mem.id).metadata;
  assert.equal(meta.custom_flag, "keep-me", "pre-existing metadata not clobbered");
  assert.ok(meta.entity_extracted_at, "stamp added alongside");
  store.close();
});

test("sleep: pending_extracted_at is cleared on success and on failure (review #3)", async () => {
  const { service, store } = setup();
  const good = makeMemory(service, "好记忆", "内容G", "history");
  const bad = makeMemory(service, "坏记忆", "bad 内容", "history");
  const ctx = mockCtx(
    (user) => (String(user).includes("bad") ? "不是JSON{{{" : ENTITY_LLM_JSON),
    { provider: "p", model: "m" }
  );
  const config = baseConfig({ sleepEntityExtractionEnabled: true });
  const first = await runSleep(ctx, service, config, ctx.logger, null, null);
  const phase = first.phases["entity-extraction"];
  assert.equal(phase.extracted, 1);
  assert.equal(phase.failed, 1);
  assert.equal(service.getById(good.id).metadata?.pending_extracted_at, null, "success clears pending");
  assert.equal(service.getById(bad.id).metadata?.pending_extracted_at, null, "failure clears pending");
  store.close();
});

test("sleep: all-failed extraction surfaces failed status through deriveStatus (review #5)", async () => {
  const { service, store } = setup();
  makeMemory(service, "坏记忆1", "bad 一", "history");
  makeMemory(service, "坏记忆2", "bad 二", "history");
  const ctx = mockCtx(() => "不是JSON{{{", { provider: "p", model: "m" });
  const result = await runSleep(ctx, service, baseConfig({ sleepEntityExtractionEnabled: true }), ctx.logger, null, null);
  const phase = result.phases["entity-extraction"];
  assert.equal(phase.status, "failed", "all-failed extraction reports failed");
  assert.equal(phase.failed, 2);
  assert.ok(["failed", "degraded"].includes(result.status), "deriveStatus folds failed into run status");
  store.close();
});

test("store: listForEntityExtraction pages oldest un-stamped candidates (review #2)", async () => {
  const { service, store } = setup();
  const a = makeMemory(service, "甲", "内容甲", "history");
  makeMemory(service, "乙", "内容乙", "history");
  const archived = makeMemory(service, "归档", "内容归档", "history");
  store.setArchived(archived.id, true);
  makeMemory(service, "摘要", "内容摘要", "summary");
  makeMemory(service, "丙", "内容丙", "history"); // second un-stamped candidate so oldest-first has two to compare
  service.setMemoryMetadata(a.id, { entity_extracted_at: new Date().toISOString() });
  const list = store.listForEntityExtraction({ limit: 10, offset: 0 });
  const titles = list.map((m) => m.title);
  assert.ok(!titles.includes("归档"), "archived excluded");
  assert.ok(!titles.includes("摘要"), "summary excluded");
  assert.ok(!titles.includes("甲"), "already-stamped excluded");
  assert.ok(titles.includes("乙"), "un-stamped included");
  assert.ok(titles.includes("丙"), "un-stamped included");
  assert.equal(list[0].created_at <= list[1].created_at, true, "oldest first");
  store.close();
});
