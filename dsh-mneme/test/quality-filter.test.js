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
