import { validateDecisions, applyDecisions } from "./dream/decisions.js";
import { createHash, randomUUID } from "node:crypto";
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
- 仅合并同类型条目（type 相同）
- 不要编造 ids；只使用提供的 id
- 重要性 1-5，合并后取最高
- 只输出 JSON 数组，不要其他文字`;

function totalChars(memories) {
  return memories.reduce((sum, m) => sum + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0);
}

// ---------------------------------------------------------------- audit

/**
 * Canonical digest of the consolidation input snapshot. Built from stable
 * fields sorted by id, so identical inputs always yield the same hash — the
 * basis for replaying/verifying a recorded decision (receipt check).
 */
export function hashSnapshot(memories) {
  const canon = memories
    .map((m) => [m.id, m.type, m.title, m.content, m.importance, m.updated_at])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((parts) => parts.map((p) => String(p ?? "")).join("\u0001"))
    .join("\u0002");
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Compact machine-verifiable receipt for one autoDream run. Format:
 *   dsh-mneme:run:<runId>:<status>:<snapshotHash(12)>:<inputCount>:<applied>:<summaryFlag>
 * Enough to correlate a run with its persisted audit row and to spot silent
 * drift (same snapshot hash + same decisions must reproduce the same outcome).
 */
export function buildReceipt({ runId, status, snapshotHash, inputCount, applied, summaryStored }) {
  return `dsh-mneme:run:${runId}:${status}:${snapshotHash.slice(0, 12)}:${inputCount}:${applied}:${summaryStored ? 1 : 0}`;
}

/**
 * Parse a receipt back into fields; returns undefined for malformed input.
 */
export function parseReceipt(receipt) {
  if (typeof receipt !== "string") return undefined;
  const parts = receipt.split(":");
  if (parts.length !== 8 || parts[0] !== "dsh-mneme" || parts[1] !== "run") return undefined;
  const [, , runId, status, snapshotHash, inputCount, applied, summaryStored] = parts;
  if (!runId || !/^(ok|failed)$/.test(status)) return undefined;
  const count = Number(inputCount);
  const appliedN = Number(applied);
  if (!Number.isInteger(count) || !Number.isInteger(appliedN)) return undefined;
  return { runId, status, snapshotHash, inputCount: count, applied: appliedN, summaryStored: summaryStored === "1" };
}

/**
 * Derive the per-id disposition (keep / merge-keep / merge-archived /
 * archived / conflict-winner / conflict-archived) from a validated decision
 * list. Stored in the audit row so a run can be replayed without re-running
 * the LLM.
 */
export function buildOutcome(decisions) {
  const byId = {};
  for (const d of decisions ?? []) {
    if (d.action === "keep") {
      for (const id of d.ids) byId[id] = "keep";
    } else if (d.action === "archive") {
      for (const id of d.ids) byId[id] = "archived";
    } else if (d.action === "merge") {
      for (const id of d.ids) byId[id] = id === d.keepSource ? "merge-keep" : "merge-archived";
    } else if (d.action === "conflict") {
      byId[d.winner] = "conflict-winner";
      byId[d.loser] = "conflict-archived";
    }
  }
  return { byId };
}

/**
 * Consume an LLM stream and return the accumulated text. Direct text-delta
 * accumulation covers both the real protocol ({type:"text-delta", index, text})
 * and looser test doubles ({type:"text-delta", text}); a terminal error/abort
 * surfaces as undefined. The caller decides how to treat an empty result.
 */
async function streamText(ctx, options) {
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
      return undefined;
    }
  }
  return text;
}

/**
 * Resolve the LLM route: agent default model (deployment) first, plugin config
 * (dreamProvider/dreamModel) as fallback. Falls through to undefined when no
 * route exists — runDream then fails safe. Fallback is logged so a silent
 * route switch is observable.
 */
function resolveRoute(ctx, config, logger) {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
    logger?.warn?.("dsh-mneme dream: agentDefaultModel unavailable, falling back to config route");
  } catch (error) {
    logger?.warn?.(`dsh-mneme dream: agentDefaultModel lookup failed, falling back to config route: ${String(error)}`);
  }
  if (config.dreamProvider && config.dreamModel) return { provider: config.dreamProvider, model: config.dreamModel };
  return undefined;
}

export function createDreamScheduler({ onRun, thresholdCount = 10, thresholdChars = 5000, delayMs = 2000, logger }) {
  let pendingTimer = null;
  let running = false;
  let disposed = false;
  let baseline = { count: 0, chars: 0 };
  let inFlight = null;

  function shouldTrigger(service) {
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    const count = memories.length;
    const chars = totalChars(memories);
    const overBase = count >= baseline.count + thresholdCount || chars >= baseline.chars + thresholdChars;
    const overAbs = count >= thresholdCount || chars >= thresholdChars;
    return { trigger: overAbs && overBase, count, chars };
  }

  function maybeSchedule(service) {
    if (disposed || running || pendingTimer) return false;
    const { trigger, count, chars } = shouldTrigger(service);
    if (!trigger) return false;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      running = true;
      // Defer the onRun invocation so a synchronous throw cannot escape the
      // timer callback (which would crash the process) and skip the teardown.
      // Errors are logged, never swallowed silently. inFlight lets dispose()
      // await the running consolidation before the caller closes the store.
      inFlight = Promise.resolve()
        .then(() => (onRun ? onRun() : Promise.resolve({ ok: true, skipped: true })))
        .then((result) => {
          // Refresh the baseline only for a successful run (design §5.3: an
          // LLM failure must not move the baseline, so the next write can
          // immediately re-trigger a retry). A `{ok:false}` result or a throw
          // keeps the old baseline. A run that reports nothing is treated as
          // completed without failure (no-op hooks / minimal test doubles).
          if (result && result.ok) {
            try {
              baseline = shouldTrigger(service);
            } catch (error) {
              // Store closed mid-flight: keep the last known baseline.
              logger?.warn?.(`dsh-mneme dream: baseline refresh failed: ${String(error)}`);
            }
          }
        })
        .catch((error) => {
          logger?.warn?.(`dsh-mneme dream: run failed: ${error?.message ?? error}`);
          // Failed runs do not refresh the baseline.
        })
        .finally(() => {
          running = false;
          inFlight = null;
        });
    }, delayMs);
    return true;
  }

  async function dispose() {
    disposed = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    // An in-flight run is left to complete naturally (its LLM calls are
    // already paid for and aborting would discard the work). Await it so the
    // caller can close the store only after every write has landed.
    if (inFlight) await inFlight.catch(() => {});
  }

  async function runDream(ctx, service, config) {
    const logger = ctx.logger;
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    if (memories.length === 0) return { ok: true, applied: 0, skipped: true, summary: false };
    const snapshot = new Map(memories.map((m) => [m.id, m]));
    const route = resolveRoute(ctx, config, logger);
    const runId = randomUUID();
    const snapshotHash = hashSnapshot([...snapshot.values()]);
    // Every exit (success or failure) funnels through `finish`, which writes
    // the audit row + receipt. A record failure is logged, never thrown —
    // auditing must not break the consolidation path. Failed runs still
    // capture their decisions/outcome when the LLM produced a validated list
    // (e.g. summary step failed after consolidation), so the partial write is
    // replayable too.
    const finish = (result) => {
      const status = result.ok ? "ok" : "failed";
      const applied = result.applied ?? 0;
      const summaryStored = result.summary ?? false;
      const receipt = buildReceipt({ runId, status, snapshotHash, inputCount: snapshot.size, applied, summaryStored });
      try {
        service.saveDreamRun({
          id: runId,
          status,
          error: result.error,
          provider: route?.provider,
          model: route?.model,
          snapshot_hash: snapshotHash,
          input_count: snapshot.size,
          // Full input snapshot (canonical fields) so the exact arbitration
          // input can be rebuilt offline from the audit row alone — the
          // digest + decisions + outcome triple makes silent errors locatable
          // even after the store has moved on.
          input: [...snapshot.values()].map((m) => ({
            id: m.id,
            type: m.type,
            title: m.title,
            content: m.content,
            importance: m.importance,
            updated_at: m.updated_at
          })),
          decisions: result.decisions,
          outcome: result.outcome,
          applied,
          summary_stored: summaryStored,
          receipt
        });
      } catch (error) {
        logger?.warn?.(`dsh-mneme dream: failed to record audit run: ${String(error)}`);
      }
      return { ...result, runId, receipt, snapshotHash };
    };
    if (!route) {
      logger?.warn?.("dsh-mneme dream: no llm route available");
      return finish({ ok: false, error: "no llm route", summary: false });
    }

    const listText = [...snapshot.values()].map((m) =>
      `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`
    ).join("\n");

    let decisionText;
    try {
      decisionText = await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        purpose: "compaction",
        maxTokens: config.dreamMaxTokens ?? 4096,
        messages: [
          { role: "system", content: [{ type: "text", text: CONSOLIDATION_PROMPT }] },
          { role: "user", content: [{ type: "text", text: listText }] }
        ]
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: consolidation llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", summary: false });
    }
    if (decisionText === undefined) {
      logger?.warn?.("dsh-mneme dream: consolidation llm stream aborted or errored");
      return finish({ ok: false, error: "llm failed", summary: false });
    }

    let decisions;
    try {
      const start = decisionText.indexOf("[");
      const end = decisionText.lastIndexOf("]");
      if (start === -1 || end <= start) {
        logger?.warn?.("dsh-mneme dream: no json array in llm output");
        return finish({ ok: false, error: "no json array in llm output", summary: false });
      }
      decisions = JSON.parse(decisionText.slice(start, end + 1));
    } catch {
      logger?.warn?.("dsh-mneme dream: invalid decisions json");
      return finish({ ok: false, error: "invalid decisions json", summary: false });
    }
    const { ok, errors } = validateDecisions(decisions, snapshot);
    if (!ok) {
      logger?.warn?.(`dsh-mneme dream: invalid decisions: ${errors.join("; ")}`);
      return finish({ ok: false, error: `invalid decisions: ${errors.length} errors`, summary: false });
    }

    const applied = applyDecisions(decisions, service, logger);
    const outcome = buildOutcome(decisions);

    // Summary generation (second LLM call). A throwing stream is reported as
    // a failed run; summary:false marks a run that produced no summary.
    let summaryText;
    try {
      summaryText = await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        purpose: "compaction",
        maxTokens: config.dreamMaxTokens ?? 2048,
        messages: [
          { role: "system", content: [{ type: "text", text: SUMMARY_PROMPT }] },
          { role: "user", content: [{ type: "text", text: service.all().filter((m) => !m.archived && m.type !== "summary").map((m) => `- ${m.title}: ${m.content}`).join("\n") }] }
        ]
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme dream: summary llm call failed: ${String(error)}`);
      return finish({ ok: false, error: "llm failed", applied, decisions, outcome, summary: false });
    }
    let summaryStored = false;
    if (summaryText !== undefined && summaryText.trim()) {
      service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: summaryText.trim(), importance: 5, source: "dream" });
      summaryStored = true;
    }
    return finish({ ok: true, applied, decisions, outcome, summary: summaryStored });
  }

  return { maybeSchedule, runDream, dispose };
}
