import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

const SUMMARY_PROMPT = `你是记忆库提炼助手。根据下面的会话内容，提炼 2-3 条值得跨会话记住的记忆。
只输出 JSON 数组，每项形如 {"type":"preference|project|decision|history","title":"简短标题","content":"一句话内容","importance":1-5}。
不要输出任何其他文字。`;

/** Extract a JSON array from LLM output that may contain prose around it. */
export function parseSummaryJson(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const VALID = new Set(["preference", "project", "decision", "history"]);
  return arr.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      VALID.has(item.type) &&
      typeof item.title === "string" &&
      item.title.trim() &&
      typeof item.content === "string" &&
      item.content.trim()
  ).map((item) => ({
    type: item.type,
    title: item.title.trim(),
    content: item.content.trim(),
    importance: Number.isInteger(item.importance) ? Math.min(5, Math.max(1, item.importance)) : 3
  }));
}

// The dsh-llm StreamChunk protocol BlockAssembler.push() consumes:
// block-start {index, blockType}, text-delta {index, text},
// block-end {index, block}, finish {reason}. Some consumers observe a
// looser shape ({block} / {delta} / {kind}); normalize before pushing so
// both real adapter streams and shape-tolerant test doubles assemble.
const STREAM_CHUNK_TYPES = new Set([
  "block-start",
  "text-delta",
  "reasoning-delta",
  "tool-call-delta",
  "block-end",
  "usage",
  "finish"
]);

function toProtocolChunk(chunk) {
  switch (chunk.type) {
    case "block-start":
      return { type: "block-start", index: chunk.index ?? 0, blockType: chunk.blockType ?? chunk.block?.type ?? "text" };
    case "text-delta":
      return { type: "text-delta", index: chunk.index ?? 0, text: chunk.text ?? chunk.delta ?? "" };
    case "reasoning-delta":
      return { type: "reasoning-delta", index: chunk.index ?? 0, text: chunk.text ?? chunk.delta ?? "" };
    case "block-end":
      return { type: "block-end", index: chunk.index ?? 0, block: chunk.block ?? { type: "text" } };
    case "finish":
      return {
        type: "finish",
        reason: chunk.reason ?? { kind: chunk.kind === "error" ? "error" : "stop" },
        replayState: chunk.replayState
      };
    default:
      return chunk;
  }
}

function collectMessages(session) {
  const messages = [];
  for (const event of session.events ?? []) {
    if (event.type === "user/message") {
      messages.push(createUserMessage({ content: event.data?.content ?? [{ type: "text", text: "" }] }));
    }
  }
  return messages.slice(-20);
}

export function createSummarizer(ctx, service, config) {
  if (!config.autoSummarize) return { dispose: () => {} };

  let inFlight = new Map();

  async function summarize(session) {
    if (inFlight.has(session.id)) return;
    const controller = new AbortController();
    inFlight.set(session.id, controller);
    try {
      const header = session.requestHeader?.()?.config;
      const route = header?.provider && header?.model
        ? { provider: header.provider, model: header.model }
        : undefined;
      if (!route) return;
      const messages = collectMessages(session);
      if (!messages.length) return;

      const assembler = new BlockAssembler();
      let text = "";
      const options = {
        provider: route.provider,
        model: route.model,
        purpose: "summarization",
        messages: [
          { role: "system", content: [{ type: "text", text: SUMMARY_PROMPT }] },
          ...messages
        ],
        signal: controller.signal
      };
      for await (const chunk of ctx.llm.stream(options)) {
        if (STREAM_CHUNK_TYPES.has(chunk.type)) assembler.push(toProtocolChunk(chunk));
        if (chunk.type === "text-delta") {
          text += chunk.text ?? chunk.delta ?? "";
        }
        if (chunk.type === "finish" && (chunk.kind === "error" || chunk.reason?.kind === "error")) return;
      }
      // Real adapters emit protocol chunks that BlockAssembler reassembles;
      // fall back to the raw delta text for non-protocol shapes. Note: this
      // dsh-llm exposes no public no-arg assemble() — blocks() is the API.
      const blocks = assembler.blocks();
      const assembledText = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const entries = parseSummaryJson(text || assembledText);
      for (const entry of entries) {
        service.saveWithDedupe({ ...entry, source: `session:${session.id}` });
      }
    } finally {
      inFlight.delete(session.id);
    }
  }

  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    // Return the summarization promise so awaiters (tests, runtime dispatch)
    // observe the writes; the catch keeps listener dispatch from rejecting.
    return summarize(session).catch((error) => {
      ctx.logger?.warn?.(`dsh-memory: summarization failed: ${String(error)}`);
    });
  });

  return {
    dispose() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    }
  };
}
