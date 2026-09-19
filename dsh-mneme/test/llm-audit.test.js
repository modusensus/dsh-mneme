import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { createSummarizer } from "../src/summarize.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { mockCtx } from "./helpers/dream-mock.js";

// Bug8: LLM audit trail. Every background LLM call (autoDream consolidation +
// summary, autoSummarize compression) records tokens/time/status into
// llm_audit_logs. Failures are captured as status='error' and never block the
// calling feature. Read back through the API (/llm-audit + /llm-audit/stats).
// Gating: runDream treats llmAudit.enabled === false as off; summarize treats
// llmAudit.enabled !== false as on.

function dreamSetup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return {
    store,
    service,
    config: { dreamProvider: "deepseek", dreamModel: "deepseek-chat", llmAudit: { enabled: true }, ...over }
  };
}

test("autoDream writes llm_audit_logs rows for consolidation and summary", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  service.saveWithDedupe({ type: "project", title: "旧2", content: "第二段内容" });
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=\w+\s*\|\s*importance=\d+/g)].map((m) => m[1]);
      return JSON.stringify(ids.map((id) => ({ action: "keep", ids: [id] })));
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, true);

  const rows = service.listLlmAudits();
  assert.equal(rows.length, 2, "one consolidation + one summary audit row");
  const consolidate = rows.find((r) => r.operation_type === "dream_consolidate");
  const summarize = rows.find((r) => r.operation_type === "dream_summarize");
  assert.ok(consolidate, "dream_consolidate row present");
  assert.ok(summarize, "dream_summarize row present");
  assert.equal(consolidate.trigger_source, "autoDream");
  assert.equal(summarize.trigger_source, "autoDream");
  assert.equal(consolidate.status, "success");
  assert.equal(summarize.status, "success");
  // config-first (Issue #25): dreamSetup sets dreamProvider/dreamModel, so it
  // wins over mockCtx's agentDefaultModel (mock:stress-model) — assert the
  // actually-used config route.
  assert.equal(consolidate.model_id, "deepseek:deepseek-chat");
  assert.equal(summarize.model_id, "deepseek:deepseek-chat");
  assert.ok(Array.isArray(consolidate.related_memory_ids) && consolidate.related_memory_ids.length === 2,
    "consolidation audit records the snapshot ids");
  assert.ok(consolidate.total_tokens >= 0 && summarize.total_tokens >= 0);
  assert.ok(typeof consolidate.duration_ms === "number" && consolidate.duration_ms >= 0);
  store.close();
});

test("autoDream LLM failure is audited as status=error and never blocks the run", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  // Consolidation stream finishes with kind "error" → streamText returns
  // undefined → the run fails safe; runAuditedLlm must still leave an
  // error audit row before the failure propagates.
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "" };
        yield { type: "finish", reason: { kind: "error" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, false, "aborted/errored stream fails the run");
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "failed consolidation still audited");
  assert.equal(rows[0].operation_type, "dream_consolidate");
  assert.equal(rows[0].status, "error");
  assert.ok(rows[0].error_message, "error message recorded");
  // the audit write did not block the failure path
  assert.equal(result.error, "llm failed");
  store.close();
});

test("autoDream throwing LLM is audited as status=error", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        throw new Error("network down");
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, false);
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "throwing call still audited");
  assert.equal(rows[0].status, "error");
  assert.match(rows[0].error_message, /network down/);
  store.close();
});

test("autoDream parse failure is audited as status=error, not fake success", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  // Stream completes fine but returns no JSON array — the run fails, and the
  // audit must NOT claim success (the old bug: llm_audit said dream_consolidate
  // success while the run recorded failed).
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(m) },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "抱歉，我无法解析成 JSON。" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, false);
  assert.equal(result.error, "no json array in llm output");
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "failed consolidation still audited");
  assert.equal(rows[0].operation_type, "dream_consolidate");
  assert.equal(rows[0].status, "error", "stream succeeded but output unusable → audit error");
  assert.match(rows[0].error_message, /no json array in llm output/);
  assert.ok(warnings.some((m) => m.includes("head: 抱歉，我无法解析成")), "raw output head logged for diagnosis");
  store.close();
});

test("autoDream audit is skipped when llmAudit.enabled === false", async () => {
  const { store, service, config } = dreamSetup({ llmAudit: { enabled: false } });
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const ctx = mockCtx();
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, config);
  assert.equal(service.listLlmAudits().length, 0, "no audit rows when disabled");
  store.close();
});

test("autoSummarize writes an llm_audit_logs row (trigger_source autoSummarize)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 }
        ]) };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const config = {
    autoSummarize: true,
    summarizeProvider: "deepseek",
    summarizeModel: "deepseek-chat",
    llmAudit: { enabled: true }
  };
  createSummarizer(ctx, service, config);
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: {} }),
    events: [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我选型" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "one autoSummarize audit row");
  assert.equal(rows[0].trigger_source, "autoSummarize");
  assert.equal(rows[0].operation_type, "summarize_compress");
  assert.equal(rows[0].model_id, "deepseek:deepseek-chat");
  assert.equal(rows[0].status, "success");
  store.close();
});

// --- token 记账：用量嵌在 chunk.usage 下 -------------------------------------
// 真实 dsh-llm 协议的用量形状是 { type:"usage", usage: TokenUsage }（TokenUsage
// = { inputTokens, outputTokens, … }），chunk 顶层没有 token 字段。把整个 chunk
// 当用量对象读取会让 input/output 恒为 undefined，审计行落 0：本机实测 7 天 49
// 次 success 调用 total_tokens 全 0，面板「LLM 消耗」永远显示 0。下面三例锁住
// 真实形状，并保留用量平铺在顶层的兼容分支。

/** 在 base ctx 的流末尾（finish 之前）插入一个 usage chunk。 */
function withUsageChunk(base, usageChunk) {
  return {
    ...base,
    llm: {
      async *stream(options) {
        for await (const chunk of base.llm.stream(options)) {
          if (chunk.type === "finish") yield usageChunk;
          yield chunk;
        }
      }
    }
  };
}

/** consolidation 决策：全部 keep，保证 run 成功且无需解析语义。 */
const keepAllDecisions = (listText) => {
  const ids = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=\w+\s*\|\s*importance=\d+/g)].map((m) => m[1]);
  return JSON.stringify(ids.map((id) => ({ action: "keep", ids: [id] })));
};

test("autoDream records tokens from the nested usage chunk (chunk.usage)", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  const ctx = withUsageChunk(
    mockCtx({ onConsolidation: keepAllDecisions }),
    { type: "usage", usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } }
  );
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, true);

  const rows = service.listLlmAudits();
  const consolidate = rows.find((r) => r.operation_type === "dream_consolidate");
  assert.equal(consolidate.input_tokens, 1200, "input tokens come from chunk.usage");
  assert.equal(consolidate.output_tokens, 300, "output tokens come from chunk.usage");
  assert.equal(consolidate.total_tokens, 1500);
  const summary = rows.find((r) => r.operation_type === "dream_summarize");
  assert.equal(summary.total_tokens, 1500, "the dream summary call is accounted too");
  store.close();
});

test("autoSummarize records tokens from the nested usage chunk (chunk.usage)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const ctx = withUsageChunk({
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 }
        ]) };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  }, { type: "usage", usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 } });
  const config = {
    autoSummarize: true,
    summarizeProvider: "deepseek",
    summarizeModel: "deepseek-chat",
    llmAudit: { enabled: true }
  };
  createSummarizer(ctx, service, config);
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: {} }),
    events: [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我选型" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });

  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, 800, "input tokens come from chunk.usage");
  assert.equal(rows[0].output_tokens, 200, "output tokens come from chunk.usage");
  assert.equal(rows[0].total_tokens, 1000);
  store.close();
});

test("flat top-level usage shape still records tokens", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  const ctx = withUsageChunk(
    mockCtx({ onConsolidation: keepAllDecisions }),
    { type: "usage", inputTokens: 40, outputTokens: 10 }
  );
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, config);
  const consolidate = service.listLlmAudits().find((r) => r.operation_type === "dream_consolidate");
  assert.equal(consolidate.total_tokens, 50, "flat shape is still readable");
  store.close();
});

// --- token 记账的边界语义 ----------------------------------------------------
// 上面三例锁的是「有 usage chunk 且形状正确」。契约的另一半是「没有用量时的
// 行为」：未知不等于错误，记 0（不崩，也不凭空编数），同时保留协议演进时
// 用量平铺在 chunk 根的读法。

test("no usage chunk at all still writes 0 tokens and never crashes", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  // 桩的原始形状就是不发 usage chunk：适配器未上报用量的情形走这条路径。
  const ctx = mockCtx({ onConsolidation: keepAllDecisions });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, true, "缺少用量不该让巩固本身失败");
  const rows = service.listLlmAudits();
  assert.ok(rows.length >= 1, "巩固那行仍然要写下");
  for (const row of rows) {
    assert.equal(row.input_tokens, 0, "未知用量记 0，不编数");
    assert.equal(row.output_tokens, 0);
    assert.equal(row.total_tokens, 0);
  }
  store.close();
});

test("root-level flattened usage fields still record tokens (protocol fallback)", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  // 用量数字直接挂在 chunk 根、没有嵌套 usage 对象，命中的是 `chunk.usage ?? chunk`
  // 的兜底分支；这里用 snake_case，锁住读取端的别名链。
  const ctx = withUsageChunk(
    mockCtx({ onConsolidation: keepAllDecisions }),
    { type: "usage", input_tokens: 9, output_tokens: 3 }
  );
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, true);
  const rows = service.listLlmAudits();
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.input_tokens, 9, "根级平铺字段仍可读");
    assert.equal(row.output_tokens, 3);
    assert.equal(row.total_tokens, 12);
  }
  store.close();
});

// --- API surface ------------------------------------------------------------

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path) {
  const r = new EventEmitter();
  r.url = path;
  r.method = "GET";
  r.headers = {};
  return r;
}

function apiSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  createApi(ctx, service, settings, { add: () => {}, remove: () => false, list: () => [] });
  return { store, service, routes };
}

test("GET /api/dsh-mneme/semantic/llm-audit paginates and filters by source", async () => {
  const { store, service, routes } = apiSetup();
  for (let i = 0; i < 3; i++) {
    service.saveLlmAudit({
      trigger_source: "autoDream",
      operation_type: "dream_consolidate",
      model_id: "deepseek:deepseek-chat",
      input_tokens: 10, output_tokens: 5, status: "success"
    });
  }
  service.saveLlmAudit({
    trigger_source: "autoSummarize",
    operation_type: "summarize_compress",
    model_id: "deepseek:deepseek-chat",
    input_tokens: 3, output_tokens: 1, status: "success"
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit");

  // full page
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?page=1&pageSize=2"), res);
  let data = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(data.total, 4);
  assert.equal(data.page, 1);
  assert.equal(data.pageSize, 2);
  assert.equal(data.items.length, 2);

  // second page
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?page=2&pageSize=2"), res);
  data = JSON.parse(res.body);
  assert.equal(data.items.length, 2, "page 2 has the remaining rows");
  assert.equal(data.total, 4);

  // source filter
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?source=autoSummarize"), res);
  data = JSON.parse(res.body);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].trigger_source, "autoSummarize");
  store.close();
});

test("GET /api/dsh-mneme/semantic/llm-audit/stats aggregates by source and status", async () => {
  const { store, service, routes } = apiSetup();
  service.saveLlmAudit({
    timestamp: new Date().toISOString(),
    trigger_source: "autoDream", operation_type: "dream_consolidate",
    model_id: "m", input_tokens: 100, output_tokens: 40, duration_ms: 25, status: "success"
  });
  service.saveLlmAudit({
    timestamp: new Date().toISOString(),
    trigger_source: "autoDream", operation_type: "dream_summarize",
    model_id: "m", input_tokens: 30, output_tokens: 10, duration_ms: 8, status: "success"
  });
  service.saveLlmAudit({
    timestamp: new Date().toISOString(),
    trigger_source: "autoSummarize", operation_type: "summarize_compress",
    model_id: "m", input_tokens: 5, output_tokens: 2, duration_ms: 4, status: "error"
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit/stats");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit/stats?days=7"), res);
  const stats = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(stats.days, 7);
  assert.equal(stats.total_calls, 3);
  assert.equal(stats.input_tokens, 135);
  assert.equal(stats.output_tokens, 52);
  assert.equal(stats.total_tokens, 187);
  assert.equal(stats.total_duration_ms, 37);
  const bySource = stats.by_source.find((s) => s.source === "autoDream");
  assert.equal(bySource.c, 2);
  assert.equal(bySource.total_tokens, 180);
  const errStatus = stats.by_status.find((s) => s.status === "error");
  assert.equal(errStatus.c, 1);
  store.close();
});
