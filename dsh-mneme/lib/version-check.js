// 版本自检（issue #174 后续，2026-09-15 拍板）：独立插件不把「用户在用哪个
// 版本」托付给插件市场——市场收录有 ~26h 年龄闸门 + 30min 缓存，且安装时
// 精确指定过版本的 profile 会被 pnpm 钉子挡住（update 尊重既有 semver 范围，
// 永不跨 minor/major，#174 的报障者正是这样用着 0.7.32 的行为模型来报 bug）。
//
// 本模块只做三件事：
//   1. 向 npm registry 查 @modusensus/dsh-mneme 的 latest dist-tag（带 TTL
//      缓存 + 超时 + 全失败静默——离线/被墙/registry 异常都返回 null，调用方
//      据 null 渲染「未知」，前端不打扰）；
//   2. 与运行版本做纯函数比对（classify）；
//   3. 对外暴露 registry URL 白名单校验（validateRegistryUrl）——发请求前
//      强制 https + 精确 host，构造上排除本机与内网地址。
import { readFileSync } from "node:fs";

// 运行版本：src/ 与 lib/ 都在插件根下一层，相对 import.meta.url 解析一致；
// 读取失败（打包/受限环境）降级 "unknown"，横幅随之静默。
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// registry 查询地址是模块常量而非用户输入；validateRegistryUrl 仍作为发请求
// 前的强制闸（构造上即排除非 https 与非白名单 host，双保险且可单测）。
const REGISTRY_URL = "https://registry.npmjs.org/@modusensus%2Fdsh-mneme/latest";
const REGISTRY_HOST = "registry.npmjs.org";
// 市场收录本身有 ~1 天年龄闸门，1h 的 registry 缓存远低于该粒度，足够新鲜。
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

// 精确 host 白名单：协议必须 https，且 host 逐字等于 registry.npmjs.org。
// 这一条即构造性排除本机回环、私有网段与保留地址——不做任何
// 「看起来像公网」的宽松判断，将来换源必须显式改这里的常量。
export function validateRegistryUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === REGISTRY_HOST;
}

/** 解析 `x.y.z` / `x.y.z-后缀` 为可比较结构；解析失败返回 null。 */
function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // 有 prerelease 后缀的同号版本视为更旧（0.9.0-rc.1 < 0.9.0）。
    prerelease: match[4] !== undefined
  };
}

/**
 * 三元组语义化比较：a<b → -1，a>b → 1，无法比较 → null（调用方归入 unknown）。
 * 仅比较数字部分；数字相等时，带 prerelease 的一方更旧（0.9.0-rc.1 < 0.9.0），
 * 两侧都带则视为同版——横幅只关心「是否落后于 latest」，不追求完整 semver 序。
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  if (va.prerelease !== vb.prerelease) return va.prerelease ? -1 : 1;
  return 0;
}

/**
 * 运行版本 vs registry latest 的展示归类。latest 为 null（查询失败/离线）
 * 或任一侧解析失败时归 unknown——前端对 unknown 完全静默。
 */
export function classify(version, latest) {
  const cmp = compareVersions(version, latest);
  if (cmp === null) return "unknown";
  if (cmp < 0) return "outdated";
  if (cmp > 0) return "ahead";
  return "up-to-date";
}

// 模块级缓存：面板可能多处/多次拉取，TTL 内一律复用，不重复打 registry。
// at 用 -Infinity 作「从未拉取」哨兵：任何时钟下 now-at 都是正无穷，首轮
// 必然真实请求（测试的假时钟从 0 起也不会被误判成新鲜缓存）。
let cache = { at: -Infinity, latest: null };

/**
 * 查询 registry latest。TTL 内直接命中缓存；任何失败（网络/超时/非 2xx/
 * 响应形状不对/URL 校验不过）都静默返回 null——版本提示是锦上添花，绝不
 * 让它成为新的故障面。失败不写缓存：TTL 起点保持旧值，下次调用立刻重试。
 */
export async function fetchLatestVersion({ fetchImpl = typeof fetch === "function" ? fetch : () => Promise.reject(new Error("no fetch")), now = Date.now } = {}) {
  if (now() - cache.at < CACHE_TTL_MS) return cache.latest;
  if (!validateRegistryUrl(REGISTRY_URL)) return null;
  let manifest;
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" }
    });
    if (!response.ok) return null;
    manifest = await response.json();
  } catch {
    return null;
  }
  const latest = typeof manifest?.version === "string" && manifest.version ? manifest.version : null;
  cache = { at: now(), latest };
  return latest;
}

/** 仅供测试：清空模块级缓存与时间戳。 */
export function resetCacheForTest() {
  cache = { at: -Infinity, latest: null };
}

export { PACKAGE_VERSION, REGISTRY_URL, CACHE_TTL_MS };
