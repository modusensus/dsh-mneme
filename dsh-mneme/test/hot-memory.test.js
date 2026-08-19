import test from "node:test";
import assert from "node:assert/strict";
import { createHotMemory, estimateTokens } from "../src/hot-memory.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// --- hot memory buffer ---

test("hot memory keeps the latest rounds within maxRounds", () => {
  const hot = createHotMemory({ maxRounds: 2, maxTokens: 10000 });
  hot.add({ query: "第一轮", response: "答一" });
  hot.add({ query: "第二轮", response: "答二" });
  hot.add({ query: "第三轮", response: "答三" });
  assert.equal(hot.rounds().length, 2);
  assert.ok(hot.getContext().includes("第三轮"));
  assert.ok(!hot.getContext().includes("第一轮"));
});

test("hot memory enforces the token budget", () => {
  const hot = createHotMemory({ maxRounds: 10, maxTokens: 30 });
  hot.add({ query: "很长的第一轮问题".repeat(10), response: "很长的回答".repeat(10) });
  hot.add({ query: "第二轮", response: "答二" });
  // The first round alone blows the budget; the newest round survives and
  // the buffer never empties completely.
  const rounds = hot.rounds();
  assert.ok(rounds.length >= 1);
  assert.equal(rounds[rounds.length - 1].query, "第二轮");
});

test("hot memory getContext uses the Q/A round format", () => {
  const hot = createHotMemory({ maxRounds: 5, maxTokens: 10000 });
  hot.add({ query: "Q1", response: "A1" });
  hot.add({ query: "Q2", response: "A2" });
  assert.equal(hot.getContext(), "Q: Q1\nA: A1\n\nQ: Q2\nA: A2");
});

test("hot memory ignores empty rounds and clears", () => {
  const hot = createHotMemory({ maxRounds: 5, maxTokens: 10000 });
  hot.add({ query: "", response: "x" });
  hot.add(null);
  assert.equal(hot.rounds().length, 0);
  hot.add({ query: "q" });
  hot.clear();
  assert.equal(hot.getContext(), "");
});

test("estimateTokens counts CJK heavier than ASCII", () => {
  assert.ok(estimateTokens("中文内容") > estimateTokens("abcd"));
});

// --- entry defense: non-positive / non-integer bounds fall back to defaults ---
// Bug: createHotMemory({ maxRounds: -1 }) made the eviction while-loop
// `while (buffer.length > maxRounds)` unbounded — after the buffer emptied,
// `0 > -1` stayed true and buffer.shift() on an empty array is a no-op, so
// every add() spun forever. Non-integer values (1.5, NaN, null) were also
// silently wrong. The fix clamps them to the 5/2000 defaults at the door.

test("hot memory falls back to maxRounds=5 for non-positive/invalid values", () => {
  for (const bad of [0, -1, 1.5, NaN, null]) {
    const hot = createHotMemory({ maxRounds: bad, maxTokens: 10000 });
    for (let i = 0; i < 8; i++) hot.add({ query: `第${i}轮`, response: "x" });
    assert.equal(hot.rounds().length, 5, `maxRounds=${bad} must fall back to 5, no infinite loop`);
    assert.ok(hot.getContext().includes("第7轮"), `maxRounds=${bad}: newest round survives`);
    assert.ok(!hot.getContext().includes("第0轮"), `maxRounds=${bad}: oldest round evicted`);
  }
});

test("hot memory falls back to maxTokens=2000 for non-positive/infinite values", () => {
  for (const bad of [0, -1, Infinity]) {
    const hot = createHotMemory({ maxRounds: 50, maxTokens: bad });
    // 50 rounds at ~74 tokens each blow a 2000-token budget; the fallback must
    // evict into (1, 50). A broken budget of 0/-1 would squeeze to 1 round and
    // Infinity would keep all 50 — both are the pre-fix behavior.
    for (let i = 0; i < 50; i++) hot.add({ query: `第${i}轮`, response: "长回答".repeat(40) });
    const n = hot.rounds().length;
    assert.ok(n > 1 && n < 50, `maxTokens=${bad} falls back to 2000 (kept ${n} rounds)`);
  }
});

// --- service-level: BM25 fusion + semantic dedup + selective injection ---

function toyVec(text) {
  const v = new Array(64).fill(0);
  for (const t of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function setup(overrides = {}) {
  const store = createStore(":memory:");
  const config = {
    entitySearchEnabled: false,
    bm25SearchEnabled: true,
    adaptiveThresholdEnabled: false,
    searchSemanticDedup: true,
    selectiveInjectEnabled: true,
    ...overrides
  };
  const service = createService({ store, mirror: null, config, logger: null });
  service.setVectorIndex(createVectorIndex({ store, logger: null }));
  service.setEmbedder({ embedSingle: async (t) => toyVec(t) });
  return { store, service };
}

test("searchMemories fuses BM25: scattered-term queries recall both rows", async () => {
  const { store, service } = setup();
  const a = store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });
  const b = store.save({ type: "decision", title: "语言迁移", content: "编译模块迁移到 Rust", importance: 3 });
  store.save({ type: "project", title: "无关", content: "夜间 ETL 脚本", importance: 3 });

  // "rust 异步" is not a substring of either row — LIKE misses both; BM25
  // must surface both rows in the merged result.
  const results = await service.searchMemories("rust 异步", { mode: "auto", topK: 5 });
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(a.id), "async row must be recalled via BM25");
  assert.ok(ids.includes(b.id), "rust row must be recalled via BM25");
  assert.equal(results.find((r) => r.id === a.id)?.source, "bm25");
});

test("bm25SearchEnabled=false restores the two-path behavior", async () => {
  const { store, service } = setup({ bm25SearchEnabled: false });
  const a = store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });
  const results = await service.searchMemories("rust 异步", { mode: "auto", topK: 5 });
  assert.ok(!results.some((r) => r.id === a.id), "no BM25 → scattered-term miss is back");
});

test("search-time semantic dedup drops near-identical embeddings", async () => {
  const { store, service } = setup();
  const a = store.save({ type: "project", title: "偏好 A", content: "用户喜欢深色主题编辑器", importance: 3 });
  const b = store.save({ type: "project", title: "偏好 A 备份", content: "用户喜欢深色主题编辑器（备份）", importance: 3 });
  store.setEmbedding(a.id, toyVec("用户喜欢深色主题编辑器"));
  store.setEmbedding(b.id, toyVec("用户喜欢深色主题编辑器"));

  // auto (not keyword): keyword mode is the documented text-only path and is
  // exempt from dedup by design; auto exercises the dedup the way production
  // searches run.
  const results = await service.searchMemories("深色主题", { mode: "auto", topK: 5 });
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(a.id) !== ids.includes(b.id), "one of the near-duplicate pair is dropped");
});

test("searchSemanticDedup=false keeps duplicate embeddings", async () => {
  const { store, service } = setup({ searchSemanticDedup: false });
  const a = store.save({ type: "project", title: "偏好 A", content: "用户喜欢深色主题编辑器", importance: 3 });
  const b = store.save({ type: "project", title: "偏好 A 备份", content: "用户喜欢深色主题编辑器（备份）", importance: 3 });
  store.setEmbedding(a.id, toyVec("用户喜欢深色主题编辑器"));
  store.setEmbedding(b.id, toyVec("用户喜欢深色主题编辑器"));
  const results = await service.searchMemories("深色主题", { mode: "keyword", topK: 5 });
  assert.equal(results.length, 2);
});

test("selective injection re-orders candidates by query similarity", () => {
  const { store, service } = setup();
  const thesis = store.save({ type: "project", title: "湿地论文", content: "毕业论文研究城市湿地公园", importance: 5 });
  const plugin = store.save({ type: "project", title: "插件项目", content: "dsh-mneme 记忆插件开发", importance: 5 });
  store.setEmbedding(thesis.id, toyVec("毕业论文研究城市湿地公园"));
  store.setEmbedding(plugin.id, toyVec("dsh-mneme 记忆插件开发"));

  // Rule-based order would put both at equal importance; the query vector is
  // about the thesis, so topic ranking must put the thesis memory first.
  const picked = service.injectCandidates({
    query: "论文写作",
    queryVector: toyVec("毕业论文研究城市湿地公园"),
    maxItems: 2,
    threshold: 3
  });
  assert.equal(picked[0].id, thesis.id);
  assert.ok(picked.some((m) => m.id === plugin.id));
});
