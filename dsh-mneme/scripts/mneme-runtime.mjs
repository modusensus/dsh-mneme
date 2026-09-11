#!/usr/bin/env node
/**
 * 本地推理运行时管理入口（issue #131 / PR-A）
 *
 * 为什么不在 bin/cli.mjs 里加子命令：那个 CLI 的契约是「外部 HTTP API 客户端」，
 * 要求 dsh-mneme 服务正在运行。而收编/验证运行时恰恰发生在服务没起来、插件甚至
 * 装不上的时候 —— 两者是相反的使用场景。scripts/ 是与 benchmark-embed.js 同类的
 * 本地工具目录，放这里符合既有约定，也不用动物那个零依赖 CLI 的契约。
 *
 * 用法（在插件目录下运行）：
 *   node scripts/mneme-runtime.mjs status  [--runtime <dir>] [--json]
 *   node scripts/mneme-runtime.mjs adopt   --from <宿主 node_modules 目录> [--runtime <dir>] [--overwrite] [--json]
 *   node scripts/mneme-runtime.mjs verify  [--runtime <dir>] [--cache-dir <dir>] [--json]
 *
 * 退出码：0 = 健康 / 1 = 不健康或失败 / 2 = 用法错误。
 * 每一档都要能被脚本直接拿去 gate，所以「没装」和「装坏了」返回的都是 1，
 * 具体区别看输出里的 status。
 */
import process from "node:process";
import { adoptRuntime } from "../lib/runtime/adopt.js";
import { describeLocalRuntime, resolveRuntimeEntry } from "../lib/runtime/loader.js";
import { defaultModelCacheDir, defaultRuntimeDir, describePayload } from "../lib/runtime/layout.js";
import { verifyPayload } from "../lib/runtime/verify.js";

// 注意：下面是模板字面量，帮助正文里**不能出现反引号** —— 会把字面量提前截断。
// 这个坑踩过一次，而且因为本文件原本不在任何测试覆盖里，CI 完全没抓到；
// 现在由 test/runtime-cli.test.js 动态 import 本文件来兜底（语法错会在测试里直接炸）。
const USAGE = `本地推理运行时管理（dsh-mneme / issue #131）

用法：
  node scripts/mneme-runtime.mjs status  [--runtime <dir>] [--json]
  node scripts/mneme-runtime.mjs adopt   --from <宿主 node_modules 目录> [--runtime <dir>] [--overwrite] [--json]
  node scripts/mneme-runtime.mjs verify  [--runtime <dir>] [--cache-dir <dir>] [--json]

说明：
  status  只读探查：这份运行时在哪、来源是什么、结构完不完整。不加载模型。
  adopt   把宿主 node_modules 里已有的那份依赖闭包收编进插件自管目录，
          优先用硬链接（同盘时几乎不额外占盘）。收编后宿主那份可以随时被 pnpm 删掉。
  verify  真加载运行时并跑一次推理，外加结构与完整性检查。
          ⚠ 功能验证是离线的（allowRemoteModels=false）：模型必须已在缓存目录里，
          否则会明确失败 —— 这是有意的，验证不该偷偷触网。
          默认缓存目录若与你的 embedModelCacheDir 不一致，用 --cache-dir 指过去。

默认运行时目录：${defaultRuntimeDir()}
默认模型缓存目录：${defaultModelCacheDir()}
`;

class UsageError extends Error {}

/** 必须带值的选项；缺值时是用法错误，不能把 "true" 当成路径用下去。 */
const VALUE_OPTIONS = new Set(["runtime", "from", "cache-dir"]);
/** 纯开关。 */
const FLAG_OPTIONS = new Set(["json", "overwrite"]);

/**
 * 参数解析：只支持 `--key value` 与 `--flag`。
 * 够用就不引库 —— 这个脚本要在「插件装不上」的场景下还能跑，依赖越少越好。
 *
 * 两个刻意的严格行为：
 * - 缺值的 `--runtime` / `--from` / `--cache-dir` 直接报用法错误（exit 2）。宽松处理会让
 *   它们变成 `true`，再被当作一个叫 "true" 的路径用下去，最后以 exit 1 收场 ——
 *   真正的「你少打了一个值」被伪装成「运行时坏了」。
 * - 未知选项也报用法错误，而不是静默忽略：打错字应当立刻可见。
 */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const key = token.startsWith("--") ? token.slice(2) : null;
    if (key === null || (!VALUE_OPTIONS.has(key) && !FLAG_OPTIONS.has(key))) {
      const accepted = [
        ...[...VALUE_OPTIONS].map((k) => `--${k} <值>`),
        ...[...FLAG_OPTIONS].map((k) => `--${k}`)
      ].join("、");
      throw new UsageError(`无法识别的参数：${token}（可用：${accepted}）`);
    }
    if (FLAG_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${key} 需要带一个值`);
    }
    options[key] = value;
    i++;
  }
  return options;
}

const printJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

/** payloadId → 人类可读的标签，纯展示。 */
function describePayloadLabel(report) {
  const parts = [];
  if (report.version) parts.push(`transformers ${report.version}`);
  if (report.procedure) parts.push(`来源 ${report.procedure}`);
  if (report.materialize) parts.push(`物化 ${report.materialize}`);
  return parts.join("，");
}

function runStatus({ runtimeDir, asJson }) {
  const report = describeLocalRuntime({ runtimeDir });
  const healthy = report.status === "available";
  if (asJson) {
    printJson(report);
    return healthy ? 0 : 1;
  }

  const label = { available: "可用", missing: "未安装", broken: "损坏", unreadable: "读不到" }[report.status] ?? report.status;
  console.log(`运行时目录：${report.runtimeDir}`);
  console.log(`状态：${label}`);
  if (report.payloadId) console.log(`payload：${report.payloadId}`);
  const extra = describePayloadLabel(report);
  if (extra) console.log(`       ${extra}`);
  if (healthy) {
    console.log(`完整性：${report.integrity}`);
    // 明说「结构通过 ≠ 验过」，否则这个面板会给出虚假的安心感。
    console.log(`功能：${report.functional}（状态探查不加载模型，跑 verify 才能确认真的能推理）`);
  }
  for (const item of report.missing ?? []) console.log(`缺失：${item}`);
  for (const reason of report.reasons ?? []) console.log(`原因：${reason}`);
  if (report.reason) console.log(`原因：${report.reason}`);
  if (!healthy) console.log(`\n${report.hint}`);
  return healthy ? 0 : 1;
}

async function runAdopt({ runtimeDir, asJson, options }) {
  const from = String(options.from ?? "").trim();
  if (!from) {
    throw new UsageError(
      "adopt 需要 --from <宿主 node_modules 目录>，例如：\n" +
        "  .../profiles/<profile>/node_modules\n" +
        "（就是当前装着 @huggingface/transformers 的那个 node_modules）"
    );
  }

  const result = await adoptRuntime({
    fromModulesDir: from,
    runtimeDir,
    overwrite: options.overwrite === true
  });

  // 收编失败时 adoptRuntime **不带 payloadDir**（入口包解析不到就是这条路径）。
  // 必须先处理，否则下面拿 undefined 当路径喂给 describePayload，用户看到的是
  // `TypeError: The "path" argument must be of type string` 的堆栈，
  // 而不是「入口包不存在 + 下一步该做什么」——而这是文档里给用户的第一条命令。
  if (result.ok === false) {
    if (asJson) printJson(result);
    else console.log(`收编失败：${result.reason}`);
    return 1;
  }

  // 搬运完立刻做结构检查：缺件现在就能发现，不必等到第一次推理才炸。
  const structural = describePayload(result.payloadDir);

  // 两条判据都要过：describePayload 只点三个必需包，**不看闭包计划里的必需依赖缺口**。
  // 只认 structural.ok 的话，「缺传递依赖、入口一 import 就炸」的收编会报 exit 0，
  // 脚本化的 gate 就在最需要它的时候误报健康。
  const gaps = result.plan.gaps;
  const healthy = structural.ok && gaps.length === 0;

  if (asJson) {
    printJson({ ...result, structural, healthy });
    return healthy ? 0 : 1;
  }

  console.log(`已收编到：${result.payloadDir}`);
  console.log(`payload：${result.payloadId}`);
  console.log(`包数：${result.plan.packages.length}    文件：${result.totals.files}    字节：${result.totals.bytes}`);
  console.log(`物化方式：${result.manifest.materialize.mode}` + (result.manifest.materialize.linkError ? `（硬链接失败原因：${result.manifest.materialize.linkError}）` : ""));
  if (result.plan.skipped.length) {
    console.log(`跳过（平台不适用）：${result.plan.skipped.map((s) => s.name).join("、")}`);
  }
  for (const warning of result.manifest.warnings) console.log(`警告：${warning}`);
  for (const gap of gaps) {
    console.log(`缺失依赖：${gap.name}（被 ${gap.from} 需要：${gap.reason}）`);
  }
  for (const item of structural.missing) console.log(`缺失文件：${item}`);
  for (const reason of structural.reasons) console.log(`结构问题：${reason}`);
  console.log(`结构检查：${structural.ok ? "通过" : "未通过"}`);
  if (gaps.length > 0) {
    console.log(`闭包完整性：未通过（${gaps.length} 个必需依赖缺失，入口加载时会失败）`);
  }
  if (healthy) {
    console.log(`\n下一步：node scripts/mneme-runtime.mjs verify   # 真跑一次推理确认可用`);
  }
  return healthy ? 0 : 1;
}

async function runVerify({ runtimeDir, asJson, options }) {
  const candidate = resolveRuntimeEntry({ runtimeDir });
  if (candidate === null) {
    // 「没得验」不是用法错误，是不健康 —— 复用 status 的提示，别自己编一套说法。
    const report = describeLocalRuntime({ runtimeDir });
    if (asJson) printJson(report);
    else console.log(`没有可用的运行时 payload。\n\n${report.hint}`);
    return 1;
  }

  const cacheDir = String(options["cache-dir"] ?? "").trim() || defaultModelCacheDir();
  if (!asJson) {
    console.log(`验证 payload：${candidate.payloadId}`);
    console.log(`模型缓存目录：${cacheDir}`);
    console.log("正在加载运行时并推理（首次可能要几十秒）...");
  }

  const result = await verifyPayload(candidate.dir, { cacheDir });

  if (asJson) {
    printJson(result);
    return result.ok ? 0 : 1;
  }

  console.log(`结构检查：${result.structural.ok ? "通过" : "未通过"}`);
  for (const item of result.structural.missing) console.log(`  缺失：${item}`);
  for (const reason of result.structural.reasons) console.log(`  原因：${reason}`);
  const fn = result.functional;
  console.log(`功能验证：${fn.ok ? `通过（维度 ${fn.dim}，${fn.rows} 行，${fn.elapsedMs}ms）` : "未通过"}`);
  if (!fn.ok) {
    console.log(`  原因：${fn.reason}`);
    // 最常见的失败是模型不在这个目录 —— 注意这里的默认值不一定等于用户配置的
    // embedModelCacheDir，所以要明确告诉他能改。
    console.log(`  提示：功能验证不触网（allowRemoteModels=false），模型必须已在缓存目录里。`);
    console.log(`        若模型在别处，用 --cache-dir <目录> 指过去（应与配置项 embedModelCacheDir 一致）；`);
    console.log(`        或先用 embedProvider="local" 触发一次下载（走 embedModelMirror 镜像）。`);
  }
  console.log(`完整性：${result.integrity.status}${result.integrity.detail ? `（${result.integrity.detail}）` : ""}`);
  console.log(`\n总判定：${result.ok ? "通过" : "未通过"}`);
  return result.ok ? 0 : 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const options = parseArgs(rest);
  const runtimeDir = String(options.runtime ?? "").trim() || defaultRuntimeDir();
  const asJson = options.json === true;

  if (command === "status") return runStatus({ runtimeDir, asJson });
  if (command === "adopt") return runAdopt({ runtimeDir, asJson, options });
  if (command === "verify") return runVerify({ runtimeDir, asJson, options });
  throw new UsageError(`未知命令：${command}\n\n${USAGE}`);
}

/**
 * 只有被直接执行时才跑 CLI。这样测试可以安全地 `import` 本文件来验证它能被解析并求值
 * —— 脚本不在任何其它测试覆盖里，一个模板字面量里的反引号就足以让它整体坏掉而 CI 全绿。
 * 与 scripts/benchmark-recall.js 的 invokedDirectly 同一套写法。
 */
const invokedDirectly =
  process.argv[1] != null && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      // 验证/收编本身是 fail-safe 的；能走到这里的多半是环境问题（磁盘、权限），
      // 如实打出来，别吞。
      process.stderr.write(`失败：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    }
  }
}

export { main, parseArgs, runAdopt, UsageError };
