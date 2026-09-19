// dsh-mneme/src/organize.js
// agent 主动整理接口（issue #231，口径基线 = #164 的「第三腿触发」）：dryRun
// 出比对报告 → agent 判断 → apply 落库；筛除项进归档不删；调用全程留审计回执。
//
// 只做功能本体（维护者口径，issue #231）：落在 service 层并带测试，**不进工具
// 列表、不加独立 opt-in 开关**——#249 到位时只差「注册工具 + 注入指引」一步。
//
// 独立成模块（AGENTS.md 尺寸约定，同 document.js / recall-stats.js 先例）：
// service.js 只做依赖注入 + barrel 出口，调用方零改动。
//
// 四条硬规则，都是「宁可什么都不做」的形态：
// 1. dryRun 不写记忆表：它只读 + 写一行审计（dream_runs）。比对是报告，不是动作。
// 2. apply 必须引用一次真实 dryRun——run_id 且 run_type='organize'，且不是 apply
//    自己的回执（靠 outcome.dry_run_id 区分）、也不是 failed 的报告。没有比对过的
//    候选一律不落库，堵死「跳过报告直接写」这条绕过路径。
// 3. apply 只重放 dryRun 校验过的那份规范化快照，且只认快照里的索引：被 dryRun
//    跳过的候选没有资格落库；payload 级 scope 也随快照一起走，不会出现「报告按
//    scope A 比对、落地却写成全局」的错位。
// 4. 筛除 = 归档（store.setArchived），绝不物理删除：归档可恢复，删除不可逆。
//
// 宽容形态（仓库红线 4，同 issue #89）只管**输入**：单条非法候选/决策跳过 + 应用
// 合法子集 + run 记 degraded，不整单拒绝。基础设施错误（嵌入器抛错、存储异常）
// 相反——记 failed 并原样上抛，绝不静默降级成「没找到重复」。审计口径复用
// dream_runs 的 receipt 语义（buildReceipt / parseReceipt 同一格式），不新建审计面。

import { createHash, randomUUID } from "node:crypto";
import { scopeKeyOf } from "./scope.js";
import { cosineSimilarity } from "./dream/clustering.js";
import { buildReceipt } from "./dream.js";

// 与 document 的 C2 档（#230）和 findSessionDuplicate 的 vector 档同源：同一份
// 「近重复」语义只有一个阈值，不在第三个地方另发明一个。
const MIN_SIM = 0.92;
// 向量比对对象的上限（document.js 同口径：精确层全量、向量层有界）。精确层
// 不能截断——同标题漏检会让报告给出错误的 verdict。
const CANDIDATE_LIMIT = 200;
// 单次 dryRun 的候选硬上限：主场景是「长段工作收尾整理」，不是批量导入；不设界
// 的话一次调用会把整库拉进比对。
const MAX_ITEMS = 50;
// scope 标注只做搬运（判定在 store / service 侧），省得整理接口成为第二条绕过
// scope 治理的写入通道。载荷级给的值是候选级的缺省——比对按它判 scope，落地就必须
// 带上它，否则报告与写入落在两个 scope 里。
const SCOPE_KEYS = ["sensitivity", "agent_scope", "workspace_scope", "agent_scope_source", "workspace_scope_source"];

/**
 * Build the organizer.
 *
 * Injected deps are service.js closure members (store / embedQuery / saveWithDedupe
 * / transaction / finalize) so this module stays free of service-internal wiring;
 * `saveWithDedupe` is the normal write path, so its own epilogue (mirror sync and
 * notify) is never duplicated here. `finalize` is the post-commit re-embed hook
 * (document.js 同款): transaction 提交后补重嵌入，见 service.js › transaction 注释。
 *
 * @returns {{ organize: (payload: object, opts?: object) => Promise<object> }}
 *   `organize({ mode: "dryRun"|"apply", ... }, opts)` — 一个入口带 mode 参数
 *   （维护者倾向的形态），内部两个具名函数各自可测。
 */
export function createOrganizer({ store, embedQuery, saveWithDedupe, transaction, finalize }) {
  const hashOf = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

  /**
   * 候选规范化。返回 `{ candidate }` 或 `{ error }`——错误在 dryRun 里进 skipped，
   * 不抛整单（红线 4）。document 刻意在此拦下：它的唯一铸造口是 registerDocument
   * （#230），service 的通用 save 路径也会拒绝，这里提前拦截只是为了报告不撒谎。
   */
  function normalizeCandidate(raw, defaults = {}) {
    const type = String(raw?.type ?? "").trim();
    const title = String(raw?.title ?? "").trim();
    const content = String(raw?.content ?? "").trim();
    if (!type || !title || !content) return { error: "type/title/content are required" };
    if (type === "document") return { error: "document rows are minted only via registerDocument (#230)" };
    const candidate = {
      type,
      title,
      content,
      importance: Number.isInteger(raw?.importance) ? Math.min(5, Math.max(1, raw.importance)) : 3,
      tags: [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map((t) => String(t ?? "").trim()).filter(Boolean))],
      source: String(raw?.source ?? "organize")
    };
    for (const key of SCOPE_KEYS) {
      const value = raw?.[key] ?? defaults[key];
      if (value !== undefined) candidate[key] = value;
    }
    return { candidate };
  }

  /** 标题归一（同 findSessionDuplicate 的 title 档）：大小写与标点不构成「不同标题」。 */
  const normalizeTitle = (s) => String(s ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");

  /**
   * 向量档最佳命中。拿不到向量/嵌入器时返回 null（无信号 = 不判定，不是报错）；
   * 但**抛出的**错误不再吞掉——嵌入器故障下的空信号会被读成「全是新条目」，让
   * agent 把重复条写进库，比整单失败更糟，交 dryRun 记 failed 后上抛。
   */
  async function bestNear(candidate, rows, vecs) {
    if (!vecs?.size) return null;
    const probe = await embedQuery([candidate.title, candidate.content].filter(Boolean).join("\n"));
    if (!probe) return null;
    let best = null;
    for (const m of rows) {
      const v = vecs.get(m.id);
      if (!v) continue; // 无向量的既有行不参与比对
      const sim = cosineSimilarity(probe, v);
      if (sim >= MIN_SIM && (!best || sim > best.sim)) best = { memory: m, sim };
    }
    return best;
  }

  /**
   * 比对报告。**不写记忆表**；只写一行 dream_runs 审计（run_type='organize'）。
   *
   * @param {object} payload
   *   `{ candidates: Array<{type,title,content,importance?,tags?}>, agent_scope?,
   *      workspace_scope?, sensitivity? }`
   * @returns {Promise<{run_id, created_at, status, counts, items, skipped}>}
   *   items[i] = `{ index, type, title, verdict: "exact"|"near"|"new", match }`
   */
  async function dryRun(payload = {}) {
    const raws = Array.isArray(payload.candidates) ? payload.candidates : null;
    if (!raws) throw new Error("organize.dryRun: candidates must be an array");
    const bounded = raws.slice(0, MAX_ITEMS);
    const defaults = Object.fromEntries(SCOPE_KEYS.filter((k) => payload?.[k] !== undefined).map((k) => [k, payload[k]]));

    const skipped = [];
    const accepted = [];
    bounded.forEach((raw, index) => {
      const { candidate, error } = normalizeCandidate(raw, defaults);
      if (error) skipped.push({ index, error });
      else accepted.push({ index, candidate });
    });
    // 审计存规范化快照（带原始索引），不存调用方原始输入：apply 要重放的就是这份
    // ——原始输入里混着被跳过的候选，也没有随行的 payload 级 scope。
    const snapshot = accepted.map(({ index, candidate }) => ({ index, ...candidate }));

    // scope 同等才比对（跨 scope 永不互判——防泄漏，与 saveWithDedupe 的去重键
    // 「type+title+scope」同口径）。行扫描与向量读取按 type 缓存：一批候选通常
    // 同类型，避免逐条全表扫。
    const scopeMatches = (m) =>
      scopeKeyOf(m.agent_scope) === scopeKeyOf(payload?.agent_scope) &&
      scopeKeyOf(m.workspace_scope) === scopeKeyOf(payload?.workspace_scope) &&
      scopeKeyOf(m.sensitivity) === scopeKeyOf(payload?.sensitivity);
    const rowsByType = new Map();
    const rowsFor = (type) => {
      if (!rowsByType.has(type)) {
        rowsByType.set(type, store.list({ type, limit: null }).filter((m) => !m.archived && scopeMatches(m)));
      }
      return rowsByType.get(type);
    };
    const vecsByType = new Map();
    const vecsFor = (type, rows) => {
      if (!vecsByType.has(type)) {
        vecsByType.set(type, store.getEmbeddings(rows.slice(0, CANDIDATE_LIMIT).map((m) => m.id)));
      }
      return vecsByType.get(type);
    };

    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotHash = hashOf(bounded);
    const record = (status, { error = null, decisions = items, skipped: skipList = skipped, applied = 0 } = {}) =>
      store.saveDreamRun({
        id: runId,
        created_at: createdAt,
        status,
        error,
        provider: null,
        model: null,
        snapshot_hash: snapshotHash,
        input_count: bounded.length,
        input: snapshot,
        decisions,
        applied,
        summary_stored: 0,
        receipt: buildReceipt({ runId, status, snapshotHash, inputCount: bounded.length, applied, summaryStored: false }),
        policy_epoch: 0,
        run_type: "organize",
        ...(skipList.length ? { skipped: skipList } : {})
      });

    const items = [];
    try {
      for (const { index, candidate } of accepted) {
        const rows = rowsFor(candidate.type);
        let item = { index, type: candidate.type, title: candidate.title, verdict: "new", match: null };
        const exact = rows.find((m) => normalizeTitle(m.title) === normalizeTitle(candidate.title));
        if (exact) {
          item = { ...item, verdict: "exact", match: { id: exact.id, title: exact.title, sim: null } };
        } else {
          const near = await bestNear(candidate, rows, vecsFor(candidate.type, rows));
          if (near) {
            item = { ...item, verdict: "near", match: { id: near.memory.id, title: near.memory.title, sim: near.sim } };
          }
        }
        items.push(item);
      }
    } catch (e) {
      // 审计先留痕、再上抛：一份没有回执的失败报告，事后无法与「没调用过」区分。
      record("failed", { error: String(e?.message ?? e) });
      throw e;
    }

    const counts = {
      total: items.length,
      exact: items.filter((i) => i.verdict === "exact").length,
      near: items.filter((i) => i.verdict === "near").length,
      new: items.filter((i) => i.verdict === "new").length,
      skipped: skipped.length,
      truncated: raws.length - bounded.length
    };
    // 有被拒的候选 → degraded（如实标记），而不是 ok 掩盖过去；一条都没报 → noop。
    const status = skipped.length ? "degraded" : items.length ? "ok" : "noop";
    record(status);
    return { run_id: runId, created_at: createdAt, status, counts, items, skipped };
  }

  /**
   * 按 agent 的判断落库。decisions 逐条：
   *   `{ action: "save", index }`     — 写候选（走 saveWithDedupe：同键自动合并）
   *   `{ action: "discard", index }`  — 不写（只进回执，不删任何东西）
   *   `{ action: "archive", id }`     — 库内被取代的行 → 归档（可恢复，不删）
   *
   * @param {object} payload `{ run_id, decisions }`
   * @param {object} [opts] `{ hiddenIds }` — 调用者 scope 看不见的行按「不存在」
   *   处理（#170 复核项 4：无存在性泄漏），与 document 的 hiddenEvidenceIds 同形：
   *   **可见性由可信调用方算好传入**（tools 层先例：register_document），不取 payload
   *   里的字段——那是调用方可自选的内容，不是授权。
   * @returns {{run_id, dry_run_id, status, saved, discarded, archived, memory_ids, skipped, degraded}}
   */
  function apply(payload = {}, { hiddenIds = [] } = {}) {
    const dryRunId = String(payload?.run_id ?? "").trim();
    if (!dryRunId) {
      throw new Error("organize.apply: run_id is required (apply must reference a dryRun report)");
    }
    const report = store.getDreamRun(dryRunId);
    if (!report || report.run_type !== "organize") {
      throw new Error(`organize.apply: unknown organize run "${dryRunId}"`);
    }
    // apply 回执与 dryRun 报告共用 run_type='organize'：只有 outcome.dry_run_id 能
    // 把它们分开。不查这一条，apply 的 run_id 可以被当成 dry_run_id，串成
    // apply → apply 的审计链，报告那一环就此消失。
    if (report.outcome?.dry_run_id) {
      throw new Error(`organize.apply: "${dryRunId}" is an apply receipt, not a dryRun report`);
    }
    if (report.status === "failed") {
      throw new Error(`organize.apply: dryRun "${dryRunId}" failed — re-run dryRun before applying`);
    }
    const decisions = Array.isArray(payload?.decisions) ? payload.decisions : null;
    if (!decisions) throw new Error("organize.apply: decisions must be an array");

    const snapshot = Array.isArray(report.input) ? report.input : [];
    const byIndex = new Map(snapshot.map((entry) => [Number(entry?.index), entry]));
    const hidden = new Set((Array.isArray(hiddenIds) ? hiddenIds : []).map((id) => String(id)));
    const skipped = [];
    const byId = {};
    const memoryIds = [];
    const savedRows = [];
    let saved = 0;
    let discarded = 0;
    let archived = 0;

    const runDecisions = () => {
      decisions.forEach((decision, i) => {
        const action = String(decision?.action ?? "").trim();
        if (action === "save") {
          const index = Number(decision?.index);
          const entry = Number.isInteger(index) ? byIndex.get(index) : undefined;
          if (!entry) {
            // 索引不在快照里 = dryRun 从没校验过它（越界，或当时就被 normalize 拒了）。
            skipped.push({ index: i, action, error: "candidate index was not accepted by this dryRun" });
            return;
          }
          const { index: _originalIndex, ...candidate } = entry;
          // 这里不吞异常：能走到这一步的候选是 dryRun 已经规范化过的合法输入，抛出
          // 来的只能是基础设施错误 → 让它冒到事务外，整批回滚 + failed（红线 4 的
          // 「单条跳过」只覆盖输入级错误，那一步在 normalizeCandidate）。
          const result = saveWithDedupe(candidate);
          saved++;
          savedRows.push(result.memory);
          memoryIds.push(result.memory.id);
          byId[result.memory.id] = action;
          return;
        }
        if (action === "discard") {
          discarded++;
          return;
        }
        if (action === "archive") {
          const id = String(decision?.id ?? "").trim();
          const row = !id || hidden.has(id) ? null : store.getById(id);
          if (!row) {
            skipped.push({ index: i, action, ids: id ? [id] : [], error: "unknown, archived or out of scope" });
            return;
          }
          if (row.archived) {
            byId[id] = "keep"; // 已归档 = 目标状态已达，不重复计数
            return;
          }
          store.setArchived(id, true);
          archived++;
          byId[id] = action;
          return;
        }
        skipped.push({ index: i, action, error: `unknown action "${action}"` });
      });
    };

    const applyRunId = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotHash = report.snapshot_hash;
    // 回执的 applied/byId 由调用方传入：失败路径必须报 0（事务已回滚，累积的
    // saved/archived 是尝试值，写进回执就是撒谎）。
    const record = (status, error, { byId: outcomeById = byId, applied = saved + archived } = {}) => store.saveDreamRun({
      id: applyRunId,
      created_at: createdAt,
      status,
      error,
      provider: null,
      model: null,
      snapshot_hash: snapshotHash,
      input_count: snapshot.length,
      input: snapshot,
      decisions,
      // dry_run_id 是这条回执与它所指报告的连接键：审计能还原「报告 → 判断 → 落地」
      // 三步，而不用新建审计面。
      outcome: { dry_run_id: dryRunId, byId: outcomeById },
      applied,
      summary_stored: 0,
      receipt: buildReceipt({
        runId: applyRunId,
        status,
        snapshotHash,
        inputCount: snapshot.length,
        applied,
        summaryStored: false
      }),
      policy_epoch: 0,
      run_type: "organize",
      ...(skipped.length ? { skipped } : {})
    });

    let status;
    try {
      transaction(() => {
        runDecisions();
        // 只有 discard 的批次什么都没改 → noop（绝不虚报 ok）。
        status = skipped.length ? "degraded" : saved + archived > 0 ? "ok" : "noop";
        // 成功回执与数据同事务：审计写不进去就一起回滚，不留「库改了却没有回执」
        // 的窗口（回执是这条链上唯一的证据）。
        record(status, null);
      });
    } catch (e) {
      // 事务已回滚 → 失败回执单独写（它本身失败就让它抛，不掩盖原始错误）。
      record("failed", String(e?.message ?? e), { byId: {}, applied: 0 });
      throw e;
    }

    // transaction 只负责镜像与通知，重嵌入留给调用方（service.js › transaction
    // 注释）；document.js 用同一个 finalize 先例。放在提交之后，事务里 scheduleEmbed
    // 会被 txDepth 挡掉，不补这一步新写的记忆就没有向量。
    if (savedRows.length && typeof finalize === "function") finalize(savedRows);

    return {
      run_id: applyRunId,
      dry_run_id: dryRunId,
      status,
      saved,
      discarded,
      archived,
      memory_ids: memoryIds,
      skipped,
      degraded: skipped.length > 0
    };
  }

  /** 一个入口带 mode 参数（维护者口径）；opts 是可信调用上下文，不取 payload 里的字段。 */
  async function organize(payload = {}, opts = {}) {
    const mode = String(payload?.mode ?? "dryRun").trim();
    if (mode === "dryRun") return dryRun(payload);
    if (mode === "apply") return apply(payload, opts);
    throw new Error(`organize: unknown mode "${mode}" (dryRun | apply)`);
  }

  return { organize };
}
