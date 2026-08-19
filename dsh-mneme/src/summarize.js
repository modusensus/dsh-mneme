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

// Only direct human prompts are summarized: plugin-injected context
// (AGENTS.md, skill bodies, file-change notices) and other machine-originated
// events must not leak into the memory store. Events without a data payload
// (minimal test doubles) pass the kind check and are handled by the content
// check below.
function collectMessages(session) {
  const messages = [];
  for (const event of session.events ?? []) {
    const kind = event.data?.source?.kind;
    if (event.type !== "user/message") continue;
    if (kind !== undefined && kind !== "user") continue;
    if (!event.data?.content?.length) continue; // nothing to summarize
    messages.push(createUserMessage({ content: event.data.content }));
  }
  return messages.slice(-20);
}

export function createSummarizer(ctx, service, config) {
  if (!config.autoSummarize) return { dispose: () => {} };

  const inFlight = new Map();
  let disposed = false;

  async function summarize(session) {
    if (disposed || inFlight.has(session.id)) return;
    const controller = new AbortController();
    inFlight.set(session.id, controller);
    // Bug8: audit state for the compression call. null = no audit for this run
    // (disabled, or no LLM call was actually made). The audit row is written in
    // the finally below — once, regardless of which exit path the call took —
    // so a failed/aborted stream still leaves a status='error' trail without
    // ever blocking the summarization itself.
    let audit = null;
    try {
      const header = session.requestHeader?.()?.config;
      // Config override takes priority, then session header, then nothing.
      const route = (config.summarizeProvider && config.summarizeModel)
        ? { provider: config.summarizeProvider, model: config.summarizeModel }
        : (header?.provider && header?.model)
          ? { provider: header.provider, model: header.model }
          : undefined;
      if (!route) return;
      const messages = collectMessages(session);
      if (!messages.length) return;

      if (config?.llmAudit?.enabled !== false && typeof service.saveLlmAudit === "function") {
        audit = {
          route,
          timestamp: new Date().toISOString(),
          startedAt: Date.now(),
          inputTokens: 0,
          outputTokens: 0,
          status: "success",
          errorMessage: null
        };
      }

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
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          if (STREAM_CHUNK_TYPES.has(chunk.type)) assembler.push(toProtocolChunk(chunk));
          if (chunk.type === "text-delta") {
            text += chunk.text ?? chunk.delta ?? "";
          }
          if (chunk.type === "usage" && audit) {
            const i = chunk.input_tokens ?? chunk.inputTokens ?? chunk.prompt_tokens ?? chunk.promptTokens;
            const o = chunk.output_tokens ?? chunk.outputTokens ?? chunk.completion_tokens ?? chunk.completionTokens;
            if (Number.isFinite(i)) audit.inputTokens = i;
            if (Number.isFinite(o)) audit.outputTokens = o;
          }
          if (chunk.type === "finish") {
            const reasonKind = chunk.reason?.kind ?? chunk.kind;
            if (reasonKind === "error" || reasonKind === "aborted") {
              if (audit) {
                audit.status = "error";
                audit.errorMessage = `llm stream ${reasonKind}`;
              }
              return;
            }
          }
        }
      } catch (error) {
        if (audit) {
          audit.status = "error";
          audit.errorMessage = String(error?.message ?? error);
        }
        throw error; // caller's catch handles the failure; audit already staged
      }
      // Direct delta accumulation is the primary extraction path (it works
      // for real protocol chunks {index,text} and looser {delta} shapes
      // alike); the assembler blocks are a fallback for streams that only
      // deliver text inside block-end. This dsh-llm exposes no public
      // no-arg assemble() — blocks() is the message-level API.
      const blocks = assembler.blocks();
      const assembledText = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const entries = parseSummaryJson(text || assembledText);
      for (const entry of entries) {
        // Provenance: the summarizer runs on a real session (turn/end hook), so
        // session.id is always available here — it rides both the human-readable
        // source label and the structured session_id column (v0.5.x memory
        // provenance, the raw material for v0.6.0 reasoning-path / drift analysis).
        service.saveWithDedupe({ ...entry, source: `session:${session.id}`, session_id: session.id });
      }
    } finally {
      if (audit) {
        try {
          service.saveLlmAudit({
            timestamp: audit.timestamp,
            trigger_source: "autoSummarize",
            operation_type: "summarize_compress",
            model_id: `${audit.route.provider}:${audit.route.model}`,
            input_tokens: audit.inputTokens,
            output_tokens: audit.outputTokens,
            total_tokens: audit.inputTokens + audit.outputTokens,
            cost_usd: 0,
            duration_ms: Date.now() - audit.startedAt,
            status: audit.status,
            error_message: audit.errorMessage,
            related_memory_ids: []
          });
        } catch (auditError) {
          ctx.logger?.warn?.(`dsh-mneme: llm audit write failed: ${String(auditError)}`);
        }
      }
      inFlight.delete(session.id);
    }
  }

  const unsubscribe = ctx.on("session/event", (session, event) => {
    if (disposed || event.type !== "turn/end") return;
    // Return the summarization promise so awaiters observe the writes; the
    // catch keeps listener dispatch from rejecting. Dispose-initiated aborts
    // and external AbortErrors are silent.
    return summarize(session).catch((error) => {
      if (disposed || error?.name === "AbortError") return;
      ctx.logger?.warn?.(`dsh-mneme: summarization failed: ${String(error)}`);
    });
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    }
  };
}
