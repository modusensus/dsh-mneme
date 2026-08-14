import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDreamScheduler,
  hashSnapshot,
  buildReceipt,
  parseReceipt,
  buildOutcome
} from "../src/dream.js";
import { applyDecisions } from "../src/dream/decisions.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// ---------------------------------------------------------------- helpers

/**
 * Minimal DSH-like ctx whose LLM distinguishes the two dream calls by the user
 * prompt shape: consolidation prompts start with "id=…", summary prompts with
 * "- title: content". `onConsolidation` receives the raw list text and returns
 * a decisions JSON string; `summaryText` (or a throw) drives the summary call.
 */
function mockCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文。" } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText) : "[]" };
          yield { type: "block-end", index: 0, block: { type: "text" } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        if (typeof summaryText === "string") {
          yield { type: "text-delta", index: 0, text: summaryText };
          yield { type: "finish", reason: { kind: "stop" } };
        } else {
          throw summaryText instanceof Error ? summaryText : new Error(String(summaryText));
        }
      }
    }
  };
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  return { store, service, dream };
}

// ---------------------------------------------------------------- audit rows

test("successful runDream writes an audit row with receipt, decisions and outcome", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);

  const runs = store.listDreamRuns();
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, "ok");
  assert.equal(run.input_count, 2);
  assert.equal(run.applied, 1);
  assert.equal(run.summary_stored, true);
  assert.equal(run.provider, "mock");
  assert.match(run.receipt, /^dsh-mneme:run:/);

  // receipt round-trips and correlates with the audit row
  const parsed = parseReceipt(run.receipt);
  assert.deepEqual(parsed, {
    runId: run.id,
    status: "ok",
    snapshotHash: run.snapshot_hash.slice(0, 12),
    inputCount: 2,
    applied: 1,
    summaryStored: true
  });

  // per-id outcome is derived correctly
  assert.equal(run.outcome.byId[a.id], "merge-archived");
  assert.equal(run.outcome.byId[b.id], "merge-keep");
  // raw decisions are stored for replay
  assert.equal(run.decisions.length, 1);
  assert.equal(run.decisions[0].action, "merge");
  // full input snapshot is persisted and its digest matches — the audit row
  // alone can rebuild the exact arbitration input offline
  assert.equal(run.input.length, 2);
  assert.deepEqual(run.input.map((m) => m.title).sort(), ["插件", "插件2"]);
  assert.equal(hashSnapshot(run.input), run.snapshot_hash, "input snapshot digest matches stored snapshot_hash");
  store.close();
});

test("failed runDream records status failed with the error", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = mockCtx({ onConsolidation: () => "抱歉，我无法处理这个任务" });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /no json array/);

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "failed");
  assert.equal(run.decisions, undefined);
  assert.match(run.error, /no json array/);
  const parsed = parseReceipt(run.receipt);
  assert.equal(parsed.status, "failed");
  store.close();
});

test("summary failure still records the applied decisions for replay", async () => {
  const { store, service, dream } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "keep", ids: [m.id] }]),
    summaryText: new Error("summary boom")
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "llm failed");

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "failed");
  assert.equal(run.decisions.length, 1, "decisions captured despite summary failure");
  assert.equal(run.outcome.byId[m.id], "keep");
  store.close();
});

test("audit rows persist across store reopen (file-backed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-audit-"));
  const path = join(dir, "memory.db");
  const s1 = createStore(path);
  s1.saveDreamRun({
    id: "run-1", status: "ok", snapshot_hash: "abc", input_count: 1,
    decisions: [{ action: "keep", ids: ["x"] }],
    outcome: { byId: { x: "keep" } }, applied: 0, summary_stored: false,
    receipt: "dsh-mneme:run:run-1:ok:abc:1:0:0"
  });
  s1.close();
  const s2 = createStore(path);
  const run = s2.getDreamRun("run-1");
  assert.equal(run.status, "ok");
  assert.equal(run.decisions[0].action, "keep");
  s2.close();
});

// ---------------------------------------------------------------- hashing & receipts

test("hashSnapshot is deterministic and order-independent", () => {
  const mk = (id, title, content = "c") => ({ id, type: "project", title, content, importance: 3, updated_at: "2026-01-01T00:00:00.000Z" });
  const a = mk("a", "t1");
  const b = mk("b", "t2");
  assert.equal(hashSnapshot([a, b]), hashSnapshot([b, a]), "order independent");
  assert.equal(hashSnapshot([a, b]), hashSnapshot([{ ...a }, { ...b }]), "field order / clone independent");
  assert.notEqual(hashSnapshot([a, b]), hashSnapshot([a, { ...b, content: "changed" }]), "content change flips hash");
});

test("receipt round-trips and malformed receipts parse to undefined", () => {
  const receipt = buildReceipt({ runId: "r1", status: "ok", snapshotHash: "0123456789abcdef", inputCount: 3, applied: 2, summaryStored: true });
  assert.deepEqual(parseReceipt(receipt), { runId: "r1", status: "ok", snapshotHash: "0123456789ab", inputCount: 3, applied: 2, summaryStored: true });
  for (const bad of ["nope", "", "dsh-mneme:run:r1", "dsh-mneme:run:r1:weird:abc:1:0:0", "dsh-mneme:run:r1:ok:abc:nan:0:0"]) {
    assert.equal(parseReceipt(bad), undefined, `rejects ${JSON.stringify(bad)}`);
  }
});

test("buildOutcome maps every decision action to per-id disposition", () => {
  const outcome = buildOutcome([
    { action: "keep", ids: ["k"] },
    { action: "archive", ids: ["a1", "a2"] },
    { action: "merge", ids: ["m1", "m2"], keepSource: "m1" },
    { action: "conflict", winner: "w", loser: "l" }
  ]);
  assert.equal(outcome.byId.k, "keep");
  assert.equal(outcome.byId.a1, "archived");
  assert.equal(outcome.byId.a2, "archived");
  assert.equal(outcome.byId.m1, "merge-keep");
  assert.equal(outcome.byId.m2, "merge-archived");
  assert.equal(outcome.byId.w, "conflict-winner");
  assert.equal(outcome.byId.l, "conflict-archived");
});

// ---------------------------------------------------------------- replayability

test("replaying a recorded decision list is idempotent", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月15日", importance: 4 });
  const { memory: b } = service.saveWithDedupe({ type: "decision", title: "截止新", content: "8月20日", importance: 5 });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "conflict", winner: b.id, loser: a.id, reason: "更新" }])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);

  const run = store.getDreamRun(result.runId);
  assert.equal(run.decisions[0].winner, b.id);
  assert.equal(run.outcome.byId[a.id], "conflict-archived");
  assert.equal(run.outcome.byId[b.id], "conflict-winner");

  // store already reflects the run
  assert.equal(store.getById(a.id).archived, true);
  assert.ok(store.getById(b.id).content.includes("已否决旧信息"), "provenance note appended");

  // replay the exact recorded decision list → no-op (idempotent)
  const replayed = applyDecisions(run.decisions, service);
  assert.equal(replayed, 0, "already-applied decisions re-apply nothing");
  assert.equal(store.getById(a.id).archived, true);
  assert.equal(store.getById(b.id).content, store.getById(b.id).content);
  store.close();
});

test("re-applying a decision many times has no cumulative side effects", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月15日", importance: 4 });
  const { memory: b } = service.saveWithDedupe({ type: "decision", title: "截止新", content: "8月20日", importance: 5 });
  const { memory: m1 } = service.saveWithDedupe({ type: "project", title: "甲", content: "旧甲", importance: 3 });
  const { memory: m2 } = service.saveWithDedupe({ type: "project", title: "乙", content: "旧乙", importance: 4 });
  const decisions = [
    { action: "conflict", winner: b.id, loser: a.id, reason: "更新" },
    { action: "merge", ids: [m1.id, m2.id], keepSource: m2.id, title: "甲乙", content: "合并", importance: 4 }
  ];
  // apply 3 times (e.g. concurrent/replayed dream runs)
  for (let i = 0; i < 3; i++) applyDecisions(decisions, service);

  const winner = store.getById(b.id);
  assert.equal(winner.content.split("已否决旧信息").length - 1, 1, "provenance note appended exactly once");
  assert.equal(store.getById(a.id).archived, true);
  assert.equal(store.getById(m2.id).title, "甲乙", "keeper merged");
  assert.equal(store.getById(m1.id).archived, true, "merge source archived once");
  store.close();
});
