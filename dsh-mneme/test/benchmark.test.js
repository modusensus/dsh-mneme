import test from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, TEST_CASES } from "../scripts/benchmark-recall.js";

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
