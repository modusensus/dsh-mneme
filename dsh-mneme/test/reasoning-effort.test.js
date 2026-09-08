// Regression for issue #9:
//  - B: dreamMaxTokens cap widened (min 256, max 131072) so large memory
//    libraries no longer starve the consolidation output.
//  - A: dreamReasoningEffort / sleepReasoningEffort pass-through. Default
//    'none' must OMIT the reasoningEffort field entirely (the provider's own
//    default applies); low/medium/high are forwarded verbatim on every dream /
//    sleep LLM call. Asserted by capturing the options each llm.stream() sees.
import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { createDreamScheduler } from "../src/dream.js";
import { runSleep } from "../src/dream/sleep.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

// ---------------------------------------------------------------- config schema

test("issue#9: dreamMaxTokens accepts the widened 131072 cap and defaults to 4096", () => {
  assert.equal(Config({}).dreamMaxTokens, 32768, "default unchanged");
  assert.equal(Config({ dreamMaxTokens: 131072 }).dreamMaxTokens, 131072, "new upper bound accepted");
  assert.equal(Config({ dreamMaxTokens: 65536 }).dreamMaxTokens, 65536, "intermediate value accepted");
});

test("issue#9: reasoningEffort config defaults to none and rejects unknown values", () => {
  const cfg = Config({});
  assert.equal(cfg.dreamReasoningEffort, "none");
  assert.equal(cfg.sleepReasoningEffort, "none");
  assert.equal(Config({ dreamReasoningEffort: "high" }).dreamReasoningEffort, "high");
  assert.equal(Config({ sleepReasoningEffort: "medium" }).sleepReasoningEffort, "medium");
  assert.throws(() => Config({ dreamReasoningEffort: "bogus" }), "invalid effort rejected");
  assert.throws(() => Config({ sleepReasoningEffort: "ultra" }), "invalid effort rejected");
});

// ---------------------------------------------------------------- dream passthrough

/** dream ctx that records every llm.stream() call's options for inspection. */
function dreamCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文。", captured = [] } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        captured.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText) : "[]" };
        } else {
          yield { type: "text-delta", index: 0, text: summaryText };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

test("issue#9: dream omits reasoningEffort under default 'none' and still consolidates (applied>0)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);
  assert.ok(result.applied > 0, "end-to-end dream run still lands changes");
  assert.equal(captured.length, 2, "consolidation + summary both hit the LLM");
  for (const options of captured) {
    assert.equal("reasoningEffort" in options, false, `default 'none' must not forward reasoningEffort (${options.purpose})`);
  }
  store.close();
});

test("issue#9: dream forwards dreamReasoningEffort on both LLM calls", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "high" });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 2);
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "high", `reasoningEffort forwarded on ${options.purpose}`);
  }
  store.close();
});

test("issue#25: dreamProvider/dreamModel config wins over the agentDefaultModel route", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  // dreamCtx's agentDefaultModel resolves (mock:mock-model), but the explicit
  // config route must win — otherwise dreamProvider/dreamModel is dead code in
  // a standard DSH install and the dream can never be moved off a thinking model.
  const result = await dream.runDream(ctx, service, { dreamProvider: "volcano", dreamModel: "deepseek-v3" });
  assert.equal(result.ok, true);
  assert.ok(captured.length >= 2, "consolidation + summary both hit the LLM");
  for (const options of captured) {
    assert.equal(options.provider, "volcano");
    assert.equal(options.model, "deepseek-v3", "config route wins over agentDefaultModel (mock:mock-model)");
  }
  store.close();
});

test("issue#9: rejected reasoningEffort retries once without it and still consolidates", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const calls = [];
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          // First attempt forwards reasoningEffort: the provider rejects it.
          if (options.reasoningEffort) {
            throw new Error("UNSUPPORTED_REASONING_EFFORT: DeepSeek does not support reasoning effort \"low\"");
          }
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：用户偏好中文。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, true, "run survives the effort rejection via the fallback retry");
  assert.ok(result.applied > 0, "consolidation still lands changes");
  assert.equal(calls.length, 3, "consolidation tried (rejected) + retried without effort + summary");
  assert.equal(calls[0].reasoningEffort, "low", "first consolidation attempt forwards the effort");
  assert.equal("reasoningEffort" in calls[1], false, "retry omits the rejected effort field");
  store.close();
});

// ---------------------------------------------------------------- sleep passthrough

function sleepSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 10,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

/** sleep ctx that records every llm.stream() call's options. */
function sleepCtx(onConsolidation, selection = { provider: "mock", model: "sleep-model" }, captured = []) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      async *stream(options) {
        captured.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText) : "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

test("issue#9: sleep forwards sleepReasoningEffort on its LLM passes", async () => {
  const { store, service, vectorIndex } = sleepSetup();
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const captured = [];
  const ctx = sleepCtx(
    (userText) => userText.startsWith("候选冲突")
      ? JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
      : "[]",
    { provider: "mock", model: "sleep-model" },
    captured
  );
  const result = await runSleep(ctx, service, baseConfig({ sleepReasoningEffort: "medium" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");
  assert.ok(captured.length >= 2, "conflict + pattern passes both hit the LLM");
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "medium", `reasoningEffort forwarded on ${options.purpose}`);
  }
  store.close();
});

// ------------------------------------------------------------------ stream-level rejection
// dsh-llm rc.1 converts adapter-stage failures (including the provider's
// UNSUPPORTED_REASONING_EFFORT throw from resolveCallWithInfo) into a terminal
// error finish chunk inside adapterStream — the rejection NEVER reaches our
// catch. The v0.7.16 throw-based fallback was therefore dead code for the
// stream path; these tests pin the finish-chunk-based fallback.

test("rc.1 stream-level effort rejection (error finish chunk) also triggers the no-effort retry", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const calls = [];
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        if (options.reasoningEffort) {
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: {
                code: "UNSUPPORTED_REASONING_EFFORT",
                message: 'provider "mock" model "mock-model" does not support reasoning effort "low"'
              }
            }
          };
          return;
        }
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：用户偏好中文。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, true, "run survives the stream-level effort rejection");
  assert.ok(result.applied > 0, "consolidation still lands changes");
  assert.equal(calls[0].reasoningEffort, "low", "first attempt forwards the effort");
  assert.equal("reasoningEffort" in calls[1], false, "retry omits the rejected effort field");
  assert.ok(warnings.some((w) => w.includes("rejected via stream")), "the stream-level rejection is logged");
  store.close();
});

test("non-effort stream failures are not retried and the finish-chunk cause reaches the audit row", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const calls = [];
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "finish", reason: { kind: "error", failure: { code: "PROVIDER_GONE", message: "provider mock is not registered" } } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "llm failed", "the run error stays the stable short string");
  assert.equal(calls.length, 1, "no blind retry when the stream failure is not an effort rejection");
  const row = service.listLlmAudits().find((r) => r.operation_type === "dream_consolidate");
  assert.ok(row && row.status === "error", "failed consolidation still audited");
  assert.ok(
    String(row.error_message).includes("PROVIDER_GONE") && String(row.error_message).includes("provider mock is not registered"),
    "audit error_message carries the finish-chunk cause"
  );
  store.close();
});

test("sleep passes the stream failure accessor so a stream-level effort rejection retries", async () => {
  const { store, service, vectorIndex } = sleepSetup();
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const captured = [];
  const ctx = sleepCtx(null, { provider: "mock", model: "sleep-model" }, captured);
  ctx.llm.stream = async function* (options) {
    captured.push(options);
    if (options.reasoningEffort) {
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: 'provider "mock" model "sleep-model" does not support reasoning effort "low"' } }
      };
      return;
    }
    const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
    yield { type: "text-delta", index: 0, text: userText.startsWith("候选冲突")
      ? JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
      : "[]" };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  const result = await runSleep(ctx, service, baseConfig({ sleepReasoningEffort: "low" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok", "sleep survives the stream-level effort rejection");
  assert.equal(captured[0].reasoningEffort, "low", "first conflict attempt forwards the effort");
  assert.equal("reasoningEffort" in captured[1], false, "conflict retry omits the rejected effort field");
  store.close();
});
