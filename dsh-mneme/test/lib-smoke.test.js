// lib/ 是 npm 实际加载的产物（package main 指向 lib/index.js），而现有测试只引 src/，
// 覆盖不到发布产物——issue #65 就是 src 适配了、lib 没同步，npm 包静默跑旧代码。
// 本文件直接从 lib/ 导入，复跑 DSH 0.1.2-rc.1 snapshotEvents 关键用例，
// 并静态断言 src → lib 逐文件一致，防止同类回归再次发生。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { createStore } from "../lib/store.js";
import { createService } from "../lib/service.js";
import { createInjector } from "../lib/inject.js";
import { createSettings } from "../lib/settings.js";
import { createSummarizer, parseSummaryJson } from "../lib/summarize.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  const injector = createInjector(ctx, service, settings, config);
  return { contexts, injector };
}

test("lib: session with only snapshotEvents() (DSH 0.1.2-rc.1) still renders hot context", () => {
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

test("lib: session with only snapshotEvents() (DSH 0.1.2-rc.1) still summarizes", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm: {
      stream() {
        const json = JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
          { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
        ]);
        return (async function* () {
          yield { type: "finish", kind: "ok" };
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
        })();
      }
    }
  };
  const summarizer = createSummarizer(ctx, service, { autoSummarize: true });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s6",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    snapshotEvents: () => [{ type: "user/message", data: { content: ["用快照接口提问"] } }, { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  assert.ok(store.all().some((m) => m.type === "decision"));
  assert.ok(store.all().some((m) => m.type === "preference"));
  summarizer.dispose();
});

test("lib/ mirrors src/ — every src file identical in lib (npm loads lib!)", () => {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const libRoot = fileURLToPath(new URL("../lib/", import.meta.url));
  const mismatches = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = relative(srcRoot, full);
        const counterpart = join(libRoot, rel);
        if (!existsSync(counterpart) || !readFileSync(full).equals(readFileSync(counterpart))) {
          mismatches.push(rel);
        }
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(mismatches, [], "src 文件在 lib 缺失或内容不一致——请先 npm run sync 并提交");
});
