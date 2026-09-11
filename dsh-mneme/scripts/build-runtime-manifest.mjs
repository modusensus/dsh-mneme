// 生成 runtime-manifest.json（issue #131 / PR-C）
//
// 为什么要有这个文件：下载通道需要知道「要取哪些包、放到 payload 里的什么位置、sha512 是多少」。
// 手写 49 条哈希必然漂移，所以这里从**已经装好的真实闭包**（planClosure）+ **package-lock.json
// 里 npm 自己算的 integrity** 机械产出。改依赖后重跑一次即可，维护成本从「人工核对」变成「跑脚本」。
//
// 为什么要按平台分开存：闭包随平台变化（sharp 与 @img/* 的平台二进制、onnxruntime-node 的
// 平台子树）。只能在本机推出「本机平台」那一份，所以脚本一次只写一个平台条目，并与已有文件
// **合并**（不覆盖别的平台）。这是刻意的：编不出一个平台就编不出，宁可让下载器在缺失时明确失败，
// 也不要凭空给出一份没人验证过的清单。
//
// 用法：
//   node scripts/build-runtime-manifest.mjs            # 生成/更新本机平台条目
//   node scripts/build-runtime-manifest.mjs --check     # 只校验现有条目与本机闭包一致（CI 用）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planClosure } from "../src/runtime/closure.js";
import { payloadId } from "../src/runtime/layout.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "runtime-manifest.json");
const MANIFEST_VERSION = 1;

/**
 * 证据：`@huggingface/transformers` 的 Node 构建（dist/transformers.node.mjs）顶层只 import
 * onnxruntime-node 与 sharp，从不 import onnxruntime-web（把一个空的 onnxruntime-web 打桩进去，
 * 嵌入结果逐字节相同：dims=[2,512]、L2 范数 1.0000、cos 0.3053）。而 onnxruntime-web 解包后
 * 127.7MB —— 占整个闭包的三分之一。所以清单里剔除它，风险由 verify 的真实推理兜底。
 */
const EXCLUDED = { "onnxruntime-web": "Node 构建从不 import 它（打桩验证：嵌入结果逐字节相同）" };

/**
 * 被剔除的包，以及**它子树下的一切**。
 *
 * 只按包名过滤会漏掉嵌套条目：闭包是按源布局镜像的，所以存在
 * `onnxruntime-web/node_modules/onnxruntime-common` 这种位于被剔除包内部的包 ——
 * 那个位置根本不会被取回来，留在清单里就是让下载器去填一个不存在的坑。
 * 同名但位于别处（例如顶层 onnxruntime-common）不受影响。
 */
export function isExcluded(pkg) {
  return Object.keys(EXCLUDED).some(
    (name) => pkg.name === name || pkg.rel === name || pkg.rel.startsWith(`${name}/`)
  );
}

/**
 * 从 npm lockfile v3 建 `name@version → {integrity, resolved}` 索引。
 * 键是安装路径（`node_modules/foo`、`node_modules/a/node_modules/b`），包名取最后一段 node_modules 之后的部分。
 */
export function integrityIndex(lock) {
  const index = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    const marker = path.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const name = path.slice(marker + "node_modules/".length);
    if (!name || !meta?.version || !meta?.integrity) continue;
    index.set(`${name}@${meta.version}`, { integrity: meta.integrity, resolved: meta.resolved ?? null });
  }
  return index;
}

/** registry 的 tarball 地址；lockfile 里记了就用它（权威且与 integrity 同源），否则按 npm 约定推。 */
function tarballUrl(name, version, resolved) {
  if (typeof resolved === "string" && resolved.startsWith("http")) return resolved;
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

export function build({ platform, arch }) {
  const plan = planClosure({ rootModulesDir: join(ROOT, "node_modules"), platform, arch });
  const index = integrityIndex(JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")));

  const entry = plan.packages[0];
  if (entry === undefined) throw new Error(`闭包入口没解析出来：${plan.gaps.map((g) => g.reason).join("; ")}`);

  const packages = [];
  const missing = [];
  for (const pkg of plan.packages) {
    if (isExcluded(pkg)) continue;
    const found = index.get(`${pkg.name}@${pkg.version}`);
    if (found === undefined) {
      // 查不到哈希就不能写进清单：没有 integrity 的条目会让下载器「先信任再校验」，那是假校验。
      missing.push(`${pkg.name}@${pkg.version}`);
      continue;
    }
    packages.push({
      name: pkg.name,
      version: pkg.version,
      rel: pkg.rel,
      integrity: found.integrity,
      tarball: tarballUrl(pkg.name, pkg.version, found.resolved),
      optional: pkg.optional === true
    });
  }
  if (missing.length > 0) throw new Error(`这些包在 package-lock.json 里找不到 integrity：${missing.join("、")}`);

  return {
    payloadId: payloadId({ version: entry.version, platform, arch }),
    transformersVersion: entry.version,
    platform,
    arch,
    packages
  };
}

/**
 * 生成/校验本平台条目。
 *
 * `--check` 在「本平台尚无条目」时**不算失败**：清单是按平台逐个生成的，CI 的 linux-x64 本来
 * 就可能没人生成过；硬报不一致会让人以为清单坏了。只有「有条目但对不上」才是失败。
 * @param {string[]} args - 命令行参数。
 * @returns {number} 退出码。
 */
export function main(args = process.argv.slice(2)) {
  const check = args.includes("--check");
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch}`;
  const built = build({ platform, arch });

  const existing = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  const summary = `${key}: ${built.packages.length} 个包（剔除 ${Object.keys(EXCLUDED).join("、")}）`;

  if (check) {
    if (existing?.platforms?.[key] === undefined) {
      process.stdout.write(`… ${summary} —— 该平台在 runtime-manifest.json 里尚无条目（本机不是生成它的那台）\n`);
      return 0;
    }
    const same = JSON.stringify(existing.platforms[key]) === JSON.stringify(built);
    process.stdout.write(`${same ? "✓" : "✗"} ${summary}${same ? "" : " —— 与 runtime-manifest.json 里的不一致，请重跑生成"}\n`);
    return same ? 0 : 1;
  }

  const next = {
    manifestVersion: MANIFEST_VERSION,
    entry: "@huggingface/transformers",
    excluded: EXCLUDED,
    platforms: { ...(existing?.platforms ?? {}), [key]: built }
  };
  writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  process.stdout.write(`写入 ${MANIFEST}\n${summary}\n`);
  for (const other of Object.keys(existing?.platforms ?? {})) {
    if (other !== key) process.stdout.write(`保留既有平台条目：${other}\n`);
  }
  return 0;
}

// 只有被直接执行时才干活：被 import 时（测试里）不该顺手改写清单文件。
const invokedDirectly =
  process.argv[1] != null && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (invokedDirectly) process.exitCode = main();
