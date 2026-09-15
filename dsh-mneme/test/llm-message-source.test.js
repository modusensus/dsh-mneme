import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { createSummarizer } from "../src/summarize.js";
import { runSleep } from "../src/dream/sleep.js";
import { extractEntities } from "../src/entities/extractor.js";
import { createVectorIndex } from "../src/vector-index.js";

// 回归：dsh-llm 的消息契约要求每条消息带 source。provider 适配器会直接读
// message.source.kind 来区分用户内容与工具结果（例如
// @mars-sea/dsh-commandcode-provider 的 messagesToCC），缺字段时请求在序列化
// 阶段就抛 "Cannot read properties of undefined (reading 'kind')"，四条 LLM 管线
// （dream / sleep / summarize / entity extraction）全军覆没、耗时 0ms。
// 这里用同等严格的桩驱动真实管线，任何新加的消息漏了 source 都会失败。
function assertMessageSources(options) {
  for (const message of options.messages ?? []) {
    assert.equal(
      message.source?.kind,
      "plugin",
      `LLM 消息缺 source（provider 会抛 TypeError）: ${message.role} / ${String(message.content?.[0]?.text ?? "").slice(0, 40)}`
    );
  }
}

const logger = { warn: () => {}, info: () => {} };

function makeService() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

// dsh-llm chunk 形状与真实 provider 对齐：文本增量 + 终止 chunk。
function reply(text, finish = { reason: { kind: "stop" } }) {
  return (async function* () {
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", ...finish };
  })();
}

// ---------------------------------------------------------------- dream

test("dream: consolidation and summary messages carry source", async () => {
  const { store, service } = makeService();
  service.saveWithDedupe({ type: "project", title: "主题01", content: "规范内容", importance: 5 });
  service.saveWithDedupe({ type: "project", title: "主题01·变体", content: "旧变体", importance: 3 });

  const calls = [];
  const ctx = {
    logger,
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "source-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        assertMessageSources(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        yield* reply(userText.startsWith("id=") ? "[]" : "记忆库总览：已巩固。");
      }
    }
  };

  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const run = await dream.runDream(ctx, service, {});
  assert.equal(run.ok, true, "dream run succeeds against the strict provider stub");
  assert.ok(calls.some((c) => c.purpose === "compaction"), "consolidation called the LLM");
  assert.ok(calls.length >= 2, "consolidation + summary both called");
  store.close();
});

// ---------------------------------------------------------------- summarize

test("summarize: distilled transcript and prompt messages carry source", async () => {
  const { store, service } = makeService();
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    logger,
    llm: {
      stream(options) {
        calls.push(options);
        assertMessageSources(options);
        return reply("[]", { kind: "ok" });
      }
    }
  };
  createSummarizer(ctx, service, { autoSummarize: true });

  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s-source",
    requestHeader: () => ({ config: { provider: "mock", model: "source-model" } }),
    events: [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我选型" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });

  assert.equal(calls.length, 1, "summarization called the LLM");
  store.close();
});

// ---------------------------------------------------------------- sleep

test("sleep: conflict and pattern messages carry source", async () => {
  const { store, service } = makeService();
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embedSingle: async () => [1, 0, 0],
    embed: async () => [1, 0, 0],
    schedule: () => {},
    modelHash: "mock#1",
    dimension: 3
  };
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  // 冲突候选要在向量索引里真有向量（同 sleep.test.js 的 seedConflictPair）；
  // 同时给 pattern 阶段留下 2 条素材。
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);

  const calls = [];
  const ctx = {
    logger,
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        assertMessageSources(options);
        yield* reply("[]");
      }
    }
  };
  const config = {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 2,
    sleepMaxPatternPerRun: 3
  };
  const result = await runSleep(ctx, service, config, logger, { embedder, vectorIndex }, null);

  assert.ok(calls.some((c) => c.purpose === "sleep-conflict"), "conflict phase called the LLM");
  assert.ok(calls.some((c) => c.purpose === "sleep-pattern"), "pattern phase called the LLM");
  assert.ok(result.runId, "sleep run produced a receipt");
  store.close();
});

// ---------------------------------------------------------------- entity extraction

test("entity extraction: messages handed to the llm adapter carry source", async () => {
  const { store, service } = makeService();
  const memory = service.saveWithDedupe({ type: "project", title: "协作", content: "Alpha 与 Beta 一起干活", importance: 3 }).memory;

  const calls = [];
  const callLLM = async (messages) => {
    calls.push(messages);
    assertMessageSources({ messages });
    return "[]";
  };

  await extractEntities(memory, { store, config: {}, callLLM, logger });

  assert.equal(calls.length, 1, "extraction called the LLM adapter");
  store.close();
});
