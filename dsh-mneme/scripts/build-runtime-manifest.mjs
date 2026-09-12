// 生成 runtime-manifest.json（issue #131 / PR-C）
//
// **平台无关**是这份清单的核心设计：数据源是 `package-lock.json` 而不是「本机装好的那棵树」。
// npm 的 lockfile 里包含**所有平台**的包条目（各自的 os / cpu 与 integrity），所以一份清单就能
// 覆盖 win32 / darwin / linux × x64 / arm64 —— 下载时再按平台过滤（`matchesPlatform`）。
//
// 为什么不做成「按平台各存一份、谁在哪个系统上生成」：那样 macOS 用户在一台没人跑过脚本的机器上
// 会看到「清单里没有 darwin-arm64 的条目」而直接卡住。清单是随包发布的静态数据，它必须一次覆盖
// 所有平台，而不是依赖某个贡献者手上有对应的机器。
//
// 哈希取自 lockfile 的 integrity（npm 自己算的），所以维护成本是「改依赖后重跑一次脚本」。
//
// 用法：
//   node scripts/build-runtime-manifest.mjs            # 生成/更新
//   node scripts/build-runtime-manifest.mjs --check     # 只校验现有文件与 lockfile 一致（CI 用）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesPlatform } from "../src/runtime/closure.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "runtime-manifest.json");
const MANIFEST_VERSION = 2;
const ENTRY = "@huggingface/transformers";

/**
 * 证据：`@huggingface/transformers` 的 Node 构建（dist/transformers.node.mjs）顶层只 import
 * onnxruntime-node 与 sharp，从不 import onnxruntime-web（把一个空的 onnxruntime-web 打桩进去，
 * 嵌入结果逐字节相同：dims=[2,512]、L2 范数 1.0000、cos 0.3053）。而它解包后 127.7MB，占整个
 * 闭包约三分之一。所以清单里剔除它，风险由 verify 的真实推理兜底。
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

/** lockfile 的路径 → 包名（最后一段 `node_modules/` 之后的部分）。 */
export function nameOfPath(path) {
  const marker = path.lastIndexOf("node_modules/");
  return marker === -1 ? path : path.slice(marker + "node_modules/".length);
}

/** lockfile 的路径 → payload 里的相对路径（去掉开头的 `node_modules/`）。 */
export function relOfPath(path) {
  return path.startsWith("node_modules/") ? path.slice("node_modules/".length) : path;
}

/**
 * 按 Node 的解析语义列出候选路径：从引用者自身的 `node_modules` 逐级向上，最后兜底到根部。
 *
 * 例：引用者在 `node_modules/a/node_modules/b`、依赖 `x` →
 *   `…/b/node_modules/x` → `node_modules/a/node_modules/x` → `node_modules/x`
 * @param {string} fromPath - 引用者的 lockfile 路径。
 * @param {string} name - 依赖名。
 * @returns {string[]} 候选路径，由近到远。
 */
export function resolveCandidates(fromPath, name) {
  const out = [`${fromPath}/node_modules/${name}`];
  let cursor = fromPath;
  while (cursor.includes("/node_modules/")) {
    cursor = cursor.slice(0, cursor.lastIndexOf("/node_modules/"));
    out.push(cursor === "" ? `node_modules/${name}` : `${cursor}/node_modules/${name}`);
  }
  if (!out.includes(`node_modules/${name}`)) out.push(`node_modules/${name}`);
  return out;
}

/** registry 的 tarball 地址：lockfile 记了 resolved 就用它（与 integrity 同源），否则按 npm 约定推。 */
function tarballUrl(name, version, resolved) {
  if (typeof resolved === "string" && resolved.startsWith("http")) return resolved;
  const base = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/**
 * 从 lockfile 走一遍闭包。
 * @param {object} lock - package-lock.json 的内容。
 * @returns {{packages: object[], missing: string[]}} 包列表（按 rel 排序）与解析不到的依赖。
 */
export function closureFromLockfile(lock) {
  const all = lock.packages ?? {};
  const known = new Set(
    Object.entries(all)
      .filter(([path, meta]) => path.includes("node_modules/") && meta?.version !== undefined)
      .map(([path]) => path)
  );
  const seen = new Map();
  const missing = [];
  const queue = [`node_modules/${ENTRY}`];

  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const meta = all[path];
    if (meta?.version === undefined) {
      missing.push(path);
      continue;
    }
    if (isExcluded({ name: nameOfPath(path), rel: relOfPath(path) })) continue;
    seen.set(path, meta);

    const deps = { ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const resolved = resolveCandidates(path, name).find((option) => known.has(option));
      if (resolved === undefined) missing.push(`${name}（被 ${relOfPath(path)} 需要）`);
      else queue.push(resolved);
    }
  }

  const packages = [...seen.entries()]
    .map(([path, meta]) => ({
      name: nameOfPath(path),
      version: meta.version,
      rel: relOfPath(path),
      integrity: meta.integrity ?? null,
      tarball: tarballUrl(nameOfPath(path), meta.version, meta.resolved),
      // 平台约束照抄 lockfile：下载器按它过滤。没有这三个字段 = 与平台无关。
      ...(Array.isArray(meta.os) ? { os: meta.os } : {}),
      ...(Array.isArray(meta.cpu) ? { cpu: meta.cpu } : {}),
      // libc 也带上：linux-x64 的 glibc 机器靠它剔掉两套 musl 变体（十几 MB）。
      // 下载器只在**确认**了本机 libc 时才据此过滤，拿不到证据就不看这个字段。
      ...(Array.isArray(meta.libc) ? { libc: meta.libc } : {})
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  return { packages, missing };
}

/** 某个平台实际需要取哪些包（与下载器用同一条判据）。 */
export function packagesForPlatform(manifest, platform, arch, libc = null) {
  return manifest.packages.filter((pkg) => matchesPlatform(pkg, platform, arch, libc));
}

/** 生成一份**平台无关**的清单。 */
export function build() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const { packages, missing } = closureFromLockfile(lock);
  // 解析不到的依赖必须让生成**失败**：带缺口的清单会让用户在下载时才失败，而且「少了一个包」
  // 这种缺口结构检查看不出来（它只点三个必需包）。生成期的数据问题就该在生成期炸掉 ——
  // 这也是我第一版真正踩过的：被剔除包的孤儿依赖留在了清单里，而生成器一声不吭。
  if (missing.length > 0) {
    throw new Error(`这些依赖在 package-lock.json 里解析不到：${missing.slice(0, 10).join("、")}`);
  }

  const entry = packages.find((pkg) => pkg.rel === ENTRY);
  if (entry === undefined) throw new Error(`闭包入口没解析出来：${missing.join("; ") || "lockfile 里没有它"}`);
  // 查不到 sha512 就不能写进清单：那等于让下载器「先信任再校验」，是假校验。
  const withoutIntegrity = packages.filter(
    (pkg) => typeof pkg.integrity !== "string" || !pkg.integrity.startsWith("sha512-")
  );
  if (withoutIntegrity.length > 0) {
    throw new Error(`这些包在 package-lock.json 里没有 sha512 integrity：${withoutIntegrity.map((p) => p.rel).join("、")}`);
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    entry: ENTRY,
    transformersVersion: entry.version,
    excluded: EXCLUDED,
    // 平台无关：下载时按 os/cpu/libc 过滤（payloadId 也由下载器按本机平台算）。
    packages
  };
}

/** 应当被覆盖的平台（自检与 CI 断言用）。 */
export const COVERED_PLATFORMS = [
  ["win32", "x64"],
  ["win32", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"]
];

/** 命令行入口。`--check` 只校验，不写文件。 */
export function main(args = process.argv.slice(2)) {
  const check = args.includes("--check");
  const built = build();
  const coverage = COVERED_PLATFORMS.map(([platform, arch]) => {
    const set = packagesForPlatform(built, platform, arch);
    const hasEntry = set.some((pkg) => pkg.rel === ENTRY);
    const hasNative = set.some((pkg) => pkg.rel === "onnxruntime-node");
    // linux 再报一次「确认 glibc 时」的包数：下载器会剔掉另一套 libc 的变体，这行让
    // 「剔掉了多少」在 --check 里看得见，而不是只能翻清单。
    const glibc = platform === "linux" ? `；确认 glibc 时 ${packagesForPlatform(built, platform, arch, "glibc").length} 个` : "";
    return `${platform}-${arch}: ${set.length} 个包${glibc}${hasEntry && hasNative ? "" : "（缺入口或原生依赖！）"}`;
  });

  if (check) {
    const existing = existsSync(MANIFEST) ? readFileSync(MANIFEST, "utf8") : "";
    const same = existing === `${JSON.stringify(built, null, 2)}\n`;
    process.stdout.write(`${same ? "✓" : "✗"} 清单与 package-lock.json ${same ? "一致" : "不一致，请重跑生成"}\n`);
    for (const line of coverage) process.stdout.write(`   ${line}\n`);
    return same ? 0 : 1;
  }

  writeFileSync(MANIFEST, `${JSON.stringify(built, null, 2)}\n`, "utf8");
  process.stdout.write(`写入 ${MANIFEST}\n共 ${built.packages.length} 个包（已剔除 ${Object.keys(EXCLUDED).join("、")} 及其子树）\n`);
  for (const line of coverage) process.stdout.write(`   ${line}\n`);
  return 0;
}

// 只有被直接执行时才干活：被 import 时（测试里）不该顺手改写清单文件。
const invokedDirectly =
  process.argv[1] != null && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (invokedDirectly) process.exitCode = main();
