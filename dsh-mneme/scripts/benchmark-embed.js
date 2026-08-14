#!/usr/bin/env node
// scripts/benchmark-embed.js
// 嵌入吞吐量基准：测量 LocalEmbedder(ONNX) / OllamaEmbedder / OpenAIEmbedder
// 的延迟与吞吐。src/local-embedder.js 可能尚在开发，这里用 await import() 动态
// 加载，失败时打印友好错误而非崩溃。
//
// 用法：
//   node scripts/benchmark-embed.js                                   # 默认 local
//   node scripts/benchmark-embed.js --provider local --device cpu
//   node scripts/benchmark-embed.js --provider ollama --model bge-m3
//   node scripts/benchmark-embed.js --provider openai --base-url https://api.openai.com/v1 \
//       --api-key sk-... --model text-embedding-3-small
//   node scripts/benchmark-embed.js --texts 32 --batch-size 8 --warmup 2 --iters 5
//   node scripts/benchmark-embed.js --help
//
// 环境变量（npm scripts 里可直接用）：EMBED_PROVIDER / EMBED_MODEL /
// EMBED_DIMENSION / EMBED_DEVICE / EMBED_BATCH_SIZE / EMBED_BASE_URL /
// EMBED_API_KEY / EMBED_CACHE_DIR。命令行参数优先于环境变量。

const SAMPLE_TEXTS = [
  "用户偏好使用中文交流，偶尔夹杂英文术语。",
  "项目使用 SQLite 作为主存储，Markdown 作为人工可读镜像。",
  "考研科目：公共管理学（631）与公共政策学（864）。",
  "autoDream 在后台自动去重、合并、归档记忆。",
  "本地模型支持 ONNX、Ollama 与 OpenAI 兼容三种后端。",
  "Rerank 精排可以提升语义检索的 Top-K 准确率。",
  "记忆库越大，向量检索的优势越明显。",
  "今天完成了语义引擎的架构设计文档。",
];

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function parseArgs(argv) {
  const args = {
    provider: null, model: null, dimension: null, device: null,
    batchSize: null, baseUrl: null, apiKey: null, cacheDir: null,
    texts: 16, warmup: 1, iters: 5, help: false
  };
  const take = (key, i) => (argv[i + 1] !== undefined ? argv[i + 1] : null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; break; }
    if (a === "--provider") args.provider = take("provider", i++);
    else if (a === "--model") args.model = take("model", i++);
    else if (a === "--dimension") args.dimension = Number(take("dimension", i++)) || null;
    else if (a === "--device") args.device = take("device", i++);
    else if (a === "--batch-size") args.batchSize = Number(take("batch-size", i++)) || null;
    else if (a === "--base-url") args.baseUrl = take("base-url", i++);
    else if (a === "--api-key") args.apiKey = take("api-key", i++);
    else if (a === "--cache-dir") args.cacheDir = take("cache-dir", i++);
    else if (a === "--texts") args.texts = Number(take("texts", i++)) || args.texts;
    else if (a === "--warmup") args.warmup = Number(take("warmup", i++)) || 0;
    else if (a === "--iters") args.iters = Number(take("iters", i++)) || 1;
    else { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(2); }
  }
  // 环境变量兜底（命令行优先）
  const env = process.env;
  args.provider = args.provider ?? env.EMBED_PROVIDER ?? "local";
  args.model = args.model ?? env.EMBED_MODEL ?? null;
  args.dimension = args.dimension ?? (env.EMBED_DIMENSION ? Number(env.EMBED_DIMENSION) : null);
  args.device = args.device ?? env.EMBED_DEVICE ?? "cpu";
  args.batchSize = args.batchSize ?? (env.EMBED_BATCH_SIZE ? Number(env.EMBED_BATCH_SIZE) : 8);
  args.baseUrl = args.baseUrl ?? env.EMBED_BASE_URL ?? "";
  args.apiKey = args.apiKey ?? env.EMBED_API_KEY ?? "";
  args.cacheDir = args.cacheDir ?? env.EMBED_CACHE_DIR ?? "";
  return args;
}

function usage() {
  console.log(`嵌入吞吐量基准（dsh-mneme）

用法：
  node scripts/benchmark-embed.js [选项]

选项：
  --provider <local|ollama|openai>   嵌入后端（默认 local，可由环境变量 EMBED_PROVIDER 覆盖）
  --model <name>                     模型名（local=HF 模型 id；ollama=Ollama 模型名；openai=API 模型名）
  --dimension <n>                    向量维度（不填则按后端推断）
  --device <cpu|wasm|gpu>            ONNX 设备（仅 local 生效，默认 cpu）
  --batch-size <n>                   分批嵌入条数（默认 8）
  --base-url <url>                   openai/ollama 端点（ollama 默认 http://localhost:11434）
  --api-key <key>                    openai 密钥
  --cache-dir <dir>                  local 模型缓存目录
  --texts <n>                        生成样本文本条数（默认 16，从示例库循环）
  --warmup <n>                       预热轮数（默认 1）
  --iters <n>                        计时轮数（默认 5）
  -h, --help                         显示帮助并退出

环境变量：EMBED_PROVIDER / EMBED_MODEL / EMBED_DIMENSION / EMBED_DEVICE /
  EMBED_BATCH_SIZE / EMBED_BASE_URL / EMBED_API_KEY / EMBED_CACHE_DIR
  （命令行参数优先）
`);
}

function buildTexts(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(SAMPLE_TEXTS[i % SAMPLE_TEXTS.length]);
  return out;
}

/** 安全读取维度：规避部分版本 getter 自递归的坑，取不到则回退 _dimension。 */
function safeDimension(embedder, fallback) {
  try {
    const d = embedder?.dimension;
    return d > 0 ? d : fallback;
  } catch {
    return embedder?._dimension ?? fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }

  let mod;
  try {
    mod = await import("../src/local-embedder.js");
  } catch (err) {
    console.error("无法加载 src/local-embedder.js：");
    console.error(`  ${err.message}`);
    console.error("该模块可能尚未创建。基准脚本依赖 createEmbedderByProvider（local/ollama/openai）。");
    process.exit(1);
  }
  const { createEmbedderByProvider } = mod;
  if (typeof createEmbedderByProvider !== "function") {
    console.error("src/local-embedder.js 未导出 createEmbedderByProvider，请先实现该模块。");
    process.exit(1);
  }

  // 构造后端
  let embedder;
  try {
    embedder = createEmbedderByProvider(args.provider, {
      model: args.model ?? undefined,
      dimension: args.dimension ?? undefined,
      device: args.device,
      batchSize: args.batchSize,
      baseUrl: args.baseUrl || undefined,
      apiKey: args.apiKey || undefined,
      cacheDir: args.cacheDir || undefined,
      logger: null
    });
    await embedder.init();
  } catch (err) {
    console.error(`初始化 ${args.provider} 后端失败：${err.message}`);
    console.error("请检查模型是否已下载 / Ollama 是否运行 / API 配置是否正确。");
    process.exit(1);
  }

  const texts = buildTexts(args.texts);
  const dim = safeDimension(embedder, args.dimension ?? 0);
  console.log("══════ dsh-mneme 嵌入基准 ══════");
  console.log(`后端：${args.provider}  模型：${embedder.model ?? "（默认）"}  维度：${dim || "未知"}  设备：${args.device}`);
  console.log(`文本：${texts.length} 条  批次：${args.batchSize}  预热：${args.warmup}  计时：${args.iters}\n`);

  // 预热（含首次推理/缓存填充）
  for (let i = 0; i < args.warmup; i++) {
    try { await embedder.embed(texts); } catch (err) { console.error(`预热失败：${err.message}`); process.exit(1); }
  }

  // 计时
  const rows = [];
  for (let i = 0; i < args.iters; i++) {
    const t0 = process.hrtime.bigint();
    try {
      const vecs = await embedder.embed(texts);
      if (!Array.isArray(vecs) || vecs.length !== texts.length) {
        console.error(`第 ${i + 1} 轮返回 ${Array.isArray(vecs) ? vecs.length : "?"} 条向量，期望 ${texts.length}。`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`第 ${i + 1} 轮嵌入失败：${err.message}`);
      process.exit(1);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows.push({ iter: i + 1, ms, perText: ms / texts.length, tps: (texts.length * 1000) / ms });
  }

  // 结果表
  console.log(`${pad("轮次", 6)}${pad("文本数", 8)}${pad("耗时(ms)", 12)}${pad("ms/条", 10)}${pad("条/秒", 12)}`);
  for (const r of rows) {
    console.log(`${pad(r.iter, 6)}${pad(texts.length, 8)}${pad(r.ms.toFixed(1), 12)}${pad(r.perText.toFixed(3), 10)}${pad(r.tps.toFixed(1), 12)}`);
  }
  const msArr = rows.map((r) => r.ms);
  const avg = msArr.reduce((a, b) => a + b, 0) / msArr.length;
  const min = Math.min(...msArr);
  const max = Math.max(...msArr);
  console.log("\n汇总（均值 / 最小 / 最大）：");
  console.log(`  耗时 ms：${avg.toFixed(1)} / ${min.toFixed(1)} / ${max.toFixed(1)}`);
  console.log(`  吞吐：${(texts.length * 1000 / avg).toFixed(1)} 条/秒（平均每轮 ${texts.length} 条）`);
  console.log("══════ 结束 ══════");
  embedder.dispose?.();
}

main().catch((err) => {
  console.error(`未预期错误：${err?.stack ?? err}`);
  process.exit(1);
});
