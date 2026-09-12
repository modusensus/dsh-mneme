// 依赖闭包遍历 + 平台过滤（issue #131 / PR-A）
//
// 用途：adopt（从宿主 node_modules 收编）与 export（导出给别的机器）要回答的是
// 同一个问题——「一份能跑的运行时，到底需要哪些包，各自该落到哪个位置」。
//
// 两个刻意的设计：
//
// 1) 按源布局镜像，不压平。入口 transformers.node.mjs 内部是裸导入
//    （`import sharp from "sharp"`、`import * as ONNX_NODE from "onnxruntime-node"`），
//    靠 Node 逐级向上查找解析。只要目标目录的嵌套结构与源一致，解析行为就一致；
//    压平会把「同一个包的两个版本分别落在不同层」这类情形悄悄改成另一种结果。
//    所以 rel 保留 `a/node_modules/b` 这种层级。
//
// 2) 跳过 peerDependencies。peer 由宿主提供（例如 @deepseek-ai/* 那些服务），
//    插件自管的运行时不该把宿主的实现复制进来——复制了反而会和宿主的实例分叉。
//
// @module dsh-mneme/runtime/closure
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { readJsonSafe } from "./layout.js";

/** 闭包条目数上限：纯属防呆，命中即截断并如实上报，不静默丢包。 */
export const DEFAULT_MAX_PACKAGES = 400;

/**
 * 包是否匹配当前平台。npm 用 package.json 的 os / cpu / libc 字段声明平台，
 * 支持 `["win32"]` 正向匹配与 `["!darwin"]` 反向排除两种写法。
 * 字段缺省表示「不限平台」。
 *
 * libc（glibc / musl）与前两者不同：**只有确实知道本机 libc 时才据此过滤**。
 * 传 null（拿不到证据）就一律放行 —— 反过来「拿不到就当 musl」会把 glibc 变体滤掉，
 * 装出一份必然 import 不起来的运行时，而本仓库没有 Linux 机器能验证这条路径。
 * 少省十几兆，换「不会静默装错」。
 * @param {any} manifest - 包的 package.json（或清单条目）。
 * @param {string} platform - process.platform 取值。
 * @param {string} arch - process.arch 取值。
 * @param {string|null} [libc] - 本机 libc；null/缺省 = 不据此过滤。
 * @returns {boolean} 是否匹配。
 */
export function matchesPlatform(manifest, platform, arch, libc = null) {
  const check = (values, actual) => {
    if (!Array.isArray(values) || values.length === 0) return true;
    const negated = values.filter((v) => typeof v === "string" && v.startsWith("!"));
    const positive = values.filter((v) => typeof v === "string" && !v.startsWith("!"));
    // 反向排除优先：命中任一 `!x` 即不匹配（与 npm 的语义一致）。
    if (negated.some((v) => v.slice(1) === actual)) return false;
    if (positive.length === 0) return true;
    return positive.includes(actual);
  };
  if (!check(manifest?.os, platform) || !check(manifest?.cpu, arch)) return false;
  if (libc === null || libc === undefined) return true;
  return check(manifest?.libc, libc);
}

/**
 * 按 Node 的解析规则，从 fromDir 出发找 name 的包目录，但**不越出 rootModulesDir**。
 *
 * Node 的规则是：从所在目录逐级向上，每级查 `<级>/node_modules/<name>`。所以对
 * `root/@scope/pkg` 而言，候选依次是 `root/@scope/pkg/node_modules/...`、
 * `root/@scope/node_modules/...`、`root/node_modules/...`（这一级是
 * node_modules 套 node_modules，通常不存在），最后到 `dirname(root)/node_modules/...`
 * ——正好就是 `root/<name>`。因此循环要允许走到 root 的上一级再停。
 * @param {string} fromDir - 从哪个包目录出发解析。
 * @param {string} name - 依赖名。
 * @param {string} rootModulesDir - 允许查找的边界 node_modules 目录。
 * @returns {string|null} 包目录绝对路径，找不到返回 null。
 */
export function resolvePackageDir(fromDir, name, rootModulesDir) {
  const limit = dirname(rootModulesDir);
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === limit || dir === dirname(dir)) return null;
    dir = dirname(dir);
  }
}

/** 转成 manifest 里使用的、与平台无关的相对路径（始终用 `/`）。 */
function toRel(root, dir) {
  return relative(root, dir).split(sep).join("/");
}

/**
 * 计算一份运行时的依赖闭包。
 *
 * 只走 dependencies 与 optionalDependencies：
 * - 必需依赖缺失 → 记进 gaps（让调用方能如实报「这份闭包不完整」）；
 * - 可选依赖缺失 → 静默跳过（这正是平台分片包在别的平台上的正常形态）；
 * - 平台不匹配的包 → 记进 skipped（导出给别的机器时，跨平台的残留不会被带走）。
 * @param {object} opts - 选项。
 * @param {string} opts.rootModulesDir - 源 node_modules 目录。
 * @param {string} [opts.entry] - 入口包名。
 * @param {string} [opts.platform] - 目标平台。
 * @param {string} [opts.arch] - 目标架构。
 * @param {number} [opts.maxPackages] - 条目上限。
 * @returns {{rootModulesDir: string, entry: string, platform: string, arch: string,
 *   packages: {name: string, version: string|null, rel: string, srcDir: string, optional: boolean}[],
 *   gaps: {name: string, from: string, reason: string}[],
 *   skipped: {name: string, rel: string, reason: string}[], truncated: boolean}}
 */
export function planClosure({
  rootModulesDir,
  entry = "@huggingface/transformers",
  platform = process.platform,
  arch = process.arch,
  maxPackages = DEFAULT_MAX_PACKAGES
} = {}) {
  const packages = [];
  const gaps = [];
  const skipped = [];
  const seen = new Set();

  const entryDir = resolvePackageDir(rootModulesDir, entry, rootModulesDir);
  if (entryDir === null) {
    gaps.push({ name: entry, from: ".", reason: "入口包不存在" });
    return { rootModulesDir, entry, platform, arch, packages, gaps, skipped, truncated: false };
  }

  // BFS：队列里放已被解析出来的包目录。用真实目录去重，避免软链接/重复边导致来回走。
  const queue = [{ dir: entryDir, rel: toRel(rootModulesDir, entryDir), optional: false }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.dir)) continue;
    seen.add(current.dir);

    const manifest = readJsonSafe(join(current.dir, "package.json"));
    if (manifest === undefined) {
      gaps.push({ name: current.rel, from: current.rel, reason: "package.json 读不到" });
      continue;
    }
    // 入口包本身不做平台过滤：它是用户明确要的那一个。
    if (current.rel !== toRel(rootModulesDir, entryDir) && !matchesPlatform(manifest, platform, arch)) {
      skipped.push({ name: manifest.name ?? current.rel, rel: current.rel, reason: "平台不匹配" });
      continue;
    }
    if (packages.length >= maxPackages) {
      truncated = true;
      break;
    }
    packages.push({
      name: manifest.name ?? current.rel,
      version: manifest.version ?? null,
      rel: current.rel,
      srcDir: current.dir,
      optional: current.optional
    });

    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    for (const name of [...required, ...optional]) {
      const isOptional = optional.includes(name);
      const dir = resolvePackageDir(current.dir, name, rootModulesDir);
      if (dir === null) {
        // 可选依赖缺失是正常形态（平台分片包在别的平台就是这样），不报警。
        if (!isOptional) gaps.push({ name, from: current.rel, reason: "必需依赖未找到" });
        continue;
      }
      const rel = toRel(rootModulesDir, dir);
      // 不允许越出源树：越出说明解析跑到了宿主其它位置，这份闭包就不是自包含的。
      if (rel.startsWith("..")) {
        gaps.push({ name, from: current.rel, reason: "解析结果越出源 node_modules" });
        continue;
      }
      queue.push({ dir, rel, optional: isOptional });
    }
  }

  return { rootModulesDir, entry, platform, arch, packages, gaps, skipped, truncated };
}
