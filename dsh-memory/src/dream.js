import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { validateDecisions, applyDecisions } from "./dream/decisions.js";
export { validateDecisions, applyDecisions };

const SUMMARY_PROMPT = `你是记忆库摘要助手。根据整理后的记忆，生成一段 150-200 字的记忆库总览，覆盖：用户偏好、活跃项目、关键决策。之后作为会话上下文注入。只输出摘要文本，不要其他内容。`;

const CONSOLIDATION_PROMPT = `你是记忆库整理助手。下面是全部记忆条目（id、类型、标题、内容、重要性、更新时间）。
请执行记忆巩固（consolidation）：
1. 识别主题相近的条目 → 输出 merge（合并为更精炼的摘要，保留信息最完整的 id 作为 keepSource）
2. 识别重复/过时信息 → 输出 archive
3. 识别内容矛盾的条目 → 输出 conflict（根据时间新旧、来源完整性、信息具体程度判断 winner/loser）
4. 无问题的条目 → 输出 keep

规则：
- 每条记忆至少出现在一个决策中
- merge 的 keepSource 必须是 ids 之一
- 不要编造 ids；只使用提供的 id
- 重要性 1-5，合并后取最高
- 只输出 JSON 数组，不要其他文字`;

function totalChars(memories) {
  return memories.reduce((sum, m) => sum + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0);
}

async function streamText(ctx, options) {
  const assembler = new BlockAssembler();
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    assembler.push(chunk);
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      return undefined;
    }
  }
  return text || assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("");
}

function resolveRoute(ctx, config) {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
  } catch { /* fall through */ }
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  return undefined;
}

export function createDreamScheduler({ onRun, thresholdCount = 10, thresholdChars = 5000, delayMs = 2000 }) {
  let pendingTimer = null;
  let running = false;
  let baseline = { count: 0, chars: 0 };

  function shouldTrigger(service) {
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    const count = memories.length;
    const chars = totalChars(memories);
    const overBase = count >= baseline.count + thresholdCount || chars >= baseline.chars + thresholdChars;
    const overAbs = count >= thresholdCount || chars >= thresholdChars;
    return { trigger: overAbs && overBase, count, chars };
  }

  function maybeSchedule(service) {
    if (running || pendingTimer) return false;
    const { trigger, count, chars } = shouldTrigger(service);
    if (!trigger) return false;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      running = true;
      Promise.resolve(onRun ? onRun() : Promise.resolve())
        .catch(() => {})
        .finally(() => {
          running = false;
          baseline = { count, chars };
        });
    }, delayMs);
    return true;
  }

  function dispose() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  async function runDream(ctx, service, config) {
    const logger = ctx.logger;
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    if (memories.length === 0) return { ok: true, applied: 0, skipped: true };
    const snapshot = new Map(memories.map((m) => [m.id, m]));
    const route = resolveRoute(ctx, config);
    if (!route) return { ok: false, error: "no llm route" };

    const listText = [...snapshot.values()].map((m) =>
      `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`
    ).join("\n");

    const decisionText = await streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 4096,
      messages: [
        { role: "system", content: [{ type: "text", text: CONSOLIDATION_PROMPT }] },
        { role: "user", content: [{ type: "text", text: listText }] }
      ]
    });
    if (decisionText === undefined) return { ok: false, error: "llm failed" };

    let decisions;
    try {
      const start = decisionText.indexOf("[");
      const end = decisionText.lastIndexOf("]");
      if (start === -1 || end <= start) return { ok: false, error: "no json array in llm output" };
      decisions = JSON.parse(decisionText.slice(start, end + 1));
    } catch {
      return { ok: false, error: "invalid decisions json" };
    }
    const { ok, errors } = validateDecisions(decisions, snapshot);
    if (!ok) {
      logger?.warn?.(`dsh-memory dream: invalid decisions: ${errors.join("; ")}`);
      return { ok: false, error: `invalid decisions: ${errors.length} errors` };
    }

    const applied = applyDecisions(decisions, service, logger);

    // Summary generation (second LLM call)
    const summaryText = await streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.dreamMaxTokens ?? 2048,
      messages: [
        { role: "system", content: [{ type: "text", text: SUMMARY_PROMPT }] },
        { role: "user", content: [{ type: "text", text: service.all().filter((m) => !m.archived && m.type !== "summary").map((m) => `- ${m.title}: ${m.content}`).join("\n") }] }
      ]
    });
    if (summaryText !== undefined && summaryText.trim()) {
      service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: summaryText.trim(), importance: 5, source: "dream" });
    }
    return { ok: true, applied };
  }

  return { maybeSchedule, runDream, dispose };
}
