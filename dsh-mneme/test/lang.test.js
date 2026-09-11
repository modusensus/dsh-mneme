
import test from "node:test";
import assert from "node:assert/strict";
import { STR, langOf } from "../src/lang.js";
import { createMirror, parseHumanEdits, renderMirrorText } from "../src/mirror.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";

test("langOf resolves the per-instance config language", () => {
  assert.equal(langOf({}), "zh");
  assert.equal(langOf({ language: "zh" }), "zh");
  assert.equal(langOf({ language: "en" }), "en");
  assert.equal(langOf({ language: "fr" }), "zh");
  assert.equal(langOf(null), "zh");
});

test("prompt table resolves by explicit language key", () => {
  assert.ok(STR.prompts.summary.zh.includes("记忆库提炼助手"));
  assert.ok(STR.prompts.summary.en.includes("memory curation assistant"));
  assert.ok(STR.prompts.consolidation.zh.includes("记忆库整理助手"));
  assert.ok(STR.prompts.consolidation.en.includes("consolidation assistant"));
  assert.ok(STR.prompts.conflict.zh.includes("冲突仲裁"));
  assert.ok(STR.prompts.conflict.en.includes("conflict arbiter"));
  assert.ok(STR.prompts.pattern.zh.includes("模式发现助手"));
  assert.ok(STR.prompts.pattern.en.includes("pattern-discovery assistant"));
  // 冻结模式后缀：纯提示文本，可直接拼接在巩固 prompt 后。
  assert.ok(STR.prompts.freezeSuffix.zh.startsWith("\n\n当前为「冲突冻结」模式"));
  assert.ok(STR.prompts.freezeSuffix.en.startsWith("\n\nConflict-freeze mode is active"));
  // 无 JS 语法残留：不携带 const 声明、模板字面量包裹或拼接片段。
  for (const [key, pair] of Object.entries(STR.prompts)) {
    for (const [lang, text] of Object.entries(pair)) {
      assert.ok(!text.startsWith("const ") && !text.startsWith("? ")
        && !text.endsWith("`;") && !text.endsWith("`"),
        `${key}.${lang} must not carry JS syntax`);
    }
  }
});

test("two injectors with different language configs render independently", () => {
  function setup(language) {
    const store = createStore(":memory:");
    const service = createService({ store, mirror: null, config: {} });
    const settings = createSettings(store.db);
    const contexts = [];
    const ctx = { systemPrompt: { context(def) { contexts.push(def); } } };
    createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3, language });
    service.saveWithDedupe({ type: "preference", title: "lang", content: "value", importance: 5 });
    return { store, contexts };
  }
  const en = setup("en");
  const zh = setup("zh");
  try {
    assert.ok(en.contexts[0].text({}).includes("[Memory]"), "en instance renders English header");
    assert.ok(zh.contexts[0].text({}).includes("[记忆库]"), "zh instance renders Chinese header");
  } finally {
    en.store.close();
    zh.store.close();
  }
});

test("mirror render follows the instance language; parser accepts both", () => {
  const memory = { id: "m1", type: "preference", title: "t", content: "c", importance: 5, tags: [], updated_at: "2026-01-01" };
  const enText = renderMirrorText("preference", [memory], "en");
  const zhText = renderMirrorText("preference", [memory], "zh");
  assert.ok(enText.includes("- **Type**: preference"));
  assert.ok(zhText.includes("- **类型**: preference"));
  const edits = parseHumanEdits(enText + "\n" + zhText);
  assert.deepEqual(
    edits.map((e) => e.id),
    ["m1", "m1"]
  );
  assert.equal(edits[1].content, "c");
});
