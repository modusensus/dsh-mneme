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
