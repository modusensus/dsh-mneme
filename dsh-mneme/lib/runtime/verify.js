// 运行时验证三件套（issue #131 / PR-A）
//
// 为什么要分三层，而不是「能 import 就算通过」：
//
//   结构   —— 入口在不在、版本对不对、平台子树对不对、闭包有没有缺口。
//              便宜、确定，能立刻发现「解压到一半」。
//   功能   —— 真的 import 入口并跑一次推理。这是唯一能证明「这份运行时在这个
//              环境里真的算得出来」的一层；结构全对但原生二进制与本机 ABI 不
//              匹配时，只有它能发现。
//   完整性 —— 只对「有原始产物可比对」的来源做（下载的 tarball、本地 tarball）。
//              收编来的目录没有原始 tarball，如实标 unverified，不假装验过。
//
// 功能验证复用 src/local-embedder.js 的 engineFactory 思路：真正干活的是注入进来
// 的 engine，默认实现才去 import 真实运行时。这样测试不需要网络、不需要模型，
// 也能把「返回了非归一化向量」「只返回一行」这类问题钉住。
//
// 默认 engine 会强制 env.allowRemoteModels = false：验证过程绝不能偷偷下载模型，
// 否则「验证」本身就成了一个新的网络依赖点。
//
// @module dsh-mneme/runtime/verify
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { TRANSFORMERS_ENTRY, describePayload } from "./layout.js";

/** 默认探针文本：中英各一条，避免只覆盖单字节语种。 */
export const DEFAULT_PROBE_TEXTS = ["猫咪喜欢晒太阳", "the quick brown fox"];
/** 默认模型，与 src/config.js 的 localEmbedModel 默认值一致。 */
export const DEFAULT_PROBE_MODEL = "Xenova/bge-small-zh-v1.5";
/** L2 归一化的容忍度（我们显式请求了 normalize: true）。 */
const NORM_TOLERANCE = 0.01;
/** 判定「退化向量」的余弦上限：两条毫不相干的文本不该几乎同向。 */
const DEGENERATE_COS = 0.999;

/**
 * 默认 engine：真的去 import 运行时并建一个 feature-extraction 管道。
 *
 * 返回一个 `embed(texts) => number[][]`。之所以不返回 transformers 的 tensor，
 * 是为了把「Tensor 形状怎么读」这种细节留在实现里，验证逻辑只看数字。
 * @param {string} entryUrl - 入口文件的 file URL。
 * @param {{cacheDir?: string, model?: string, dtype?: string, device?: string}} opts - 选项。
 * @returns {Promise<(texts: string[]) => Promise<number[][]>>} 嵌入函数。
 */
export async function defaultEngine(entryUrl, { cacheDir, model = DEFAULT_PROBE_MODEL, dtype = "q8", device = "cpu" } = {}) {
  const mod = await import(entryUrl);
  const { env, pipeline } = mod;
  if (cacheDir) {
    try {
      env.cacheDir = cacheDir;
    } catch {
      /* 老版本可能没有这个字段：忽略，交给下面 pipeline 自己找缓存 */
    }
  }
  // 验证不允许触网：缓存命中就本地加载，命中不了就明确失败。
  try {
    env.allowRemoteModels = false;
  } catch {
    /* 同上 */
  }
  const extractor = await pipeline("feature-extraction", model, { dtype, device, cache_dir: cacheDir });
  return async (texts) => {
    const tensor = await extractor(texts, { pooling: "mean", normalize: true });
    const dims = Array.from(tensor.dims ?? []);
    const width = dims[dims.length - 1] || 0;
    // 宽度为 0 时下面的 `i += width` 会原地打转 —— 那是**死循环**，会把调用方（乃至 DSH 主进程）
    // 挂住。宁可明确失败：调用方按契约把失败变成 {ok:false, reason}，而不是永远等不到结果。
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error(`推理输出的维度不可用：dims=${JSON.stringify(dims)}`);
    }
    const rows = [];
    for (let i = 0; i < tensor.data.length; i += width) {
      rows.push(Array.from(tensor.data.subarray(i, i + width)));
    }
    return rows;
  };
}

/** 向量模长。 */
function norm(row) {
  let sum = 0;
  for (const value of row) sum += value * value;
  return Math.sqrt(sum);
}

/** 两行向量的余弦。 */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * 跑功能验证：真的 import 并嵌入探针文本，然后检查结果的形状与数值性质。
 *
 * 任何失败都返回结果对象，不抛异常——验证本身必须是 fail-safe 的，
 * 否则一条坏运行时会把调用方（面板、状态接口）也带崩。
 * @param {string} dir - payload 目录。
 * @param {object} [opts] - 选项。
 * @returns {Promise<{ok: boolean, reason: string|null, dim: number|null, rows: number, elapsedMs: number}>}
 */
export async function verifyFunctional(dir, {
  engine = defaultEngine,
  probeTexts = DEFAULT_PROBE_TEXTS,
  cacheDir,
  model,
  dtype,
  device
} = {}) {
  const startedAt = Date.now();
  const fail = (reason) => ({ ok: false, reason, dim: null, rows: 0, elapsedMs: Date.now() - startedAt });

  const entry = join(dir, TRANSFORMERS_ENTRY);
  let embed;
  try {
    embed = await engine(pathToFileURL(entry).href, { cacheDir, model, dtype, device });
  } catch (error) {
    return fail(`加载运行时失败：${error?.message ?? error}`);
  }

  let rows;
  try {
    rows = await embed(probeTexts);
  } catch (error) {
    return fail(`推理失败：${error?.message ?? error}`);
  }

  if (!Array.isArray(rows) || rows.length !== probeTexts.length) {
    return fail(`返回行数不符：期望 ${probeTexts.length}，实际 ${Array.isArray(rows) ? rows.length : typeof rows}`);
  }
  // 先逐行确认「是数组」且「全是有限数」。这一步不能省：non-finite（NaN/Infinity）会让
  // 下面所有比较恒为 false —— `Math.abs(NaN - 1) > tol` 是 false，`Math.abs(NaN) > 阈值`
  // 也是 false —— 于是一份坏掉的运行时会被判成「验证通过」。这是本模块最危险的失败模式
  // （假通过），比抛异常糟得多。行不是数组时同样要先拦住，否则 .length 直接抛，
  // 违背「任何失败都返回结果对象，不抛异常」的契约。
  for (let i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i])) return fail(`第 ${i} 行不是数组（${typeof rows[i]}）`);
    if (rows[i].some((v) => !Number.isFinite(v))) return fail(`第 ${i} 行含有非有限数值`);
  }
  const dim = rows[0].length;
  if (dim === 0) return fail("返回了空向量");
  if (rows.some((row) => row.length !== dim)) return fail("各行维度不一致");

  for (let i = 0; i < rows.length; i++) {
    const length = norm(rows[i]);
    if (Math.abs(length - 1) > NORM_TOLERANCE) {
      return fail(`第 ${i} 行不是 L2 归一化向量（模长 ${length.toFixed(4)}）`);
    }
  }
  if (rows.length >= 2 && Math.abs(cosine(rows[0], rows[1])) > DEGENERATE_COS) {
    return fail(`嵌入退化：两条不相干文本的余弦为 ${cosine(rows[0], rows[1]).toFixed(4)}`);
  }

  return { ok: true, reason: null, dim, rows: rows.length, elapsedMs: Date.now() - startedAt };
}

/**
 * 三层验证，任何一层失败都如实记录；结构不过就不再做功能验证（省掉一次无谓的加载）。
 * @param {string} dir - payload 目录。
 * @param {object} [opts] - 选项。
 * @param {{status: string, detail?: string}} [opts.integrity] - 调用方算好的完整性结论
 *   （下载/本地 tarball 路径在解包前比对过 sha512，把结果传进来；收编路径没有可比对
 *   的原始产物，默认 unverified）。
 * @returns {Promise<object>} 三件套结果 + 总判定。
 */
export async function verifyPayload(dir, {
  platform = process.platform,
  engine,
  probeTexts,
  cacheDir,
  model,
  dtype,
  device,
  integrity
} = {}) {
  const structural = describePayload(dir, { platform });
  const integrityResult = integrity
    ? { ok: integrity.status === "sha512-matched", status: integrity.status, detail: integrity.detail ?? null }
    : { ok: true, status: "unverified", detail: "该来源没有可比对的原始产物（收编）；如需强校验请用 --strict 走 tarball 通道" };

  const functional = structural.ok
    ? await verifyFunctional(dir, { engine, probeTexts, cacheDir, model, dtype, device })
    : { ok: false, reason: "结构检查未通过，跳过功能验证", dim: null, rows: 0, elapsedMs: 0 };

  return {
    dir,
    version: structural.version,
    ok: structural.ok && functional.ok && integrityResult.ok,
    structural,
    functional,
    integrity: integrityResult
  };
}
