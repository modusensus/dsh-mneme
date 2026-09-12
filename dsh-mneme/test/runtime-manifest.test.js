import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERED_PLATFORMS,
  build,
  closureFromLockfile,
  isExcluded,
  nameOfPath,
  packagesForPlatform,
  relOfPath,
  resolveCandidates
} from "../scripts/build-runtime-manifest.mjs";
import { REQUIRED_PACKAGES, payloadId } from "../src/runtime/layout.js";

// PR-C 的清单层，守四件事：
//   ① 剔除规则按**子树**生效 —— 只按包名会漏掉 onnxruntime-web/node_modules/... 这类嵌套条目，
//      而那个位置根本不会被取回来（第一版真踩过）。
//   ② 从 lockfile 解析依赖的走位正确（Node 的向上查找语义；嵌套重复版本就靠它）。
//   ③ 清单**平台无关**：六个常见平台都能过滤出完整的必需包，并各拿到自己的平台二进制。
//      这是「mac / linux 用户不会卡住」的唯一结构性保证 —— 我在本机没法真跑那些平台，
//      至少要钉住「过滤之后是完整的」。
//   ④ 已提交的清单必须就是生成器的输出：它随包发布，漂移了就等于发了一份错的哈希。

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
});

test("nameOfPath / relOfPath：取最后一段 node_modules 之后的部分", () => {
  assert.equal(nameOfPath("node_modules/@huggingface/transformers"), "@huggingface/transformers");
  assert.equal(nameOfPath("node_modules/a/node_modules/b"), "b");
  assert.equal(relOfPath("node_modules/a/node_modules/b"), "a/node_modules/b");
  assert.equal(relOfPath("node_modules/sharp"), "sharp");
});

test("resolveCandidates：按 Node 语义由近到远，最后兜底到根部", () => {
  assert.deepEqual(resolveCandidates("node_modules/a", "x"), ["node_modules/a/node_modules/x", "node_modules/x"]);
  assert.deepEqual(resolveCandidates("node_modules/a/node_modules/b", "x"), [
    "node_modules/a/node_modules/b/node_modules/x",
    "node_modules/a/node_modules/x",
    "node_modules/x"
  ]);
});

test("closureFromLockfile：被剔除包的（孤儿）依赖不会再进闭包", () => {
  // 这正是第一版的真实缺陷：按包名剔除了 onnxruntime-web，却把它那 16 个传递依赖留在了清单里。
  const lock = {
    packages: {
      "node_modules/@huggingface/transformers": {
        version: "4.2.0",
        integrity: "sha512-T",
        dependencies: { dep: "^1.0.0" }
      },
      "node_modules/dep": { version: "1.0.0", integrity: "sha512-D", dependencies: { "onnxruntime-web": "^1.0.0" } },
      "node_modules/onnxruntime-web": {
        version: "1.0.0",
        integrity: "sha512-W",
        dependencies: { orphan: "^1.0.0", nested: "^1.0.0" }
      },
      "node_modules/onnxruntime-web/node_modules/nested": { version: "1.0.0", integrity: "sha512-N" },
      "node_modules/orphan": { version: "1.0.0", integrity: "sha512-O" }
    }
  };
  const { packages, missing } = closureFromLockfile(lock);
  assert.deepEqual(packages.map((pkg) => pkg.rel), ["@huggingface/transformers", "dep"]);
  assert.deepEqual(missing, [], "被剔除的包不该算成「解析不到」");
});

test("closureFromLockfile：解析不到的依赖如实记下来，不静默少一个包", () => {
  const lock = {
    packages: {
      "node_modules/@huggingface/transformers": {
        version: "4.2.0",
        integrity: "sha512-T",
        dependencies: { "does-not-exist": "^1.0.0" }
      }
    }
  };
  const { packages, missing } = closureFromLockfile(lock);
  assert.deepEqual(packages.map((pkg) => pkg.rel), ["@huggingface/transformers"]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /does-not-exist/);
});

test("build：平台无关，六个常见平台都能过滤出完整的必需包与各自的平台二进制", () => {
  const built = build();
  assert.equal(built.manifestVersion, 2);
  assert.equal(built.entry, "@huggingface/transformers");
  assert.match(built.transformersVersion, /^\d+\.\d+\.\d+/);
  assert.ok(built.packages.length > 40, `闭包太小：${built.packages.length}`);

  for (const pkg of built.packages) {
    assert.match(pkg.integrity, /^sha512-/, `${pkg.rel} 缺 sha512`);
    assert.match(pkg.tarball, /^https:\/\//, `${pkg.rel} 的地址不可取`);
    assert.equal(isExcluded(pkg), false, `${pkg.rel} 不该出现在清单里`);
  }
  const rels = built.packages.map((pkg) => pkg.rel);
  assert.equal(new Set(rels).size, rels.length, "rel 有重复，落盘会互相覆盖");

  for (const [platform, arch] of COVERED_PLATFORMS) {
    const set = packagesForPlatform(built, platform, arch);
    for (const required of REQUIRED_PACKAGES) {
      assert.ok(
        set.some((pkg) => pkg.rel === required),
        `${platform}-${arch} 过滤后缺必需包 ${required}`
      );
    }
    // 各平台必须拿到**自己**的 sharp 原生包，且不能混进别的平台的（否则下载器会拉错二进制）。
    const native = set.filter((pkg) => pkg.name.startsWith("@img/sharp-"));
    assert.ok(native.length > 0, `${platform}-${arch} 没有 sharp 平台包`);
    for (const pkg of native) {
      assert.ok((pkg.os ?? []).includes(platform), `${platform}-${arch} 混进了 ${pkg.rel}`);
    }
    // payloadId 由「版本 + 平台」算出来（v2 清单里不再存它）。
    assert.equal(
      payloadId({ version: built.transformersVersion, platform, arch }),
      `transformers-4.2.0-node-${platform}-${arch}`
    );
  }
});

test("libc 过滤：确认 glibc 时剔掉 musl 变体，拿不到证据时一个都不剔", () => {
  const built = build();
  const all = packagesForPlatform(built, "linux", "x64");
  const onGlibc = packagesForPlatform(built, "linux", "x64", "glibc");
  const dropped = all.filter((pkg) => !onGlibc.includes(pkg));
  // linux-x64 上那两套 musl 变体（sharp 与 libvips）就是这条过滤的全部收益，十几 MB。
  assert.ok(dropped.length >= 2, `应当剔掉 musl 变体，实际剔了 ${dropped.length}`);
  for (const pkg of dropped) assert.deepEqual(pkg.libc, ["musl"], `${pkg.rel} 不该被剔`);
  // 必需包绝不能因 libc 被剔 —— 否则下载会在「缺必需包」处直接失败，用户拿不到出路。
  for (const required of REQUIRED_PACKAGES) {
    assert.ok(onGlibc.some((pkg) => pkg.rel === required), `确认 glibc 后缺必需包 ${required}`);
  }
  // 没有证据 = 与过滤前完全一致（默认路径必须是它）。
  assert.deepEqual(packagesForPlatform(built, "linux", "x64", null), all);
  // 别的平台没有 libc 变体，给不给证据都一样。
  assert.deepEqual(
    packagesForPlatform(built, "darwin", "arm64", "glibc"),
    packagesForPlatform(built, "darwin", "arm64")
  );
});

test("已提交的 runtime-manifest.json 就是生成器的输出（漂移 = 发布错的哈希）", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "runtime-manifest.json"), "utf8"));
  assert.deepEqual(committed, build(), "清单与 package-lock.json 不一致，请重跑 scripts/build-runtime-manifest.mjs");
});
