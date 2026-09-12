import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer, parseSummaryJson } from "../src/summarize.js";
import { createSettings } from "../src/settings.js";

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

test("skips summarization for events other than turn/end", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = { id: "s1", requestHeader: () => ({ config: {} }), events: [] };
  await handler(session, { seq: 1, type: "user/message" });
  assert.equal(store.count(), 0);
  assert.equal(calls.length, 0);
});

// DSH ≥0.1.2-rc removed Session.events; the session object only exposes
// snapshotEvents(). Regression for #59: with only the old .events path the
// collector saw an empty log and no LLM call ever happened.
test("reads events from snapshotEvents() when Session.events is absent", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    snapshotEvents: () => [userMessage("帮我选型"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "an LLM call must be made");
  assert.equal(store.count(), 2);
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

// ── v0.7.11：智能调速器（429 保护）+ 完整转录/原子记忆 ─────────────────────

test("serializes distill LLM calls across sessions (global queue, no concurrency)", async () => {
  const timeline = [];
  const { events, store } = setup({ distillRateLimitIntervalMs: 0 }, {
    stream() {
      return (async function* () {
        timeline.push(`start:${Date.now()}`);
        await new Promise((r) => setTimeout(r, 8));
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: "[]" };
        yield { type: "finish", kind: "ok" };
        timeline.push(`end:${Date.now()}`);
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const mkSession = (id) => ({
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage(`问题${id}`), { seq: 2, type: "turn/end" }]
  });
  // 两个会话几乎同时 turn/end → 必须排队，第二个请求不能与第一个并发。
  await Promise.all([
    handler(mkSession("a"), { seq: 2, type: "turn/end" }),
    handler(mkSession("b"), { seq: 2, type: "turn/end" })
  ]);
  assert.equal(timeline.length, 4); // 每个流 start + end
  const starts = timeline.filter((t) => t.startsWith("start")).map((t) => Number(t.slice(6)));
  const ends = timeline.filter((t) => t.startsWith("end")).map((t) => Number(t.slice(4)));
  assert.ok(starts[1] >= ends[0], "second distill must start only after the first finished (serial queue)");
});

test("retries with exponential backoff on 429 and still stores entries", async () => {
  let attempts = 0;
  const { events, store } = setup(
    { distillRateLimitRetries: 3, distillRateLimitBaseDelayMs: 5, distillRateLimitIntervalMs: 0 },
    {
      stream() {
        return (async function* () {
          attempts++;
          if (attempts < 3) throw Object.assign(new Error("rate limit exceeded"), { status: 429 });
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: JSON.stringify([{ type: "history", title: "重试成功", content: "第三次请求成功", importance: 3 }]) };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s9",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("限流测试"), { seq: 2, type: "turn/end" }]
  };
  const startedAt = Date.now();
  await handler(session, { seq: 2, type: "turn/end" });
  // 429 两次 → 退避重试（5ms + 10ms），第三次成功入库。
  assert.equal(attempts, 3);
  assert.ok(Date.now() - startedAt >= 15, "backoff waits should be visible");
  assert.equal(store.count(), 1);
  assert.equal(store.all()[0].title, "重试成功");
});

test("distills full transcript (tool calls, results, code output) with atomic-memory prompt", async () => {
  const { events, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s10",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("帮我修这个 bug"),
      { seq: 2, type: "tool/call", data: { name: "Bash", arguments: "node test.js" } },
      { seq: 3, type: "tool/result", data: { ok: false, output: "TypeError: x is not a function" } },
      { seq: 4, type: "tool/code-dispatch", data: { ok: true, output: "fixed" } },
      { seq: 5, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 5, type: "turn/end" });
  const transcript = JSON.stringify(calls[0].messages);
  assert.ok(transcript.includes("修这个 bug"));
  assert.ok(transcript.includes("TypeError: x is not a function"));
  assert.ok(transcript.includes("代码执行"));
  // 原子记忆 prompt：不再"硬压 2-3 条"，而是按需多提、贴近原始细节。
  assert.ok(calls[0].messages[0].content[0].text.includes("原子记忆"));
});

test("distill excludes private assistant reasoning blocks from the transcript", async () => {
  const { events, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s12",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      userMessage("解释一下这段代码"),
      {
        type: "assistant/message",
        data: {
          message: {
            content: [
              { type: "reasoning", text: "私有推理：内部权衡过程不该进记忆" },
              { type: "text", text: "这段代码有死循环，第 3 行 while 条件恒真。" }
            ]
          }
        }
      },
      { seq: 3, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 3, type: "turn/end" });
  const transcript = JSON.stringify(calls[0].messages);
  assert.ok(transcript.includes("有死循环，第 3 行"), "public assistant text still distills");
  assert.ok(!transcript.includes("私有推理"), "private reasoning must never enter the distill context");
});

test("codingRetrospect stores coding memory types in the coding memory type set", async () => {
  const { events, store, calls } = setup({ codingRetrospect: true }, {
    stream() {
      return (async function* () {
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", delta: JSON.stringify([
          { type: "rejected_solution", title: "弃用方案", content: "A 方案被否决，改用 B", importance: 4 }
        ]) };
        yield { type: "finish", kind: "ok" };
      })();
    }
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s11",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("编码任务"), { seq: 2, type: "turn/end" }]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1);
  const m = store.all()[0];
  assert.equal(m.type, "rejected_solution");
  // 读取侧门控靠 m.type（rejected_solution/pitfall/constraint ∈ INJECT_TYPES），
  // sanitizeTags 不认 `type:` 前缀，所以不给编码记忆打 tag（会清空 tags 列）。
  assert.deepEqual(m.tags, []);
  // 编码模式用编码 prompt（含 rejected_solution 类型说明）。
  assert.ok(calls[0].messages[0].content[0].text.includes("rejected_solution"));
});

// ── Issue #127：节流 / 条数上限 / 同会话去重 ────────────────────────────────

/** A distill stream that always returns exactly these entries. */
function streamOf(entries) {
  return () => (async function* () {
    yield { type: "block-start", block: { type: "text" } };
    yield { type: "text-delta", delta: JSON.stringify(entries) };
    yield { type: "finish", kind: "ok" };
  })();
}

function sessionFor(id) {
  return {
    id,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("继续"), { seq: 2, type: "turn/end" }]
  };
}

test("issue#127: min-interval gate suppresses the second turn/end and audits it as skipped", async () => {
  const { events, store, calls } = setup({ summarizeMinIntervalMinutes: 30 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = sessionFor("t1");
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "the first turn/end distills");
  assert.equal(store.count(), 2);
  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 1, "the second turn/end inside the window makes no LLM call");
  assert.equal(store.count(), 2, "nothing new is stored");
  // 可观测性：被节流不再静默——留一行 status='skipped'，一条 SQL 可自查。
  const audits = store.listLlmAudits({ source: "autoSummarize" });
  assert.ok(
    audits.some((a) => a.status === "skipped" && a.error_message === "min-interval"),
    "the suppression is visible as a status='skipped' audit row"
  );
});

test("issue#127: min-interval 0 keeps the historical every-turn behavior", async () => {
  const { events, calls } = setup({ summarizeMinIntervalMinutes: 0 });
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = sessionFor("t2");
  await handler(session, { seq: 2, type: "turn/end" });
  await handler(session, { seq: 3, type: "turn/end" });
  assert.equal(calls.length, 2, "0 = no gate (zero behavior change)");
});

test("issue#127: the interval gate is per-session (one session never throttles another)", async () => {
  const { events, calls } = setup({ summarizeMinIntervalMinutes: 30 });
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("ta"), { seq: 2, type: "turn/end" });
  await handler(sessionFor("tb"), { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "a different session is not throttled by another's lastRunAt");
});

test("issue#127: summarizeMaxEntriesPerRun caps the stored entries and audits parsed/capped", async () => {
  const { events, store } = setup({ summarizeMaxEntriesPerRun: 1 }, {
    stream: streamOf([
      { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
      { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
    ])
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t3"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "only the first capped entry is stored");
  const audit = store.listLlmAudits({ source: "autoSummarize" })[0];
  assert.equal(audit.metadata?.parsed, 2, "the raw parsed count is kept for tuning the cap");
  assert.equal(audit.metadata?.capped, 1);
});

test("issue#127: title dedupe absorbs a normalized-same title", async () => {
  const { events, store, service } = setup({ summarizeDedupeMode: "title" }, {
    stream: streamOf([{ type: "pitfall", title: "Win7  OpenSSH  失效", content: "第二次记录", importance: 4 }])
  });
  // 既有条目：同会话、标题归一化后全等（大小写与空白差异）
  const seeded = service.saveWithDedupe({
    type: "pitfall", title: "win7 openssh 失效", content: "第一次记录", source: "session:t5"
  }).memory;
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t5"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "the normalized-same title merged instead of creating a row");
  assert.ok(store.getById(seeded.id).content.includes("第二次记录"), "content appended to the existing row");
});

test("issue#127: title dedupe leaves a rephrase alone (it only catches an exact same title)", async () => {
  // 同一事实的另一种措辞 → title 档不命中，正常新建。这条界定了 title 档的边界，
  // 避免被误当成 vector 档的替代（cos≥0.85 的簇里「归一化标题全同」为 0 个）。
  const { events, store, service } = setup({ summarizeDedupeMode: "title" }, {
    stream: streamOf([{ type: "pitfall", title: "Win7 下 OpenSSH 官方脚本装不上", content: "新记录", importance: 4 }])
  });
  service.saveWithDedupe({
    type: "pitfall", title: "OpenSSH 官方脚本在 Win7 失效", content: "旧记录", source: "session:other"
  });
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t7"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2, "a rephrase (different title) is not merged by the title tier");
});

test("issue#127: vector dedupe merges a same-fact rephrase and keeps content_history", async () => {
  const embedder = {
    ready: true,
    embedSingle: async (text) => (String(text).includes("OpenSSH") ? [1, 0, 0] : [0, 1, 0])
  };
  const { events, store, service } = setup(
    { summarizeDedupeMode: "vector", summarizeDedupeMinSim: 0.92 },
    { stream: streamOf([{ type: "pitfall", title: "Win7 下 OpenSSH 官方脚本装不上", content: "重复踩坑", importance: 4 }]) }
  );
  service.setEmbedder(embedder);
  // 同一事实的另一种措辞，已有向量 → 余弦 1.0 ≥ 0.92
  const seeded = service.saveWithDedupe({
    type: "pitfall", title: "OpenSSH 官方脚本在 Win7 失效", content: "第一次记录", source: "session:t8"
  }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t8"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "no new row: the rephrase was absorbed by cosine");
  const merged = store.getById(seeded.id);
  assert.ok(merged.content.includes("重复踩坑"), "content appended into the existing row");
  assert.ok((merged.content_history ?? []).length >= 1, "content_history keeps the prior version");
  const audit = store.listLlmAudits({ source: "autoSummarize" })[0];
  assert.equal(audit.metadata?.deduped, 1);
  assert.equal(audit.metadata?.mode, "vector");
});

test("issue#127: no embedder means vector dedupe silently falls back to a normal write", async () => {
  const { events, store } = setup(
    { summarizeDedupeMode: "vector" },
    { stream: streamOf([{ type: "pitfall", title: "无关的一条", content: "内容", importance: 4 }]) }
  );
  const handler = events.find((e) => e.name === "session/event").fn;
  await handler(sessionFor("t9"), { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 1, "dedupe failure never blocks the write");
});

test("issue#127: the five summarize knobs are whitelisted and range-checked", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const merged = settings.setFeatureFlags({
    summarizeMinIntervalMinutes: 30,
    summarizeMaxEntriesPerRun: 5,
    summarizeDedupeMode: "vector",
    summarizeDedupeMinSim: 0.9,
    summarizeDedupeWindowHours: 12
  });
  assert.equal(merged.summarizeMinIntervalMinutes, 30);
  assert.equal(merged.summarizeDedupeMode, "vector");
  assert.equal(merged.summarizeDedupeMinSim, 0.9, "float thresholds round-trip (new numbers whitelist)");
  // 面板/API 写入走同一套逐键校验：越界与非法枚举必须被拒。
  assert.throws(() => settings.setFeatureFlags({ summarizeDedupeMinSim: 0.3 }), /number in \[0.5, 0.99\]/);
  assert.throws(() => settings.setFeatureFlags({ summarizeDedupeMode: "semantic" }), /one of: off, title, vector/);
  store.close();
});
