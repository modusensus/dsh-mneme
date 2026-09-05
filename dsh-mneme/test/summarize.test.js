import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer, parseSummaryJson } from "../src/summarize.js";

function setup(over = {}, opts = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {
        const i = events.findIndex((e) => e.name === name && e.fn === fn);
        if (i !== -1) events.splice(i, 1);
      };
    },
    llm: {
      stream(options) {
        calls.push(options);
        if (opts.stream) return opts.stream(options);
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

// A realistic direct human prompt event (source.kind === "user").
function userMessage(text) {
  return {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
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
    events: [userMessage("帮我选型"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  const all = store.all();
  assert.ok(all.some((m) => m.type === "decision"));
  assert.ok(all.some((m) => m.type === "preference"));
});

test("session with only snapshotEvents() (DSH 0.1.2-rc.1) still summarizes", async () => {
  const { events, store } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s6",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    snapshotEvents: () => [userMessage("用快照接口提问"), { seq: 2, type: "turn/end" }]
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

test("dispose unsubscribes and stops later turn/end events from summarizing", async () => {
  const { events, summarizer, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  summarizer.dispose();
  // The ctx.on() disposer must have removed the listener.
  assert.ok(!events.some((e) => e.name === "session/event"));
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("你好"), { seq: 2, type: "turn/end" }]
  };
  // Even a stale handler reference must not start a new LLM call.
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 0);
});

test("excludes plugin-injected user/message events from summarization input", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s2",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      {
        seq: 1,
        type: "user/message",
        data: { source: { kind: "plugin" }, content: [{ type: "text", text: "AGENTS.md 内容" }] }
      },
      userMessage("帮我看看这个报错"),
      { seq: 3, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 1);
  const userMessages = calls[0].messages.filter((m) => m.role === "user");
  assert.equal(userMessages.length, 1);
  assert.ok(!JSON.stringify(calls[0].messages).includes("AGENTS.md"));
  assert.equal(store.count(), 2);
});

test("aborted finish does not store entries", async () => {
  const { events, store, calls } = setup({}, {
    stream() {
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: "[]" };
        yield { type: "finish", kind: "aborted" };
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s3",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("继续"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1); // the stream was actually reached
  assert.equal(store.count(), 0);
});

test("uses summarizeProvider/summarizeModel config override when set", async () => {
  const { events, calls } = setup({
    summarizeProvider: "aliyun",
    summarizeModel: "qwen3.6-plus"
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s4",
    // Session header has a different model — config override should win.
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-v4-pro" } }),
    events: [userMessage("测试覆盖"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "aliyun");
  assert.equal(calls[0].model, "qwen3.6-plus");
});

test("falls back to session header when summarize config is empty", async () => {
  const { events, calls } = setup({
    summarizeProvider: "",
    summarizeModel: ""
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s5",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("回退测试"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "deepseek");
  assert.equal(calls[0].model, "deepseek-chat");
});
