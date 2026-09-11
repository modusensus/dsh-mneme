import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMirror, downloadRuntime, localTarballPath } from "../lib/runtime/download.js";
import { describePayload } from "../lib/runtime/layout.js";
import { sha512Base64 } from "../lib/runtime/tarball.js";
import { makeTgz } from "./helpers/tar-builder.js";

// 取件层（PR-C 第三层）。整条链都在本地 http 服务器上测：重试、Range 续传、sha512 校验、
// 落盘布局、失败清理、路径遍历拦截 —— 不依赖外网，也不依赖某个包恰好能下载到。

/**
 * 三个包，凑够 describePayload 要求的必需包 + 入口 + 平台二进制子树。
 *
 * 条目路径必须**相对包根**（`package/dist/...`），这正是 npm tarball 的形态 ——
 * 下载器会自己把包放进 `node_modules/<rel>`，条目里再写一遍包名就会变成
 * `node_modules/<名>/<名>/...`，结构检查随即报「缺必需包」。
 */
function makePackageTgz(name) {
  if (name === "@huggingface/transformers") {
    return makeTgz([
      { path: "package.json", body: JSON.stringify({ name, version: "4.2.0" }) },
      { path: "dist/transformers.node.mjs", body: "export const x = 1;\n" },
      // 塞一点体积，让「掐断一半」在续传测试里真的能切出两段。
      { path: "dist/padding.bin", body: "p".repeat(4096) }
    ]);
  }
  if (name === "onnxruntime-node") {
    return makeTgz([
      { path: "package.json", body: JSON.stringify({ name, version: "1.24.3" }) },
      { path: `bin/napi-v6/${process.platform}/${process.arch}/ort.bin`, body: "native\n" }
    ]);
  }
  return makeTgz([{ path: "package.json", body: JSON.stringify({ name, version: "1.0.0" }) }]);
}

function entryFor(name, rel, tgz, version = "1.0.0") {
  return { name, version, rel, integrity: `sha512-${sha512Base64(tgz)}`, tarball: "" };
}

function manifestFor(packages, { platform = process.platform, arch = process.arch } = {}) {
  return {
    manifestVersion: 1,
    entry: "@huggingface/transformers",
    excluded: {},
    platforms: {
      [`${platform}-${arch}`]: {
        payloadId: `transformers-4.2.0-node-${platform}-${arch}`,
        transformersVersion: "4.2.0",
        platform,
        arch,
        packages
      }
    }
  };
}

/**
 * 起一个只服务内存里那几份字节的服务器。
 * `cutFirst` 命中时第一次请求只发一半就掐断，用来逼出重试 + 续传；它会记录是否收到过 Range。
 */
async function serve(files, { cutFirst = null } = {}) {
  const seen = { rangeHeader: null, requests: 0 };
  let cutDone = false;
  const server = createServer((req, res) => {
    seen.requests++;
    const body = files[req.url];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const range = req.headers.range;
    if (typeof range === "string") seen.rangeHeader = range;
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;

    if (cutFirst === req.url && !cutDone && start === 0) {
      cutDone = true;
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      // 等一小会儿再掐：立刻 destroy 会在客户端读到任何字节之前就断掉，
      // 那样就测不到「带着已收字节续传」这条路径（测试脚手架的问题，不是被测代码的）。
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (start > 0) {
      const rest = body.subarray(start);
      res.writeHead(206, { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` });
      res.end(rest);
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

function standardSet(base) {
  const tgz = {
    transformers: makePackageTgz("@huggingface/transformers"),
    onnx: makePackageTgz("onnxruntime-node"),
    sharp: makePackageTgz("sharp")
  };
  const packages = [
    { ...entryFor("@huggingface/transformers", "@huggingface/transformers", tgz.transformers, "4.2.0"), tarball: `${base}/transformers.tgz` },
    { ...entryFor("onnxruntime-node", "onnxruntime-node", tgz.onnx, "1.24.3"), tarball: `${base}/onnx.tgz` },
    { ...entryFor("sharp", "sharp", tgz.sharp), tarball: `${base}/sharp.tgz` }
  ];
  return { files: { "/transformers.tgz": tgz.transformers, "/onnx.tgz": tgz.onnx, "/sharp.tgz": tgz.sharp }, packages };
}

test("applyMirror：只换前缀，保留 /name/-/file.tgz；空镜像与非 registry 地址原样返回", () => {
  const url = "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.24.3.tgz";
  assert.equal(applyMirror(url, ""), url);
  assert.equal(applyMirror(url, "https://npmmirror.com/mirrors/npm/"), "https://npmmirror.com/mirrors/npm/onnxruntime-node/-/onnxruntime-node-1.24.3.tgz");
  assert.equal(applyMirror("https://example.com/x.tgz", "https://mirror/"), "https://example.com/x.tgz");
});

test("downloadRuntime：走网络取件、校验、按 rel 落盘，产出能通过结构检查的 payload", async () => {
  const set = standardSet("http://127.0.0.1:0");
  const srv = await serve(set.files);
  const packages = set.packages.map((p) => ({ ...p, tarball: p.tarball.replace("127.0.0.1:0", `127.0.0.1:${new URL(srv.base).port}`) }));
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-dl-"));
  try {
    const result = await downloadRuntime({ manifest: manifestFor(packages), runtimeDir });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.totals.fromNetwork, 3);
    assert.equal(result.totals.fromLocal, 0);
    assert.equal(result.manifest.procedure, "downloaded");
    // 落盘位置必须与 adopt 的镜像布局一致，否则 loader 找不到入口。
    const report = describePayload(result.payloadDir);
    assert.equal(report.ok, true, `missing=${report.missing} reasons=${report.reasons}`);
    assert.equal(report.version, "4.2.0");
    const entry = join(result.payloadDir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs");
    assert.equal(readFileSync(entry, "utf8"), "export const x = 1;\n");
  } finally {
    await srv.close();
  }
});

test("downloadRuntime：sha512 不匹配即失败，且不留下半份 payload", async () => {
  const set = standardSet("http://127.0.0.1:0");
  const srv = await serve(set.files);
  const port = new URL(srv.base).port;
  const packages = set.packages.map((p) => ({ ...p, tarball: p.tarball.replace("127.0.0.1:0", `127.0.0.1:${port}`) }));
  // 篡改第二个包的期望哈希：它永远对不上。
  packages[1] = { ...packages[1], integrity: `sha512-${sha512Base64(Buffer.from("not the tarball"))}` };
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-dl-"));
  try {
    const result = await downloadRuntime({ manifest: manifestFor(packages), runtimeDir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /sha512 与清单不符/);
    // 半份 payload 比没有更糟：目录必须被清掉。
    assert.equal(readdirCount(runtimeDir), 0, "校验失败后不该留下任何 payload 目录");
  } finally {
    await srv.close();
  }
});

test("downloadRuntime：首次被掐断后用 Range 续传成功（不从头再来）", async () => {
  const set = standardSet("http://127.0.0.1:0");
  const srv = await serve(set.files, { cutFirst: "/onnx.tgz" });
  const port = new URL(srv.base).port;
  const packages = set.packages.map((p) => ({ ...p, tarball: p.tarball.replace("127.0.0.1:0", `127.0.0.1:${port}`) }));
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-dl-"));
  try {
    const result = await downloadRuntime({ manifest: manifestFor(packages), runtimeDir });
    assert.equal(result.ok, true, result.reason);
    // 关键证据：第二次请求带了 Range —— 说明是续传而不是重来。
    assert.match(String(srv.seen.rangeHeader), /^bytes=\d+-$/, `续传请求应当带 Range，实际=${srv.seen.rangeHeader}`);
    assert.equal(describePayload(result.payloadDir).ok, true);
  } finally {
    await srv.close();
  }
});

test("downloadRuntime：归档里的 ../ 越界路径必须整次失败，且不能写出目录之外", async () => {
  const evil = makeTgz([
    { path: "package.json", body: JSON.stringify({ name: "evil", version: "1.0.0" }) },
    { path: "../../escaped.txt", body: "pwned\n" }
  ], { prefix: "package/" });
  const srv = await serve({ "/evil.tgz": evil });
  const port = new URL(srv.base).port;
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-dl-"));
  const manifest = manifestFor([
    { name: "evil", version: "1.0.0", rel: "evil", integrity: `sha512-${sha512Base64(evil)}`, tarball: `${srv.base}/evil.tgz` }
  ]);
  try {
    const result = await downloadRuntime({ manifest, runtimeDir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /越出包目录|sha512|校验|失败/);
    assert.equal(existsSync(join(runtimeDir, "..", "escaped.txt")), false, "不能把外来归档的越界路径写出去");
    assert.equal(readdirCount(runtimeDir), 0, "失败后不该留下半份 payload");
  } finally {
    await srv.close();
    void port;
  }
});

test("downloadRuntime：清单里没有本机平台条目时给出可读原因", async () => {
  const result = await downloadRuntime({
    manifest: manifestFor([], { platform: "plan9", arch: "mips" }),
    runtimeDir: mkdtempSync(join(tmpdir(), "mneme-dl-")),
    platform: "win32",
    arch: "x64"
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有 win32-x64 的条目/);
});

test("downloadRuntime：本地 tarball 目录优先于网络，且目标已存在时默认拒绝", async () => {
  const tgz = makePackageTgz("sharp");
  const localDir = mkdtempSync(join(tmpdir(), "mneme-tgz-"));
  const rel = "sharp";
  // 名字用 npm 约定：<basename>-<version>.tgz —— npm pack 出来的东西直接丢进去就能用。
  assert.equal(localTarballPath(localDir, { name: "sharp", version: "1.0.0" }), join(localDir, "sharp-1.0.0.tgz"));
  writeFileSync(join(localDir, "sharp-1.0.0.tgz"), tgz);

  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-dl-"));
  const manifest = manifestFor([
    { name: "sharp", version: "1.0.0", rel, integrity: `sha512-${sha512Base64(tgz)}`, tarball: "https://registry.npmjs.org/sharp/-/sharp-1.0.0.tgz" }
  ]);
  // 不给 fetch：只要它去联网就会炸，从而证明这次确实走的是本地文件。
  const first = await downloadRuntime({
    manifest,
    runtimeDir,
    localTarballDir: localDir,
    fetchImpl: () => { throw new Error("不该联网"); }
  });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.totals.fromLocal, 1);
  assert.equal(first.totals.fromNetwork, 0);

  const again = await downloadRuntime({ manifest, runtimeDir, localTarballDir: localDir });
  assert.equal(again.ok, false);
  assert.match(again.reason, /目标已存在/);
  const forced = await downloadRuntime({ manifest, runtimeDir, localTarballDir: localDir, overwrite: true });
  assert.equal(forced.ok, true, forced.reason);
});

/** 运行时根目录下现有的目录数（用来断言「失败后没留下半份 payload」）。 */
function readdirCount(dir) {
  return existsSync(dir) ? readdirSync(dir).length : 0;
}
