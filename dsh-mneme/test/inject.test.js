import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const disposers = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        const dispose = () => disposers.push(def.name);
        return dispose;
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  const injector = createInjector(ctx, service, settings, config);
  return { store, service, contexts, injector, settings };
}

test("registers memory and user-settings contexts", () => {
  const { contexts } = setup();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].name, "memory");
  assert.equal(contexts[1].name, "user-settings");
});

test("context text renders injected memories as markdown block", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite+Markdown", importance: 4 });
  const text = contexts[0].text({});
  assert.ok(text.includes("[记忆库]"), "has header");
  assert.ok(text.includes("语言"), "includes preference");
  assert.ok(text.includes("记忆插件"), "includes high-importance project");
});

test("returns empty text when nothing qualifies", () => {
  const { contexts } = setup();
  const text = contexts[0].text({});
  assert.equal(text, "");
});

test("renders summary block first when summary candidate exists", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "这是总览摘要", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  const text = contexts[0].text({});
  const summaryIdx = text.indexOf("这是总览摘要");
  const prefIdx = text.indexOf("语言");
  assert.ok(summaryIdx !== -1, "summary present");
  assert.ok(prefIdx !== -1, "preference present");
  assert.ok(summaryIdx < prefIdx, "summary rendered first");
});

test("user-settings context renders profile and rules, empty when unset", () => {
  const { contexts, settings } = setup();
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  assert.ok(settingsCtx, "user-settings context registered");
  assert.equal(settingsCtx.text({}), "", "empty when no profile/rules");
  settings.setProfile("我叫小明，是一名前端开发者");
  settings.setRules(["回答时先给结论", "使用简体中文"]);
  const text = settingsCtx.text({});
  assert.ok(text.includes("用户画像"), "has profile header");
  assert.ok(text.includes("前端开发者"), "includes profile");
  assert.ok(text.includes("先给结论"), "includes rule");
  assert.ok(text.includes("简体中文"), "includes second rule");
});

test("user-settings context precedes memory block (order 85 < 90)", () => {
  const { contexts, settings } = setup();
  settings.setProfile("画像");
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  assert.ok(settingsCtx.order < contexts.find((c) => c.name === "memory").order);
});
