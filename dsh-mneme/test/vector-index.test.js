import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createVectorIndex } from "../src/vector-index.js";

// Focused unit tests for the vector-index layer: model fingerprint (drift
// detection), embedding save/search/delete, incremental rebuild, and stats.
// The store is used directly (createStore(":memory:")) since vector-index is a
// thin layer over the store's embedding column + vector_meta table.

function setup() {
  const store = createStore(":memory:");
  const vectorIndex = createVectorIndex({ store });
  return { store, vectorIndex };
}

// Add a memory via the store and (optionally) set its embedding vector.
function addMemory(store, { title, content, type = "preference", vector }) {
  const memory = store.save({ type, title, content, tags: [], importance: 3 });
  if (vector) store.setEmbedding(memory.id, vector);
  return memory;
}

// Embedder mock for rebuildIndex. NOTE: the rebuild guard checks
// `typeof embedder.embed === "function"` while the inner loop calls
// `embedder.embedSingle` — so a rebuild-ready mock must provide both.
function rebuildEmbedder({ vector = [1, 0, 0], modelHash = "mock#rebuild", dimension = 3 } = {}) {
  return {
    embed: async (texts) => texts.map(() => vector),
    embedSingle: async () => vector,
    modelHash,
    dimension
  };
}

test("modelHash drift detection: markModel records and replaces the fingerprint", () => {
  const { vectorIndex } = setup();

  // No model recorded yet.
  assert.equal(vectorIndex.modelHash(), undefined);
  assert.equal(vectorIndex.dimension(), undefined);

  vectorIndex.markModel("model#v1", 3);
  assert.equal(vectorIndex.modelHash(), "model#v1");
  assert.equal(vectorIndex.dimension(), 3);

  // Switching to a different model updates the fingerprint (drift signal).
  vectorIndex.markModel("model#v2", 5);
  assert.equal(vectorIndex.modelHash(), "model#v2");
  assert.equal(vectorIndex.dimension(), 5);
});

test("saveEmbedding + search recall with cosine ordering", () => {
  const { store, vectorIndex } = setup();
  // Three memories with distinct 3-d vectors.
  const a = addMemory(store, { title: "猫", content: "喜欢猫", vector: [1, 0, 0] });
  const b = addMemory(store, { title: "狗", content: "喜欢狗", vector: [0, 1, 0] });
  const c = addMemory(store, { title: "虎", content: "喜欢老虎", vector: [0.5, 0.5, 0] });

  const hits = vectorIndex.search([1, 0, 0], { limit: 10, threshold: 0 });
  assert.equal(hits.length, 3, "all embedded rows participate");
  assert.equal(hits[0].id, a.id, "exact vector match ranks first");
  assert.ok(Math.abs(hits[0].score - 1) < 1e-9, "self cosine is 1");

  // Cosine ordering: [1,0,0] vs c = 0.5/sqrt(0.5) ≈ 0.7071 > vs b = 0.
  assert.equal(hits[1].id, c.id, "higher cosine ranks before orthogonal");
  assert.ok(Math.abs(hits[1].score - 0.5 / Math.sqrt(0.5)) < 1e-9, "c score is dot/sqrt(nb)");
  assert.equal(hits[2].id, b.id, "orthogonal vector ranks last");
  assert.ok(Math.abs(hits[2].score) < 1e-9, "orthogonal cosine is 0");

  // threshold filters low-similarity rows out.
  const filtered = vectorIndex.search([1, 0, 0], { limit: 10, threshold: 0.9 });
  assert.deepEqual(filtered.map((h) => h.id), [a.id], "only the 1.0 match passes threshold 0.9");
});

test("deleteEmbedding clears the cached vector; getEmbedding reflects it", () => {
  const { store, vectorIndex } = setup();
  const m = addMemory(store, { title: "备忘", content: "临时内容", vector: [1, 0, 0] });

  assert.deepEqual(vectorIndex.getEmbedding(m.id), [1, 0, 0]);

  vectorIndex.deleteEmbedding(m.id);
  assert.equal(vectorIndex.getEmbedding(m.id), undefined, "deleted embedding reads as undefined");
  assert.equal(vectorIndex.getStats().embeddedCount, 0, "count drops after delete");

  // Save again restores it.
  vectorIndex.saveEmbedding(m.id, [0, 0, 1]);
  assert.deepEqual(vectorIndex.getEmbedding(m.id), [0, 0, 1]);
});

test("rebuildIndex embeds only rows missing an embedding and marks the model", async () => {
  const { store, vectorIndex } = setup();
  // One memory already embedded, two missing.
  addMemory(store, { title: "已有向量", content: "A", vector: [0, 1, 0] });
  addMemory(store, { title: "缺向量1", content: "B" });
  addMemory(store, { title: "缺向量2", content: "C" });
  assert.equal(vectorIndex.getStats().embeddedCount, 1);

  const seen = [];
  const embedder = rebuildEmbedder({ vector: [1, 0, 0], modelHash: "mock#rebuild", dimension: 3 });
  embedder.embedSingle = async (text) => { seen.push(text); return [1, 0, 0]; };

  const result = await vectorIndex.rebuildIndex(embedder, { limit: 100 });
  assert.equal(result.indexed, 2, "two missing embeddings written");
  assert.equal(result.skipped, 0);
  assert.equal(vectorIndex.getStats().embeddedCount, 3, "all rows embedded after rebuild");
  assert.equal(seen.length, 2, "embedSingle called once per missing row");

  // Rebuild is a no-op once everything is embedded.
  const again = await vectorIndex.rebuildIndex(embedder, { limit: 100 });
  assert.equal(again.indexed, 0);
  assert.equal(again.skipped, 0);

  // Model fingerprint marked from the rebuild embedder.
  assert.equal(vectorIndex.modelHash(), "mock#rebuild");
  assert.equal(vectorIndex.dimension(), 3);
});

test("rebuildIndex handles a throwing embedder without failing the batch", async () => {
  const { store, vectorIndex } = setup();
  addMemory(store, { title: "好行", content: "A" });
  addMemory(store, { title: "坏行", content: "B" });
  addMemory(store, { title: "空行", content: "C" });

  let calls = 0;
  const embedder = rebuildEmbedder({ modelHash: "mock#throwing" });
  embedder.embedSingle = async () => {
    calls++;
    if (calls === 2) throw new Error("model unavailable");
    if (calls === 3) return []; // empty vector → not counted
    return [1, 0, 0];
  };

  const result = await vectorIndex.rebuildIndex(embedder, { limit: 100 });
  assert.equal(result.indexed, 1, "only the successful row is indexed");
  assert.equal(result.skipped, 2, "thrown + empty rows count as skipped");
  assert.equal(vectorIndex.getStats().embeddedCount, 1);
});

test("rebuildIndex guard: embedder without embed() is ignored", async () => {
  const { store, vectorIndex } = setup();
  addMemory(store, { title: "缺向量", content: "A" });
  const bare = { embedSingle: async () => [1, 0, 0], modelHash: "mock#bare", dimension: 3 };
  const result = await vectorIndex.rebuildIndex(bare, { limit: 100 });
  assert.deepEqual(result, { indexed: 0, skipped: 0 }, "guard returns early when embed() is missing");
  assert.equal(vectorIndex.modelHash(), undefined, "no model marked");
});

test("getStats reports embedded/total counts and model metadata", () => {
  const { store, vectorIndex } = setup();
  addMemory(store, { title: "甲", content: "1", vector: [1, 0, 0] });
  addMemory(store, { title: "乙", content: "2", vector: [0, 1, 0] });
  addMemory(store, { title: "丙", content: "3" });

  let stats = vectorIndex.getStats();
  assert.equal(stats.embeddedCount, 2);
  assert.equal(stats.totalCount, 3);
  assert.equal(stats.modelHash, undefined);
  assert.equal(stats.dimension, undefined);
  assert.equal(stats.updatedAt, undefined);

  vectorIndex.markModel("model#v3", 4);
  stats = vectorIndex.getStats();
  assert.equal(stats.modelHash, "model#v3");
  assert.equal(stats.dimension, 4);
  assert.ok(typeof stats.updatedAt === "string" && stats.updatedAt.length > 0, "updatedAt set");
});

test("incremental update: saveEmbedding overwrites the cached vector and search reflects it", () => {
  const { store, vectorIndex } = setup();
  const a = addMemory(store, { title: "主题", content: "A", vector: [1, 0, 0] });
  const b = addMemory(store, { title: "对照", content: "B", vector: [0, 1, 0] });

  // Before overwrite: query for B's vector ranks b first.
  let hits = vectorIndex.search([0, 1, 0], { limit: 10, threshold: 0 });
  assert.equal(hits[0].id, b.id);

  // Overwrite a's vector so it now points at b's direction.
  vectorIndex.saveEmbedding(a.id, [0, 1, 0]);
  assert.deepEqual(vectorIndex.getEmbedding(a.id), [0, 1, 0]);
  assert.equal(vectorIndex.getStats().embeddedCount, 2, "overwrite does not change the count");

  hits = vectorIndex.search([0, 1, 0], { limit: 10, threshold: 0 });
  assert.equal(hits.length, 2);
  // Tie: identical vectors both score 1; ordering between them is stable by id — we
  // only assert the overwritten row now participates with a full score.
  const aHit = hits.find((h) => h.id === a.id);
  assert.ok(Math.abs(aHit.score - 1) < 1e-9, "overwritten vector scores 1 against the query");
});

test("search returns empty when nothing is embedded", () => {
  const { store, vectorIndex } = setup();
  addMemory(store, { title: "无向量", content: "A" });
  addMemory(store, { title: "也无向量", content: "B" });
  assert.deepEqual(vectorIndex.search([1, 0, 0], { limit: 10 }), []);
});
