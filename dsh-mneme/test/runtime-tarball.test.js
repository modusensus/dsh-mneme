import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { sha512Base64, stripPackagePrefix, verifyIntegrity, walkTar, walkTgz } from "../src/runtime/tarball.js";
import { tarFile, tarHeader, tarMeta, tarPax } from "./helpers/tar-builder.js";

// PR-C 下载通道的归档读取层。这里是整条链里最该被单独守住的一块：它读的是别人产出的字节，
// 一旦读错，我们就会把「缺文件/文件截断」的运行时当成完整的搬进 payload，而那种错误
// 要到第一次 import 原生模块时才现形。
//
// 合成归档在测试里现造（不引 tar 库），另外单独用 npm pack 产出的真实 .tgz 做过一次交叉核对
// （见 PR 描述里的验证记录）——合成归档只能证明读取器与规范一致，真实产物才能证明它与 npm 一致。

const END = [Buffer.alloc(512), Buffer.alloc(512)];

function collect(buffer) {
  const seen = [];
  const stats = walkTar(buffer, (entry) => seen.push([entry.path, entry.data.toString("utf8")]));
  return { seen, stats };
}

test("walkTar：普通文件、目录、prefix 长路径、符号链接跳过、归档结束块都能处理", () => {
  const archive = Buffer.concat([
    ...tarFile("package/package.json", '{"name":"x"}\n'),
    ...tarMeta("package/lib", "5"),
    ...tarFile("api.js", "export const x = 1;\n", { prefix: "package/a/very/long/nested/path" }),
    ...tarMeta("package/link", "2"),
    ...END
  ]);

  const { seen, stats } = collect(archive);
  assert.deepEqual(seen, [
    ["package/package.json", '{"name":"x"}\n'],
    ["package/a/very/long/nested/path/api.js", "export const x = 1;\n"]
  ]);
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, Buffer.byteLength('{"name":"x"}\n') + Buffer.byteLength("export const x = 1;\n"));
  // 符号链接不能假装搬过来了 —— 如实记下，让上层去判断要不要失败。
  assert.equal(stats.skipped.length, 1);
  assert.match(stats.skipped[0], /package\/link/);
});

test("walkTar：pax 的 path 覆盖下一条目（超过 ustar 字段长度的深层路径靠它）", () => {
  const long = `package/${"d".repeat(120)}/${"e".repeat(120)}/file.js`;
  const archive = Buffer.concat([...tarPax(long), ...tarFile("truncated-name", "ok\n"), ...END]);
  const { seen } = collect(archive);
  assert.deepEqual(seen.map(([p]) => p), [long]);
});

test("walkTar：没有结束块也能读完（registry 产物有，但别依赖它）", () => {
  const { seen } = collect(Buffer.concat([...tarFile("package/a.txt", "a\n")]));
  assert.deepEqual(seen, [["package/a.txt", "a\n"]]);
});

test("walkTgz：gzip 包装的归档走同一条路", () => {
  const inner = Buffer.concat([...tarFile("package/package.json", "{}\n"), ...END]);
  // 未压缩那份用 walkTar 读，压缩那份用 walkTgz 读，两者结论必须一致。
  const plain = collect(inner).seen;
  const viaGzip = [];
  const stats = walkTgz(gzipSync(inner), (entry) => viaGzip.push([entry.path, entry.data.toString("utf8")]));
  assert.deepEqual(viaGzip, plain);
  assert.equal(stats.files, 1);
});

test("stripPackagePrefix：只去 npm 那一层前缀", () => {
  assert.equal(stripPackagePrefix("package/lib/index.js"), "lib/index.js");
  assert.equal(stripPackagePrefix("package"), "package");
  assert.equal(stripPackagePrefix("lib/index.js"), "lib/index.js");
});

test("verifyIntegrity：只认 sha512，且不匹配就是不匹配", () => {
  const good = Buffer.from("hello tarball");
  const integrity = `sha512-${sha512Base64(good)}`;
  assert.equal(verifyIntegrity(good, integrity), true);

  const tampered = Buffer.from("hello tarbal!");
  assert.equal(verifyIntegrity(tampered, integrity), false, "差一个字节也必须失败");
  // 不认识的算法不能放行：那等于把「没校验」说成「校验通过」。
  assert.equal(verifyIntegrity(good, "md5-YWJj"), false);
  assert.equal(verifyIntegrity(good, ""), false);
  assert.equal(verifyIntegrity(good, "sha512-"), false);
});