// 极简 USTAR 读取 + sha512 校验（issue #131 / PR-C）
//
// 为什么自己写而不是加依赖：插件里多一个 tar 依赖，就多一份要跟着上游走的供应链与体积
// 成本；而这里只需要读「npm registry 产出的 .tgz」这一种固定格式（gzip + ustar/pax），
// node:zlib 加一个一两百行的读取器就够，而且行为完全可审计。
//
// 只做下载通道必需的事：逐个条目回调（不把整棵解压树同时留在内存里）、跳过目录与不认识的
// 类型、支持 ustar 的 prefix 长路径与 pax 的 path 覆盖（npm 的深层路径两者都会用到）。
//
// @module dsh-mneme/runtime/tarball
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
/** npm tarball 把所有内容放在统一的 `package/` 前缀下。 */
const PACKAGE_PREFIX = "package/";

/** 读 ustar 头里的字符串字段：到 NUL 截断，去掉尾随空白。 */
function readString(buffer, start, length) {
  const nul = buffer.indexOf(0, start);
  const end = nul === -1 || nul > start + length ? start + length : nul;
  return buffer.subarray(start, end).toString("utf8").trim();
}

/**
 * 读数字字段。ustar 用八进制 + NUL/空格填充；GNU 对超大值改用 base-256（首字节最高位为 1）。
 * 两者都认，否则遇到大文件会把它读成 0 字节而静默截断。
 */
function readNumber(buffer, start, length) {
  if ((buffer[start] & 0x80) !== 0) {
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + buffer[i];
    return value;
  }
  const text = readString(buffer, start, length);
  if (text === "") return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** pax 扩展头（typeflag 'x'）的载荷是一串 `长度 key=value\n`，只需要 path。 */
function paxPath(data) {
  const text = data.toString("utf8");
  const match = /^\d+ path=(.*)$/m.exec(text);
  return match ? match[1] : null;
}

/**
 * 遍历一个未压缩的 tar 归档。
 * @param {Buffer} buffer - tar 字节。
 * @param {(entry: {path: string, data: Buffer}) => void} onFile - 每个普通文件回调一次。
 * @returns {{files: number, bytes: number, skipped: string[]}} 统计；skipped 是跳过的类型。
 */
export function walkTar(buffer, onFile) {
  const stats = { files: 0, bytes: 0, skipped: [] };
  let offset = 0;
  let pendingPath = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // 全零块 = 归档结束（正常收尾，不是错误）。
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const size = readNumber(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header, 345, 155);
    offset += BLOCK;

    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    // pax 扩展头：只取 path 覆盖下一条目，自身不是文件。
    if (typeflag === "x") {
      pendingPath = paxPath(data) ?? pendingPath;
      continue;
    }
    if (typeflag === "g") continue; // 全局 pax 头，本用途不需要

    const full = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;

    if (typeflag === "5") continue; // 目录：由文件自身的路径隐式创建
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "") {
      // 符号链接、硬链接、设备节点等：registry 产物里不该出现，如实记下而不是假装搬过来了。
      stats.skipped.push(`${full} (typeflag=${typeflag})`);
      continue;
    }

    onFile({ path: full.replace(/^\.\//, ""), data });
    stats.files++;
    stats.bytes += data.length;
  }

  return stats;
}

/**
 * 遍历一个 .tgz（registry 的产物形态）。
 * @param {Buffer} gzipped - gzip 字节。
 * @param {(entry: {path: string, data: Buffer}) => void} onFile - 每个普通文件回调一次。
 * @returns {{files: number, bytes: number, skipped: string[]}}
 */
export function walkTgz(gzipped, onFile) {
  return walkTar(gunzipSync(gzipped), onFile);
}

/** 去掉 npm tarball 统一的 `package/` 前缀，得到包内相对路径。 */
export function stripPackagePrefix(path) {
  return path.startsWith(PACKAGE_PREFIX) ? path.slice(PACKAGE_PREFIX.length) : path;
}

/** sha512（base64）。与 npm `integrity` 字段的载荷同形。 */
export function sha512Base64(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

/**
 * 校验一条 npm integrity 字符串（形如 `sha512-<base64>`）。
 * 只认 sha512：这是 lockfile 里给我们的那一种，其它算法一律当不匹配 —— 校验失败必须是失败，
 * 不能因为「不认识的算法」而放行。
 * @param {Buffer} buffer - 待校验的字节。
 * @param {string} integrity - npm integrity 字符串。
 * @returns {boolean} 是否匹配。
 */
export function verifyIntegrity(buffer, integrity) {
  const expected = String(integrity ?? "").trim();
  if (!expected.startsWith("sha512-")) return false;
  return sha512Base64(buffer) === expected.slice("sha512-".length);
}
