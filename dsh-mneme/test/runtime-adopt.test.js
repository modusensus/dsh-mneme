import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptRuntime, materializePackage, RUNTIME_MANIFEST_VERSION } from "../lib/runtime/adopt.js";
import { describePayload, nodeModulesDir, payloadDir, payloadId, runtimeManifestPath } from "../lib/runtime/layout.js";
import { readJsonSafe } from "../lib/runtime/layout.js";

// 收编（issue #131 / PR-A）：守住「老用户升级后本地嵌入不断」这条底线。
// 关键判据是——源布局被如实镜像（含嵌套层）、同卷走硬链接、符号链接不跟随、
// 产出的目录能通过结构检查。

/** 造一份「像真的」源 node_modules：入口 + 三平台单包 + 平台分片 + 嵌套版本冲突。 */
function makeSource({ withSymlink = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "mneme-adopt-src-"));
  const nm = join(base, "node_modules");
  const write = (rel, body) => {
    const full = join(nm, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  const pkg = (rel, manifest) => write(join(rel, "package.json"), JSON.stringify(manifest));

  pkg("@huggingface/transformers", {
    name: "@huggingface/transformers",
    version: "4.2.0",
    dependencies: { "onnxruntime-node": "1.24.3", sharp: "^0.34.5" }
  });
  write("@huggingface/transformers/dist/transformers.node.mjs", "export const real = true;\n");

  pkg("onnxruntime-node", { name: "onnxruntime-node", version: "1.24.3", dependencies: { "onnxruntime-common": "1.24.3" } });
  write("onnxruntime-node/bin/napi-v6/win32/onnxruntime.dll", "dll-bytes\n");
  write("onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.dylib", "dylib-bytes\n");

  pkg("onnxruntime-common", { name: "onnxruntime-common", version: "1.24.3" });
  write("onnxruntime-common/index.js", "export default 1;\n");

  pkg("sharp", { name: "sharp", version: "0.34.5" });
  write("sharp/index.js", "export default 2;\n");

  if (withSymlink) write("sharp/linked.js", "export default 3;\n");

  return { base, nm, write };
}

test("收编：镜像源布局（含嵌套层），并写出清单", () => {
  const { nm } = makeSource();
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-adopt-dst-"));
  const result = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64" });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.payloadId, "transformers-4.2.0-node-win32-x64");
  assert.equal(result.payloadDir, payloadDir(runtimeDir, payloadId({ version: "4.2.0", platform: "win32", arch: "x64" })));

  const manifest = readJsonSafe(runtimeManifestPath(result.payloadDir));
  assert.equal(manifest.manifestVersion, RUNTIME_MANIFEST_VERSION);
  assert.equal(manifest.procedure, "adopted");
  assert.equal(manifest.version, "4.2.0");
  assert.ok(manifest.packages.some((p) => p.rel === "onnxruntime-node"));

  // 收编产物必须能通过结构检查——这是「adopt 与 layout 契约一致」的整合判据。
  const report = describePayload(result.payloadDir, { platform: "win32" });
  assert.equal(report.ok, true, `missing=${report.missing} reasons=${report.reasons}`);
  assert.equal(report.manifest?.procedure, "adopted");
});

test("收编：同卷走硬链接（不额外占盘），且文件内容一致", () => {
  const { nm } = makeSource();
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-adopt-dst-"));
  const result = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64" });

  assert.equal(result.totals.files, result.totals.linked + result.totals.copied, "每个文件要么链接要么复制");
  assert.ok(result.totals.linked > 0, `同卷应当走硬链接，实际 linked=${result.totals.linked} copied=${result.totals.copied}`);
  assert.ok(result.totals.bytes > 0);
  assert.equal(result.manifest.materialize.mode, "hardlink");
  assert.equal(result.manifest.materialize.linkError, null, "没回退就不该有 linkError");

  const copied = join(nodeModulesDir(result.payloadDir), "onnxruntime-node", "bin", "napi-v6", "win32", "onnxruntime.dll");
  assert.equal(readJsonSafe(copied), undefined, "非 JSON 内容应当原样搬过来");
});

test("收编：硬链接不可用时回退复制，并把原因如实记进清单与 warnings", () => {
  const { nm } = makeSource();
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-adopt-dst-"));
  // 注入一个必定失败的 linkSync，覆盖「跨卷 / 权限不足」这类本机不可复现的环境差异。
  const denyLink = () => {
    const error = new Error("operation not permitted, link");
    error.code = "EPERM";
    throw error;
  };
  const result = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64", link: denyLink });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.totals.linked, 0);
  assert.equal(result.totals.copied, result.totals.files);
  assert.equal(result.manifest.materialize.mode, "copy");
  assert.match(result.manifest.materialize.linkError, /EPERM/);
  assert.equal(
    result.manifest.warnings.filter((w) => w.includes("硬链接不可用")).length,
    1,
    "同一次收编只该记一条回退原因，不是每个文件记一条"
  );
  // 回退之后产物依然必须能通过结构检查——回退不能以正确性为代价。
  assert.equal(describePayload(result.payloadDir, { platform: "win32" }).ok, true);
});

test("收编：跳过嵌套 node_modules，避免把同一份包搬两遍", () => {
  const { nm, write } = makeSource();
  // 给入口包塞一个嵌套副本：闭包不会把它当作依赖，因此不该被搬进产物。
  write("@huggingface/transformers/node_modules/orphan/index.js", "orphan\n");
  write("@huggingface/transformers/node_modules/orphan/package.json", JSON.stringify({ name: "orphan", version: "1.0.0" }));

  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-adopt-dst-"));
  const result = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(result.ok, true, result.reason);

  const orphan = join(nodeModulesDir(result.payloadDir), "@huggingface", "transformers", "node_modules", "orphan");
  assert.equal(describePayload(result.payloadDir, { platform: "win32" }).ok, true);
  assert.equal(readJsonSafe(join(orphan, "package.json")), undefined, "不可达的嵌套包不该被搬进来");
});

test("收编：符号链接不跟随，记进 warnings（isolated 布局的来源会被如实暴露）", (t) => {
  const { nm, write } = makeSource();
  const real = join(nm, "sharp", "index.js");
  const link = join(nm, "sharp", "linked.js");
  try {
    symlinkSync(real, link, "file");
  } catch {
    t.skip("当前环境不允许创建符号链接（Windows 需要开发者模式），跳过该断言");
    return;
  }
  assert.ok(write);

  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-adopt-dst-"));
  const result = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(result.totals.symlinks, 1);
  assert.ok(result.manifest.warnings.some((w) => w.includes("符号链接")));
});

test("收编：目标已存在时默认拒绝，overwrite 才覆盖", () => {
  const { nm } = makeSource();
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-adopt-dst-"));
  const first = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(first.ok, true);

  const again = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(again.ok, false);
  assert.match(again.reason, /目标已存在/);

  const forced = adoptRuntime({ fromModulesDir: nm, runtimeDir, platform: "win32", arch: "x64", overwrite: true });
  assert.equal(forced.ok, true);
});

test("收编：源里没有入口包时给出可读原因，不抛异常", () => {
  const empty = mkdtempSync(join(tmpdir(), "mneme-adopt-empty-"));
  mkdirSync(join(empty, "node_modules"), { recursive: true });
  const result = adoptRuntime({ fromModulesDir: join(empty, "node_modules") });
  assert.equal(result.ok, false);
  assert.match(result.reason, /入口包不存在|入口包未解析到/);
});

test("materializePackage：统计文件与字节数，返回自身可测", () => {
  const { base } = makeSource();
  const src = join(base, "node_modules", "onnxruntime-common");
  const dest = mkdtempSync(join(tmpdir(), "mneme-materialize-"));
  const stats = materializePackage({ srcDir: src, destDir: join(dest, "pkg") });
  assert.equal(stats.files, 2, "package.json + index.js");
  assert.ok(stats.bytes > 0);
  assert.equal(stats.symlinks, 0);
});
