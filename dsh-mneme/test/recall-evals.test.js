import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { Config } from "../src/config.js";

// Mock embedder: every query maps to the fixed vector [1,0,0], so vector recall
// surfaces any row embedded at [1,0,0] and excludes orthogonal ones.
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "eval#mock",
  dimension: 3
};

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

function saveMemory(service, title, content) {
  return service.saveWithDedupe({ type: "preference", title, content, importance: 5 }).memory;
}

// ---------------------------------------------------------------- schema / config

test("config: evalPersistTestResults defaults to false (opt-in)", () => {
  assert.equal(Config({}).evalPersistTestResults, false, "off by default");
  assert.equal(Config({ evalPersistTestResults: true }).evalPersistTestResults, true, "explicit opt-in");
});

test("schema: recall_evals table exists with the expected columns", () => {
  const store = createStore(":memory:");
  const cols = store.db.prepare("PRAGMA table_info(recall_evals)").all().map((c) => c.name);
  for (const col of ["id", "recall_run_id", "query", "expected_ids", "actual_ids", "metrics", "eval_type", "created_at"]) {
    assert.ok(cols.includes(col), `column ${col} present`);
  }
  // FK clause is declared against recall_runs.
  const fks = store.db.prepare("PRAGMA foreign_key_list(recall_evals)").all();
  assert.ok(fks.some((fk) => fk.table === "recall_runs" && fk.from === "recall_run_id"), "FK to recall_runs(id) declared");
  store.close();
});

test("legacy DB without recall_evals is upgraded idempotently on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-recall-evals-"));
  const dbPath = join(dir, "memory.db");
  try {
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE recall_runs (
        id TEXT PRIMARY KEY, query TEXT NOT NULL, mode TEXT NOT NULL,
        top_k INTEGER, threshold REAL, candidates TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO recall_runs (id, query, mode, candidates, created_at) VALUES ('r1', '旧', 'keyword', '[]', 't');
    `);
    old.close();
    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(recall_evals)").all().map((c) => c.name);
    assert.ok(cols.includes("id"), "recall_evals created on a legacy DB");
    assert.equal(store.getRecallRun("r1").query, "旧", "legacy recall_runs row preserved");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- switch-off / switch-on

test("switch off: evaluateRetrieval computes metrics but writes nothing", async () => {
  const { store, service } = setup({}); // evalPersistTestResults defaults false
  const m = saveMemory(service, "量子计算入门", "叠加态");
  const res = await service.evaluateRetrieval("量子", [m.id], { mode: "keyword", topK: 10 });
  assert.ok(res.metrics.precision >= 0 && res.metrics.precision <= 1, "metrics computed");
  assert.deepEqual(res.actualIds, [m.id], "retrieval ran and returned the memory");
  assert.equal(res.persisted, false, "no persistence when switch is off");
  assert.deepEqual(store.listRecallEvals(), [], "recall_evals stays empty");
  store.close();
});

test("switch on: evaluateRetrieval persists a recall_evals snapshot", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  const m = saveMemory(service, "量子计算入门", "叠加态");
  const res = await service.evaluateRetrieval("量子", [m.id], { mode: "keyword", topK: 10, evalType: "regression" });
  assert.equal(res.persisted, true, "snapshot persisted");
  const evals = store.listRecallEvals();
  assert.equal(evals.length, 1, "one eval row");
  const row = evals[0];
  assert.equal(row.query, "量子");
  assert.deepEqual(row.expected_ids, [m.id], "expected ids round-trip");
  assert.deepEqual(row.actual_ids, [m.id], "actual ids round-trip");
  assert.equal(row.eval_type, "regression");
  assert.ok(row.metrics && typeof row.metrics.precision === "number", "metrics JSON round-trips");
  assert.ok(typeof row.created_at === "string" && row.created_at.length > 0, "timestamp captured");
  // Idempotent on id: the same logical eval id replays without duplicates.
  store.saveRecallEval({ id: "ev-x", query: "q", expected_ids: [], actual_ids: [], metrics: {}, eval_type: "manual" });
  store.saveRecallEval({ id: "ev-x", query: "q2", expected_ids: [], actual_ids: [], metrics: {}, eval_type: "manual" });
  assert.equal(store.listRecallEvals().filter((e) => e.id === "ev-x").length, 1, "replay overwrites, no duplicate");
  store.close();
});

test("persist override: call-level persist:true writes even with the switch off", async () => {
  const { store, service } = setup({}); // switch off
  const m = saveMemory(service, "量子计算入门", "叠加态");
  const res = await service.evaluateRetrieval("量子", [m.id], { mode: "keyword", persist: true });
  assert.equal(res.persisted, true, "explicit persist override honored");
  assert.equal(store.listRecallEvals().length, 1);
  store.close();
});

test("persist override: call-level persist:false suppresses even with the switch on", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  saveMemory(service, "量子计算入门", "叠加态");
  const res = await service.evaluateRetrieval("量子", [], { mode: "keyword", persist: false });
  assert.equal(res.persisted, false, "explicit opt-out honored");
  assert.deepEqual(store.listRecallEvals(), [], "nothing written");
  store.close();
});

// ---------------------------------------------------------------- metrics correctness

test("metrics: computeRetrievalMetrics is exact for known inputs", () => {
  const { service } = setup();
  // a,b,c retrieved; a,x expected → 1 relevant at rank 1.
  assert.deepEqual(
    service.computeRetrievalMetrics(["a", "b", "c"], ["a", "x"]),
    { precision: 0.3333, recall: 0.5, mrr: 1, hit_count: 1 }
  );
  // relevant at rank 3 → mrr 1/3.
  assert.deepEqual(
    service.computeRetrievalMetrics(["x", "y", "a"], ["a", "b"]),
    { precision: 0.3333, recall: 0.5, mrr: 0.3333, hit_count: 1 }
  );
  // empty retrieval → zero metrics, no divide-by-zero.
  assert.deepEqual(
    service.computeRetrievalMetrics([], ["a", "b"]),
    { precision: 0, recall: 0, mrr: 0, hit_count: 0 }
  );
  // everything relevant, nothing missed → perfect scores.
  assert.deepEqual(
    service.computeRetrievalMetrics(["a", "b"], ["a", "b"]),
    { precision: 1, recall: 1, mrr: 1, hit_count: 2 }
  );
  // extra noise harms precision but not recall.
  assert.deepEqual(
    service.computeRetrievalMetrics(["a", "b", "c", "d"], ["a"]),
    { precision: 0.25, recall: 1, mrr: 1, hit_count: 1 }
  );
});

test("metrics: integration — partial hit scores precision/recall/mrr from real recall", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  const hit = saveMemory(service, "量子计算入门", "叠加态");
  saveMemory(service, "量子纠缠", "贝尔态");
  saveMemory(service, "猫咪饲养", "喂食");
  const res = await service.evaluateRetrieval("量子", [hit.id], { mode: "keyword", topK: 10 });
  // Two literal 量子 hits retrieved, one relevant → precision 1/2, recall 1/1.
  // Title-tied, equal-importance rows order by updated_at DESC, so the later
  // saved 量子纠缠 ranks first and the relevant row is at rank 2 → mrr 1/2.
  assert.equal(res.metrics.hit_count, 1);
  assert.equal(res.metrics.precision, 0.5);
  assert.equal(res.metrics.recall, 1);
  assert.equal(res.metrics.mrr, 0.5);
  const row = store.listRecallEvals()[0];
  assert.equal(row.metrics.precision, 0.5, "persisted metrics match");
  store.close();
});

// ---------------------------------------------------------------- FK linkage

test("FK: recordRecall=true links the eval to the recall_runs audit row", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  const m = saveMemory(service, "量子计算入门", "叠加态");
  const res = await service.evaluateRetrieval("量子", [m.id], { mode: "keyword", topK: 5, recordRecall: true });
  assert.ok(res.recallRunId, "a recall run was recorded for the same scene");
  assert.equal(store.listRecallRuns().length, 1, "exactly one recall_runs row");
  const run = store.getRecallRun(res.recallRunId);
  assert.equal(run.query, "量子");
  const evals = store.listRecallEvals();
  assert.equal(evals.length, 1);
  assert.equal(evals[0].recall_run_id, res.recallRunId, "eval links to the recorded run");
  store.close();
});

test("FK: explicit recallRunId is preserved — recordRecall never clobbers it (regression)", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  const m = saveMemory(service, "量子计算入门", "叠加态");
  // Pre-existing audit run the evaluator wants to link against.
  const run = store.saveRecallRun({
    query: "量子", mode: "keyword", topK: 5, candidates: [], created_at: new Date().toISOString()
  });
  // recordRecall=true alongside an explicit recallRunId: the explicit link wins,
  // and NO extra recall_runs row is minted.
  const res = await service.evaluateRetrieval("量子", [m.id], { mode: "keyword", recordRecall: true, recallRunId: run.id });
  assert.equal(res.recallRunId, run.id, "explicit recallRunId preserved");
  assert.equal(store.listRecallRuns().length, 1, "no duplicate recall_runs row minted");
  const evals = store.listRecallEvals();
  assert.equal(evals[0].recall_run_id, run.id, "eval links to the pre-existing run");
  store.close();
});

test("FK: recordRecall=false leaves recall_run_id null and writes no recall_runs row", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  const m = saveMemory(service, "量子计算入门", "叠加态");
  const res = await service.evaluateRetrieval("量子", [m.id], { mode: "keyword" });
  assert.equal(res.recallRunId, null, "no run recorded by default");
  assert.deepEqual(store.listRecallRuns(), [], "recall_runs untouched by evals");
  const row = store.listRecallEvals()[0];
  assert.ok(!row.recall_run_id, "eval row has no recall_run_id");
  store.close();
});

// ---------------------------------------------------------------- production isolation

test("production search never writes recall_evals, even with the switch on", async () => {
  const { store, service } = setup({ evalPersistTestResults: true });
  // Mimic src/index.js wiring: the recall recorder persists to recall_runs.
  service.setRecallRecorder((recall) => {
    store.saveRecallRun({
      query: recall.query, mode: recall.mode, topK: recall.topK, threshold: recall.threshold ?? null,
      candidates: recall.candidates ?? [], created_at: recall.createdAt
    });
  });
  saveMemory(service, "量子计算入门", "叠加态");
  const rows = await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.ok(rows.length >= 1, "search returned results");
  assert.equal(store.listRecallRuns().length, 1, "production audit lands in recall_runs");
  assert.deepEqual(store.listRecallEvals(), [], "recall_evals stays untouched by production search");
  store.close();
});
