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

test("Bug6: long content is truncated to ~300 chars with an ellipsis", () => {
  const { contexts, service } = setup();
  const longContent = "这是一段非常长的记忆正文".repeat(200); // ~2600 chars
  service.saveWithDedupe({ type: "preference", title: "长记忆", content: longContent, importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("长记忆"), "memory still rendered");
  assert.ok(text.includes("…"), "ellipsis marks the truncation");
  assert.ok(!text.includes(longContent.slice(300)), "full body not injected verbatim");
});

test("Bug6: injected block stays within the ~1500 char budget, later entries collapse", () => {
  const { contexts, service } = setup({ maxInjectedItems: 8 });
  for (let i = 0; i < 8; i++) {
    service.saveWithDedupe({ type: "preference", title: `长标题记忆${i}`, content: "这是一段".repeat(100), importance: 5 });
  }
  const text = contexts[0].text({});
  assert.ok(text.length <= 1600, `memory block bounded near budget, got ${text.length} chars`);
  // The first entries render full bodies; every entry is present by title.
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`长标题记忆${i}`), `entry ${i} present`);
});

test("injectTimePrefix: off by default, no time prefix injected", () => {
  const { contexts } = setup();
  const text = contexts[0].text({ agent: { session: { id: "s1" } } });
  assert.ok(!text.includes("[当前时间:"), "no time prefix when disabled");
});

test("injectTimePrefix: enabled injects once at conversation start with correct format", () => {
  const { contexts, service } = setup({ injectTimePrefix: true });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  const text = contexts[0].text({ agent: { session: { id: "s1" } } });
  assert.match(
    text,
    /^\[当前时间: \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}\]\n\n/,
    "prefix leads the injection with the documented format"
  );
  assert.ok(text.includes("语言"), "memory body still rendered after the prefix");
});

test("injectTimePrefix: same session never re-injects, a new session injects again", () => {
  const { contexts } = setup({ injectTimePrefix: true });
  const first = contexts[0].text({ agent: { session: { id: "s1" } } });
  assert.match(first, /^\[当前时间:/, "injects on the first render of s1");
  const second = contexts[0].text({ agent: { session: { id: "s1" } } });
  assert.ok(!second.includes("[当前时间:"), "no re-inject within the same session");
  const third = contexts[0].text({ agent: { session: { id: "s2" } } });
  assert.match(third, /^\[当前时间:/, "a new session injects the prefix again");
});

test("issue #40: {{...}} in memory content is escaped at the injection boundary", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "模板记忆", content: "{{hl|highlight}} 和 {{挖空}} {{关键词}}", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("模板记忆"), "memory still rendered by title");
  assert.ok(text.includes("{\\{hl|highlight}\\}"), "ASCII template braces escaped");
  assert.ok(text.includes("{\\{挖空}\\}"), "CJK template braces escaped");
  assert.ok(!text.includes("{{"), "no raw {{ survives into the prompt");
  assert.ok(!text.includes("}}"), "no raw }} survives into the prompt");
});

test("issue #40: odd brace runs like {{{a}}} are escaped too", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "三层模板", content: "{{{a}}} 和 }}} 结尾", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(!text.includes("{{"), "no raw {{ for odd brace runs");
  assert.ok(!text.includes("}}"), "no raw }} for odd brace runs");
});

test("issue #40: {{...}} in user profile/rules is escaped", () => {
  const { contexts, settings } = setup();
  settings.setProfile("我叫{{名字}}，前端开发者");
  settings.setRules(["回答时用 {{hl|term}}", "以 }} 结尾的规则"]);
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  const text = settingsCtx.text({});
  assert.ok(text.includes("{\\{名字}\\}"), "profile braces escaped");
  assert.ok(text.includes("{\\{hl|term}\\}"), "rule braces escaped");
  assert.ok(!text.includes("{{"), "no raw {{ in user-settings block");
  assert.ok(!text.includes("}}"), "no raw }} in user-settings block");
});

test("issue #40: hot-context rounds with {{...}} are escaped", () => {
  const { contexts } = setup();
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s1",
        events: [
          { type: "user/message", data: { source: { kind: "user" }, content: ["用 {{hl|你好}} 测试"] } },
          { type: "assistant/message", data: { source: { kind: "assistant" }, content: ["返回 {{答案}}"] } }
        ]
      }
    }
  });
  assert.ok(text.includes("[短期上下文]"), "hot context rendered");
  assert.ok(!text.includes("{{"), "no raw {{ in hot context");
  assert.ok(!text.includes("}}"), "no raw }} in hot context");
});

test("session with only snapshotEvents() (DSH 0.1.2-rc.1) still renders hot context", () => {
  const { contexts } = setup();
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: "user/message", data: { source: { kind: "user" }, content: ["用快照接口提问"] } },
          { type: "assistant/message", data: { source: { kind: "assistant" }, content: ["快照返回的答复"] } }
        ]
      }
    }
  });
  assert.ok(text.includes("[短期上下文]"), "hot context rendered");
  assert.ok(text.includes("用快照接口提问"), "user query picked up from snapshotEvents");
  assert.ok(text.includes("快照返回的答复"), "assistant reply picked up from snapshotEvents");
});

test("issue #40: escapePromptVariables=false passes {{...}} through verbatim", () => {
  const { contexts, service } = setup({ escapePromptVariables: false });
  service.saveWithDedupe({ type: "preference", title: "模板", content: "{{挖空}} 与 {{hl|term}}", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("{{挖空}}"), "raw braces preserved when escaping disabled");
  assert.ok(text.includes("{{hl|term}}"), "raw ASCII braces preserved when escaping disabled");
});
