import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeLocalRuntime, loadTransformers, publicRuntimeStatus, resolveRuntimeEntry } from "../lib/runtime/loader.js";
import { TRANSFORMERS_ENTRY, defaultRuntimeDir, payloadDir, payloadId } from "../lib/runtime/layout.js";

// 三层解析（issue #131 / PR-A）。这里守的是两条容易出错的承诺：
//   ① 自管运行时优先，且能用绝对 file URL 真的加载起来；
//   ② 降级路径不许静默 —— 「自管那份坏了」和「本机根本没有」必须能分辨。
// 第 ② 层（宿主裸 specifier）是 PR-A 期间老用户不断线的保障，必须真的会退回去。

/** 造一份结构合法的 payload。 */
function makePayload(runtimeDir, { version = "4.2.0", platform = "win32", arch = "x64", withEntry = true } = {}) {
  const dir = payloadDir(runtimeDir, payloadId({ version, platform, arch: "x64" }));
  const write = (rel, body) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  for (const name of ["@huggingface/transformers", "onnxruntime-node", "sharp"]) {
    write(join("node_modules", name, "package.json"), JSON.stringify({ name, version: name === "@huggingface/transformers" ? version : "1.0.0" }));
  }
  if (withEntry) write(TRANSFORMERS_ENTRY, "export const source = 'runtime';\n");
  mkdirSync(join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6", platform, arch), { recursive: true });
  return dir;
}

const emptyRuntime = () => mkdtempSync(join(tmpdir(), "mneme-loader-rt-"));

test("第 ① 层：自管运行时可用时优先用它，并报出来源与 payloadId", async () => {
  const runtimeDir = emptyRuntime();
  const dir = makePayload(runtimeDir);
  const loaded = await loadTransformers({
    runtimeDir,
    platform: "win32", arch: "x64",
    importModule: async (specifier) => ({ loadedFrom: specifier })
  });
  assert.equal(loaded.source, "runtime");
  assert.equal(loaded.payloadId, "transformers-4.2.0-node-win32-x64");
  assert.equal(loaded.version, "4.2.0");
  assert.ok(loaded.entryUrl.startsWith("file:///"), "必须是绝对 file URL，否则内部裸导入解析不到同目录的包");
  // 断言「URL 反解回来就是那个入口文件」，而不是拿 URL 字符串去 includes 一个 OS 路径字符串：
  // 后者会被 pathToFileURL 的百分号编码打败（路径含空格等字符时必误报，实测 CI Windows 上就挂了）。
  assert.equal(
    fileURLToPath(loaded.entryUrl),
    join(dir, TRANSFORMERS_ENTRY),
    `entryUrl=${loaded.entryUrl} dir=${dir}`
  );
});

test("第 ② 层：没有自管运行时时退回宿主裸 specifier（PR-A 期间老用户靠这层不断线）", async () => {
  const seen = [];
  const loaded = await loadTransformers({
    runtimeDir: emptyRuntime(),
    importModule: async (specifier) => {
      seen.push(specifier);
      return { loadedFrom: specifier };
    }
  });
  assert.equal(loaded.source, "host");
  assert.deepEqual(seen, ["@huggingface/transformers"]);
});

test("降级不许静默：自管那份坏了要回调出来，同时仍然退到宿主", async () => {
  const runtimeDir = emptyRuntime();
  makePayload(runtimeDir);
  const failures = [];
  const loaded = await loadTransformers({
    runtimeDir,
    platform: "win32", arch: "x64",
    onFailure: (m) => failures.push(m),
    importModule: async (specifier) => {
      if (specifier.startsWith("file:///")) throw new Error("Cannot find package 'onnxruntime-node'");
      return { loadedFrom: "host" };
    }
  });
  assert.equal(loaded.source, "host");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /自管运行时 transformers-4.2.0-node-win32-x64 加载失败/);
  assert.match(failures[0], /onnxruntime-node/);
});

test("第 ③ 层：两层都没有时给出可操作提示，并列出每一层为什么失败", async () => {
  const runtimeDir = emptyRuntime();
  makePayload(runtimeDir);
  await assert.rejects(
    () =>
      loadTransformers({
        runtimeDir,
        platform: "win32", arch: "x64",
        importModule: async (specifier) => {
          throw new Error(specifier.startsWith("file:///") ? "payload broken" : "Cannot find module");
        }
      }),
    (error) => {
      assert.equal(error.code, "MNEME_RUNTIME_UNAVAILABLE");
      assert.match(error.message, /本地推理运行时不可用/);
      assert.match(error.message, /mneme-runtime\.mjs/, "提示要指向真实存在的入口，而不是一个不存在的子命令");
      // 提示里给的入口脚本必须真的存在。这条踩过：提示指向了一个并不存在的子命令，
      // 用户照着敲只会得到「command not found」，比不给提示更糟。
      const script = /node "([^"]+mneme-runtime\.mjs)"/.exec(error.message);
      assert.ok(script, "提示要带出入口脚本的绝对路径");
      assert.ok(existsSync(script[1]), `提示指向的脚本不存在：${script[1]}`);
      assert.match(error.message, /adopt --from/, "要给出可执行的下一步，而不是一句 module not found");
      assert.match(error.message, /payload broken/, "自管那层的失败原因要带出来");
      assert.match(error.message, /Cannot find module/, "宿主那层的失败原因也要带出来");
      assert.equal(error.failures.length, 2);
      return true;
    }
  );
});

test("resolveRuntimeEntry：跳过结构不合法的 payload，取到可用的那份；全不合规则返回 null", () => {
  const runtimeDir = emptyRuntime();
  makePayload(runtimeDir, { version: "4.2.0", withEntry: false }); // 缺入口 → 不合法
  assert.equal(resolveRuntimeEntry({ runtimeDir, platform: "win32", arch: "x64" }), null, "结构不合法的不能被选中");

  makePayload(runtimeDir, { version: "4.3.0" });
  const picked = resolveRuntimeEntry({ runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(picked.payloadId, "transformers-4.3.0-node-win32-x64");
  assert.equal(picked.version, "4.3.0");
});

test("resolveRuntimeEntry：运行时根目录不存在时返回 null（不是抛错）", () => {
  assert.equal(resolveRuntimeEntry({ runtimeDir: join(tmpdir(), "mneme-nope-" + Date.now()), platform: "win32", arch: "x64" }), null);
});

test("publicRuntimeStatus：只放行白名单字段，绝对路径与原始错误一律不进 HTTP", () => {
  // /api/dsh-mneme/semantic 是刻意不鉴权的只读端点。完整状态里有 runtimeDir（绝对路径）、
  // hint（内嵌脚本绝对路径）以及 reason/reasons（原始错误文本里带完整文件路径），
  // 发给任何能连上该端口的人就是信息泄漏（CWE-200）。用精确白名单守住这件事：
  // 将来谁往里加字段，这条测试就会红。
  const EXPECTED = ["functional", "integrity", "materialize", "payloadId", "procedure", "status", "version"];

  const missing = describeLocalRuntime({ runtimeDir: join(tmpdir(), `mneme-secret-${Date.now()}`), platform: "win32", arch: "x64" });
  const pubMissing = publicRuntimeStatus(missing);
  assert.deepEqual(Object.keys(pubMissing).sort(), EXPECTED);
  assert.equal(pubMissing.status, "missing");
  // 完整状态里确实带着这些敏感字段 —— 否则这条测试就没在测东西。
  assert.ok(missing.runtimeDir.startsWith(tmpdir()));
  assert.ok(missing.hint.includes("mneme-runtime.mjs"));

  const runtimeDir = emptyRuntime();
  const dir = makePayload(runtimeDir);
  writeFileSync(join(dir, "mneme-runtime.json"), JSON.stringify({ procedure: "adopted", materialize: { mode: "hardlink" } }));
  const pubAvailable = publicRuntimeStatus(describeLocalRuntime({ runtimeDir, platform: "win32", arch: "x64" }));
  assert.deepEqual(Object.keys(pubAvailable).sort(), EXPECTED);
  assert.equal(pubAvailable.status, "available");
  assert.equal(pubAvailable.payloadId, "transformers-4.2.0-node-win32-x64");
  assert.equal(pubAvailable.procedure, "adopted");
  assert.equal(pubAvailable.materialize, "hardlink");
  // 整份投影里不能出现本机路径的任何形态。
  const text = JSON.stringify(pubAvailable);
  assert.equal(text.includes(runtimeDir), false);
  assert.equal(text.includes(runtimeDir.replace(/\\/g, "/")), false);
});

test("describeLocalRuntime：可用时报出 payload 与来源，且不假装验过", () => {
  const runtimeDir = emptyRuntime();
  const dir = makePayload(runtimeDir);
  // 收编来的 payload 会带一份清单，验证来源/物化方式确实被带出来。
  writeFileSync(
    join(dir, "mneme-runtime.json"),
    JSON.stringify({ procedure: "adopted", materialize: { mode: "hardlink" } })
  );
  const report = describeLocalRuntime({ runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(report.status, "available");
  assert.equal(report.payloadId, "transformers-4.2.0-node-win32-x64");
  assert.equal(report.version, "4.2.0");
  assert.equal(report.procedure, "adopted");
  assert.equal(report.materialize, "hardlink");
  // 结构检查是 GET 端点能负担的；功能验证要真加载原生模块跑推理，状态探针不做 ——
  // 如实说「不知道」，而不是把「文件都在」说成「验过了」。
  assert.equal(report.functional, "unknown");
  assert.equal(report.integrity, "unverified");
  assert.match(report.hint, /mneme-runtime\.mjs/);
});

test("describeLocalRuntime：没有 payload 时报 missing，而不是报坏掉", () => {
  const report = describeLocalRuntime({ runtimeDir: emptyRuntime(), platform: "win32", arch: "x64" });
  assert.equal(report.status, "missing");
});

test("describeLocalRuntime：有目录但缺件时报 broken 并点名缺了什么", () => {
  const runtimeDir = emptyRuntime();
  makePayload(runtimeDir, { withEntry: false });
  const report = describeLocalRuntime({ runtimeDir, platform: "win32", arch: "x64" });
  assert.equal(report.status, "broken");
  assert.deepEqual(report.missing, [TRANSFORMERS_ENTRY]);
});

test("describeLocalRuntime：空 runtimeDir 走默认目录，不能把空串当相对路径", () => {
  // 配置项 runtimeDir 的默认值就是空串。原样传下去 readdirSync("") 会失败，
  // 「没配」会被误报成「坏了」—— 这条守的就是它。
  const report = describeLocalRuntime({ runtimeDir: "  ", platform: "win32", arch: "x64" });
  assert.equal(report.runtimeDir, defaultRuntimeDir());
  assert.ok(isAbsolute(report.runtimeDir));
  assert.notEqual(report.status, "unreadable");
});
