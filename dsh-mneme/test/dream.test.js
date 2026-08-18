import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions, applyDecisions, createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { mockCtx } from "./helpers/dream-mock.js";

function snapshot(ids, type = "project") {
  return new Map(ids.map((id, i) => [id, { id, type, title: `t${i}`, content: `c${i}`, importance: 3, archived: false, forgotten: false }]));
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

test("uncovered snapshot memories are auto-filled with keep (implicit keep, v0.4.4)", () => {
  const snap = snapshot(["a", "b"]);
  const decisions = [{ action: "keep", ids: ["a"] }];
  const { ok, errors } = validateDecisions(decisions, snap);
  assert.equal(ok, true, errors.join("; "));
  assert.equal(decisions.length, 2, "keep appended for the uncovered snapshot id");
  assert.ok(decisions.some((d) => d.action === "keep" && d.ids.includes("b")), "b auto-kept");
});

test("dreamImplicitKeep=false keeps the strict full-coverage validation", () => {
  const snap = snapshot(["a", "b"]);
  const decisions = [{ action: "keep", ids: ["a"] }];
  const { ok, errors } = validateDecisions(decisions, snap, { dreamImplicitKeep: false });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing from decisions")));
});

test("duplicate ids within one decision reject", () => {
  const { ok } = validateDecisions([{ action: "keep", ids: ["a", "a"] }], snapshot(["a"]));
  assert.equal(ok, false);
});

test("merge importance out of range rejects", () => {
  const snap = snapshot(["a", "b"]);
  for (const importance of [0, 6, 99, 1.5, "4"]) {
    const { ok, errors } = validateDecisions([
      { action: "merge", ids: ["a", "b"], keepSource: "a", title: "t", content: "c", importance }
    ], snap);
    assert.equal(ok, false, `importance=${JSON.stringify(importance)} rejected`);
    assert.ok(errors.some((e) => e.includes("importance")), `importance error present for ${JSON.stringify(importance)}`);
  }
  const { ok } = validateDecisions([
    { action: "merge", ids: ["a", "b"], keepSource: "a", title: "t", content: "c", importance: 5 }
  ], snap);
  assert.equal(ok, true, "importance 5 accepted");
});

test("merge across types rejects", () => {
  const snap = new Map([
    ["p", { id: "p", type: "preference", title: "语言", content: "中文", importance: 3, archived: false, forgotten: false }],
    ["j", { id: "j", type: "project", title: "插件", content: "内容", importance: 3, archived: false, forgotten: false }]
  ]);
  const { ok, errors } = validateDecisions([
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "合并", content: "合并内容", importance: 4 }
  ], snap);
  assert.equal(ok, false, "cross-type merge rejected");
  assert.ok(errors.some((e) => e.includes("multiple types")), "multi-type error present");
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
  const { applied } = applyDecisions([
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
  const { applied } = applyDecisions([{ action: "archive", ids: ["ghost"], reason: "x" }], service);
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
  const { applied, failures } = applyDecisions([
    { action: "archive", ids: [a.id], reason: "x" },
    { action: "archive", ids: [b.id], reason: "y" }
  ], service, logger);
  assert.equal(applied, 1, "throwing decision not counted, surviving decision counted");
  assert.equal(failures.length, 1, "thrown decision reported as a failure");
  assert.equal(store.getById(a.id).archived, false, "throwing decision left no partial effect");
  assert.equal(store.getById(b.id).archived, true, "later decision still applied");
  assert.equal(warnings.length, 1, "logger called once");
  assert.match(warnings[0], /failed to apply archive at index 0: boom/);
});

test("applyDecisions conflict with missing loser skips cleanly", () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { applied } = applyDecisions([{ action: "conflict", winner: w.id, loser: "ghost", reason: "x" }], service);
  assert.equal(applied, 0);
  assert.equal(store.getById(w.id).archived, false, "winner untouched");
  assert.ok(!store.getById(w.id).content.includes("已否决"), "no provenance note appended");
});

test("applyDecisions merge with missing keeper skips cleanly", () => {
  const { store, service } = dreamSetup();
  const { applied } = applyDecisions([
    { action: "merge", ids: ["ghost"], keepSource: "ghost", title: "t", content: "c" }
  ], service);
  assert.equal(applied, 0);
  assert.equal(store.getById("ghost"), undefined);
});

test("applyDecisions merge without importance falls back to max source importance", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const { applied } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", keepSource: b.id }
  ], service);
  assert.equal(applied, 1);
  assert.equal(store.getById(b.id).importance, 4, "keeper keeps max of source importances");
  assert.equal(store.getById(a.id).archived, true, "source archived");
});

test("maybeSchedule triggers when count exceeds threshold", () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; },
    thresholdCount: 3,
    thresholdChars: 5000,
    delayMs: 0
  });
  for (let i = 0; i < 3; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(100) });
  const pending = dream.maybeSchedule(service);
  assert.equal(pending, true, "scheduled");
  assert.equal(runs, 0, "not run yet (async)");
  store.close();
});

test("maybeSchedule does not trigger below threshold", () => {
  const { store, service } = dreamSetup();
  const dream = createDreamScheduler({ onRun: async () => {}, thresholdCount: 10, thresholdChars: 5000, delayMs: 0 });
  service.saveWithDedupe({ type: "project", title: "only", content: "x" });
  assert.equal(dream.maybeSchedule(service), false);
  store.close();
});

test("scheduler fires async and resets baseline", async () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5
  });
  for (let i = 0; i < 2; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(50) });
  dream.maybeSchedule(service);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 1, "ran once");
  // still above threshold but baseline reset → no immediate re-trigger
  assert.equal(dream.maybeSchedule(service), false, "baseline prevents loop");
  store.close();
});

test("failed run does not refresh baseline: next write re-triggers", async () => {
  const { store, service } = dreamSetup();
  let calls = 0;
  const dream = createDreamScheduler({
    onRun: async () => {
      calls++;
      return { ok: false, error: "llm failed" };
    },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x".repeat(10) });
  service.saveWithDedupe({ type: "project", title: "b", content: "y".repeat(10) });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, "run attempted once");
  // baseline NOT refreshed on failure → the same write volume still triggers
  assert.equal(dream.maybeSchedule(service), true, "failed run keeps baseline, re-schedules");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2, "retried after failure");
  store.close();
});

test("noop run (nothing changed) does not refresh baseline: next write re-triggers", async () => {
  const { store, service } = dreamSetup();
  let calls = 0;
  const dream = createDreamScheduler({
    onRun: async () => { calls++; return { ok: false, status: "noop", applied: 0, summary: false }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x".repeat(10) });
  service.saveWithDedupe({ type: "project", title: "b", content: "y".repeat(10) });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, "run attempted once");
  // a noop is not a success: the baseline stays put so the accumulated writes
  // are still owed and the next write re-schedules instead of being absorbed
  assert.equal(dream.maybeSchedule(service), true, "noop keeps baseline, re-schedules");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2, "retried after noop");
  store.close();
});

test("throwing run does not refresh baseline and is logged", async () => {
  const { store, service } = dreamSetup();
  const warnings = [];
  let calls = 0;
  const dream = createDreamScheduler({
    onRun: async () => {
      calls++;
      throw new Error("boom");
    },
    thresholdCount: 1, thresholdChars: 0, delayMs: 5,
    logger: { warn: (msg) => warnings.push(msg) }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1, "run attempted once");
  assert.ok(warnings.some((m) => m.includes("run failed")), "throw logged");
  assert.equal(dream.maybeSchedule(service), true, "throw keeps baseline, re-schedules");
  store.close();
});

test("maybeSchedule returns false while a run is in flight", async () => {
  const { store, service } = dreamSetup();
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = false;
  const dream = createDreamScheduler({
    onRun: async () => { entered = true; await gate; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "first schedule accepted");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(entered, true, "run started");
  assert.equal(dream.maybeSchedule(service), false, "no schedule while running");
  release();
  await new Promise((r) => setTimeout(r, 10)); // let the run finish + baseline refresh
  store.close();
});

test("dispose clears pending timer and blocks future scheduling", async () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 5,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  dream.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 0, "pending run cancelled by dispose");
  assert.equal(dream.maybeSchedule(service), false, "disposed scheduler never schedules");
  store.close();
});

test("dispose awaits an in-flight run so the store can close safely", async () => {
  const { store, service } = dreamSetup();
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = false;
  let finished = false;
  const dream = createDreamScheduler({
    onRun: async () => { entered = true; await gate; finished = true; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(entered, true, "run started");

  const disposeP = dream.dispose();
  let settled = false;
  disposeP.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "dispose must not resolve while a run is in flight");
  assert.equal(finished, false, "run still pending");

  release();
  await disposeP;
  assert.equal(finished, true, "run completed before dispose resolved");
  store.close();
});

test("runDream stores summary and applies decisions", async () => {
  const { store, service } = dreamSetup();
  // seed 2 memories so snapshot is non-empty and decisions cover them
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  const b = service.saveWithDedupe({ type: "project", title: "旧2", content: "第二段内容" });
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        if (calls === 1) {
          const text = JSON.stringify([
            { action: "merge", ids: [a.memory.id, b.memory.id], title: "合并标题", content: "合并后的内容", importance: 4, keepSource: a.memory.id }
          ]);
          yield { type: "text-delta", text };
        } else {
          yield { type: "text-delta", text: "记忆库总览摘要文本" };
        }
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "merge decision applied");
  assert.equal(result.summary, true, "summary stored");
  const keeper = store.getById(a.memory.id);
  assert.equal(keeper.title, "合并标题", "keeper title updated");
  assert.equal(keeper.content, "合并后的内容", "keeper content updated");
  assert.equal(keeper.importance, 4, "keeper importance updated");
  assert.equal(store.getById(b.memory.id).archived, true, "merged source archived");
  const summary = store.all().find((m) => m.type === "summary");
  assert.ok(summary, "summary created");
  assert.equal(summary.title, "记忆库总览");
  assert.equal(summary.content, "记忆库总览摘要文本");
  store.close();
});

test("runDream fails safe on invalid decisions", async () => {
  const { store, service } = dreamSetup();
  const saved = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  let calls = 0;
  const warnings = [];
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        yield { type: "text-delta", text: calls === 1 ? "not json at all" : "summary" };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: (msg) => warnings.push(msg) }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, false, "invalid decisions rejected");
  assert.equal(result.summary, false, "no summary flag on failure");
  assert.equal(store.all().filter((m) => m.type === "summary").length, 0, "no summary on failure");
  const lang = store.getById(saved.memory.id);
  assert.ok(lang, "original memory still present");
  assert.equal(lang.archived, false, "original memory not archived");
  assert.equal(lang.content, "中文", "original memory content untouched");
  assert.ok(warnings.length >= 1, "failure was logged");
  store.close();
});

// --- item ①: CAS guard against concurrent edits ----------------------------

test("applyDecisions CAS: merge onto a concurrently-edited target is skipped as a conflict, not applied", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  // snapshot captured before the "LLM call"; a concurrent edit lands meanwhile
  const snapshot = new Map([a.id, b.id].map((id) => [id, store.getById(id)]));
  service.update(a.id, { content: "并发编辑" });
  const { applied, conflicts, committed } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }
  ], service, null, snapshot);
  assert.equal(applied, 0, "decision skipped entirely");
  assert.equal(conflicts.length, 1, "recorded as a CAS conflict");
  assert.equal(committed.length, 0, "nothing committed");
  assert.equal(store.getById(a.id).content, "并发编辑", "concurrent edit preserved");
  assert.equal(store.getById(b.id).archived, false, "source not archived");
  assert.equal(store.getById(b.id).title, "插件2", "keeper untouched");
  store.close();
});

test("applyDecisions CAS: update to a concurrently-edited memory is skipped as a conflict", () => {
  const { store, service } = dreamSetup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "喜欢 Python" });
  const snapshot = new Map([[m.id, store.getById(m.id)]]);
  service.update(m.id, { content: "并发改动" });
  const { applied, conflicts } = applyDecisions(
    [{ action: "update", ids: [m.id], content: "喜欢 Rust" }],
    service, null, snapshot
  );
  assert.equal(applied, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(store.getById(m.id).content, "并发改动", "concurrent edit wins");
  store.close();
});

test("applyDecisions without a snapshot skips the CAS guard (replay path unchanged)", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  service.update(a.id, { content: "并发编辑" }); // concurrent edit
  const { applied, conflicts } = applyDecisions([
    { action: "archive", ids: [a.id], reason: "x" }
  ], service);
  assert.equal(applied, 1, "snapshotless replay applies (no CAS guard)");
  assert.equal(conflicts.length, 0);
  assert.equal(store.getById(a.id).archived, true);
  store.close();
});

// --- item ②: per-decision transaction atomicity ----------------------------

test("applyDecisions merge is atomic: a throwing archive step rolls back the keeper update too", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "甲", content: "旧甲", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "乙", content: "旧乙", importance: 4 });
  const originalSetArchived = service.setArchived;
  service.setArchived = (id, archived) => {
    if (id === a.id) throw new Error("archive boom");
    return originalSetArchived.call(service, id, archived);
  };
  const warnings = [];
  const { applied, failures, committed } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "甲乙", content: "合并", importance: 4, keepSource: b.id }
  ], service, { warn: (m) => warnings.push(m) });
  assert.equal(applied, 0, "merge not committed");
  assert.equal(failures.length, 1, "reported as a failure");
  assert.equal(committed.length, 0, "outcome must not claim a merge that rolled back");
  assert.equal(store.getById(b.id).title, "乙", "keeper title untouched by the rolled-back update");
  assert.equal(store.getById(b.id).content, "旧乙", "keeper content untouched");
  assert.equal(store.getById(a.id).archived, false, "source not archived");
  assert.ok(warnings.length >= 1, "failure logged");
  store.close();
});

// --- conflict freeze: manual review instead of auto-adjudication ----------

function freezeCtx({ conflicts, includes = [], summaryText = "记忆库总览摘要" }) {
  let calls = 0;
  const warnings = [];
  const ctx = {
    warnings,
    llm: {
      stream: async function* () {
        calls++;
        const list = [...includes, ...conflicts];
        yield { type: "text-delta", text: calls === 1 ? JSON.stringify(list) : summaryText };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: (m) => warnings.push(m) }
  };
  return ctx;
}

test("runDream with conflictFreezeEnabled parks conflicts instead of adjudicating", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新，候选取新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", conflictFreezeEnabled: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0, "no conflict applied");
  assert.equal(result.frozen, 1, "one conflict frozen");
  // pending row recorded for human review
  const pending = store.listConflictPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "日期更新，候选取新");
  // neither side was auto-adjudicated
  assert.equal(store.getById(l.id).archived, false, "loser NOT archived");
  assert.equal(store.getById(w.id).archived, false, "winner NOT archived");
  assert.ok(!store.getById(w.id).content.includes("已否决旧信息"), "no provenance note appended");
  // audit outcome marks both sides pending
  const run = store.listDreamRuns()[0];
  assert.equal(run.outcome.byId[w.id], "conflict-pending");
  assert.equal(run.outcome.byId[l.id], "conflict-pending");
  assert.equal(run.status, "ok", "summary stored + freeze landed → ok");
  assert.equal(store.listReceipts().length, 0, "no conflict receipt for a frozen (unapplied) conflict");
  store.close();
});

test("runDream freeze keeps auto-adjudication when disabled (default)", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "更新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "conflict auto-adjudicated when freeze is off");
  assert.equal(result.frozen, 0);
  assert.equal(store.getById(l.id).archived, true, "loser archived");
  assert.ok(store.getById(w.id).content.includes("已否决旧信息"), "provenance note appended");
  assert.equal(store.listConflictPending().length, 0, "no pending rows in auto mode");
  store.close();
});

test("runDream freeze applies non-conflict decisions while parking conflicts", async () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({
    includes: [{ action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }],
    conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }]
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", conflictFreezeEnabled: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "merge applied normally");
  assert.equal(result.frozen, 1, "conflict frozen");
  assert.equal(store.getById(b.id).title, "插件总览", "merge keeper updated");
  assert.equal(store.getById(a.id).archived, true, "merge source archived");
  assert.equal(store.getById(l.id).archived, false, "conflict loser untouched by the merge run");
  const pending = store.listConflictPending();
  assert.equal(pending.length, 1);
  assert.ok(pending[0].reason.includes("日期更新"));
  store.close();
});

test("runDream freeze respects conflictFreezeMaxPending cap and skips overflow", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "x" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat",
    conflictFreezeEnabled: true, conflictFreezeMaxPending: 0
  });
  assert.equal(result.frozen, 0, "nothing frozen at capacity");
  assert.equal(store.listConflictPending().length, 0, "no pending rows");
  assert.ok(ctx.warnings.some((m) => m.includes("freeze queue full")), "capacity warning logged");
  store.close();
});

test("runDream freeze store failure never blocks the run (fail-safe)", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  service.saveConflictPending = () => { throw new Error("pending store boom"); };
  service.countConflictPending = () => { throw new Error("count boom"); };
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "x" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", conflictFreezeEnabled: true
  });
  assert.equal(result.ok, true, "run completes despite freeze store failure");
  assert.equal(result.frozen, 0, "nothing frozen");
  assert.ok(ctx.warnings.length >= 1, "freeze failure logged");
  assert.equal(store.getById(l.id).archived, false, "no side effects on memories");
  assert.equal(store.getById(w.id).content, "8月20日", "winner untouched");
  store.close();
});

// --- v0.4.4: 大记忆量 autoDream（滑动窗口 + 隐式 keep）回归 -----------------

test("autoDream with 650 memories: sliding window truncates snapshot + implicit keep fills uncovered ids", async () => {
  const { store, service } = dreamSetup();
  // seed 650 memories — the size that used to produce 677 "missing from
  // decisions" errors and applied=0 under the strict full-coverage check
  for (let i = 0; i < 650; i++) {
    service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
  }
  // mock LLM claims only a small subset (20 archives) and never emits keeps
  // for the rest — implicit keep must auto-fill the uncovered snapshot ids
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=\d+/g)]
        .map((m) => m[1]);
      return JSON.stringify(ids.slice(0, 20).map((id) => ({ action: "archive", ids: [id], reason: "stale" })));
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamMaxSnapshotSize: 200,
    // mock only claims 20/200 = 10%; the implicit-keep coverage floor must be
    // lowered so this deliberate "tiny explicit claim" scenario still passes
    // (it exercises the window + keep-fill, not the coverage guard)
    dreamMinExplicitCoverage: 0.1
  });
  assert.equal(result.ok, true, "run succeeds instead of 677-error rejection");
  assert.ok(result.applied > 0, "archive decisions applied");
  // snapshot capped at the sliding window
  const run = store.listDreamRuns()[0];
  assert.equal(run.input_count, 200, "snapshot truncated to dreamMaxSnapshotSize");
  // decisions cover exactly the snapshot window, with implicit keeps
  assert.equal(result.decisions.length, 200, "decisions count = snapshot count");
  assert.equal(result.decisions.filter((d) => d.action === "archive").length, 20, "claimed subset present");
  assert.equal(result.decisions.filter((d) => d.action === "keep").length, 180, "uncovered ids auto-kept");
  assert.equal(store.getById(result.decisions.find((d) => d.action === "archive").ids[0]).archived, true, "an archive landed");
  store.close();
});

// --- v0.4.4 fix: 残缺输出防洗白（显式覆盖率下限） + 严格模式透传 --------------

test("validateDecisions rejects a truncated output whose explicit coverage is below the floor", () => {
  const snap = snapshot(["a", "b", "c", "d"]);
  const decisions = [{ action: "keep", ids: ["a"] }]; // claims 1/4 = 25%
  const { ok, errors } = validateDecisions(decisions, snap, { dreamMinExplicitCoverage: 0.5 });
  assert.equal(ok, false, "low explicit coverage rejects the whole list");
  assert.ok(
    errors.some((e) => e.includes("explicit decision coverage 25% < minimum 50%")),
    `coverage error present, got: ${errors.join("; ")}`
  );
  assert.equal(decisions.length, 1, "no keep-fill pushed on rejection (nothing washed white)");
});

test("validateDecisions covers the whole snapshot when explicit coverage meets the floor", () => {
  const snap = snapshot(["a", "b", "c", "d"]);
  const decisions = [{ action: "archive", ids: ["a", "b"], reason: "stale" }]; // claims 2/4 = 50%
  const { ok, errors } = validateDecisions(decisions, snap, { dreamMinExplicitCoverage: 0.5 });
  assert.equal(ok, true, errors.join("; "));
  assert.equal(decisions.length, 3, "archive + 2 implicit keeps for c/d");
  assert.equal(decisions.filter((d) => d.action === "keep").length, 2);
});

test("runDream with dreamImplicitKeep=false rejects a partial mock output (missing from decisions)", async () => {
  const { store, service } = dreamSetup();
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
  }
  // mock only claims the first snapshot id, misses the rest — strict mode must
  // reject the whole run instead of auto-keeping the uncovered ids
  const warnings = [];
  const ctx = {
    warnings,
    logger: { warn: (m) => warnings.push(m) },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "stress-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          const ids = [...userText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=\d+/g)].map((m) => m[1]);
          yield { type: "text-delta", index: 0, text: JSON.stringify(ids.slice(0, 1).map((id) => ({ action: "archive", ids: [id], reason: "stale" }))) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览摘要" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat",
    dreamImplicitKeep: false
  });
  assert.equal(result.ok, false, "strict mode rejects the partial output");
  assert.match(result.error, /invalid decisions: \d+ errors/);
  assert.ok(warnings.some((m) => m.includes("missing from decisions")), "warned which ids are missing");
  assert.equal(store.listDreamRuns()[0].status, "failed", "run audited as failed");
  store.close();
});

test("runDream sliding window keeps the newest N memories and excludes the oldest", async () => {
  const { store, service } = dreamSetup();
  // seed 5 memories, backdate updated_at so i=0 is oldest (5h ago), i=4 newest (1h ago)
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const { memory } = service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
    ids.push(memory.id);
  }
  for (let i = 0; i < 5; i++) {
    const old = new Date(Date.now() - (5 - i) * 3600000).toISOString();
    store.db.prepare("UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?").run(old, old, ids[i]);
  }
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const inWindow = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=\d+/g)]
        .map((m) => m[1]);
      return JSON.stringify(inWindow.map((id) => ({ action: "keep", ids: [id] })));
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamMaxSnapshotSize: 3
  });
  const run = store.listDreamRuns()[0];
  assert.equal(run.input_count, 3, "window capped at dreamMaxSnapshotSize");
  const windowIds = run.input.map((m) => m.id).sort();
  const expected = [ids[2], ids[3], ids[4]].sort(); // newest 3 by updated_at
  assert.deepEqual(windowIds, expected, "window contains the newest 3 memories");
  assert.ok(!windowIds.includes(ids[0]), "oldest memory excluded from the window");
  assert.equal(result.decisions.length, 3, "decisions cover exactly the window");
  store.close();
});

// --- v0.4.4 fix: 决策 JSON schema 固化（kimi 等模型输出合规） -----------------

test("consolidation prompt pins the decision schema (action field, single-string winner/loser, single claim per id)", async () => {
  const { store, service } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  let systemText = "";
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream(options) {
        systemText = options.messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "";
        yield { type: "text-delta", text: "[]" };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  // 字段名必须写死为 action（kimi 曾输出 "type" 导致整单拒绝）
  assert.match(systemText, /"action"/, "prompt names the action field");
  assert.match(systemText, /严禁写成\s*type/, "prompt forbids the type field name");
  // conflict winner/loser 是单个 id 字符串而非数组
  assert.match(systemText, /"winner"/, "prompt names the winner field");
  assert.match(systemText, /"loser"/, "prompt names the loser field");
  assert.match(systemText, /单个 id 字符串/, "winner/loser must be a single id string");
  assert.match(systemText, /不是数组|绝不是数组/, "winner/loser must not be an array");
  // 同一 id 不可被多个决策重复 claim
  assert.match(systemText, /最多被 claim 一次/, "each memory claimed at most once");
  // 决策 JSON 示例块
  assert.match(systemText, /决策 JSON 示例/, "prompt includes a canonical example block");
  store.close();
});
