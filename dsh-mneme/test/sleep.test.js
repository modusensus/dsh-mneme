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
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
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
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
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
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
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
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
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
