import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// 回归（issue #198）：注入渲染是同步的（宿主 systemPrompt 不支持异步 text），
// 查询向量只能异步 prefetch 给下一轮用——首轮 queryVectorCache 必 miss。
// 此时 injectCandidates 落到静态 priority 排序（summary > preference >
// importance×quality）：老的高重要性 preference 会占满全部槽位，当前话题的
// decision/project 进不来（报告者库：427 活跃、29 条 imp=5 preference）。
// 修复：首轮同步兜底用 BM25 词法召回领位（纯进程内、无需向量）；语义向量
// 命中时行为不变（向量 > 缓存召回 > BM25 > 静态排序）。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

// 与查询词法完全不相交的旧高价值 preference（双字组不重叠）
function seedStalePreferences(service, n = 8) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(service.saveWithDedupe({
      type: "preference",
      title: `旧偏好条目${i}`,
      content: `用户喜欢深色界面与紧凑排版，这是第${i}条历史偏好存档`
    , importance: 5 }).memory.id);
  }
  return ids;
}

test("#198: first round (no vector) leads with BM25 topical hits, not stale preferences", () => {
  const { service, store } = setup();
  seedStalePreferences(service, 8);
  const onTopic = service.saveWithDedupe({
    type: "decision",
    title: "夜航限流选型",
    content: "决定采用令牌桶做夜航App的限流方案，阈值按用户等级分层",
    importance: 3
  }).memory;

  const picked = service.injectCandidates({ query: "夜航App令牌桶限流方案怎么设计的", maxItems: 5, threshold: 3 });
  assert.ok(picked.some((m) => m.id === onTopic.id), "on-topic decision must enter the first-round block");
  assert.equal(picked[0].id, onTopic.id, "BM25 topical hit leads the block");
  store.close();
});

test("#198: legacy static order is kept when bm25 is disabled", () => {
  const { service, store } = setup({ bm25SearchEnabled: false });
  seedStalePreferences(service, 8);
  const onTopic = service.saveWithDedupe({
    type: "decision",
    title: "夜航限流选型",
    content: "决定采用令牌桶做夜航App的限流方案，阈值按用户等级分层",
    importance: 3
  }).memory;

  const picked = service.injectCandidates({ query: "夜航App令牌桶限流方案怎么设计的", maxItems: 5, threshold: 3 });
  assert.ok(!picked.some((m) => m.id === onTopic.id), "bm25 off -> legacy static order (preferences fill the slots)");
  store.close();
});

test("#198: vector hits still outrank BM25 when a queryVector is available", async () => {
  const { service, store } = setup();
  seedStalePreferences(service, 3);
  // 词法与查询不相交、但向量命中的记忆：语义路径必须压过 BM25 词法路径。
  const vectorHit = service.saveWithDedupe({
    type: "project",
    title: "星图渲染重构",
    content: "星图渲染重构记录：绘制管线迁移与图层合并",
    importance: 3
  }).memory;
  const bm25Hit = service.saveWithDedupe({
    type: "decision",
    title: "夜航限流选型",
    content: "决定采用令牌桶做夜航App的限流方案，阈值按用户等级分层",
    importance: 3
  }).memory;
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  vectorIndex.saveEmbedding(vectorHit.id, [1, 0, 0]);

  const picked = service.injectCandidates({ query: "夜航App令牌桶限流方案怎么设计的", maxItems: 5, threshold: 3, queryVector: [1, 0, 0] });
  assert.equal(picked[0].id, vectorHit.id, "vector hit leads; BM25 only fills the gap when no vector");
  assert.ok(picked.some((m) => m.id === bm25Hit.id), "BM25 hit still present among candidates");
  store.close();
});
