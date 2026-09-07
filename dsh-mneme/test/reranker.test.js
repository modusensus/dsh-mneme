import test from "node:test";
import assert from "node:assert/strict";
import { LocalReranker } from "../src/reranker.js";

/** Injected scorer: records (query, passage) calls, returns a fixed score. */
function makeScorer(scoreOf) {
  const calls = [];
  const fn = async (query, passage) => {
    calls.push({ query, passage });
    return typeof scoreOf === "function" ? scoreOf(passage) : scoreOf;
  };
  return { fn, calls };
}

/** Fake feature-extraction engine: each input embeds to [1, k*0.25, 0, 0]. */
function makeFakeExtractor(dim = 4, calls = []) {
  let k = 0;
  const fn = async (texts) => {
    calls.push({ count: texts.length });
    const rows = texts.map(() => {
      const n = k++;
      return Array.from({ length: dim }, (__, j) => (j === 0 ? 1 : j === 1 ? n * 0.25 : 0));
    });
    const flat = Float32Array.from(rows.flat());
    return { data: flat, dims: [texts.length, dim] };
  };
  fn.dispose = () => {
    fn.disposed = true;
  };
  return fn;
}

/** Fake text-classification engine exposing tokenizer + model for the tc path. */
function makeFakeTc(logitsPerRow) {
  const tokenizer = (texts, opts) => ({ texts, text_pair: opts.text_pair });
  const model = async (inputs) => {
    const n = inputs.texts.length;
    const flat = new Float32Array(logitsPerRow.slice(0, n * 2));
    return { logits: { data: flat, dims: [n, 2] } };
  };
  return { tokenizer, model, dispose: () => {} };
}

function candidates(ids) {
  return ids.map((id) => ({ id, title: `T-${id}`, content: `C-${id}` }));
}

test("init with injected scorePair skips model loading", async () => {
  let factoryCalled = false;
  const { fn, calls } = makeScorer(0.7);
  const r = new LocalReranker({
    scorePair: fn,
    engineFactory: async () => {
      factoryCalled = true;
      throw new Error("should never load");
    }
  });
  await r.init();
  assert.equal(factoryCalled, false);
  const out = await r.rerank("q", candidates(["a"]));
  assert.deepEqual(out, [{ id: "a", score: 0.7 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "q");
  assert.equal(calls[0].passage, "T-a\nC-a");
});

test("rerank returns results sorted by descending score", async () => {
  const { fn } = makeScorer((p) => (p.includes("A") ? 0.9 : p.includes("B") ? 0.5 : 0.2));
  const r = new LocalReranker({ scorePair: fn });
  await r.init();
  const out = await r.rerank("q", candidates(["A", "B", "C"]));
  assert.deepEqual(out.map((x) => x.id), ["A", "B", "C"]);
  assert.deepEqual(out.map((x) => x.score), [0.9, 0.5, 0.2]);
});

test("rerank returns [] for empty candidates", async () => {
  const { fn } = makeScorer(0.9);
  const r = new LocalReranker({ scorePair: fn });
  await r.init();
  assert.deepEqual(await r.rerank("q", []), []);
});

test("rerank drops candidates below scoreThreshold", async () => {
  const { fn } = makeScorer((p) => (p.includes("A") ? 0.8 : p.includes("B") ? 0.4 : 0.05));
  const r = new LocalReranker({ scorePair: fn, scoreThreshold: 0.3 });
  await r.init();
  const out = await r.rerank("q", candidates(["A", "B", "C"]));
  assert.deepEqual(out.map((x) => x.id), ["A", "B"]);
});

test("rerank clamps scores into 0..1", async () => {
  const { fn } = makeScorer((p) => (p.includes("A") ? 1.5 : p.includes("B") ? -0.2 : NaN));
  const r = new LocalReranker({ scorePair: fn, scoreThreshold: 0 });
  await r.init();
  const out = await r.rerank("q", candidates(["A", "B", "C"]));
  assert.deepEqual(out.map((x) => x.score), [1, 0, 0]);
});

test("rerank truncates to maxCandidates", async () => {
  const { fn, calls } = makeScorer(0.6);
  const r = new LocalReranker({ scorePair: fn, maxCandidates: 2 });
  await r.init();
  const out = await r.rerank("q", candidates(["a", "b", "c", "d"]));
  assert.equal(calls.length, 2);
  assert.equal(out.length, 2);
});

test("passage falls back to title when content is missing", async () => {
  const { fn, calls } = makeScorer(0.8);
  const r = new LocalReranker({ scorePair: fn });
  await r.init();
  await r.rerank("q", [{ id: "x", title: "only-title", content: "" }]);
  assert.equal(calls[0].passage, "only-title");
});

test("rerank propagates injected scorer failures", async () => {
  const bad = async () => {
    throw new Error("scorer boom");
  };
  const r = new LocalReranker({ scorePair: bad });
  await r.init();
  await assert.rejects(() => r.rerank("q", candidates(["a"])), /scorer boom/);
});

test("rerank throws on non-array candidates", async () => {
  const r = new LocalReranker({ scorePair: async () => 0.5 });
  await r.init();
  await assert.rejects(() => r.rerank("q", "not-an-array"), /array/);
});

test("init throws when no strategy can load", async () => {
  const r = new LocalReranker({
    engineFactory: async () => {
      throw new Error("Unsupported pipeline");
    }
  });
  await assert.rejects(() => r.init(), /LocalReranker failed to load/);
});

test("init cascades rerank -> tc -> feature-extraction and batches", async () => {
  const calls = [];
  const loader = async (task) => {
    if (task === "feature-extraction") return makeFakeExtractor(4, calls);
    throw new Error(`Unsupported pipeline: ${task}`);
  };
  const r = new LocalReranker({ engineFactory: loader, batchSize: 2 });
  await r.init();
  const out = await r.rerank("q", candidates(["a", "b", "c"]));
  // Query k=0 [1,0,0,0]; a,b,c embed at k=1..3 -> cosine 0.970, 0.894, 0.8,
  // all above the default threshold.
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.id), ["a", "b", "c"]);
  assert.ok(out[0].score >= out[1].score && out[1].score >= out[2].score);
  // Query embed (cached) + two batches of size 2 and 1.
  assert.deepEqual(calls.map((c) => c.count), [1, 2, 1]);
  // Query vector is cached: a second rerank only makes batch calls.
  await r.rerank("q", candidates(["a", "b", "c"]));
  assert.deepEqual(calls.map((c) => c.count), [1, 2, 1, 2, 1]);
});

test("text-classification strategy scores via logit delta", async () => {
  const loader = async (task) => {
    if (task === "text-classification") return makeFakeTc([0, 1, 0, 0, -2, 2]);
    throw new Error(`Unsupported pipeline: ${task}`);
  };
  const r = new LocalReranker({ engineFactory: loader });
  await r.init();
  const out = await r.rerank("q", candidates(["A", "B", "C"]));
  // sigmoid(1-0)=0.731, sigmoid(0)=0.5, sigmoid(2-(-2))=0.982.
  assert.deepEqual(out.map((x) => x.id), ["C", "A", "B"]);
  assert.ok(Math.abs(out[0].score - 0.982) < 1e-3);
  assert.ok(Math.abs(out[1].score - 0.731) < 1e-3);
  assert.ok(Math.abs(out[2].score - 0.5) < 1e-3);
});

test("modelHash follows the embedder convention", () => {
  const a = new LocalReranker({ model: "Xenova/bge-reranker-base" });
  const b = new LocalReranker({ model: "Xenova/bge-reranker-base" });
  assert.equal(a.modelHash, b.modelHash);
  assert.match(a.modelHash, /^Xenova\/bge-reranker-base#[0-9a-f]+$/);
  assert.notEqual(a.modelHash, new LocalReranker({ model: "other/model" }).modelHash);
});

test("dispose releases the loaded pipeline", async () => {
  const extractor = makeFakeExtractor(4);
  const r = new LocalReranker({
    engineFactory: async (task) => {
      if (task === "feature-extraction") return extractor;
      throw new Error("Unsupported pipeline");
    }
  });
  await r.init();
  assert.ok(r.pipeline);
  r.dispose();
  assert.equal(r.pipeline, null);
  assert.equal(extractor.disposed, true);
});
