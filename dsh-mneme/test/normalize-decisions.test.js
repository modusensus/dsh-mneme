// Field-name normalization guard (v0.5.3): thinking-type models
// (deepseek-v4-flash etc.) sometimes ignore the prompt's exact decision schema
// and emit alias keys —实测方案 A 输出 "consolidation"/"target_ids"、方案 B
// 输出 "action"/"targetIds"，都不是插件要求的 "action"/"ids"。normalizeDecisions
// 在 validateDecisions 之前把这些变体重写回规范字段名，让"语义正确但 schema
// 不听话"的输出仍被应用，而不是整单被拒。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDecisions, createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

test("normalizeDecisions: canonical decisions pass through untouched", () => {
  const raw = [
    { action: "merge", ids: ["m1", "m2"], keepSource: "m1", title: "t", content: "c", importance: 4, reason: "主题相近" },
    { action: "conflict", winner: "m3", loser: "m4", reason: "矛盾" },
    { action: "update", ids: ["m5"], content: "修正" },
    { action: "archive", ids: ["m6"], reason: "过时" },
    { action: "create", type: "pattern", title: "新模式", content: "发现", importance: 3 }
  ];
  assert.deepEqual(normalizeDecisions(raw), raw);
});

test("normalizeDecisions: alias keys rewritten to canonical names", () => {
  const raw = [
    { consolidation: "merge", target_ids: ["m1", "m2"], keep_source: "m1", new_title: "t", new_content: "c", priority: 4, rationale: "主题相近" },
    { action: "conflict", winner_id: "m3", loser_id: "m4", why: "矛盾" },
    { action: "update", targetIds: ["m5"], merged_content: "修正" },
    { action: "archive", memory_ids: ["m6"] }
  ];
  assert.deepEqual(normalizeDecisions(raw), [
    { action: "merge", ids: ["m1", "m2"], keepSource: "m1", title: "t", content: "c", importance: 4, reason: "主题相近" },
    { action: "conflict", winner: "m3", loser: "m4", reason: "矛盾" },
    { action: "update", ids: ["m5"], content: "修正" },
    { action: "archive", ids: ["m6"] }
  ]);
});

test("normalizeDecisions: action value synonyms normalized", () => {
  const raw = [
    { action: "archived", ids: ["m1"], reason: "重复" },
    { action: "consolidation", target_ids: ["m2", "m3"], keep_source: "m2" },
    { action: "combine", targetIds: ["m4", "m5"], keeper: "m5" },
    { action: "Remove", memory_ids: ["m6"] }
  ];
  const normalized = normalizeDecisions(raw);
  assert.equal(normalized[0].action, "archive");
  assert.equal(normalized[1].action, "merge");
  assert.equal(normalized[1].ids[0], "m2");
  assert.equal(normalized[2].action, "merge");
  assert.equal(normalized[2].keepSource, "m5");
  assert.equal(normalized[3].action, "archive");
});

test("normalizeDecisions: wrapper object around the array is unwrapped", () => {
  const raw = { consolidation: [{ action: "merge", ids: ["m1"], keepSource: "m1", title: "t", content: "c" }] };
  assert.deepEqual(normalizeDecisions(raw), [
    { action: "merge", ids: ["m1"], keepSource: "m1", title: "t", content: "c" }
  ]);
  const raw2 = { decisions: [{ action: "archive", target_ids: ["m9"] }] };
  assert.deepEqual(normalizeDecisions(raw2), [{ action: "archive", ids: ["m9"] }]);
});

test("normalizeDecisions: single decision object (non-array) normalized too", () => {
  const raw = { action: "update", targetIds: ["m1"], new_content: "修正" };
  assert.deepEqual(normalizeDecisions(raw), [{ action: "update", ids: ["m1"], content: "修正" }]);
});

test("normalizeDecisions: single-string ids become a one-element array", () => {
  const raw = [{ action: "archive", target_id: "m7" }];
  // target_id (singular) is not an alias key — the raw key survives untouched
  // and validateDecisions rejects it (safe side). But targetIds (plural, string)
  // IS mapped and wrapped.
  const raw2 = [{ action: "archive", targetIds: "m7" }];
  assert.deepEqual(normalizeDecisions(raw2), [{ action: "archive", ids: ["m7"] }]);
  assert.deepEqual(normalizeDecisions(raw), [{ action: "archive", target_id: "m7" }]);
});

test("normalizeDecisions: create keeps its type field (never mistaken for action)", () => {
  const raw = { action: "create", type: "preference", title: "语言", content: "中文", importance: 3 };
  assert.deepEqual(normalizeDecisions(raw), [
    { action: "create", type: "preference", title: "语言", content: "中文", importance: 3 }
  ]);
});

test("normalizeDecisions: null / non-parseable returns as-is (caller's no-json branch)", () => {
  assert.equal(normalizeDecisions(null), null);
  assert.equal(normalizeDecisions(undefined), undefined);
  assert.equal(normalizeDecisions("not json"), "not json");
});

test("dream runDream applies alias-key consolidation output end-to-end", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          // deepseek-v4-flash 实测风格：consolidation 当 action、target_ids 当 ids
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { consolidation: "merge", target_ids: [a.id, b.id], keep_source: b.id, new_title: "插件总览", new_content: "合并内容", priority: 4 }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：默认摘要。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true, "alias-key output must not be rejected wholesale");
  assert.ok(result.applied > 0, "alias-key decisions still land changes");
  store.close();
});
