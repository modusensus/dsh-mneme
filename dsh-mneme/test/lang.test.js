
import test from "node:test";
import assert from "node:assert/strict";
import { STR, lang, setMnemeLanguage, getMnemeLanguage } from "../src/lang.js";
import { parseHumanEdits } from "../src/mirror.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";

test("language switch flips prompt and injection pairs at runtime", () => {
  assert.equal(getMnemeLanguage(), "zh");
  setMnemeLanguage("en");
  assert.equal(lang(), "en");
  assert.ok(STR.memoryHeader.en.includes("[Memory]"));
  assert.ok(STR.prompts.summary.en.includes("memory curation assistant"));
  assert.ok(STR.prompts.consolidation.en.includes("consolidation assistant"));
  assert.ok(STR.prompts.conflict.en.includes("conflict arbiter"));
  setMnemeLanguage("zh");
  assert.ok(STR.memoryHeader.zh.includes("记忆库"));
  assert.ok(STR.prompts.summary.zh.includes("记忆库提炼助手"));
  // 未知语言被忽略，保持原值。
  setMnemeLanguage("fr");
  assert.equal(lang(), "zh");
});

test("injection header follows the active language", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); } } };
  createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3 });
  service.saveWithDedupe({ type: "preference", title: "lang", content: "value", importance: 5 });
  try {
    setMnemeLanguage("en");
    assert.ok(contexts[0].text({}).includes("[Memory]"));
    setMnemeLanguage("zh");
    assert.ok(contexts[0].text({}).includes("[记忆库]"));
  } finally {
    setMnemeLanguage("zh");
    store.close();
  }
});

test("mirror parser accepts both label languages", () => {
  const zhBlock = "## T\n\n- **ID**: `m1`\n- **类型**: preference\n- **重要性**: 5\n- **标签**: `a`\n- **更新时间**: 2026-01-01\n\nbody zh\n\n---\n\n";
  const enBlock = "## T\n\n- **ID**: `m2`\n- **Type**: preference\n- **Importance**: 5\n- **Tags**: `a`\n- **Updated**: 2026-01-01\n\nbody en\n\n---\n\n";
  const edits = parseHumanEdits(zhBlock + "\n" + enBlock);
  assert.deepEqual(
    edits.map((e) => e.id),
    ["m1", "m2"]
  );
  assert.equal(edits[0].content, "body zh");
  assert.equal(edits[1].content, "body en");
});
