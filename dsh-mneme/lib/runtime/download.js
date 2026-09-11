// 运行时取件（issue #131 / PR-C）
//
// 三档来源，按可用性依次尝试。第一档「收编本机 node_modules」在 adopt.js；这里管后两档：
//   ② 本地 .tgz 目录 —— 给「某个包网络下不到」的情况（本机就有一份 82MB 的 vendor tarball）；
//   ③ registry（可换镜像）—— 有网络时的常规路径。
//
// 三条硬规矩：
//   1. **先校验 sha512 再落盘**。不匹配就不写、整次判失败。没有「先信任再校验」这种中间态。
//   2. **tar 条目路径必须落在该包目录内**。registry 与本地 tarball 都是外来输入，`../` 这类
//      路径遍历要在这里挡住 —— 这是信任边界上的校验，不是美化。
//   3. **任何一步失败都清掉半份 payload**。结构检查只看必需包与入口，半份 payload 可能
//      「看起来能用」，然后在 import 原生模块时才炸，错误现场离真正的原因很远。
//
// @module dsh-mneme/runtime/download
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { RUNTIME_MANIFEST_VERSION } from "./adopt.js";
import { defaultRuntimeDir, nodeModulesDir, payloadDir, runtimeManifestPath } from "./layout.js";
import { stripPackagePrefix, verifyIntegrity, walkTgz } from "./tarball.js";

const DEFAULT_ATTEMPTS = 3;

/**
 * 把 registry 地址换成镜像地址：只换前缀，保留 `/name/-/file.tgz` 这段路径。
 * 换不了（不是 registry.npmjs.org 的地址）就原样返回 —— 清单里写死的地址优先。
 * @param {string} url - 清单里的地址。
 * @param {string} mirror - 镜像前缀，空 = 不换。
 * @returns {string} 实际要取的地址。
 */
export function applyMirror(url, mirror) {
  const base = String(mirror ?? "").trim().replace(/\/+$/, "");
  if (base === "") return url;
  const marker = url.indexOf("/-/");
  if (marker === -1) return url;
  const name = url.slice(url.indexOf("registry.npmjs.org/") + "registry.npmjs.org/".length, marker);
  return name === "" ? url : `${base}/${name}${url.slice(marker)}`;
}

/**
 * 本地 tarball 目录里的候选文件名。用 npm 的约定（`<basename>-<version>.tgz`），
 * 这样 `npm pack` 出来的东西直接丢进目录就能用，不需要改名字。
 * @param {string} dir - 目录。
 * @param {{name: string, version: string}} pkg - 包。
 * @returns {string} 候选路径。
 */
export function localTarballPath(dir, pkg) {
  const base = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
  return join(dir, `${base}-${pkg.version}.tgz`);
}

/**
 * 取一个 .tgz 的字节。失败重试；已经收到部分字节时用 `Range` **续传**而不是从头再来
 * —— 82MB 的 onnxruntime-node 在移动网络上重来一次的代价太大。
 * @param {string} url - 地址。
 * @param {object} [opts] - 选项。
 * @returns {Promise<{buffer: Buffer, attempts: number, resumed: boolean}>}
 */
export async function fetchTarball(url, { attempts = DEFAULT_ATTEMPTS, fetchImpl = fetch, onProgress } = {}) {
  let lastError = null;
  let chunks = [];
  let received = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, received > 0 ? { headers: { Range: `bytes=${received}-` } } : undefined);
      if (res.status === 206) {
        // 续传被接受：已有字节保留，接着追加。
      } else if (res.ok) {
        // 服务端不支持续传（或首次请求）：从头来。
        chunks = [];
        received = 0;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }

      if (res.body?.getReader === undefined) {
        const whole = Buffer.from(await res.arrayBuffer());
        chunks = [whole];
        received = whole.length;
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          received += chunk.length;
          onProgress?.({ received, attempt });
        }
      }
      return { buffer: Buffer.concat(chunks, received), attempts: attempt, resumed: attempt > 1 };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`取件失败（试了 ${attempts} 次）：${lastError?.message ?? lastError}`);
}

/** 解一个 .tgz 到该包的目录里；条目路径必须落在目录内。 */
function extractInto(buffer, pkgDir, skipped) {
  const stats = { files: 0, bytes: 0 };
  const guard = pkgDir.endsWith(sep) ? pkgDir : `${pkgDir}${sep}`;
  const walked = walkTgz(buffer, (entry) => {
    const target = join(pkgDir, stripPackagePrefix(entry.path));
    // 越界即整次失败：把外来归档里的 ../ 写出去是不可接受的。
    if (!target.startsWith(guard)) throw new Error(`归档里有越出包目录的路径：${entry.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    stats.files++;
    stats.bytes += entry.data.length;
  });
  for (const item of walked.skipped) skipped.push(item);
  return stats;
}

/**
 * 按清单把运行时取回来并落盘（第二、三档来源）。
 * @param {object} opts - 选项。
 * @param {object} opts.manifest - runtime-manifest.json 的内容。
 * @param {string} [opts.runtimeDir] - 运行时根目录。
 * @param {string} [opts.localTarballDir] - 本地 .tgz 目录（有就用，优先于网络）。
 * @param {string} [opts.mirror] - registry 镜像前缀。
 * @param {boolean} [opts.overwrite] - 目标已存在时是否覆盖。
 * @returns {Promise<object>} 与 adoptRuntime 同形的结果；失败时 ok=false 且带 reason，不抛。
 */
export async function downloadRuntime({
  manifest,
  platform = process.platform,
  arch = process.arch,
  runtimeDir = defaultRuntimeDir(),
  localTarballDir = "",
  mirror = "",
  overwrite = false,
  attempts = DEFAULT_ATTEMPTS,
  fetchImpl = fetch,
  onProgress
}) {
  const key = `${platform}-${arch}`;
  const entry = manifest?.platforms?.[key];
  if (entry === undefined) {
    return { ok: false, reason: `清单里没有 ${key} 的条目 —— 本机平台不在 runtime-manifest.json 覆盖范围内` };
  }

  const dir = payloadDir(runtimeDir, entry.payloadId);
  if (existsSync(dir) && !overwrite) {
    return {
      ok: false,
      reason: `目标已存在：${dir}（需要覆盖请传 overwrite: true）`,
      payloadDir: dir,
      payloadId: entry.payloadId
    };
  }
  // 覆盖前先清空：否则上一次的残留文件会让结构检查看到「完整」，掩盖这一次的缺件。
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  const totals = { packages: 0, files: 0, bytes: 0, fromLocal: 0, fromNetwork: 0 };
  const warnings = [];
  const packages = [];
  const skipped = [];

  try {
    for (const pkg of entry.packages) {
      const local = localTarballDir ? localTarballPath(localTarballDir, pkg) : "";
      const useLocal = local !== "" && existsSync(local);
      const url = applyMirror(pkg.tarball, mirror);
      const buffer = useLocal ? readFileSync(local) : (await fetchTarball(url, { attempts, fetchImpl, onProgress })).buffer;
      if (useLocal) totals.fromLocal++;
      else totals.fromNetwork++;

      if (!verifyIntegrity(buffer, pkg.integrity)) {
        // 校验失败必须停在这里：写下去就等于把「来源不可信」变成「已装好」。
        throw new Error(`${pkg.name}@${pkg.version} 的 sha512 与清单不符（来源：${useLocal ? local : url}）`);
      }

      const stats = extractInto(buffer, join(nodeModulesDir(dir), pkg.rel), skipped);
      totals.files += stats.files;
      totals.bytes += stats.bytes;
      totals.packages++;
      packages.push({ name: pkg.name, version: pkg.version, rel: pkg.rel, optional: pkg.optional === true });
      onProgress?.({ package: pkg.name, done: totals.packages, total: entry.packages.length });
    }
  } catch (error) {
    // 半份 payload 比没有更糟：清掉，让「没装成」这件事在磁盘上也成立。
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: String(error?.message ?? error) };
  }

  const written = {
    manifestVersion: RUNTIME_MANIFEST_VERSION,
    payloadId: entry.payloadId,
    entry: manifest.entry ?? "@huggingface/transformers",
    version: entry.transformersVersion,
    platform,
    arch,
    procedure: "downloaded",
    createdAt: new Date().toISOString(),
    materialize: { mode: "download", linkError: null },
    sources: { mirror: mirror || null, localTarballDir: localTarballDir || null, counts: { local: totals.fromLocal, network: totals.fromNetwork } },
    packages,
    gaps: [],
    skipped,
    warnings
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(runtimeManifestPath(dir), `${JSON.stringify(written, null, 2)}\n`, "utf8");
  return {
    ok: true,
    payloadDir: dir,
    payloadId: entry.payloadId,
    version: entry.transformersVersion,
    totals,
    manifest: written
  };
}
