import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROBE_TEXTS, defaultEngine, verifyFunctional, verifyPayload } from "../lib/runtime/verify.js";
import { TRANSFORMERS_ENTRY } from "../lib/runtime/layout.js";

// 验证三件套（issue #131 / PR-A）。重点不是「能跑通」，而是「坏的那几种能被抓住」：
// 结构对但原生二进制与本机不匹配、返回非归一化向量、向量退化、加载直接抛——
// 这些都必须变成一条可读的失败结论，而不是让调用方拿到一个假的 ok。

/** 造一个结构上合法的 payload（只有形状，没有真东西）。 */
function makePayload({ platform = "win32", arch = "x64", withEntry = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-verify-"));
  const write = (rel, body) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  for (const name of ["@huggingface/transformers", "onnxruntime-node", "sharp"]) {
    write(join("node_modules", name, "package.json"), JSON.stringify({ name, version: name === "@huggingface/transformers" ? "4.2.0" : "1.0.0" }));
  }
  if (withEntry) write(TRANSFORMERS_ENTRY, "export const x = 1;\n");
  mkdirSync(join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6", platform, arch), { recursive: true });
  return dir;
}

/** 归一化的假向量：`rows` 行，每行 dim 维，方向由 seed 决定。 */
function fakeRows(rows, dim, seed = 0) {
  return Array.from({ length: rows }, (_, r) => {
    const v = Array.from({ length: dim }, (_, i) => Math.sin((i + 1) * (r + 1 + seed)));
    const length = Math.hypot(...v);
    return v.map((x) => x / length);
  });
}

/** 注入一个「什么都能返回」的 engine。 */
function engineReturning(value) {
  return async () => async () => value;
}

test("功能验证：正常的向量通过，并报出维度与耗时", async () => {
  const result = await verifyFunctional("/whatever", { engine: engineReturning(fakeRows(2, 512)) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.dim, 512);
  assert.equal(result.rows, 2);
  assert.ok(result.elapsedMs >= 0);
});

test("功能验证：行数不符要报出来（而不是只取第一行当作通过）", async () => {
  const result = await verifyFunctional("/whatever", { engine: engineReturning(fakeRows(1, 512)) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /返回行数不符/);
});

test("功能验证：非归一化向量要报出来（说明 normalize 没生效）", async () => {
  const rows = fakeRows(2, 8).map((row) => row.map((x) => x * 3));
  const result = await verifyFunctional("/whatever", { engine: engineReturning(rows) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /不是 L2 归一化/);
});

test("功能验证：向量退化成同一方向要报出来", async () => {
  const one = fakeRows(1, 16)[0];
  const result = await verifyFunctional("/whatever", { engine: engineReturning([one, one]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /嵌入退化/);
});

test("功能验证：加载失败与推理失败分别给出不同措辞", async () => {
  const loadFail = await verifyFunctional("/whatever", {
    engine: async () => {
      throw new Error("Cannot find package 'onnxruntime-node'");
    }
  });
  assert.equal(loadFail.ok, false);
  assert.match(loadFail.reason, /加载运行时失败/);
  assert.match(loadFail.reason, /onnxruntime-node/);

  const embedFail = await verifyFunctional("/whatever", {
    engine: async () => async () => {
      throw new Error("boom");
    }
  });
  assert.equal(embedFail.ok, false);
  assert.match(embedFail.reason, /推理失败/);
});

test("功能验证：返回空向量要报出来，而不是当成 dim=0 通过", async () => {
  const result = await verifyFunctional("/whatever", { engine: engineReturning([[], []]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /空向量/);
});

test("三件套：结构不过就不再做功能验证（省掉一次无谓的加载）", async () => {
  const dir = makePayload({ withEntry: false });
  let engineCalled = false;
  const result = await verifyPayload(dir, {
    platform: "win32",
    arch: "x64",
    engine: async () => {
      engineCalled = true;
      return async () => fakeRows(2, 8);
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.functional.ok, false);
  assert.match(result.functional.reason, /跳过功能验证/);
  assert.equal(engineCalled, false);
});

test("三件套：结构 + 功能都过、完整性缺失时如实标 unverified 且不判定失败", async () => {
  const dir = makePayload();
  const result = await verifyPayload(dir, {
    platform: "win32",
    arch: "x64",
    engine: engineReturning(fakeRows(2, 8))
  });
  assert.equal(result.ok, true);
  assert.equal(result.integrity.status, "unverified");
  assert.equal(result.integrity.ok, true);
  assert.equal(result.version, "4.2.0");
});

test("三件套：--strict 场景下哈希不匹配即整体不通过", async () => {
  const dir = makePayload();
  const matched = await verifyPayload(dir, {
    platform: "win32",
    arch: "x64",
    engine: engineReturning(fakeRows(2, 8)),
    integrity: { status: "sha512-matched", detail: "tarball 比对通过" }
  });
  assert.equal(matched.ok, true);
  assert.equal(matched.integrity.status, "sha512-matched");

  const mismatch = await verifyPayload(dir, {
    platform: "win32",
    arch: "x64",
    engine: engineReturning(fakeRows(2, 8)),
    integrity: { status: "sha512-mismatch", detail: "与钉死的哈希不一致" }
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.structural.ok, true, "结构仍然是对的，失败来自完整性");
  assert.equal(mismatch.functional.ok, true);
});

test("假通过防线 ①：行不是数组时返回失败，而不是抛异常", async () => {
  // 契约是「任何失败都返回结果对象，不抛」；非数组行会让 .length/.some 直接抛。
  const dir = makePayload();
  const result = await verifyPayload(dir, {
    platform: "win32",
    arch: "x64",
    engine: engineReturning([null, null])
  });
  assert.equal(result.ok, false);
  assert.match(result.functional.reason, /不是数组/);
});

test("假通过防线 ②：非有限数值必须判失败（NaN 的比较恒为 false，会静默通过）", async () => {
  const dir = makePayload();
  for (const bad of [[NaN, 0], [Infinity, 0], ["0.5", "0.5"]]) {
    const result = await verifyPayload(dir, {
      platform: "win32",
      arch: "x64",
      engine: engineReturning([bad, [0, 0]])
    });
    assert.equal(result.ok, false, `含 ${JSON.stringify(bad)} 的向量不该被判通过`);
    assert.match(result.functional.reason, /非有限数值/);
  }
});

test("默认 engine 是导出的函数，且探针文本固定（改它等于改验收标准）", () => {
  assert.equal(typeof defaultEngine, "function");
  assert.deepEqual(DEFAULT_PROBE_TEXTS, ["猫咪喜欢晒太阳", "the quick brown fox"]);
});
