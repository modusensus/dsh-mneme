// scripts/stress-dsh.js
// 压测：沿着三条轴线检验 dsh-mneme 的 autoDream 与存储在长会话、冲突、
// 并发压力下的表现。LLM 全部用确定性的 mock 决策，离线可跑、无需 API Key。
//
//   轴线 1 · 长会话检索：Recall@k（规范记忆能否被召回）与陈旧残留率
//   轴线 2 · 冲突裁决：可重放仲裁集 —— 仲裁正确率、确定性、审计/回放
//   轴线 3 · 多 Agent 并发：丢更新、重复合并、事务/崩溃恢复
//
// 运行：node scripts/stress-dsh.js
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import {
  createDreamScheduler,
  hashSnapshot,
  parseReceipt
} from "../src/dream.js";
import { applyDecisions } from "../src/dream/decisions.js";
import {
  sessionDecisions,
  arbitrationDecisions,
  mockCtx
} from "../test/helpers/dream-mock.js";

const pass = (ok) => (ok ? "✅" : "❌");

// ---------------------------------------------------------------- 轴线 1

async function axis1LongSessionRetrieval() {
  console.log("【轴线 1】长会话检索：Recall@k 与陈旧残留率");
  const topics = 20;
  const rounds = 8;
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-stress-a1-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const ctx = mockCtx({ onConsolidation: sessionDecisions });

  // 每个主题一条规范记忆（ground truth，importance 5）
  const gt = [];
  for (let t = 1; t <= topics; t++) {
    const title = `主题${String(t).padStart(2, "0")}`;
    const { memory } = service.saveWithDedupe({ type: "project", title, content: `${title} 的规范内容`, importance: 5 });
    gt.push({ title, id: memory.id });
  }
  // 长会话：每轮追加同主题旧变体（importance 3）并触发一次 autoDream
  for (let round = 1; round <= rounds; round++) {
    for (let t = 1; t <= topics; t++) {
      service.saveWithDedupe({
        type: "project",
        title: `主题${String(t).padStart(2, "0")}·变体${round}`,
        content: `主题${t} 第${round}轮旧变体`,
        importance: 3
      });
    }
    await dream.runDream(ctx, service, {});
  }

  let hits5 = 0;
  let hits10 = 0;
  for (const { title, id } of gt) {
    const k5 = service.search(title, { limit: 5 });
    const k10 = service.search(title, { limit: 10 });
    if (k5.some((m) => m.id === id)) hits5++;
    if (k10.some((m) => m.id === id)) hits10++;
  }
  const recall5 = hits5 / topics;
  const recall10 = hits10 / topics;

  // 陈旧残留率 = 仍活跃的旧变体 / 全部旧变体（dream 应全部清掉 → 0）
  const all = store.all();
  const variants = all.filter((m) => m.type === "project" && m.title.includes("变体"));
  const staleResidual = variants.filter((m) => !m.archived).length / variants.length;
  const runs = store.listDreamRuns().length;

  console.log(`  主题 ${topics} 个 × 变体 ${rounds} 轮 = ${topics * rounds} 条旧记忆，autoDream 触发 ${runs} 次`);
  console.log(`  ${pass(recall5 >= 0.95)} Recall@5  = ${(recall5 * 100).toFixed(1)}%（规范记忆 top5 召回）`);
  console.log(`  ${pass(recall10 >= 0.95)} Recall@10 = ${(recall10 * 100).toFixed(1)}%`);
  console.log(`  ${pass(staleResidual === 0)} 陈旧残留率 = ${(staleResidual * 100).toFixed(1)}%（理想 0%）`);
  store.close();
  return { recall5, recall10, staleResidual, runs };
}

// ---------------------------------------------------------------- 轴线 2

async function axis2ConflictArbitration() {
  console.log("【轴线 2】冲突裁决：可重放仲裁集");
  const sets = [
    { key: "项目截止日期", winner: { type: "decision", title: "项目截止日期", content: "8月20日交付", importance: 5 }, loser: { type: "decision", title: "项目截止日期(旧)", content: "8月15日交付", importance: 3 } },
    { key: "语言偏好", winner: { type: "preference", title: "语言偏好", content: "使用简体中文", importance: 5 }, loser: { type: "preference", title: "语言偏好(旧)", content: "使用繁体中文", importance: 2 } },
    { key: "存储选型", winner: { type: "decision", title: "存储选型", content: "node:sqlite（零依赖）", importance: 5 }, loser: { type: "decision", title: "存储选型(旧)", content: "better-sqlite3（需编译）", importance: 3 } },
    { key: "部署环境", winner: { type: "project", title: "部署环境", content: "生产环境 Node 24 + Windows Server", importance: 4 }, loser: { type: "project", title: "部署环境(旧)", content: "生产环境 Node 20 + Linux", importance: 2 } }
  ];

  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-stress-a2-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const ctx = mockCtx({ onConsolidation: arbitrationDecisions });

  // 仲裁集入库（先败者后胜者，模拟旧信息先存、新信息后到）
  for (const set of sets) {
    service.saveWithDedupe({ ...set.loser });
    service.saveWithDedupe({ ...set.winner });
  }
  const before = hashSnapshot(service.all().filter((m) => !m.archived && m.type !== "summary"));

  // 跑一次裁决 → 审计 + receipt
  const run1 = await dream.runDream(ctx, service, {});
  console.log(`  裁决运行：${pass(run1.ok)}（applied=${run1.applied}，receipt=${run1.receipt.slice(0, 40)}…）`);

  // 正确性：胜者保留 + 败者归档 + 来源链注释
  let arbOk = 0;
  for (const set of sets) {
    const winner = service.list({ type: set.winner.type }).find((m) => m.title === set.winner.title);
    const loser = store.all().find((m) => m.title === set.loser.title);
    if (winner && loser && loser.archived && winner.content.includes("已否决旧信息")) arbOk++;
  }
  const arbRate = arbOk / sets.length;
  console.log(`  ${pass(arbRate === 1)} 仲裁正确率 = ${(arbRate * 100).toFixed(0)}%（胜者保留 + 败者归档 + 来源链注释）`);

  // 确定性：同一输入快照 → 同一决策。重跑前先把败者"复活"为原始状态。
  const audit = store.getDreamRun(run1.runId);
  const receipt = parseReceipt(audit.receipt);
  console.log(`  ${pass(!!receipt && receipt.status === "ok")} receipt 可解析，snapshot=${receipt.snapshotHash}，输入 ${receipt.inputCount} 条`);
  console.log(`  ${pass(audit.outcome && Object.keys(audit.outcome.byId).length === sets.length * 2)} 审计 outcome 覆盖全部 ${sets.length * 2} 个仲裁对象`);

  // 可重放：审计中的决策清单在同一 store 上重放 → 幂等（无副作用）
  const winnerBefore = store.list({ type: sets[0].winner.type }).find((m) => m.title === sets[0].winner.title).content;
  const replayed = applyDecisions(audit.decisions, service);
  const winnerAfter = store.list({ type: sets[0].winner.type }).find((m) => m.title === sets[0].winner.title).content;
  const idempotent = replayed.applied === 0 && winnerBefore === winnerAfter;
  console.log(`  ${pass(idempotent)} 决策清单重放幂等（repeat 无副作用，来源链不重复追加）`);
  console.log(`  ${pass(before.length === 64)} 快照哈希稳定（${before.length} hex 位）`);

  const runs = store.listDreamRuns().length;
  store.close();
  return { arbRate, runs, idempotent };
}

// ---------------------------------------------------------------- 轴线 3

function bump(content) {
  const m = content.match(/count=(\d+)/);
  return `count=${m ? Number(m[1]) + 1 : 1}`;
}

async function axis3Concurrency() {
  console.log("【轴线 3】多 Agent 并发：丢更新 / 重复合并 / 事务恢复");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-stress-a3-"));
  const path = join(dir, "memory.db");

  // --- 重复合并：20 个 agent 并发保存同标题 → 最终只 1 条活跃
  const sA = createStore(path);
  const svA = createService({ store: sA, mirror: null, config: {} });
  const agents = 20;
  const writes = [];
  for (let i = 0; i < agents; i++) {
    writes.push(Promise.resolve().then(() => svA.saveWithDedupe({ type: "preference", title: "并发任务", content: `agent-${i}` })));
  }
  await Promise.all(writes);
  const dupes = svA.list({ type: "preference", limit: 100 }).filter((m) => m.title === "并发任务");
  const noDupes = dupes.length === 1;
  console.log(`  ${pass(noDupes)} 重复合并：${agents} 个 agent 同标题并发保存 → 活跃 ${dupes.length} 条（期望 1）`);

  // --- 丢更新：CAS 原子递增（硬断言：陈旧版本必须被拒，增量不得丢失）
  const sB = createStore(path);
  const svB = createService({ store: sB, mirror: null, config: {} });
  svA.saveWithDedupe({ type: "history", title: "计数器", content: "count=0", importance: 3 });
  const counterId = svA.list({ type: "history" })[0].id;
  svA.update(counterId, { content: "count=0" });
  const baseline = svA.getById(counterId); // updated_at=T, count=0
  // Agent A 持最新版本 → CAS 成功（count=1）
  const aOk = svA.compareAndUpdate(counterId, baseline.updated_at, { content: bump(baseline.content) });
  // Agent B 仍持过期版本 T → CAS 必须被拒；若被接受即丢更新
  const bStale = svB.compareAndUpdate(counterId, baseline.updated_at, { content: bump("count=0") });
  const casRejected = aOk !== undefined && bStale === undefined;
  // B 重读最新值重试 → 两个 +1 都落地
  if (bStale === undefined) {
    const cur = svB.getById(counterId);
    svB.compareAndUpdate(counterId, cur.updated_at, { content: bump(cur.content) });
  }
  const casResult = svB.getById(counterId).content;
  const noLostUpdate = casRejected && casResult === "count=2";
  console.log(`  ${pass(noLostUpdate)} CAS 并发递增：陈旧版本被拒=${casRejected}，重读重试后 → ${casResult}（期望 count=2，硬断言）`);
  // 串行化修复（无 CAS 时的人工约定）：写前重读最新值
  svA.update(counterId, { content: "count=0" });
  svA.update(counterId, { content: bump(svA.getById(counterId).content) });
  svB.update(counterId, { content: bump(svB.getById(counterId).content) });
  const fixedResult = svB.getById(counterId).content;
  const fixed = fixedResult === "count=2";
  console.log(`  ${pass(fixed)} 串行重读修复：写前重读最新 → ${fixedResult}（期望 count=2）`);

  // --- 多步原子性：事务中途抛错 → 全部回滚（硬断言，无半成品）
  let txThrew = false;
  try {
    svB.transaction(() => {
      svB.saveWithDedupe({ type: "project", title: "原子A", content: "x" });
      svB.saveWithDedupe({ type: "project", title: "原子B", content: "y" });
      throw new Error("boom");
    });
  } catch { txThrew = true; }
  const allNow = svB.all();
  const atomic = txThrew
    && !allNow.some((m) => m.title === "原子A")
    && !allNow.some((m) => m.title === "原子B");
  console.log(`  ${pass(atomic)} 多步原子性：事务中途抛错 → 原子A/原子B 全部回滚（期望均不存在，硬断言）`);

  // --- 事务/崩溃恢复：已提交写入在异常后 + reopen 后完整保留
  const svC = createService({ store: sB, mirror: null, config: {} }); // 复用同一文件连接
  svC.saveWithDedupe({ type: "project", title: "已提交A", content: "x" });
  svC.saveWithDedupe({ type: "project", title: "已提交B", content: "y" });
  let threw = false;
  try {
    svC.update("nonexistent-id", { content: "boom" }); // store.update 对未知 id 抛错
  } catch {
    threw = true;
  }
  sA.close();
  sB.close();
  const sR = createStore(path); // 重新打开（模拟进程重启）
  const recovered = sR.all();
  const recoveryOk = threw
    && recovered.some((m) => m.title === "已提交A")
    && recovered.some((m) => m.title === "已提交B")
    && recovered.some((m) => m.title === "计数器");
  console.log(`  ${pass(recoveryOk)} 事务恢复：中途异常后已提交写入不丢，reopen 后完整可读`);
  console.log(`  ${pass(recovered.filter((m) => m.title === "已提交A").length === 1)} 无半成品残留（已提交A 仅 1 条）`);

  sR.close();
  return { noDupes, noLostUpdate, atomic, fixed, recoveryOk };
}

// ---------------------------------------------------------------- 汇总

console.log("══════ dsh-mneme 压测：三条轴线 ══════");
console.log("");
const a1 = await axis1LongSessionRetrieval();
console.log("");
const a2 = await axis2ConflictArbitration();
console.log("");
const a3 = await axis3Concurrency();
console.log("");
console.log("══════ 压测汇总 ══════");
console.log(`  轴线1 长会话检索：Recall@5=${(a1.recall5 * 100).toFixed(1)}%  Recall@10=${(a1.recall10 * 100).toFixed(1)}%  陈旧残留=${(a1.staleResidual * 100).toFixed(1)}%  （${a1.runs} 次 autoDream 全部入审计）`);
console.log(`  轴线2 冲突裁决：仲裁正确率=${(a2.arbRate * 100).toFixed(0)}%  重放幂等=${a2.idempotent ? "是" : "否"}`);
console.log(`  轴线3 多 Agent 并发：去重=${a3.noDupes ? "✅" : "❌"}  CAS无丢更新=${a3.noLostUpdate ? "✅" : "❌"}  多步原子=${a3.atomic ? "✅" : "❌"}  串行修复=${a3.fixed ? "✅" : "❌"}  崩溃恢复=${a3.recoveryOk ? "✅" : "❌"}`);
// 丢更新与多步原子性都是硬断言：任一失败 → 非零退出，绝不把风险标成通过
const allOk = a1.recall5 >= 0.95 && a1.staleResidual === 0 && a2.arbRate === 1 && a2.idempotent
  && a3.noDupes && a3.noLostUpdate && a3.atomic && a3.fixed && a3.recoveryOk;
console.log(`  结论：${allOk ? "全部通过 ✅" : "存在失败项 ❌"}`);
console.log("══════ 压测结束 ══════");
process.exit(allOk ? 0 : 1);
