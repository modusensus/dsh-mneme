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
import { pathToFileURL } from "node:url";
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
 * 在运行时根目录里挑一份可用的 payload。
 *
 * 多份并存时取目录名倒序的第一个通过结构检查的（同平台通常只会有一份；
 * 需要严格挑版本时由调用方先自己筛 runtimeDir）。
 * @param {object} [opts] - 选项。
 * @returns {{dir: string, payloadId: string, entryUrl: string, version: string|null, manifest: any}|null}
 *   没有可用 payload 时返回 null（不是错误——第 ② 层还有机会）。
 */
export function resolveRuntimeEntry({ runtimeDir = defaultRuntimeDir(), platform = process.platform } = {}) {
  for (const id of listPayloadDirs(runtimeDir).reverse()) {
    const dir = payloadDir(runtimeDir, id);
    const report = describePayload(dir, { platform });
    if (!report.ok) continue;
    return {
      dir,
      payloadId: id,
      entryUrl: pathToFileURL(join(dir, TRANSFORMERS_ENTRY)).href,
      version: report.version,
      manifest: report.manifest
    };
  }
  return null;
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
  const hint =
    "本地推理运行时不可用。可在设置面板「本地推理运行时」里安装，或把已有的运行时收编：" +
    "dsh-mneme runtime adopt --from <node_modules 目录>。检索会自动降级为关键词/BM25，不影响记忆读写。";
  const error = new Error(`${hint}\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  error.code = "MNEME_RUNTIME_UNAVAILABLE";
  error.failures = failures;
  throw error;
}
