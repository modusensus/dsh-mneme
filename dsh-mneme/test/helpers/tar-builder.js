// test/helpers/tar-builder.js
// 共享的 tar 造件器：tarball 读取层与取件层的测试都要造归档，放这里免得两份漂移。
// 只造真东西（POSIX ustar 布局 + 正确的校验和），不引 tar 库 —— 那正是被测代码要回避的依赖。

import { gzipSync } from "node:zlib";

/** 一个 ustar 头块；字段布局照 POSIX，校验和按规范先按空格算再写回。 */
export function tarHeader({ name = "", prefix = "", size = 0, type = "0" }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write(type, 156, 1, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return header;
}

/** 普通文件条目（数据按 512 对齐补齐）。 */
export function tarFile(name, body, { prefix = "" } = {}) {
  const data = Buffer.from(body, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return [tarHeader({ name, prefix, size: data.length, type: "0" }), padded];
}

/** 目录（"5"）/ 符号链接（"2"）等无数据条目。 */
export function tarMeta(name, type) {
  return [tarHeader({ name, size: 0, type })];
}

/** pax 扩展头：载荷是 `长度 path=值\n`。 */
export function tarPax(path) {
  const record = Buffer.from(`path=${path}\n`, "utf8");
  const line = `${record.length + String(record.length).length} path=${path}\n`;
  return [tarHeader({ name: "PaxHeaders/x", size: Buffer.byteLength(line), type: "x" }), padTo512(Buffer.from(line, "utf8"))];
}

/** 补齐到 512 的整数倍。 */
export function padTo512(buffer) {
  if (buffer.length % 512 === 0) return buffer;
  const padded = Buffer.alloc(Math.ceil(buffer.length / 512) * 512);
  buffer.copy(padded);
  return padded;
}

/** 两个全零块 = 归档结束。 */
export const END_BLOCKS = [Buffer.alloc(512), Buffer.alloc(512)];

/**
 * 造一份 .tgz。`entries` 每项：
 *   { path, body }       普通文件（自动加 `package/` 前缀，除非 path 已含它）
 *   { path, type }       目录/符号链接等（type 是 ustar 的 typeflag 字符）
 *   { paxPath }          pax 头，覆盖下一条目的路径
 * @param {Array<object>} entries - 条目。
 * @param {{prefix?: string|null, end?: boolean}} [opts] - 前缀（默认 package/）、是否追加结束块。
 * @returns {Buffer} gzip 后的归档。
 */
export function makeTgz(entries, { prefix = "package/", end = true } = {}) {
  const blocks = [];
  for (const entry of entries) {
    if (entry.paxPath !== undefined) {
      blocks.push(...tarPax(prefix === null ? entry.paxPath : `${prefix}${entry.paxPath}`));
      continue;
    }
    const path = prefix === null || entry.path.startsWith(prefix) ? entry.path : `${prefix}${entry.path}`;
    if (entry.type !== undefined) blocks.push(...tarMeta(path, entry.type));
    else blocks.push(...tarFile(path, entry.body ?? ""));
  }
  if (end) blocks.push(...END_BLOCKS);
  return gzipSync(Buffer.concat(blocks));
}
