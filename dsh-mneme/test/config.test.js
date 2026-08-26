import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config } from "../src/config.js";

// ---------------------------------------------------------------- rerank opt-in (item ⑥)

test("rerank is opt-in: default config does not enable the local reranker", () => {
  const cfg = Config({});
  assert.equal(cfg.rerankEnabled, false, "rerankEnabled defaults to false");
  assert.equal(cfg.rerankProvider, "none", "rerankProvider defaults to none");
  // The plugin gate in index.js: LocalReranker is only constructed when both
  // hold — under defaults the gate is closed, so onnxruntime is never loaded.
  assert.equal(cfg.rerankEnabled && cfg.rerankProvider === "local", false, "gate closed by default");
  const enabled = Config({ rerankEnabled: true, rerankProvider: "local" });
  assert.equal(enabled.rerankEnabled && enabled.rerankProvider === "local", true, "explicit opt-in opens the gate");
});

test("dream sliding window + implicit keep config defaults and bounds (v0.4.4)", () => {
  const cfg = Config({});
  assert.equal(cfg.dreamMaxSnapshotSize, 200, "window defaults to 200");
  assert.equal(cfg.dreamImplicitKeep, true, "implicit keep defaults to true");
  const capped = Config({ dreamMaxSnapshotSize: 1000 });
  assert.equal(capped.dreamMaxSnapshotSize, 1000, "upper bound accepted");
  const off = Config({ dreamImplicitKeep: false });
  assert.equal(off.dreamImplicitKeep, false, "implicit keep can be disabled");
});

test("injectTimePrefix is opt-in: default off, enabled explicitly (issue #34)", () => {
  const cfg = Config({});
  assert.equal(cfg.injectTimePrefix, false, "time prefix defaults to false (behavior unchanged)");
  const on = Config({ injectTimePrefix: true });
  assert.equal(on.injectTimePrefix, true, "explicit opt-in enables it");
});

test("dream explicit coverage threshold config defaults and bounds (v0.4.4 fix)", () => {
  const cfg = Config({});
  assert.equal(cfg.dreamMinExplicitCoverage, 0.5, "coverage threshold defaults to 0.5");
  const low = Config({ dreamMinExplicitCoverage: 0.1 });
  assert.equal(low.dreamMinExplicitCoverage, 0.1, "lower bound accepted");
  const high = Config({ dreamMinExplicitCoverage: 1 });
  assert.equal(high.dreamMinExplicitCoverage, 1, "upper bound accepted");
});

test("startup probe: the reranker module never statically imports transformers/onnxruntime", () => {
  // LocalReranker is imported eagerly by index.js, so a bare install must not
  // pull onnxruntime in at module load. The heavy load is a lazy dynamic import
  // that only runs inside init(), which index.js calls only when the opt-in gate
  // is open (rerankEnabled && rerankProvider === "local").
  const src = readFileSync(new URL("../src/reranker.js", import.meta.url), "utf8");
  assert.ok(
    !src.includes('from "@huggingface/transformers"'),
    "no static transformers.js import in reranker.js"
  );
  assert.match(src, /await import\("@huggingface\/transformers"\)/, "transformers.js loads lazily via dynamic import");
});
