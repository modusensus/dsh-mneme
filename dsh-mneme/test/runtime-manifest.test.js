import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, integrityIndex, isExcluded } from "../scripts/build-runtime-manifest.mjs";
import { payloadId } from "../lib/runtime/layout.js";

// PR-C 的清单层。守两件事：
//   ① 剔除规则必须按**子树**生效（只按包名会漏掉 onnxruntime-web/node_modules/... 这类嵌套条目，
//      而那个位置根本不会被取回来 —— 这个漏洞我在写完第一版时真的踩到了）；
//   ② 已提交的 runtime-manifest.json 必须自洽：每条都有 sha512 与可取的地址，且 payloadId 与
//      契约函数一致，否则下载器会带着错的哈希或错的目录名去干活。

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const localKey = `${process.platform}-${process.arch}`;

test("isExcluded：按包名与子树一起判定，嵌套条目不能漏", () => {
  assert.equal(isExcluded({ name: "onnxruntime-web", rel: "onnxruntime-web" }), true);
  // 这一条就是漏网的形态：包名不是被剔除的那个，但位置在被剔除包的子树里。
  assert.equal(
    isExcluded({ name: "onnxruntime-common", rel: "onnxruntime-web/node_modules/onnxruntime-common" }),
    true
  );
  // 同名但位于别处（顶层那份）必须保留。
  assert.equal(isExcluded({ name: "onnxruntime-common", rel: "onnxruntime-common" }), false);
  assert.equal(isExcluded({ name: "onnxruntime-node", rel: "onnxruntime-node" }), false);
  assert.equal(isExcluded({ name: "sharp", rel: "sharp" }), false);
});

test("integrityIndex：按 name@version 建索引，嵌套路径取最后一段包名，缺 integrity 的跳过", () => {
  const index = integrityIndex({
    packages: {
      "": { name: "root" },
      "node_modules/a": { version: "1.0.0", integrity: "sha512-AAA", resolved: "https://r/a-1.0.0.tgz" },
      "node_modules/a/node_modules/b": { version: "2.0.0", integrity: "sha512-BBB" },
      "node_modules/c": { version: "3.0.0" },
      "node_modules/@scope/d": { version: "4.0.0", integrity: "sha512-DDD" }
    }
  });
  assert.equal(index.get("a@1.0.0").integrity, "sha512-AAA");
  assert.equal(index.get("a@1.0.0").resolved, "https://r/a-1.0.0.tgz");
  assert.equal(index.get("b@2.0.0").integrity, "sha512-BBB", "嵌套条目也必须能查到");
  assert.equal(index.get("@scope/d@4.0.0").integrity, "sha512-DDD");
  assert.equal(index.has("c@3.0.0"), false, "没有 integrity 的条目不能进索引（否则等于先信任再校验）");
});

test("build：本机闭包能编出清单，每条都带 sha512 与可取地址", () => {
  const built = build({ platform: process.platform, arch: process.arch });
  assert.ok(built.packages.length > 10, `闭包太少了：${built.packages.length}`);
  assert.equal(built.payloadId, payloadId({ version: built.transformersVersion, platform: process.platform, arch: process.arch }));
  for (const pkg of built.packages) {
    assert.match(pkg.integrity, /^sha512-/, `${pkg.name} 缺 sha512`);
    assert.match(pkg.tarball, /^https:\/\//, `${pkg.name} 的地址不可取`);
    assert.ok(pkg.rel && pkg.version && pkg.name, `${pkg.name} 条目字段不全`);
    assert.equal(isExcluded(pkg), false, `${pkg.rel} 不该出现在清单里`);
  }
  // 平台包必须在（缺了它，sharp 在运行时会找不到自己的原生二进制）。
  assert.ok(built.packages.some((p) => p.rel === "onnxruntime-node"));
  assert.ok(built.packages.some((p) => p.name.startsWith("@img/sharp-") || p.name === "sharp"));
});

test("已提交的 runtime-manifest.json 自洽（下载器的输入契约）", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "runtime-manifest.json"), "utf8"));
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.entry, "@huggingface/transformers");
  assert.ok(Object.keys(manifest.excluded).includes("onnxruntime-web"), "剔除项要写进清单，别让后来者以为是漏了");
  assert.ok(Object.keys(manifest.platforms).length >= 1);

  for (const [key, entry] of Object.entries(manifest.platforms)) {
    assert.equal(key, `${entry.platform}-${entry.arch}`, "平台键必须与条目里的平台一致");
    assert.equal(entry.payloadId, payloadId({ version: entry.transformersVersion, platform: entry.platform, arch: entry.arch }));
    assert.ok(entry.packages.length > 10, `${key} 的包太少`);
    const rels = entry.packages.map((p) => p.rel);
    assert.equal(new Set(rels).size, rels.length, `${key} 里 rel 有重复，落盘会互相覆盖`);
    for (const pkg of entry.packages) {
      assert.match(pkg.integrity, /^sha512-/, `${key}/${pkg.name} 缺 sha512`);
      assert.ok(!pkg.rel.startsWith("onnxruntime-web"), `${key}/${pkg.rel} 落在被剔除包的子树里`);
    }
  }
});
