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
  assert.equal(Config({}).dreamMaxTokens, 8192, "default unchanged");
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
