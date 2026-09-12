import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import {
  evaluateMemoryQuality,
  META_MEMORY_RE,
  textSimilarity,
  dedupRatio
} from "../src/quality-filter.js";

// Bug7: rule-based memory quality filter. Gated on
// config.memoryQualityFilter.enabled === true — raw configs (`{}`) keep the
// legacy behavior. Score bands:
//   >= 60       stored normally
//   30 .. < 60  quality_score persisted, injection ranked by importance × score/100
//   < 30        archived + tagged low_quality (explicit search still recalls it)

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { memoryQualityFilter: { enabled: true }, ...over } });
  return { store, service };
}

test("evaluateMemoryQuality: meta-memory scores below 60 (degraded, not archived)", () => {
  const { score, tags } = evaluateMemoryQuality({
    type: "history",
    title: "对话总结",
    content: "总结一下刚才的对话，需要记住以下要点"
  });
  assert.ok(score >= 30 && score < 60, `meta memory should be degraded (30..60), got ${score}`);
  assert.ok(tags.includes("meta"), "tagged meta");
});

test("evaluateMemoryQuality: short content is archived (< 30)", () => {
  const { score, tags } = evaluateMemoryQuality({ type: "preference", title: "语言", content: "短" });
  assert.ok(score < 30, `short content should be archived, got ${score}`);
  assert.ok(tags.includes("short_content"));
  assert.ok(tags.includes("low_quality"));
});

test("evaluateMemoryQuality: near-duplicate of a recent memory is archived", () => {
  const { score, tags } = evaluateMemoryQuality(
    { type: "preference", title: "重复", content: "猫咪喜欢在阳台晒太阳并打盹" },
    { recentContents: ["猫咪喜欢在阳台晒太阳并打盹"] }
  );
  assert.ok(score < 30, `duplicate should be archived, got ${score}`);
  assert.ok(tags.includes("duplicate"));
});

test("saveWithDedupe: meta memory persists quality_score < 60 and is not archived", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "history",
    title: "对话总结",
    content: "总结一下刚才的对话，需要记住以下要点"
  });
  const got = store.getById(memory.id);
  assert.ok(got.quality_score !== undefined && got.quality_score < 60,
    `meta memory should store quality_score < 60, got ${got.quality_score}`);
  assert.equal(got.archived, false, "degraded memory stays un-archived");
});

test("saveWithDedupe: short text is archived + tagged low_quality", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "preference",
    title: "语言",
    content: "短"
  });
  const got = store.getById(memory.id);
  assert.equal(got.archived, true, "short text archived");
  assert.ok(got.tags.includes("low_quality"), "tagged low_quality");
  assert.ok(got.quality_score < 30, `score below archive threshold, got ${got.quality_score}`);
});

test("saveWithDedupe: near-duplicate content is archived", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "习惯一", content: "猫咪喜欢在阳台晒太阳并打盹" });
  const { memory: dup } = service.saveWithDedupe({ type: "preference", title: "习惯二", content: "猫咪喜欢在阳台晒太阳并打盹" });
  const got = store.getById(dup.id);
  assert.equal(got.archived, true, "near-duplicate archived");
  assert.ok(got.tags.includes("low_quality"));
});

test("saveWithDedupe: filter disabled (raw config) skips scoring entirely", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短" });
  const got = store.getById(memory.id);
  assert.equal(got.archived, false, "nothing archived when filter off");
  assert.equal(got.quality_score, undefined, "no quality_score when filter off");
  assert.ok(!got.tags.includes("low_quality"));
});

test("injectCandidates: degraded memory ranks below a healthy preference", () => {
  const { service } = setup();
  // Healthy preference: score 100 → weight 1.0 → 3 * 1.0 = 3.0.
  service.saveWithDedupe({ type: "preference", title: "健康偏好", content: "用户平时习惯用中文交流", importance: 3 });
  // Degraded (meta-memory) preference: score ~55 → weight 0.55 → 5 * 0.55 = 2.75.
  service.saveWithDedupe({ type: "preference", title: "元记忆偏好", content: "总结一下刚才的对话内容吧", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  const titles = candidates.map((c) => c.title);
  assert.ok(titles.includes("健康偏好"), "healthy preference present");
  assert.ok(titles.includes("元记忆偏好"), "degraded preference present");
  assert.ok(titles.indexOf("健康偏好") < titles.indexOf("元记忆偏好"),
    "degraded memory is demoted below the healthy one");
});

test("exported helpers behave (meta regex, similarity, dedup ratio)", () => {
  assert.ok(META_MEMORY_RE.test("总结一下刚才的对话"));
  assert.ok(META_MEMORY_RE.test("作为AI助手，我需要记住"));
  assert.ok(!META_MEMORY_RE.test("用户喜欢喝咖啡"));
  assert.equal(textSimilarity("猫咪喜欢晒太阳", "猫咪喜欢晒太阳"), 1);
  assert.ok(textSimilarity("猫咪喜欢晒太阳", "完全不同的内容") < 0.3);
  assert.ok(dedupRatio("哈哈哈哈哈哈") < 0.3, "repetitive filler has low dedup ratio");
  assert.ok(dedupRatio("一句信息量足够的话") > 0.3);
});

// --- Issue #135 附属发现 1：importance ≥ exemptImportance 只降权，不静默归档 ----

test("Issue #135: importance-5 memory below archive threshold is demoted, not archived", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "preference", title: "关键决策", content: "短", importance: 5
  });
  const got = store.getById(memory.id);
  assert.equal(got.archived, false, "importance 5 >= exemptImportance 4 → kept active");
  assert.ok(got.quality_score < 30, `score still persisted, got ${got.quality_score}`);
  assert.ok(got.tags.includes("low_quality"), "signal tag still written (verdict observable)");
});

test("Issue #135: importance-4 is exempt by default; importance-3 is still archived", () => {
  const { store, service } = setup();
  const four = service.saveWithDedupe({ type: "preference", title: "决策甲", content: "短", importance: 4 }).memory;
  const three = service.saveWithDedupe({ type: "preference", title: "决策乙", content: "短", importance: 3 }).memory;
  assert.equal(store.getById(four.id).archived, false, "importance 4 exempt by default");
  assert.equal(store.getById(three.id).archived, true, "importance 3 below the floor still archived");
});

test("Issue #135: exemptImportance=1 disables auto-archive; =5 narrows the floor", () => {
  const one = setup({ memoryQualityFilter: { enabled: true, exemptImportance: 1 } });
  const threeLow = one.service.saveWithDedupe({ type: "preference", title: "语言", content: "短", importance: 3 }).memory;
  assert.equal(one.store.getById(threeLow.id).archived, false, "exemptImportance 1 exempts everything");

  const five = setup({ memoryQualityFilter: { enabled: true, exemptImportance: 5 } });
  const four = five.service.saveWithDedupe({ type: "preference", title: "决策甲", content: "短", importance: 4 }).memory;
  assert.equal(five.store.getById(four.id).archived, true, "importance 4 no longer exempt at floor 5");
});

// --- Issue #135 附属发现 2：update 的 tags 整组替换不再抹掉系统信号标签 --------

test("Issue #135: update with tags preserves the filter's signal tags", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短" });
  assert.ok(store.getById(memory.id).tags.includes("low_quality"), "precondition: filter tagged the row");

  service.update(memory.id, { tags: ["用户标签"], content: "补充后的完整内容，不再是短文本了" });
  const after = store.getById(memory.id);
  assert.ok(after.tags.includes("用户标签"), "user tags applied");
  assert.ok(after.tags.includes("low_quality"), "low_quality preserved through the update");
  assert.ok(after.tags.includes("short_content"), "short_content preserved too");
});

test("Issue #135: update without tags leaves the row untouched (legacy path)", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短" });
  const before = store.getById(memory.id).tags;
  service.update(memory.id, { content: "只改内容，不带 tags 字段" });
  assert.deepEqual(store.getById(memory.id).tags, before, "no tags in patch → tags untouched");
});

test("Issue #135 review: self_referential is a signal tag and survives a tagged update", () => {
  const { store, service } = setup();
  // type 自指（title 提到自身类型标签「偏好」）→ quality-filter.js 写
  // self_referential（−15）；加短内容一起跌破归档线。SIGNAL_TAGS 清单必须
  // 覆盖它，否则带 tags 的 update 恰好把这个标签抹掉（审计线索缺口）。
  const { memory } = service.saveWithDedupe({ type: "preference", title: "偏好记录", content: "短" });
  const tagged = store.getById(memory.id);
  assert.ok(tagged.tags.includes("self_referential"), "precondition: self_referential written");

  service.update(memory.id, { tags: ["用户标签"], content: "补充后的完整内容" });
  const after = store.getById(memory.id);
  assert.ok(after.tags.includes("self_referential"), "self_referential preserved through the update");
  assert.ok(after.tags.includes("用户标签"), "user tags still applied");
});
