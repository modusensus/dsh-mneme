import test from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, runFusionBenchmark, seedService, TEST_CASES } from "../scripts/benchmark-recall.js";

// The benchmark harness must stay a working evaluation: it runs the real
// searchMemories pipeline over the seeded store and the fused configuration
// must not fall behind the legacy one (that is the whole point of the third
// recall path).
test("benchmark harness runs both configurations", async () => {
  const report = await runBenchmark({ topK: 5 });
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs[0].config, "legacy");
  assert.equal(report.runs[1].config, "fused");
  for (const run of report.runs) {
    assert.equal(run.rows.length, TEST_CASES.length);
    assert.ok(run.recallAtK >= 0 && run.recallAtK <= 1);
  }
});

test("fused configuration never trails legacy on Recall@5", async () => {
  const report = await runBenchmark({ topK: 5 });
  const [legacy, fused] = report.runs;
  assert.ok(
    fused.recallAtK >= legacy.recallAtK,
    `fused (${fused.recallAtK}) must be >= legacy (${legacy.recallAtK})`
  );
});

test("test cases cover the scattered-term BM25 territory", () => {
  assert.ok(TEST_CASES.length >= 10);
  assert.ok(TEST_CASES.some((tc) => tc.expected.length >= 2), "multi-target cases present");
  for (const tc of TEST_CASES) {
    assert.ok(tc.query && tc.expected.length > 0);
  }
});

// --- PR1: recall fusion recipes + signal transparency ---------------------

test("fusion-recipe A/B runs blend/rrf/minmax with valid recall on the seed corpus", async () => {
  const report = await runFusionBenchmark({ topK: 5 });
  assert.deepEqual(report.runs.map((r) => r.config), ["blend", "rrf", "minmax"]);
  for (const run of report.runs) {
    assert.equal(run.rows.length, TEST_CASES.length, `${run.config} covers every query`);
    assert.ok(run.recallAtK >= 0 && run.recallAtK <= 1, `${run.config} recallAtK in [0,1]`);
    assert.ok(run.avgMrr >= 0 && run.avgMrr <= 1, `${run.config} avgMrr in [0,1]`);
  }
});

test("signalTransparency decorates rows with per-source signals", async () => {
  const svc = seedService({ recallFusion: "blend", signalTransparency: true });
  const rows = await svc.searchMemories("rust 异步", { mode: "auto", topK: 5, useRerank: false });
  assert.ok(rows.length > 0, "the seed corpus returns hits for a scattered-term query");
  for (const r of rows) {
    assert.equal(typeof r.signals, "object", "each row carries a signals object");
    assert.equal(typeof r.signals.final, "number", "signals carries the fused final score");
    assert.ok([
      "keyword" in r.signals,
      "vector" in r.signals,
      "bm25" in r.signals
    ].some(Boolean), "at least one source signal is present");
  }
});

test("recallFusion recipes produce distinct fused scores for the same memory", async () => {
  const scores = {};
  for (const recipe of ["blend", "rrf", "minmax"]) {
    const svc = seedService({ recallFusion: recipe });
    const rows = await svc.searchMemories("rust 异步", { mode: "auto", topK: 5, useRerank: false });
    const hit = rows.find((r) => r.id === "mem_async_pattern") ?? rows[0];
    assert.ok(hit, `${recipe} surfaces a hit`);
    scores[recipe] = hit.score ?? 0;
  }
  // RRF is rank-based (Σ 1/(k+rank+1)) and minmax normalizes before blending,
  // so they must not all collapse onto the same numeric score.
  assert.ok(new Set(Object.values(scores)).size > 1, `recipes score differently: ${JSON.stringify(scores)}`);
});
