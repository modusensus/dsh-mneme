// v0.6.4 Tag 加权召回测试。
// 覆盖：extractQueryTags（#标签/已知 tag/去重/空）/ applyTagBoost（交集乘系数/
// 无交集不变/双叠加封顶/降序/标记）/ searchMemories 集成（开/关行为）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractQueryTags, applyTagBoost } from "../src/search/tag-boost.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

// ============================================================ extractQueryTags

test("extractQueryTags: extracts #hashtags including CJK", () => {
  const tags = extractQueryTags("查看 #规划 和 #meeting_123");
  assert.deepEqual(tags, ["规划", "meeting_123"]);
});

test("extractQueryTags: matches known tags without #", () => {
  const tags = extractQueryTags("规划会议纪要", ["规划", "会议"]);
  assert.deepEqual(tags, ["规划", "会议"]);
});

test("extractQueryTags: dedupes and merges explicit and known tags", () => {
  const tags = extractQueryTags("#规划 规划进度", ["规划", "项目"]);
  assert.deepEqual(tags, ["规划"]);
});

test("extractQueryTags: empty/invalid query returns empty array", () => {
  assert.deepEqual(extractQueryTags(""), []);
  assert.deepEqual(extractQueryTags(null), []);
});

// ============================================================ applyTagBoost

test("applyTagBoost: boosts candidates overlapping query tags", () => {
  const out = applyTagBoost([{ id: "a", score: 0.8, tags: ["规划"] }], {
    queryTags: ["规划"],
    factor: 1.15,
  });
  assert.ok(Math.abs(out[0].score - 0.92) < 1e-9, "0.8 × 1.15 ≈ 0.92 (float-safe)");
  assert.equal(out[0].tagBoost, true);
});

test("applyTagBoost: leaves non-overlapping candidates unchanged and stable", () => {
  const out = applyTagBoost(
    [
      { id: "a", score: 0.5, tags: ["x"] },
      { id: "b", score: 0.5, tags: ["y"] },
    ],
    { queryTags: ["z"] }
  );
  assert.deepEqual(out.map((m) => m.score), [0.5, 0.5]);
  assert.deepEqual(out.map((m) => m.id), ["a", "b"]);
  assert.ok(!out.some((m) => m.tagBoost));
});

test("applyTagBoost: applies both boosts and caps at 1", () => {
  const out = applyTagBoost([{ id: "a", score: 0.9, tags: ["规划", "热门"] }], {
    queryTags: ["规划"],
    sessionTags: ["热门"],
    factor: 1.15,
    sessionFactor: 1.08,
  });
  assert.equal(out[0].score, 1);
  assert.equal(out[0].tagBoost, true);
});

test("applyTagBoost: sorts results by boosted score descending", () => {
  const out = applyTagBoost(
    [
      { id: "low", score: 0.9, tags: ["x"] },
      { id: "high", score: 0.8, tags: ["plan"] },
    ],
    { queryTags: ["plan"], factor: 1.25 }
  );
  assert.deepEqual(out.map((m) => m.id), ["high", "low"]);
  assert.equal(out[0].tagBoost, true);
});

// ============================================================ searchMemories 集成

test("searchMemories: tagBoostEnabled tags the matching memory", async () => {
  const { store, service } = makeService({ tagBoostEnabled: true });
  const a = service.saveWithDedupe({
    type: "preference", title: "规划笔记", content: "项目规划方案", importance: 3,
  }).memory;
  store.setMemoryTags(a.id, ["规划"]);
  const results = await service.searchMemories("项目 #规划", {
    mode: "hybrid", limit: 10, useRerank: false, trustEpistemicWeighting: false,
  });
  const tagged = results.find((r) => r.id === a.id);
  assert.ok(tagged, "tagged memory should be returned");
  assert.equal(tagged.tagBoost, true, "boosted candidate carries tagBoost marker");
});

test("searchMemories: tagBoostEnabled=false adds no tagBoost markers", async () => {
  const { store, service } = makeService({ tagBoostEnabled: false });
  const a = service.saveWithDedupe({
    type: "preference", title: "规划笔记", content: "项目规划方案", importance: 3,
  }).memory;
  store.setMemoryTags(a.id, ["规划"]);
  const results = await service.searchMemories("项目 #规划", {
    mode: "hybrid", limit: 10, useRerank: false, trustEpistemicWeighting: false,
  });
  assert.ok(!results.some((r) => r.tagBoost), "no tagBoost marker when disabled");
});

test("searchMemories: no tag in query → no boost even when enabled", async () => {
  const { store, service } = makeService({ tagBoostEnabled: true });
  const a = service.saveWithDedupe({
    type: "preference", title: "规划笔记", content: "项目规划方案", importance: 3,
  }).memory;
  store.setMemoryTags(a.id, ["规划"]);
  // query carries no #tag and no known-tag mention → boost is gated off
  const results = await service.searchMemories("项目", {
    mode: "hybrid", limit: 10, useRerank: false, trustEpistemicWeighting: false,
  });
  assert.ok(results.length > 0, "results returned");
  assert.ok(!results.some((r) => r.tagBoost), "no tagBoost marker without a tag-bearing query");
});
