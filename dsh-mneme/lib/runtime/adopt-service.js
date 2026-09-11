// 「一键收编」的服务侧实现（issue #131 / PR-C）
//
// 为什么单独一层：面板按钮需要一段「能被单测覆盖、又不必把绝对路径交给免鉴权端点」的
// 逻辑。这里只做三件事——推源、收编、给结论；路由那侧只管鉴权与搬运。
//
// 为什么源不让用户输入：既有用户的 transformers 就装在 <profile>/node_modules 里，
// 而插件自身也在那儿（<profile>/node_modules/@modusensus/dsh-mneme/）。所以从插件
// 自己的位置往上三级就能推出源目录，面板不必传参，也不把「从任意目录收编」变成
// 一个对外能力。
//
// 为什么 ok 要同时看结构和闭包缺口：describePayload 只点三个必需包，不看闭包计划里的
// 必需依赖缺口。只认结构的话，「缺传递依赖、入口一 import 就炸」的收编会被面板显示成
// 成功——这与 CLI 的退出码用的是同一条判据，两边必须一致。
//
// 同步实现：adoptRuntime 全是同步 fs 调用。收编 3203 个文件实测约 1–3 秒（同卷硬链接），
// 跨卷回退成复制时会明显更久。这是用户点按钮才触发的显式动作，短暂占用事件循环可接受；
// 将来若成为常态路径，再考虑挪进 worker。
//
// @module dsh-mneme/runtime/adopt-service
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptRuntime } from "./adopt.js";
import { describePayload } from "./layout.js";

/**
 * 从插件自身位置推出宿主 node_modules。
 *
 * `<profile>/node_modules/@modusensus/dsh-mneme/lib/<file>` 往上是
 * `lib` → `dsh-mneme` → `@modusensus` → `node_modules`，所以 dirname 四次。
 * 调用方传自己的 `import.meta.url`，src/ 与 lib/ 这两种同深度布局都成立。
 *
 * 用 dirname 而不是 `new URL("../../..")`：后者会得到带尾部路径分隔符的目录 URL，
 * fileURLToPath 之后是 `...\node_modules\`，与别处 `join()` 出来的字符串不相等 ——
 * 这个值要参与比较与拼接，形态得是干净的那种。
 *
 * 为什么这个推导对两种 linker 都成立：
 * - hoisted：插件在 `<profile>/node_modules/@modusensus/dsh-mneme/`，上三级就是 profile 的
 *   node_modules，依赖都平铺在那儿；
 * - isolated：Node 默认解析 symlink 后的真实路径，插件实际位于
 *   `<profile>/node_modules/.pnpm/<pkg>/node_modules/@modusensus/dsh-mneme/`，上三级正好是
 *   那个虚拟 store 的 node_modules —— 而 pnpm 正是把该包的依赖放在它的同级。
 * 两种情况都指向「装着这个插件依赖的那个 node_modules」，这正是要收编的东西。
 * @param {string} fromModuleUrl - 调用方自己的 import.meta.url。
 * @returns {string} 宿主 node_modules 目录。
 */
export function hostModulesDir(fromModuleUrl) {
  const file = fileURLToPath(fromModuleUrl);
  return dirname(dirname(dirname(dirname(file))));
}

/**
 * 收编本 profile 已有的运行时，给出面板可直接显示、脚本也能直接 gate 的结论。
 * @param {object} opts - 选项。
 * @param {string} opts.hostModulesDir - 源 node_modules。
 * @param {string} [opts.runtimeDir] - 运行时根目录；空 = 默认位置。
 * @param {boolean} [opts.overwrite] - 目标已存在时是否覆盖（用来修一份坏掉的 payload）。
 * @returns {{ok: boolean, status: string, reason?: string, payloadId?: string, version?: string,
 *   packages?: number, files?: number, bytes?: number, materialize?: string,
 *   missing?: string[], gaps?: string[], reasons?: string[]}}
 */
export function adoptHostRuntime({ hostModulesDir: from, runtimeDir = "", overwrite = false }) {
  const result = adoptRuntime({
    fromModulesDir: from,
    // 空串必须变成 undefined：adoptRuntime 的默认值只在「未传」时才生效，
    // 传空串会得到一个相对路径。
    runtimeDir: runtimeDir || undefined,
    overwrite
  });

  // 失败路径不带 payloadDir（入口包解析不到就是这条）—— 先拦掉，别拿 undefined 当路径。
  if (result.ok === false) {
    return { ok: false, status: "failed", reason: result.reason };
  }

  const structural = describePayload(result.payloadDir);
  const gaps = result.plan.gaps.map((gap) => gap.name);
  const healthy = structural.ok && gaps.length === 0;

  return {
    ok: healthy,
    status: healthy ? "adopted" : "incomplete",
    payloadId: result.payloadId,
    version: result.version,
    packages: result.plan.packages.length,
    files: result.totals.files,
    bytes: result.totals.bytes,
    materialize: result.manifest.materialize.mode,
    missing: structural.missing,
    gaps,
    // reasons 里可能带绝对路径，但它只回给已鉴权的调用方（面板 / 本机 CLI）；
    // 免鉴权的 /semantic 走 publicRuntimeStatus 投影，不经过这里。
    reasons: structural.reasons
  };
}
