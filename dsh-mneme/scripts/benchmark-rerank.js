#!/usr/bin/env node
// scripts/benchmark-rerank.js
// Rerank 延迟基准：测量 LocalReranker（Xenova/bge-reranker-base，交叉编码）
// 在不同候选集规模下的精排延迟。src/reranker.js 尚在开发（Phase 2），这里用
// await import() 动态加载，失败时打印友好错误而非崩溃。
//
// 用法：
//   node scripts/benchmark-rerank.js                                  # 默认候选 [10,50,100,500]
//   node scripts/benchmark-rerank.js --candidates 10,100,1000
//   node scripts/benchmark-rerank.js --candidates 10 --top-k 3 --model Xenova/bge-reranker-base
//   node scripts/benchmark-rerank.js --device cpu --batch-size 4
//   node scripts/benchmark-rerank.js --help
//
// 环境变量：RERANK_MODEL / RERANK_DEVICE / RERANK_BATCH_SIZE / RERANK_CACHE_DIR。

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

const QUERY = "如何为记忆插件配置本地语义搜索模型？";

// 与 benchmark-embed.js 同源的样本文本库，模拟记忆库候选。
const CANDIDATE_TEXTS = [
  "用户偏好使用中文交流，偶尔夹杂英文术语。",
  "项目使用 SQLite 作为主存储，Markdown 作为人工可读镜像。",
  "考研科目：公共管理学（631）与公共政策学（864）。",
  "autoDream 在后台自动去重、合并、归档记忆。",
  "本地模型支持 ONNX、Ollama 与 OpenAI 兼容三种后端。",
  "Rerank 精排可以提升语义检索的 Top-K 准确率。",
  "记忆库越大，向量检索的优势越明显。",
  "今天完成了语义引擎的架构设计文档。",
  "Web 记忆面板支持按类型浏览与全文搜索。",
  "用户每天 9-18 点在线上班，上午做深度工作。",
];

function parseArgs(argv) {
  const args = {
    candidates: [10, 50, 100, 500], topK: 5, model: null, device: null,
    batchSize: null, cacheDir: null, query: QUERY, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (n) => (argv[i + 1] !== undefined ? argv[i + 1] : null);
    if (a === "--help" || a === "-h") { args.help = true; break; }
    if (a === "--candidates") {
      args.candidates = String(take("candidates", i++)).split(",").map(Number).filter((n) => n > 0);
      if (!args.candidates.length) args.candidates = [10];
    } else if (a === "--top-k") args.topK = Number(take("top-k", i++)) || args.topK;
    else if (a === "--model") args.model = take("model", i++);
    else if (a === "--device") args.device = take("device", i++);
    else if (a === "--batch-size") args.batchSize = Number(take("batch-size", i++)) || null;
    else if (a === "--cache-dir") args.cacheDir = take("cache-dir", i++);
    else if (a === "--query") args.query = take("query", i++);
    else { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(2); }
  }
  const env = process.env;
  args.model = args.model ?? env.RERANK_MODEL ?? null;
  args.device = args.device ?? env.RERANK_DEVICE ?? "cpu";
  args.batchSize = args.batchSize ?? (env.RERANK_BATCH_SIZE ? Number(env.RERANK_BATCH_SIZE) : 8);
  args.cacheDir = args.cacheDir ?? env.RERANK_CACHE_DIR ?? "";
  return args;
}

function usage() {
  console.log(`Rerank 延迟基准（dsh-mneme）

用法：
  node scripts/benchmark-rerank.js [选项]

选项：
  --candidates <n1,n2,...>   候选集规模列表，逗号分隔（默认 10,50,100,500）
  --top-k <n>                精排返回条数（默认 5）
  --model <name>             Rerank 模型（默认 Xenova/bge-reranker-base）
  --device <cpu|wasm|gpu>    ONNX 设备（默认 cpu）
  --batch-size <n>           批大小（默认 8）
  --cache-dir <dir>          模型缓存目录
  --query <text>             检索 query（默认内置示例）
  -h, --help                 显示帮助并退出

环境变量：RERANK_MODEL / RERANK_DEVICE / RERANK_BATCH_SIZE / RERANK_CACHE_DIR
  （命令行参数优先）
`);
}

function buildCandidates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = CANDIDATE_TEXTS[i % CANDIDATE_TEXTS.length];
    out.push(i < CANDIDATE_TEXTS.length ? t : `${t} —— 变体 #${i + 1}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }

  let mod;
  try {
    mod = await import("../src/reranker.js");
  } catch (err) {
    console.error("无法加载 src/reranker.js：");
    console.error(`  ${err.message}`);
    console.error("该模块属 Phase 2，可能尚未创建。基准脚本依赖导出 LocalReranker。");
    process.exit(1);
  }
  const { LocalReranker } = mod;
  if (typeof LocalReranker !== "function") {
    console.error("src/reranker.js 未导出 LocalReranker，请先实现该模块。");
    process.exit(1);
  }

  let reranker;
  try {
    reranker = new LocalReranker({
      model: args.model ?? undefined,
      device: args.device,
      batchSize: args.batchSize,
      cacheDir: args.cacheDir || undefined,
      logger: null
    });
    await reranker.init();
  } catch (err) {
    console.error(`初始化 Reranker 失败：${err.message}`);
    console.error("请检查模型是否已下载、设备配置是否正确。");
    process.exit(1);
  }

  console.log("══════ dsh-mneme Rerank 延迟基准 ══════");
  console.log(`模型：${reranker.model ?? "（默认）"}  设备：${args.device}  候选规模：${args.candidates.join(", ")}  Top-K：${args.topK}`);
  console.log(`query：${args.query}\n`);

  // 小规模预热（含首次加载推理）
  try {
    await reranker.rerank(args.query, buildCandidates(5), 3);
  } catch (err) {
    console.error(`预热失败：${err.message}`);
    process.exit(1);
  }

  console.log(`${pad("候选数", 10)}${pad("Top-K", 8)}${pad("耗时(ms)", 12)}${pad("ms/候选", 10)}`);
  for (const n of args.candidates) {
    const candidates = buildCandidates(n);
    const t0 = process.hrtime.bigint();
    try {
      const result = await reranker.rerank(args.query, candidates, args.topK);
      if (!Array.isArray(result)) {
        console.error(`候选 ${n} 时 rerank 返回非数组，请检查 LocalReranker.rerank 的返回约定。`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`候选 ${n} 时 rerank 失败：${err.message}`);
      process.exit(1);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${pad(n, 10)}${pad(args.topK, 8)}${pad(ms.toFixed(1), 12)}${pad((ms / n).toFixed(3), 10)}`);
  }
  console.log("══════ 结束 ══════");
  reranker.dispose?.();
}

main().catch((err) => {
  console.error(`未预期错误：${err?.stack ?? err}`);
  process.exit(1);
});
