import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

// 回归（issue #202）：检索路径的固定成本。此前 searchVector 每次调用
// SELECT * 全表 + 逐行 JSON.parse（993 × 512 维 ≈ 48ms，余弦本身只占 3%），
// all() 拖着 embedding 列（5k 行 ≈ 9.4MB）且 ORDER BY 无索引走临时 B 树。
// 本批修复：updated_at 索引入 schema；all() 显式列清单排除 embedding；
// searchVector 只取 id 列 + 解析缓存（setEmbedding 为单一失效点）+ Top-N 回表。

function make() {
  const store = createStore(":memory:");
  return store;
}

test("#202: updated_at index is created on open (existing DBs included)", () => {
  const store = make();
  const row = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_updated'"
  ).get();
  assert.ok(row, "idx_memories_updated exists after open");
  store.close();
});

test("#202: all() returns full rows (minus embedding) ordered by updated_at desc", () => {
  const store = make();
  store.save({ type: "project", title: "旧", content: "c1", importance: 3 });
  store.save({ type: "decision", title: "新", content: "c2", importance: 3 });
  const rows = store.all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "新", "most recently updated first");
  for (const row of rows) {
    assert.equal(row.content?.length > 0, true, "content present");
    assert.equal("embedding" in row, false, "embedding never leaks into row objects");
  }
  store.close();
});

test("#202: searchVector cache invalidates on setEmbedding rewrite", () => {
  const store = make();
  const { id } = store.save({ type: "project", title: "A", content: "a" });
  store.setEmbedding(id, [1, 0, 0]);

  // 第一次检索：缓存 v1（[1,0,0] 方向命中）
  const hitV1 = store.searchVector([1, 0, 0], { limit: 5 });
  assert.equal(hitV1[0]?.id, id, "v1 direction matches");

  // 重写为正交向量后，旧方向必须不再命中、新方向命中——缓存失效点生效。
  // （正交余弦=0，threshold=0 会连 0 分一起入选，所以用 0.5 的阈值区分。）
  store.setEmbedding(id, [0, 1, 0]);
  const hitStale = store.searchVector([1, 0, 0], { limit: 5, threshold: 0.5 });
  assert.equal(hitStale.some((r) => r.id === id), false, "stale vector must not match after rewrite");
  const hitV2 = store.searchVector([0, 1, 0], { limit: 5 });
  assert.equal(hitV2[0]?.id, id, "new vector matches after rewrite");
  store.close();
});

test("#202: setEmbedding(null) drops the row from vector search", () => {
  const store = make();
  const { id } = store.save({ type: "project", title: "A", content: "a" });
  store.setEmbedding(id, [1, 0, 0]);
  assert.equal(store.searchVector([1, 0, 0], { limit: 5 }).length, 1);
  store.setEmbedding(id, null);
  assert.equal(store.searchVector([1, 0, 0], { limit: 5 }).length, 0, "cleared embedding leaves the search set");
  store.close();
});

test("#202: searchVector returns full memory rows with scores, sorted desc", () => {
  const store = make();
  const a = store.save({ type: "project", title: "标题A", content: "内容A", importance: 4 });
  const b = store.save({ type: "decision", title: "标题B", content: "内容B", importance: 2 });
  store.setEmbedding(a.id, [1, 0, 0]);
  store.setEmbedding(b.id, [0.6, 0.8, 0]);

  const hits = store.searchVector([1, 0, 0], { limit: 5 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, a.id, "closest vector first");
  assert.ok(hits[0].score > hits[1].score, "descending scores");
  for (const hit of hits) {
    assert.ok(hit.title && hit.content, "full fields refetched for top hits");
    assert.equal(typeof hit.score, "number");
    assert.equal(hit.importance > 0, true, "non-score fields intact");
  }
  store.close();
});

test("#202: getParsedEmbedding / getEmbeddings reflect rewrites (dedup path cache)", () => {
  const store = make();
  const { id } = store.save({ type: "project", title: "A", content: "a" });
  store.setEmbedding(id, [1, 2, 3]);
  assert.deepEqual(store.getParsedEmbedding(id), [1, 2, 3]);
  assert.deepEqual(store.getEmbeddings([id]).get(id), [1, 2, 3]);

  store.setEmbedding(id, [4, 5, 6]);
  assert.deepEqual(store.getParsedEmbedding(id), [4, 5, 6], "cache-first read sees the rewrite");
  assert.deepEqual(store.getEmbeddings([id]).get(id), [4, 5, 6]);
  store.close();
});
