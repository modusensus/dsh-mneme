import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSleepScheduler, runSleep } from "../src/sleep.js";
import { validateDecisions } from "../src/dream.js";

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { sleepEnabled: true, ...config } });
  return { store, service };
}

/** Backdate a memory's updated_at (last_accessed_at stays null → the sleep
 *  tiering reads updated_at as the reference time). */
function backdate(store, id, days) {
  const iso = new Date(Date.now() - days * 86400000).toISOString();
  store.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(iso, id);
}

/** Dummy embedder/vector index: every text maps to the same vector, so any two
 *  same-type memories score cosine 1.0 and become conflict candidates. */
function fakeSemantic() {
  return {
    embedder: {
      embed: async (texts) => texts.map(() => [1, 0, 0])
    },
    vectorIndex: {
      getEmbedding: () => null,
      saveEmbedding: () => {},
      search: () => []
    }
  };
}

/** Deterministic sleep LLM stub: conflict prompt (user text contains 候选冲突)
 *  routes to onConflict, everything else to onPattern. */
function sleepCtx({ onConflict = () => "[]", onPattern = () => "[]" } = {}) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        yield {
          type: "text-delta",
          index: 0,
          text: userText.includes("候选冲突") ? onConflict(userText) : onPattern(userText)
        };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

// ------------------------------------------------------------ scheduler

test("scheduler gates: idle + interval both required", async () => {
  const { service } = setup();
  let t = 1_000_000_000; // big enough that ±8h stays positive
  let runs = 0;
  const sleep = createSleepScheduler({
    service,
    config: { sleepEnabled: true, sleepIdleMinutes: 30, sleepMinIntervalHours: 8 },
    onRun: async () => { runs++; return { ok: true }; },
    now: () => t
  });
  assert.equal(sleep.shouldRun(t + 1), false, "just wrote: not idle yet");
  t += 30 * 60000 + 1000; // idle satisfied
  assert.equal(sleep.shouldRun(t), true, "idle met + no prior run → runnable");
  assert.equal(await sleep.maybeSchedule(), true);
  assert.equal(runs, 1);
  assert.equal(sleep.shouldRun(t), false, "interval gate: just ran");
  assert.equal(await sleep.maybeSchedule(), false);
  t += 8 * 3600000 + 1; // interval satisfied
  assert.equal(sleep.shouldRun(t), true, "interval passed → runnable again");
});

test("scheduler: noteWrite clears a pending idle timer and re-arms against the new window", () => {
  const { service } = setup();
  let t = 1_000_000_000;
  let cleared = 0;
  const timers = [];
  const sleep = createSleepScheduler({
    service,
    config: { sleepEnabled: true, sleepIdleMinutes: 30, sleepMinIntervalHours: 8 },
    onRun: async () => ({ ok: true }),
    now: () => t,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => { cleared++; }
  });
  sleep.noteWrite();
  assert.equal(timers.length, 1, "first write arms an idle timer");
  assert.equal(timers[0].ms, 30 * 60000 + 1000, "armed against the full idle window");
  t += 5 * 60000;
  sleep.noteWrite();
  assert.equal(cleared, 1, "stale timer cleared, not left to fire early");
  assert.equal(timers.length, 2, "fresh timer armed on the write");
  assert.equal(timers[1].ms, 30 * 60000 + 1000, "re-armed against a full idle window from the write");
});

test("scheduler: noteWrite resets the idle clock", () => {
  const { service } = setup();
  let t = 1_000_000_000;
  let runs = 0;
  const sleep = createSleepScheduler({
    service,
    config: { sleepEnabled: true, sleepIdleMinutes: 30, sleepMinIntervalHours: 8 },
    onRun: async () => { runs++; return { ok: true }; },
    now: () => t
  });
  t += 30 * 60000 + 1000;
  sleep.noteWrite(); // a write arrives: idle clock resets
  assert.equal(sleep.shouldRun(t), false, "idle reset by noteWrite");
});

test("scheduler: disabled → never runs", () => {
  const { service } = setup();
  const sleep = createSleepScheduler({
    service,
    config: { sleepEnabled: false, sleepIdleMinutes: 0, sleepMinIntervalHours: 0 },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000
  });
  assert.equal(sleep.shouldRun(), false);
});

test("scheduler: onRun failure is swallowed, next window still opens", async () => {
  const { service } = setup();
  let t = 1_000_000_000;
  let calls = 0;
  const sleep = createSleepScheduler({
    service,
    config: { sleepEnabled: true, sleepIdleMinutes: 1, sleepMinIntervalHours: 1 },
    onRun: async () => { calls++; if (calls === 1) throw new Error("boom"); return { ok: true }; },
    now: () => t
  });
  t += 60 * 60000;
  assert.equal(await sleep.maybeSchedule(), false, "throwing run reports false");
  assert.equal(calls, 1);
  t += 3600000;
  assert.equal(await sleep.maybeSchedule(), true, "next window still opens");
  assert.equal(calls, 2);
});

// ------------------------------------------------------------ demotion

test("phase demotion: 30d → summary + _full_content, 90d → archived", async () => {
  const { store, service } = setup({ sleepArchiveDays: 30, sleepDeepArchiveDays: 90 });
  const long = "X".repeat(200);
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "A", content: long });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "B", content: "b content" });
  const { memory: c } = service.saveWithDedupe({ type: "project", title: "C", content: "c content" });
  backdate(store, a.id, 40);
  backdate(store, b.id, 100);
  // c stays fresh
  const ctx = sleepCtx();
  const result = await runSleep(ctx, service, { sleepEnabled: true, sleepArchiveDays: 30, sleepDeepArchiveDays: 90, policyEpoch: 1 }, ctx.logger, fakeSemantic());
  assert.ok(result.phases.demotion.demoted.includes(a.id), "40d unaccessed demoted");
  assert.ok(result.phases.demotion.archived.includes(b.id), "100d unaccessed archived");
  const aNow = store.getById(a.id);
  assert.equal(aNow.content, `${"X".repeat(120)}…`, "content truncated to summary");
  assert.equal(aNow._full_content, long, "full body preserved in _full_content");
  assert.equal(store.getById(b.id).archived, true);
  assert.equal(store.getById(c.id).archived, false);
  assert.equal(store.getById(c.id)._full_content, undefined);
});

test("demoteToSummary: minRefTimeMs skips freshly-accessed memories", () => {
  const store = createStore(":memory:");
  const a = store.save({ type: "project", title: "A", content: "x".repeat(200), importance: 3, tags: [], source: "test" });
  const b = store.save({ type: "project", title: "B", content: "y".repeat(200), importance: 3, tags: [], source: "test" });
  backdate(store, a.id, 40);
  backdate(store, b.id, 40);
  const cutoff = Date.now() - 30 * 86400000;
  // b was touched after the cutoff → must NOT be demoted.
  store.touchAccess(b.id);
  const aAfter = store.demoteToSummary(a.id, "A summary", { minRefTimeMs: cutoff });
  const bAfter = store.demoteToSummary(b.id, "B summary", { minRefTimeMs: cutoff });
  assert.ok(aAfter._full_content, "old memory demoted");
  assert.equal(bAfter._full_content, undefined, "freshly-accessed memory kept full");
});

test("phase demotion: never double-wraps an already-demoted memory", async () => {
  const { store, service } = setup({ sleepArchiveDays: 30, sleepDeepArchiveDays: 90 });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "A", content: "y".repeat(200) });
  backdate(store, a.id, 40);
  const ctx = sleepCtx();
  const first = await runSleep(ctx, service, { sleepEnabled: true, sleepArchiveDays: 30, sleepDeepArchiveDays: 90 }, ctx.logger, fakeSemantic());
  const demoted1 = store.getById(a.id);
  assert.equal(demoted1._full_content, "y".repeat(200));
  const second = await runSleep(ctx, service, { sleepEnabled: true, sleepArchiveDays: 30, sleepDeepArchiveDays: 90 }, ctx.logger, fakeSemantic());
  const demoted2 = store.getById(a.id);
  assert.equal(demoted2.content, demoted1.content, "content unchanged on replay");
  assert.equal(demoted2._full_content, "y".repeat(200), "_full_content not re-wrapped");
  assert.equal(first.phases.demotion.demoted.length, 1);
  assert.equal(second.phases.demotion.demoted.length, 0, "replay demotes nothing");
});

// ------------------------------------------------------------ patterns

test("phase patterns: LLM mints pattern memories with evidence tags + sleep audit", async () => {
  const { store, service } = setup({ sleepMaxPatterns: 5, policyEpoch: 1 });
  const { memory: m1 } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const { memory: m2 } = service.saveWithDedupe({ type: "project", title: "插件", content: "mneme" });
  const ctx = sleepCtx({
    onPattern: (text) => {
      const ids = [...text.matchAll(/id=([^\s|]+)/g)].map((x) => x[1]);
      assert.ok(ids.includes(m1.id) && ids.includes(m2.id), "pattern prompt lists both memories");
      return JSON.stringify([
        { action: "create", type: "pattern", title: "中文偏好", content: "用户偏好中文内容", importance: 3, evidence: [m1.id] }
      ]);
    }
  });
  const result = await runSleep(ctx, service, { sleepEnabled: true, sleepMaxPatterns: 5, policyEpoch: 1 }, ctx.logger);
  assert.equal(result.phases.patterns.status, "ok");
  assert.equal(result.phases.patterns.applied, 1);
  const patterns = store.list({ type: "pattern" });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].title, "中文偏好");
  assert.ok(patterns[0].tags.includes(`ev:${m1.id}`), "evidence ref stored as tag");
  // sleep run is audited with run_type=sleep
  const runs = store.listDreamRuns();
  assert.ok(runs.some((r) => r.run_type === "sleep" && r.status === "ok"), "sleep audit row written");
});

test("phase patterns: invalid LLM output fails the phase but not the run", async () => {
  const { store, service } = setup();
  const { memory: m1 } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = sleepCtx({
    onPattern: () => "[{ \"action\": \"create\", \"content\": \"no title\" }]"
  });
  const result = await runSleep(ctx, service, { sleepEnabled: true, sleepMaxPatterns: 5 }, ctx.logger);
  assert.equal(result.phases.patterns.status, "failed");
  assert.equal(result.status, "failed", "only substantive phase failed → failed");
  assert.equal(store.list({ type: "pattern" }).length, 0, "nothing created on invalid output");
  assert.equal(result.ok, false, "failed run reports ok=false");
});

test("phase patterns: fabricated evidence ids are filtered out", async () => {
  const { store, service } = setup({ sleepMaxPatterns: 5 });
  const { memory: m1 } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = sleepCtx({
    onPattern: () => JSON.stringify([
      { action: "create", type: "pattern", title: "偏好", content: "中文内容偏好", importance: 3, evidence: [m1.id, "made-up-id-123"] }
    ])
  });
  const result = await runSleep(ctx, service, { sleepEnabled: true, sleepMaxPatterns: 5 }, ctx.logger);
  assert.equal(result.phases.patterns.status, "ok");
  const patterns = store.list({ type: "pattern" });
  assert.equal(patterns.length, 1);
  assert.ok(patterns[0].tags.includes(`ev:${m1.id}`), "real evidence kept");
  assert.ok(!patterns[0].tags.some((t) => t === "ev:made-up-id-123"), "fabricated evidence dropped");
});

// ------------------------------------------------------------ conflicts

test("phase conflicts (freeze mode): conflicting pairs parked for review", async () => {
  const { store, service } = setup({ conflictFreezeEnabled: true });
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日" });
  const ctx = sleepCtx();
  const result = await runSleep(ctx, service, { sleepEnabled: true, conflictFreezeEnabled: true }, ctx.logger, fakeSemantic());
  assert.equal(result.phases.conflicts.status, "ok");
  assert.equal(result.phases.conflicts.frozen, 1);
  assert.equal(service.countConflictPending(), 1, "conflict parked");
  // no auto-arbitration in freeze mode
  assert.equal(store.getById(l.id).archived, false);
});

test("phase conflicts (LLM): winner kept, loser archived", async () => {
  const { store, service } = setup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日" });
  const ctx = sleepCtx({
    onConflict: () => JSON.stringify([{ action: "conflict", winner: w.id, loser: l.id, reason: "更新" }])
  });
  const result = await runSleep(ctx, service, { sleepEnabled: true }, ctx.logger, fakeSemantic());
  assert.equal(result.phases.conflicts.status, "ok");
  assert.equal(result.phases.conflicts.applied, 1);
  assert.equal(store.getById(l.id).archived, true, "loser archived");
  assert.equal(store.getById(w.id).archived, false, "winner kept");
});

test("phase conflicts: skipped without a semantic embedder", async () => {
  const { service } = setup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日" });
  const ctx = sleepCtx();
  const result = await runSleep(ctx, service, { sleepEnabled: true }, ctx.logger, null);
  assert.equal(result.phases.conflicts.status, "skipped");
});

test("phase conflicts: LLM omitting a pair defaults it to keep, phase survives", async () => {
  const { store, service } = setup();
  // 4 same-type memories → 2 deduped conflict pairs. The LLM only adjudicates
  // the first pair; the second pair's ids must be defaulted to keep, not fail
  // the whole phase with "missing from decisions".
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const { memory } = service.saveWithDedupe({ type: "decision", title: `D${i}`, content: `内容 ${i}` });
    ids.push(memory.id);
  }
  const ctx = sleepCtx({
    onConflict: (text) => {
      const [first, second] = [...text.matchAll(/id=([^\s|]+)/g)].map((m) => m[1]);
      assert.ok(first && second, "conflict prompt shows a pair");
      return JSON.stringify([{ action: "conflict", winner: first, loser: second, reason: "矛盾" }]);
    }
  });
  const result = await runSleep(ctx, service, { sleepEnabled: true }, ctx.logger, fakeSemantic());
  assert.equal(result.phases.conflicts.status, "ok", "phase survives partial LLM coverage");
  assert.equal(result.phases.conflicts.applied, 1, "only the adjudicated pair changed");
});

test("phase conflicts: empty LLM response → all pairs kept, phase is a noop not a failure", async () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "D1", content: "内容 1" });
  service.saveWithDedupe({ type: "decision", title: "D2", content: "内容 2" });
  const ctx = sleepCtx({ onConflict: () => "[]" });
  const result = await runSleep(ctx, service, { sleepEnabled: true }, ctx.logger, fakeSemantic());
  assert.equal(result.phases.conflicts.status, "noop", "no decisions → nothing changed, not failed");
  assert.equal(result.phases.conflicts.applied, 0);
});

// ------------------------------------------------------------ create validation

test("validateDecisions: valid create passes with empty snapshot", () => {
  const { ok, errors } = validateDecisions(
    [{ action: "create", type: "pattern", title: "P", content: "c", importance: 3, evidence: ["x"] }],
    new Map(),
    { maxCreatePerRun: 5 }
  );
  assert.equal(ok, true, errors.join("; "));
});

test("validateDecisions: create rejects missing title/content and over the cap", () => {
  const empty = new Map();
  const { ok: noTitle } = validateDecisions([{ action: "create", title: "", content: "c" }], empty);
  assert.equal(noTitle, false);
  const { ok: noContent } = validateDecisions([{ action: "create", title: "P" }], empty);
  assert.equal(noContent, false);
  const { ok: badType } = validateDecisions([{ action: "create", type: "explode", title: "P", content: "c" }], empty);
  assert.equal(badType, false);
  const cap = validateDecisions(
    Array.from({ length: 6 }, (_, i) => ({ action: "create", title: `P${i}`, content: "c" })),
    empty,
    { maxCreatePerRun: 5 }
  );
  assert.equal(cap.ok, false, "exceeding maxCreatePerRun rejects");
});

test("validateDecisions: create claims no ids, so it can't cover snapshot memories", () => {
  const snap = new Map([["a", { id: "a", type: "preference", title: "t", content: "c", importance: 3, archived: false, forgotten: false }]]);
  const { ok, errors } = validateDecisions([{ action: "create", title: "P", content: "c" }], snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing from decisions")), "create cannot claim snapshot ids");
});

// ------------------------------------------------------------ touch wiring

test("searchMemories touches last_accessed_at when sleep enabled", async () => {
  const { store, service } = setup({ sleepEnabled: true });
  const { memory } = service.saveWithDedupe({ type: "project", title: "插件", content: "y" });
  assert.equal(store.getById(memory.id).last_accessed_at, undefined);
  await service.searchMemories("插件");
  assert.ok(store.getById(memory.id).last_accessed_at, "recalled memory touched");
});

test("searchMemories does NOT touch when sleep disabled", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { memory } = service.saveWithDedupe({ type: "project", title: "插件", content: "y" });
  await service.searchMemories("插件");
  assert.equal(store.getById(memory.id).last_accessed_at, undefined, "no touch when sleep off");
});

test("injectCandidates touches injected items when sleep enabled", () => {
  const { store, service } = setup({ sleepEnabled: true });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const injected = service.injectCandidates();
  assert.ok(injected.length >= 1);
  assert.ok(store.getById(injected[0].id).last_accessed_at, "injected memory touched");
});

// ------------------------------------------------------------ whole-run

test("runSleep with empty store: all phases skip, status noop", async () => {
  const { store, service } = setup();
  const ctx = sleepCtx();
  const result = await runSleep(ctx, service, { sleepEnabled: true }, ctx.logger);
  assert.equal(result.status, "noop");
  assert.equal(result.ok, false);
  assert.equal(result.phases.conflicts.status, "skipped");
  assert.equal(result.phases.demotion.status, "noop");
  assert.equal(result.phases.patterns.status, "skipped");
  const runs = store.listDreamRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_type, "sleep");
  assert.equal(runs[0].status, "noop");
});
