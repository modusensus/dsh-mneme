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

// DSH ≥0.1.2-rc removed Session.events; events are only reachable via
// snapshotEvents(). Regression for #59: the hot block must still render from
// a session object that has no .events property.
// 注意：assistant/message 的消息体在 data.message 下（见 Issue #129），夹具必须用这个
// 真实形状 —— 原先的夹具写的是 data.content，与当时有 bug 的实现是同一个错误假设，
// 所以它永远抓不到这个回归。
test("extracts hot rounds from snapshotEvents() when Session.events is absent", () => {
  const { contexts } = setup();
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "怎么修图谱面板" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "用 viewBox 单位跑模拟" }] } } }
    ]
  };
  const text = contexts[0].text({ agent: { session } });
  assert.ok(text.includes("[短期上下文]"), "hot block rendered");
  assert.ok(text.includes("怎么修图谱面板"), "round query present");
  assert.ok(text.includes("用 viewBox 单位跑模拟"), "round response present");
});

// Issue #129 的复现：assistant 轮的正文取自 data.message.content。修复前 textOf 只读
// data.content，于是每一轮的 response 都落成空串 —— 表现为「N 轮 A 全空」。
test("Issue #129: response 取自 data.message.content，N 轮不再出现空 A", () => {
  const { contexts } = setup();
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第一个问题" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一个回答" }] } } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第二个问题" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二个回答" }] } } }
    ]
  };
  const text = contexts[0].text({ agent: { session } });
  for (const s of ["第一个问题", "第一个回答", "第二个问题", "第二个回答"]) {
    assert.ok(text.includes(s), `hot block 应包含 ${s}`);
  }
});

// 修复用的是 ?? 兜底而非破坏性替换：扁平的 data.content 形状（user 消息一贯如此，
// 历史事件也可能如此）必须继续可用。
test("Issue #129: 扁平的 data.content 形状仍被兼容", () => {
  const { contexts } = setup();
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "问题" }] } },
      { type: "assistant/message", data: { content: [{ type: "text", text: "扁平形状的回答" }] } }
    ]
  };
  const text = contexts[0].text({ agent: { session } });
  assert.ok(text.includes("问题"), "query present");
  assert.ok(text.includes("扁平形状的回答"), "flat content shape still supported");
});
