// v0.6.2 auto-tag: a lightweight LLM pass that runs after an autoDream
// consolidation and extracts 1-3 tags per retained memory. Opt-in via
// config.autoTagEnabled (default false); autoTagMaxPerRun (default 10) bounds
// how many memories are tagged per run.
//
// Design notes:
//   - ONE batched LLM call per run (the consolidation route is reused). Each
//     memory is a prompt line; the model replies with a JSON array of
//     {"id","tags"} entries — the per-memory contract is `{"tags":[...]}`.
//   - Fail-safe everywhere: a missing route / aborted stream / unparseable
//     JSON / unknown id / illegal tag are all skipped, never thrown. Tagging
//     must never degrade the consolidation run it rides on.
//   - The actual writes go through service.applyMemoryTags inside a
//     service.transaction, so the mirror re-renders exactly once per pass and
//     the write hooks fire once (never per memory).
import { sanitizeTags, MAX_TAG_LENGTH } from "../parser/tag.js";

const TAG_PROMPT = `你是记忆库标签助手。下面是保留的记忆条目（id、标题、内容）。
对每条记忆提取 1-3 个中文或英文标签，用于检索分类。
标签规则：
- 只允许字符：字母、数字、下划线、中文、连字符（如：linux、考研、deepseek-r1）
- 标签长度 ≤ ${MAX_TAG_LENGTH} 字符
- 宁缺毋滥：提取最核心的 1-3 个，不要凑数
- 不要输出内容里没有依据的标签
只输出一个 JSON 数组，每项形如 { "id": "<记忆id>", "tags": ["标签1", "标签2"] }。
不要输出其他文字。`;

/** Same stream consumption contract as dream.js. Returns accumulated text or
 *  undefined when the stream aborted/errored. */
async function streamText(ctx, options) {
  if (!ctx?.llm?.stream) return undefined;
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      return undefined;
    }
  }
  return text;
}

/** Pull the outermost JSON array out of a model reply (same tolerant contract
 *  as sleep.js parseJsonArray): find the first `[` … last `]` and parse. */
function parseJsonArray(text) {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the LLM route for the tag pass: the caller-provided consolidation
 *  route first, then dreamProvider/dreamModel. Falls through to undefined. */
function resolveTagRoute(route, config, logger) {
  if (route?.provider && route?.model) return route;
  if (config?.dreamProvider && config?.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  logger?.warn?.("dsh-mneme auto-tag: no llm route available");
  return undefined;
}

/**
 * Run the auto-tag pass over retained memories.
 * @param {object} opts
 * @param {object} opts.ctx        — { llm, logger }
 * @param {object} opts.service    — service handle (all/transaction/applyMemoryTags)
 * @param {object} opts.config     — plugin config (autoTagMaxPerRun, dreamProvider…)
 * @param {object} [opts.route]    — already-resolved consolidation route
 * @returns {Promise<{ok: boolean, tagged: number, skipped: number, failed: number, skippedBy: boolean}>}
 */
export async function runAutoTag({ ctx, service, config, route }) {
  const logger = ctx?.logger;
  const maxPerRun = Number.isInteger(config?.autoTagMaxPerRun) && config.autoTagMaxPerRun > 0
    ? config.autoTagMaxPerRun
    : 10;
  // Retained = post-consolidation active memories, newest first, capped.
  const memories = service.all()
    .filter((m) => !m.archived && !m.session_disposed_at && m.type !== "summary")
    .sort((a, b) => {
      const ta = String(a.updated_at ?? "");
      const tb = String(b.updated_at ?? "");
      if (ta < tb) return 1;
      if (ta > tb) return -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, Math.max(1, maxPerRun));
  if (!memories.length) return { ok: true, tagged: 0, skipped: 0, failed: 0, skippedBy: "empty" };
  const tagRoute = resolveTagRoute(route, config, logger);
  if (!tagRoute) return { ok: false, tagged: 0, skipped: memories.length, failed: 0, skippedBy: "no-route" };

  const listText = memories
    .map((m) => `id=${m.id} | title=${m.title} | content=${m.content}`)
    .join("\n");
  const text = await streamText(ctx, {
    provider: tagRoute.provider,
    model: tagRoute.model,
    purpose: "compaction",
    maxTokens: Math.min(2048, config?.dreamMaxTokens ?? 2048),
    messages: [
      { role: "system", content: [{ type: "text", text: TAG_PROMPT }] },
      { role: "user", content: [{ type: "text", text: listText }] }
    ]
  });
  if (text === undefined) return { ok: false, tagged: 0, skipped: memories.length, failed: 0, skippedBy: "llm-failed" };

  const entries = parseJsonArray(text);
  if (!entries) {
    logger?.warn?.("dsh-mneme auto-tag: no json array in llm output");
    return { ok: false, tagged: 0, skipped: memories.length, failed: 0, skippedBy: "bad-json" };
  }

  // Validate ids against the candidate set (unknown ids are ignored, never
  // written — a stray id could otherwise tag an unrelated memory).
  const candidateIds = new Set(memories.map((m) => m.id));
  const toWrite = [];
  let skipped = 0;
  let failed = 0;
  const seenIds = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") { failed++; continue; }
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (!id || !candidateIds.has(id)) { failed++; continue; }
    if (seenIds.has(id)) continue; // first entry per id wins
    seenIds.add(id);
    // Reuse the shared sanitizer: strip, ≤20 chars, drop illegal, dedupe.
    const tags = sanitizeTags(entry.tags);
    if (!tags.length) { skipped++; continue; }
    toWrite.push({ id, tags });
  }

  // Write the whole batch under one transaction: mirror re-renders once.
  let tagged = 0;
  try {
    service.transaction(() => {
      for (const { id, tags } of toWrite) {
        service.applyMemoryTags(id, tags);
        tagged++;
      }
    });
  } catch (error) {
    logger?.warn?.(`dsh-mneme auto-tag: write failed: ${String(error)}`);
    return { ok: false, tagged, skipped, failed, skippedBy: "write-failed" };
  }
  return { ok: true, tagged, skipped, failed, skippedBy: false };
}
