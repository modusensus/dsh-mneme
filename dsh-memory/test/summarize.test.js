import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer, parseSummaryJson } from "../src/summarize.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm: {
      stream(options) {
        calls.push(options);
        const json = JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
          { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
        ]);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const config = { autoSummarize: true, ...over };
  const summarizer = createSummarizer(ctx, service, config);
  return { store, service, events, calls, summarizer };
}

test("parseSummaryJson extracts valid entries and skips malformed ones", () => {
  const parsed = parseSummaryJson(`前导文字 {"a":1}
  [
    {"type":"decision","title":"t1","content":"c1","importance":4},
    {"type":"nonsense","title":"bad","content":"x"},
    "garbage",
    {"type":"preference","title":"t2","content":"c2","importance":2}
  ]`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, "decision");
  assert.equal(parsed[1].type, "preference");
});

test("subscribes to session/event when autoSummarize enabled", () => {
  const { events } = setup();
  assert.ok(events.some((e) => e.name === "session/event"));
});

test("does not subscribe when autoSummarize disabled", () => {
  const { events } = setup({ autoSummarize: false });
  assert.ok(!events.some((e) => e.name === "session/event"));
});

test("turn/end event triggers summarization and stores entries", async () => {
  const { events, store } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      { seq: 1, type: "user/message" },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  const all = store.all();
  assert.ok(all.some((m) => m.type === "decision"));
  assert.ok(all.some((m) => m.type === "preference"));
});

test("skips summarization for events other than turn/end", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = { id: "s1", requestHeader: () => ({ config: {} }), events: [] };
  await handler(session, { seq: 1, type: "user/message" });
  assert.equal(store.count(), 0);
  assert.equal(calls.length, 0);
});
