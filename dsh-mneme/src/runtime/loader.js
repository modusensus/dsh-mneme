// 运行时加载器：三层解析（issue #131 / PR-A）
//
//   ① 插件自管目录 ~/.dsh/mneme/runtime/<payloadId>/ —— 收编来的或下载来的
//   ② 宿主裸 specifier —— 用户自己装的、或别的插件带进来的
//   ③ 都没有 —— 抛出带可操作提示的错误，由调用方降级
//
// 为什么第 ② 层不能省：PR-A 只是「先建基础设施」，依赖声明不动，所以老用户
// 升级后宿主那份还在。第 ② 层保证他们在收编完成前照常可用；等 PR-B 真的把依赖
// 摘掉、pnpm 把宿主那份 prune 掉之后，第 ① 层顶上，本地嵌入不断。
//
// 为什么第 ① 层要 import 绝对 file URL 而不是改 node_modules：入口内部全是裸导入
// （`import sharp from "sharp"`、`import * as ONNX_NODE from "onnxruntime-node"`），
// 按自身位置解析。把闭包按扁平结构放在 payload 里、用绝对 URL import 入口，
// 整套就自洽了——不需要动宿主的 node_modules，也不需要 overrides。
//
// 失败必须可见：第 ① 层如果「找到了但加载不起来」，不能静默滑到第 ② 层就完事，
// 那条错误要带出来——它是「这份 payload 坏了」和「本机根本没有」的区别。
//
// @module dsh-mneme/runtime/loader
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  TRANSFORMERS_ENTRY,
  defaultRuntimeDir,
  describePayload,
  listPayloadDirs,
  payloadDir
} from "./layout.js";

/** 默认 import 实现；测试用来注入，避免真的加载原生模块。 */
const defaultImport = (specifier) => import(specifier);

/**
 * 给用户看的可操作提示。用插件自身的相对位置推出绝对路径 —— src/ 与 lib/ 都在
 * 包根下一层，所以 `../../scripts` 在两处都解析到同一个文件，提示不会因为跑源码
 * 还是跑构建产物而指错。
 */
const RUNTIME_HINT =
  "本地推理运行时不可用。查看状态：" +
  `node "${fileURLToPath(new URL("../../scripts/mneme-runtime.mjs", import.meta.url))}" status` +
  "；宿主里已有这份依赖时可用 `adopt --from <宿主 node_modules 目录>` 收编，再用 `verify` 验证。" +
  "检索会自动降级为关键词/BM25，不影响记忆读写。";

/**
 * 空/空白 runtimeDir 视为「用默认目录」。配置项 runtimeDir 的默认值就是空串，
 * 原样传下去会变成相对路径（`readdirSync("")` 直接失败），把「没配」误报成「坏了」。
 * 收在这一处，省得每个调用方各写一遍 `|| defaultRuntimeDir()`。
 */
function effectiveRuntimeDir(runtimeDir) {
  const value = String(runtimeDir ?? "").trim();
  return value === "" ? defaultRuntimeDir() : value;
}

/**
 * 在运行时根目录里挑一份可用的 payload。
 *
 * 多份并存时取目录名倒序的第一个通过结构检查的（同平台通常只会有一份；
 * 需要严格挑版本时由调用方先自己筛 runtimeDir）。
 * @param {object} [opts] - 选项。
 * @returns {{dir: string, payloadId: string, entryUrl: string, version: string|null, manifest: any}|null}
 *   没有可用 payload 时返回 null（不是错误——第 ② 层还有机会）。
 */
export function resolveRuntimeEntry({
  runtimeDir = defaultRuntimeDir(),
  platform = process.platform,
  arch = process.arch
} = {}) {
  const dir = effectiveRuntimeDir(runtimeDir);
  for (const id of listPayloadDirs(dir).reverse()) {
    const payload = payloadDir(dir, id);
    const report = describePayload(payload, { platform, arch });
    if (!report.ok) continue;
    return {
      dir: payload,
      payloadId: id,
      entryUrl: pathToFileURL(join(payload, TRANSFORMERS_ENTRY)).href,
      version: report.version,
      manifest: report.manifest
    };
  }
  return null;
}

/**
 * 只读地报告自管运行时的当前状态，供状态接口 / 面板 / CLI 展示。
 *
 * 刻意只做结构检查，不做功能验证：这是被 GET 端点按次调用的探针，而真跑一次
 * 推理要加载原生模块、还会碰模型缓存。所以 `functional` 如实返回 "unknown"，
 * 并给出去哪验证的提示 —— 宁可说「没验过」，也不假装验过。
 *
 * 挑选口径直接复用 resolveRuntimeEntry，避免出现「状态接口报的那份」和
 * 「真正加载的那份」不是同一个。
 * @param {{runtimeDir?: string, platform?: string}} [opts] - 选项。
 * @returns {{status: string, runtimeDir: string, hint: string}} 状态；任何异常都降级成状态对象，不抛。
 */
export function describeLocalRuntime({
  runtimeDir = defaultRuntimeDir(),
  platform = process.platform,
  arch = process.arch
} = {}) {
  let candidate = null;
  const dir = effectiveRuntimeDir(runtimeDir);
  try {
    candidate = resolveRuntimeEntry({ runtimeDir: dir, platform, arch });
  } catch (error) {
    // 配置里的 runtimeDir 是用户输入（可能是离奇的字符串让 pathToFileURL 抛错），
    // 这里是唯一的边界，收在这里比每个调用方各包一层稳。
    return {
      status: "unreadable",
      runtimeDir: dir,
      reason: String(error?.message ?? error),
      functional: "unknown",
      hint: RUNTIME_HINT
    };
  }

  if (candidate !== null) {
    return {
      status: "available",
      runtimeDir: dir,
      payloadId: candidate.payloadId,
      version: candidate.version,
      procedure: candidate.manifest?.procedure ?? null,
      materialize: candidate.manifest?.materialize?.mode ?? null,
      // 历史 payload（收编来的）清单里没有 integrity 字段，如实报 unverified；
      // 下载通道会把校验结果写进清单，这里不改代码就能读到。
      integrity: candidate.manifest?.integrity ?? "unverified",
      functional: "unknown",
      hint: RUNTIME_HINT
    };
  }

  const ids = listPayloadDirs(dir);
  if (ids.length === 0) {
    return { status: "missing", runtimeDir: dir, functional: "unknown", hint: RUNTIME_HINT };
  }
  // 有目录但一份都没通过结构检查：把最新那份的缺件和原因带出来，别只说「坏了」。
  const id = ids[ids.length - 1];
  const report = describePayload(payloadDir(dir, id), { platform, arch });
  return {
    status: "broken",
    runtimeDir: dir,
    payloadId: id,
    version: report.version,
    missing: report.missing,
    reasons: report.reasons,
    functional: "unknown",
    hint: RUNTIME_HINT
  };
}

/**
 * 把 describeLocalRuntime 的结果投影成「允许出现在免鉴权 HTTP 端点里」的形状。
 *
 * 为什么必须投影：`/api/dsh-mneme/semantic` 是刻意不鉴权的只读端点（与 list/search 同列），
 * 而完整状态里有**绝对路径**（`runtimeDir`、`hint` 里嵌的脚本路径）和**原始错误文本**
 * （`reason`/`reasons` 会带上完整文件路径，例如「node_modules 不存在：C:\...」）。
 * 把它们发给任何能连上该端口的人，属于信息泄漏（CWE-200）。
 *
 * 完整诊断留给本机的 CLI（`status`）——那里本来就有文件系统权限，也才是真正需要这些细节的场景。
 * 面板侧不需要这些：它只需要 status，其余文案用本地 i18n。
 * @param {object} report - describeLocalRuntime 的返回值。
 * @returns {{status: string, payloadId: string|null, version: string|null, procedure: string|null, materialize: string|null, integrity: string|null, functional: string|null}}
 */
export function publicRuntimeStatus(report) {
  return {
    status: report?.status ?? "unknown",
    payloadId: report?.payloadId ?? null,
    version: report?.version ?? null,
    procedure: report?.procedure ?? null,
    materialize: report?.materialize ?? null,
    integrity: report?.integrity ?? null,
    functional: report?.functional ?? null
  };
}

/**
 * 按三层解析加载 transformers。任何一层失败都不抛给调用方之外的语义：
 * 全部失败时抛一个带「试过哪些、各自为什么失败」的错误，便于面板/状态接口直接展示。
 * @param {object} [opts] - 选项。
 * @param {string} [opts.runtimeDir] - 运行时根目录。
 * @param {string} [opts.platform] - 平台。
 * @param {Function} [opts.importModule] - import 实现（测试注入）。
 * @param {(message: string) => void} [opts.onFailure] - 每次降级/失败的回调：
 *   第 ① 层坏了却退到第 ② 层时，调用方（面板/日志）要能看见，不能静默。
 * @returns {Promise<{module: any, source: "runtime"|"host", payloadId?: string, version?: string, entryUrl?: string}>}
 */
export async function loadTransformers({
  runtimeDir = defaultRuntimeDir(),
  platform = process.platform,
  importModule = defaultImport,
  onFailure = null
} = {}) {
  const failures = [];
  const note = (message) => {
    failures.push(message);
    onFailure?.(message);
  };

  // ① 自管运行时
  const candidate = resolveRuntimeEntry({ runtimeDir, platform });
  if (candidate !== null) {
    try {
      const module = await importModule(candidate.entryUrl);
      return {
        module,
        source: "runtime",
        payloadId: candidate.payloadId,
        version: candidate.version,
        entryUrl: candidate.entryUrl
      };
    } catch (error) {
      // 找到了却加载不起来 —— 这条必须带出去，「坏了」和「没有」不是一回事。
      note(`自管运行时 ${candidate.payloadId} 加载失败：${error?.message ?? error}`);
    }
  }

  // ② 宿主（用户自己装的 / 别的插件带进来的）
  try {
    const module = await importModule("@huggingface/transformers");
    return { module, source: "host" };
  } catch (error) {
    note(`宿主未提供 @huggingface/transformers：${error?.message ?? error}`);
  }

  // ③ 都没有：给出可操作的下一步，而不是一句 module not found
  const error = new Error(`${RUNTIME_HINT}\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  error.code = "MNEME_RUNTIME_UNAVAILABLE";
  error.failures = failures;
  throw error;
}
