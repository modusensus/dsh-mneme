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
import { REQUIRED_PACKAGES, defaultRuntimeDir, nodeModulesDir, payloadDir, payloadId, runtimeManifestPath } from "./layout.js";
import { matchesPlatform } from "./closure.js";
import { stripPackagePrefix, verifyIntegrity, walkTgz } from "./tarball.js";

const DEFAULT_ATTEMPTS = 3;
// 单次请求的总超时。连接僵住（对端不回也不断）时，没有它就会永远等着 —— 用户看到的是一个
// 卡死的按钮，而没有任何错误可看。给得宽松：几百 MB 的包在慢网下也要能下完。
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

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
  // 只换 registry.npmjs.org 的地址：别的来源（自建 registry、file:、清单里已是镜像的地址）一律
  // 原样返回。这里曾经用 indexOf(...) 直接加偏移量拼字符串 —— 地址里没有那个域名时 indexOf 返回
  // -1，slice 出的是垃圾名字，把一条本来可用的地址改坏。
  const prefix = "https://registry.npmjs.org/";
  const marker = url.indexOf("/-/");
  if (marker === -1 || !url.startsWith(prefix)) return url;
  const name = url.slice(prefix.length, marker);
  return name === "" ? url : `${base}/${name}${url.slice(marker)}`;
}

/**
 * 本地 tarball 目录里的候选文件名。用 npm 的约定（`<basename>-<version>.tgz`），
 * 这样 
pm pack` 出来的东西直接丢进目录就能用，不需要改名字。
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
export async function fetchTarball(url, { attempts = DEFAULT_ATTEMPTS, fetchImpl = fetch, onProgress, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  let lastError = null;
  let chunks = [];
  let received = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const options = received > 0 ? { headers: { Range: `bytes=${received}-` } } : {};
      // AbortSignal.timeout 是**总时长**上限，不是空闲超时：宁可给得宽松，也不要掐断正常的慢速下载。
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) options.signal = AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(url, Object.keys(options).length > 0 ? options : undefined);
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
        // 206 的响应体只是**剩余**那段，必须追加；200 才是完整的一份 —— 覆盖会丢掉前半段，
        // 于是 sha512 校验必挂（而这次失败看起来像「来源不可信」，与真实原因不符）。
        if (res.status === 206) {
          chunks.push(whole);
          received += whole.length;
        } else {
          chunks = [whole];
          received = whole.length;
        }
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          received += chunk.length;
          // 事件带 type：同一个回调同时承载「字节级」与「包级」两种进度，不标类型调用方就只能猜。
          onProgress?.({ type: "bytes", received, attempt });
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
  // v2 清单是**平台无关**的：里面是所有平台的包（各带 os / cpu），这里按本机平台过滤。
  // 这样一份随包发布的静态清单就覆盖 win32 / darwin / linux × x64 / arm64 —— 不需要
  // 「谁在哪个系统上跑一次生成脚本」，也就不会让 macOS 用户卡在「清单里没有我的平台」。
  const all = Array.isArray(manifest?.packages) ? manifest.packages : null;
  if (all === null) return { ok: false, reason: "运行时清单不可用（缺少 packages 列表）" };

  const wanted = all.filter((pkg) => matchesPlatform(pkg, platform, arch));
  const missingRequired = REQUIRED_PACKAGES.filter((name) => !wanted.some((pkg) => pkg.rel === name));
  if (missingRequired.length > 0) {
    // 目标平台在清单里就缺必需包时，现在失败好过装出一份「结构看着全、import 原生模块才炸」的
    // 运行时 —— 那时错误现场离原因已经很远。
    return { ok: false, reason: `清单里 ${platform}-${arch} 缺少必需包：${missingRequired.join("、")}` };
  }

  const id = payloadId({ version: manifest.transformersVersion, platform, arch });

  const dir = payloadDir(runtimeDir, id);
  if (existsSync(dir) && !overwrite) {
    return {
      ok: false,
      reason: `目标已存在：${dir}（需要覆盖请传 overwrite: true）`,
      payloadDir: dir,
      payloadId: id
    };
  }
  // 覆盖前先清空：否则上一次的残留文件会让结构检查看到「完整」，掩盖这一次的缺件。
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  const totals = { packages: 0, files: 0, bytes: 0, fromLocal: 0, fromNetwork: 0 };
  const warnings = [];
  const packages = [];
  const skipped = [];

  try {
    for (const pkg of wanted) {
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
      onProgress?.({ type: "package", package: pkg.name, done: totals.packages, total: wanted.length });
    }
  } catch (error) {
    // 半份 payload 比没有更糟：清掉，让「没装成」这件事在磁盘上也成立。
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: String(error?.message ?? error) };
  }

  const written = {
    manifestVersion: RUNTIME_MANIFEST_VERSION,
    payloadId: id,
    entry: manifest.entry ?? "@huggingface/transformers",
    version: manifest.transformersVersion,
    platform,
    arch,
    procedure: "downloaded",
    // 每个 tarball 都与清单里的 sha512 比对过 —— 这是下载档独有的、可如实声明的来源完整性。
    integrity: { status: "verified", checked: packages.length, detail: "每个 tarball 的 sha512 与 runtime-manifest.json 一致" },
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
    payloadId: id,
    version: manifest.transformersVersion,
    totals,
    manifest: written
  };
}
