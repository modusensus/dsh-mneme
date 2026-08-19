// Recall benchmark (v0.5.0 评测体系): a self-contained harness that seeds an
// in-memory store with labelled memories, runs a standard query set through
// the real searchMemories pipeline, and reports Recall@K / MRR per case and
// in aggregate. Runs in two configurations so the BM25/third-path lift is
// visible: `legacy` (bm25 + adaptive + dedup off) vs `fused` (defaults on).
//
// Usage:
//   node scripts/benchmark-recall.js            # run both configurations
//   node scripts/benchmark-recall.js --json     # machine-readable output
// The harness exports runBenchmark()/TEST_CASES for the test suite; the CLI
// path below only executes when invoked directly.
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// Deterministic toy embedder: bag-of-words hashed into a fixed-dimension
// vector, so cosine similarity ≈ lexical overlap. Good enough to exercise
// the vector path mechanically — semantic quality is not under test here.
const DIM = 256;
function hashVec(text) {
  const v = new Array(DIM).fill(0);
  const tokens = String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const t of tokens) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const SEED = [
  { id: "mem_user_pref", type: "preference", title: "编辑器偏好", content: "用户偏好 VS Code，深色主题，等宽字体 JetBrains Mono", importance: 4, tags: ["editor"] },
  { id: "mem_user_project", type: "project", title: "dsh-mneme 插件项目", content: "用户在开发 dsh-mneme 记忆插件，TypeScript 与 cordis 框架", importance: 5, tags: ["plugin"] },
  { id: "mem_rust_switch", type: "decision", title: "语言迁移决策", content: "项目编译模块从 Go 迁移到 Rust，理由是内存安全", importance: 4, tags: ["rust"] },
  { id: "mem_zfs_bug", type: "project", title: "ZFS-4421 数据损坏", content: "线上池 ZFS-4421 出现 checksum 错误，根因是 HBA 固件 bug", importance: 5, tags: ["ops"] },
  { id: "mem_city_thesis", type: "project", title: "湿地论文", content: "毕业论文研究城市湿地公园周边开发案例，ArcGIS 空间分析", importance: 4, tags: ["thesis"] },
  { id: "mem_async_pattern", type: "decision", title: "异步并发模式", content: "async runtime 选用 tokio，任务用 spawn 管理，channel 通信", importance: 3, tags: ["rust"] },
  { id: "mem_python_etl", type: "project", title: "ETL 脚本", content: "夜间 ETL 用 Python 编写，pandas 清洗，SQLite 落地", importance: 3, tags: ["etl"] },
  { id: "mem_ui_style", type: "preference", title: "界面审美", content: "喜欢编辑风 brutalism 排版，低饱和度配色，衬线标题", importance: 3, tags: ["design"] }
];

// Standard query set: each case is a query plus the ids that MUST appear in
// the top-K for the case to count as a hit. Covers the three recall paths —
// multi-term lexical (BM25's home turf), identifier lookup, and semantic.
export const TEST_CASES = [
  { query: "rust 异步", expected: ["mem_async_pattern", "mem_rust_switch"], note: "scattered terms — BM25 territory" },
  { query: "ZFS-4421 checksum", expected: ["mem_zfs_bug"], note: "identifier + keyword" },
  { query: "插件 开发", expected: ["mem_user_project"], note: "multi-term CJK" },
  { query: "论文 空间分析", expected: ["mem_city_thesis"], note: "scattered CJK terms" },
  { query: "ETL 脚本", expected: ["mem_python_etl"], note: "mixed" },
  { query: "深色主题", expected: ["mem_user_pref"], note: "substring match" },
  { query: "channel 通信 任务", expected: ["mem_async_pattern"], note: "scattered terms" },
  { query: "内存安全 语言", expected: ["mem_rust_switch"], note: "scattered terms" },
  { query: "配色 审美", expected: ["mem_ui_style"], note: "scattered CJK" },
  { query: "HBA 固件", expected: ["mem_zfs_bug"], note: "scattered terms" }
];

function seedService(overrides = {}) {
  const store = createStore(":memory:");
  const config = {
    bm25SearchEnabled: true,
    adaptiveThresholdEnabled: true,
    searchSemanticDedup: true,
    searchSemanticDedupThreshold: 0.95,
    selectiveInjectEnabled: true,
    entitySearchEnabled: false,
    ...overrides
  };
  const service = createService({ store, mirror: null, config, logger: null });
  const vectorIndex = createVectorIndex({ store, logger: null });
  service.setVectorIndex(vectorIndex);
  service.setEmbedder({
    embedSingle: async (text) => hashVec(text)
  });
  for (const m of SEED) {
    const row = store.save({ type: m.type, title: m.title, content: m.content, tags: m.tags, importance: m.importance, source: "seed" });
    store.setEmbedding(row.id, hashVec(`${m.title} ${m.content}`));
  }
  return service;
}

export async function runBenchmark({ topK = 5, mode = "auto" } = {}) {
  const configs = [
    { name: "legacy", overrides: { bm25SearchEnabled: false, adaptiveThresholdEnabled: false, searchSemanticDedup: false } },
    { name: "fused", overrides: {} }
  ];
  const runs = [];
  for (const cfg of configs) {
    const service = seedService(cfg.overrides);
    const rows = [];
    let hits = 0;
    let mrrSum = 0;
    for (const tc of TEST_CASES) {
      const results = await service.searchMemories(tc.query, { mode, topK, useRerank: false });
      const ids = results.map((r) => r.id);
      const metrics = service.computeRetrievalMetrics(ids, tc.expected);
      if (metrics.recall === 1) hits++;
      mrrSum += metrics.mrr;
      rows.push({ query: tc.query, note: tc.note, expected: tc.expected, got: ids, ...metrics });
    }
    runs.push({
      config: cfg.name,
      recallAtK: +(hits / TEST_CASES.length).toFixed(3),
      avgMrr: +(mrrSum / TEST_CASES.length).toFixed(3),
      rows
    });
  }
  return { topK, mode, runs };
}

function printReport(report) {
  for (const run of report.runs) {
    console.log(`\n=== ${run.config} (topK=${report.topK}, mode=${report.mode}) ===`);
    for (const r of run.rows) {
      const ok = r.recall === 1 ? "PASS" : "MISS";
      console.log(`  [${ok}] "${r.query}" (${r.note}) recall=${r.recall} mrr=${r.mrr}`);
      if (r.recall < 1) console.log(`         expected ⊇ ${r.expected.join(", ")}  got: ${r.got.join(", ") || "—"}`);
    }
    console.log(`  → Recall@${report.topK}: ${(run.recallAtK * 100).toFixed(1)}%   avg MRR: ${run.avgMrr}`);
  }
  const [legacy, fused] = report.runs;
  const lift = ((fused.recallAtK - legacy.recallAtK) * 100).toFixed(1);
  console.log(`\n三路融合 vs 旧两路: Recall@${report.topK} ${legacy.recallAtK * 100}% → ${fused.recallAtK * 100}% (${lift >= 0 ? "+" : ""}${lift}pp)`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (invokedDirectly) {
  const asJson = process.argv.includes("--json");
  const report = await runBenchmark({});
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
