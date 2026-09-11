// 收编宿主已有的运行时（issue #131 / PR-A）
//
// 场景：老用户（以及本机）profile 里已经装好了整套 transformers + onnxruntime，
// 而且它就是能跑的。删依赖之前先把这套「收编」进插件自管的目录，老用户的本地
// 嵌入就不会因为后续的 prune 而断掉——这是分两步发版里第一步的全部意义。
//
// 两条实现约束：
//
// 1) 同卷硬链接、跨卷回退复制。收编的源和目标通常都在用户家目录（同卷），
//    硬链接是瞬时的、不额外占盘；一旦跨卷 linkSync 会抛 EXDEV，则逐个文件回退复制。
//
// 2) 不跟随符号链接。pnpm 的 isolated 布局用符号链接指向虚拟store，跟随它会把
//    宿主 store 里的东西拖进来、还会让目录层级失真。这里选择跳过并如实记进
//    warnings，让上层的验证去发现「收编不完整」，而不是悄悄产出一份半对的运行时。
//
// @module dsh-mneme/runtime/adopt
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_PACKAGES, planClosure } from "./closure.js";
import { defaultRuntimeDir, nodeModulesDir, payloadDir, payloadId, runtimeManifestPath } from "./layout.js";

/** 清单版本：将来字段变化时用来判断怎么读。 */
export const RUNTIME_MANIFEST_VERSION = 1;

/**
 * 把一个包目录物化到目标位置。跳过嵌套的 `node_modules`——那些包在闭包计划里
 * 是独立条目，会各自落到自己的相对位置；不跳就会重复搬一遍。
 * @param {object} opts - 选项。
 * @param {Function} [opts.link] - 硬链接实现，默认 fs.linkSync；测试用来注入失败。
 * @returns {{files: number, bytes: number, linked: number, copied: number, symlinks: number, linkError: string|null}}
 */
export function materializePackage({ srcDir, destDir, warnings = [], link = linkSync }) {
  const stats = { files: 0, bytes: 0, linked: 0, copied: 0, symlinks: 0, linkError: null };

  const walk = (src) => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      // 嵌套 node_modules 由闭包计划单独负责；跳过以免重复搬运。
      if (entry.isDirectory() && entry.name === "node_modules") continue;
      const full = join(src, entry.name);
      const dest = join(destDir, full.slice(srcDir.length + 1));
      if (entry.isSymbolicLink()) {
        stats.symlinks++;
        warnings.push(`跳过符号链接：${full}`);
        continue;
      }
      if (entry.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      mkdirSync(join(dest, ".."), { recursive: true });
      try {
        link(full, dest);
        stats.linked++;
      } catch (error) {
        // 跨卷（EXDEV）、权限、文件系统不支持硬链接：逐个文件回退复制。
        // 这里只记录原因（返回给调用方），不往 warnings 里塞——warnings 是「按文件」
        // 的事件（例如跳过符号链接），而「为什么整体变成复制」是「按整次收编」的事实，
        // 去重与呈现由 adoptRuntime 负责，否则每个包都会重复记一条。
        if (stats.linkError === null) {
          stats.linkError = `${error?.code ?? ""} ${error?.message ?? error}`.trim();
        }
        copyFileSync(full, dest);
        stats.copied++;
      }
      stats.files++;
      stats.bytes += statSync(full).size;
    }
  };

  mkdirSync(destDir, { recursive: true });
  walk(srcDir);
  return stats;
}

/**
 * 从一份现成的 `node_modules` 收编出一份自管运行时，并写下清单。
 * @param {object} opts - 选项。
 * @param {string} opts.fromModulesDir - 源 node_modules（通常是宿主的）。
 * @param {string} [opts.runtimeDir] - 运行时根目录。
 * @param {string} [opts.platform] - 目标平台。
 * @param {string} [opts.arch] - 目标架构。
 * @param {string} [opts.procedure] - 来源标记（adopted / downloaded / manual）。
 * @param {boolean} [opts.overwrite] - 目标已存在时是否覆盖。
 * @param {number} [opts.maxPackages] - 闭包条目上限。
 * @param {Function} [opts.link] - 硬链接实现，默认 fs.linkSync；测试用来注入失败以覆盖回退分支
 *   （与 src/local-embedder.js 的 engineFactory 同一思路：把不可复现的环境差异变成可注入的依赖）。
 * @returns {object} 结果；失败时 ok=false 且带 reason，不抛异常。
 */
export function adoptRuntime({
  fromModulesDir,
  runtimeDir = defaultRuntimeDir(),
  platform = process.platform,
  arch = process.arch,
  procedure = "adopted",
  overwrite = false,
  maxPackages,
  link
}) {
  const plan = planClosure({ rootModulesDir: fromModulesDir, platform, arch, maxPackages });
  const entryPackage = plan.packages[0];
  if (entryPackage === undefined) {
    return { ok: false, reason: plan.gaps[0]?.reason ?? "入口包未解析到", plan };
  }

  const version = entryPackage.version ?? "unknown";
  const id = payloadId({ version, platform, arch });
  const dir = payloadDir(runtimeDir, id);

  if (existsSync(dir) && !overwrite) {
    return { ok: false, reason: `目标已存在：${dir}（需要覆盖请传 overwrite: true）`, payloadDir: dir, payloadId: id, plan };
  }

  // 截断的闭包必须拒绝。maxPackages 截断会静默丢掉传递依赖，而结构检查（describePayload）
  // 只看必需包、版本和入口文件 —— 于是一份残缺的 payload 会被判为可用、被 loader 选中，
  // 直到 import 原生模块时才炸，且错误现场离真正的原因很远。宁可在物化前明确失败。
  if (plan.truncated) {
    return {
      ok: false,
      reason: `依赖闭包被截断（上限 ${maxPackages ?? DEFAULT_MAX_PACKAGES} 个包），拒绝收编；请提高 maxPackages 后重试`,
      payloadDir: dir,
      payloadId: id,
      plan
    };
  }

  // 覆盖前必须先清空目标目录。不清的话，linkSync 对已存在的目标路径抛 EEXIST，
  // 于是每个文件都落到复制分支：物化方式会假报成 "copy"、警告会错说「硬链接不可用」、
  // 整份闭包真实占盘，而且上一次闭包留下的残留文件永远不会被清掉。
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  const warnings = [];
  const totals = { files: 0, bytes: 0, linked: 0, copied: 0, symlinks: 0 };
  let linkError = null;
  for (const pkg of plan.packages) {
    const stats = materializePackage({
      srcDir: pkg.srcDir,
      destDir: join(nodeModulesDir(dir), pkg.rel),
      warnings,
      link
    });
    for (const key of Object.keys(totals)) totals[key] += stats[key];
    if (linkError === null && stats.linkError !== null) linkError = stats.linkError;
  }
  // 物化方式如实记进清单：收编「本该不占盘却占了盘」时，用户和面板都能看到原因。
  const mode = totals.copied === 0 ? "hardlink" : totals.linked === 0 ? "copy" : "mixed";
  if (linkError !== null) warnings.push(`硬链接不可用，已回退为复制：${linkError}`);

  const manifest = {
    manifestVersion: RUNTIME_MANIFEST_VERSION,
    payloadId: id,
    entry: plan.entry,
    version,
    platform,
    arch,
    procedure,
    createdAt: new Date().toISOString(),
    materialize: { mode, linkError },
    packages: plan.packages.map((p) => ({ name: p.name, version: p.version, rel: p.rel, optional: p.optional })),
    gaps: plan.gaps,
    skipped: plan.skipped,
    warnings
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(runtimeManifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { ok: true, payloadDir: dir, payloadId: id, version, plan, manifest, totals };
}
