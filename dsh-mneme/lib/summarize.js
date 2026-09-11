import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { STR, lang } from "./lang.js";

// 编码记忆蒸馏 prompt（codingRetrospect 开启时启用）：在通用记忆之外，额外提取
// 三类编码专属记忆，专治重复踩坑 / 遗忘被否决方案 / 丢失工程约束。字段仍沿用
// title/content 单列结构（store 无结构化字段），信息浓缩进 content。
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
  const VALID = new Set(["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"]);
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
//
// codingRetrospect: the distill context is the FULL turn transcript —
// user prompts plus assistant public replies, tool calls + results and code
// dispatch output — so the summarizer can see tool errors and extract pitfall
// root causes, not just what the user typed. The same filtering stays: only
// source.kind === "user" prompts enter (plugin/machine content is excluded).
// The result is a single text transcript passed to the LLM as one user message
// (SUMMARY_PROMPT already says "根据下面的会话内容").
//
// Privacy: assistant `reasoning` (private thought) blocks are deliberately NOT
// collected — distilled memories must never sink private reasoning chains.
// Only public text blocks (type "text") reach the summarizer.
function collectMessages(session, maxChars = 8000) {
  // DSH 0.1.2-rc.1 起 Session 改用 snapshotEvents()，兼容旧版 .events
  const events = session.snapshotEvents?.() ?? session.events ?? [];
  const lines = [];
  // 兼容严格形状 [{type:"text",text}] 与宽松形状 ["字符串", ...]（lib-smoke 用例
  // 直接传字符串数组）。只取公开文本块；reasoning 私有推理块不进蒸馏上下文。
  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => (typeof block === "string" ? block : (block && block.type === "text" && typeof block.text === "string" ? block.text : "")))
      .filter((s) => s)
      .join("\n");
  };
  const trim = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
  for (const event of events) {
    const data = event?.data ?? {};
    const kind = data?.source?.kind;
    switch (event.type) {
      case "user/message": {
        if (kind !== undefined && kind !== "user") break;
        const text = textOf(data?.content);
        if (text.trim()) lines.push(STR.transcriptUser[lang()](text));
        break;
      }
      case "assistant/message": {
        const msg = data?.message;
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        const text = textOf(blocks);
        if (text.trim()) lines.push(STR.transcriptAssistant[lang()](text));
        // 私有推理块（reasoning）刻意不采集：蒸馏记忆不得沉淀模型私有思考链。
        break;
      }
      case "tool/call": {
        const args = typeof data.arguments === "string"
          ? data.arguments
          : data.arguments ? JSON.stringify(data.arguments) : "";
        lines.push(STR.transcriptToolCall[lang()](data.name ?? "?", trim(args, 300)));
        break;
      }
      case "tool/result": {
        const out = typeof data.output === "string" ? data.output : data.output ? JSON.stringify(data.output) : "";
        const status = data.ok === false ? STR.statusFail[lang()] : STR.statusOk[lang()];
        lines.push(STR.transcriptToolResult[lang()](status, trim(out, 500)));
        break;
      }
      case "tool/code-dispatch": {
        const out = typeof data.output === "string" ? data.output : data.output ? JSON.stringify(data.output) : "";
        const status = data.ok === false ? STR.statusFail[lang()] : STR.statusOk[lang()];
        lines.push(STR.transcriptCode[lang()](status, trim(out, 500)));
        break;
      }
      default:
        break;
    }
  }
  return lines.length ? [createUserMessage({ content: [{ type: "text", text: trim(lines.join("\n"), maxChars) }] })] : [];
}

// ── 智能调速器（429 保护）─────────────────────────────────────────────
// 对话一多时 turn/end 会批量触发蒸馏，多个 LLM 请求"一拥而上"正是 429 的
// 来源。这里借鉴机场安检的思路：所有蒸馏调用进同一个全局串行队列，按间隔
// distillRateLimitIntervalMs 分批放行；命中 429 时按 distillRateLimitBaseDelayMs
// 指数退避（1s→2s→4s…）自动重试 distillRateLimitRetries 次，全程对用户透明，
// 不把 429 错误码直接抛出去。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(error) {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status === 429) return true;
  const msg = String(error?.message ?? error ?? "");
  return /429|rate.?limit|too many requests|请求过于频繁/i.test(msg);
}

// 全局串行链：每个蒸馏任务在前一个结束后才开始，单次失败不阻塞后续。
// 相邻请求间隔按"距上一个结束不足 intervalMs 就补齐等待"实现——单次蒸馏
// 零延迟（上次结束距今已超过间隔，直接放行），只有连续批量蒸馏才触发限速。
let distillQueue = Promise.resolve();
let lastDistillEnd = 0;
function enqueueDistill(task, intervalMs = 0) {
  const run = distillQueue.then(async () => {
    if (intervalMs > 0) {
      const wait = Math.max(0, intervalMs - (Date.now() - lastDistillEnd));
      if (wait > 0) await sleep(wait);
    }
    lastDistillEnd = Date.now();
    return task();
  });
  distillQueue = run.catch(() => {});
  return run;
}

export function createSummarizer(ctx, service, config) {
  if (!config.autoSummarize) return { dispose: () => {} };

  const inFlight = new Map();
  let disposed = false;

  async function summarize(session) {
    if (disposed || inFlight.has(session.id)) return;
    const controller = new AbortController();
    inFlight.set(session.id, controller);
    // audit state for the compression call. null = no audit for this run
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
      // 完整转录（Codex 式）：蒸馏把整轮对话交给 LLM 提炼原子记忆，不再硬裁
      // 8000 字截断语义；上限由 distillMaxChars 控制（默认 24000，可调大）。
      const messages = collectMessages(session, config.distillMaxChars ?? 24000);
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

      const options = {
        provider: route.provider,
        model: route.model,
        purpose: "summarization",
        messages: [
          { role: "system", content: [{ type: "text", text: config.codingRetrospect ? STR.prompts.codingSummary[lang()] : STR.prompts.summary[lang()] }] },
          ...messages
        ],
        signal: controller.signal
      };
      // 智能调速器：整段蒸馏 LLM 调用进全局串行队列，按间隔分批放行；429 时
      // 指数退避自动重试，全程对用户透明，不把 429 错误码直接抛出去。
      const intervalMs = config.distillRateLimitIntervalMs ?? 1000;
      const { text, assembledText, aborted } = await enqueueDistill(async () => {
        const retries = config.distillRateLimitRetries ?? 3;
        const baseDelayMs = config.distillRateLimitBaseDelayMs ?? 1000;
        for (let attempt = 0; ; attempt++) {
          const assembler = new BlockAssembler();
          let text = "";
          let aborted = false;
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
                  // 429 也可能以 finish reason error 携带 rate-limit 信息，统一
                  // 转抛错走指数退避重试。
                  if (isRateLimited(chunk.reason ?? chunk)) {
                    throw Object.assign(new Error("rate limited"), { status: 429 });
                  }
                  if (audit) {
                    audit.status = "error";
                    audit.errorMessage = `llm stream ${reasonKind}`;
                  }
                  aborted = true;
                  break;
                }
              }
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
            return { text, assembledText, aborted };
          } catch (error) {
            if (error?.name === "AbortError" || controller.signal.aborted) throw error; // dispose 中止直接放行
            if (isRateLimited(error) && attempt < retries) {
              const delay = baseDelayMs * 2 ** attempt;
              ctx.logger?.warn?.(
                `dsh-mneme: 蒸馏请求过于频繁(429)，为避免限流等待 ${delay}ms 后自动重试（第 ${attempt + 1}/${retries} 次）`
              );
              await sleep(delay);
              continue;
            }
            // 429 重试耗尽或非 429 错误：记 audit 后抛出，保持原失败路径。
            if (audit) {
              audit.status = "error";
              audit.errorMessage = String(error?.message ?? error);
            }
            throw error;
          }
        }
      }, intervalMs);
      if (aborted) return;
      const entries = parseSummaryJson(text || assembledText);
      for (const entry of entries) {
        // Provenance: the summarizer runs on a real session (turn/end hook), so
        // session.id is always available here — it rides the human-readable
        // source label.
        // 编码记忆类型（codingRetrospect）不带 tag：读取侧门控/加权靠 m.type
        // （rejected_solution/pitfall/constraint）区分即可，tag 体系
        // sanitizeTags 不认 `type:` 前缀反而会清空 tags 列（额外一次 UPDATE）。
        service.saveWithDedupe({
          ...entry,
          source: `session:${session.id}`
        });
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
