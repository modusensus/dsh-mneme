import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_PACKAGES, matchesPlatform, planClosure, resolvePackageDir } from "../lib/runtime/closure.js";

// 依赖闭包遍历（issue #131 / PR-A）：守住四条判据——按源布局镜像、平台过滤、
// 可选依赖缺失不算错、peer 不进闭包。它是 adopt / export 的共同地基，
// 走错一步就会把宿主整棵树拖进来（或漏带一个真需要的包）。

/** 从 rel 路径推导包名（处理 scope 与嵌套 node_modules）。 */
function nameFromRel(rel) {
  const parts = rel.split("/");
  const i = parts.lastIndexOf("node_modules");
  return (i === -1 ? parts : parts.slice(i + 1)).join("/");
}

/** 按紧凑的 spec 造一棵假的 node_modules 树。 */
function makeTree(spec) {
  const base = mkdtempSync(join(tmpdir(), "mneme-closure-"));
  // 刻意多套一层 proj/：这样「不允许解析越出源树」这条判据才测得出来
  // （源树的上一级就是 base，base/node_modules 里的包必须解析不到）。
  const nm = join(base, "proj", "node_modules");
  mkdirSync(nm, { recursive: true });
  for (const [rel, def = {}] of Object.entries(spec)) {
    const dir = join(nm, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: def.name ?? nameFromRel(rel),
        version: def.version ?? "1.0.0",
        ...(def.deps ? { dependencies: def.deps } : {}),
        ...(def.optional ? { optionalDependencies: def.optional } : {}),
        ...(def.peers ? { peerDependencies: def.peers } : {}),
        ...(def.os ? { os: def.os } : {}),
        ...(def.cpu ? { cpu: def.cpu } : {})
      })
    );
  }
  return { base, nm };
}

/**
 * 一份贴近真实的树：transformers 是入口，它同时带 onnxruntime-node（多平台单包）、
 * onnxruntime-web（自带一份不同版本的 onnxruntime-common）、sharp（平台分片走
 * optionalDependencies），外加 peer、环、缺件四种边界。
 */
function realisticTree() {
  return makeTree({
    "@huggingface/transformers": {
      version: "4.2.0",
      deps: {
        "onnxruntime-node": "1.24.3",
        "onnxruntime-web": "1.26.0-dev",
        sharp: "^0.34.5",
        "@huggingface/tokenizers": "^0.1.3",
        "@huggingface/jinja": "^0.5.6",
        "darwin-only-pkg": "1.0.0"
      },
      peers: { "@deepseek-ai/cordis": "^4.0.1" }
    },
    "onnxruntime-node": { version: "1.24.3", deps: { "onnxruntime-common": "1.24.3", "adm-zip": "^0.5.16" } },
    "onnxruntime-web": {
      version: "1.26.0-dev",
      deps: { "onnxruntime-common": "1.24.0-dev" }
    },
    "onnxruntime-web/node_modules/onnxruntime-common": { version: "1.24.0-dev" },
    "onnxruntime-common": { version: "1.24.3" },
    "adm-zip": { deps: { "global-agent": "^3.0.0" } },
    "global-agent": { deps: { "adm-zip": "^0.5.16" } },
    sharp: { version: "0.34.5", optional: { "@img/sharp-win32-x64": "0.34.5", "@img/sharp-darwin-arm64": "0.34.5" } },
    "@img/sharp-win32-x64": { version: "0.34.5", os: ["win32"], cpu: ["x64"] },
    "@img/sharp-darwin-arm64": { version: "0.34.5", os: ["darwin"], cpu: ["arm64"] },
    "@huggingface/tokenizers": { version: "0.1.3", optional: { "not-installed-optional": "^1.0.0" } },
    "@huggingface/jinja": { version: "0.5.6", deps: { "missing-required-thing": "^1.0.0" } },
    "darwin-only-pkg": { os: ["darwin"] },
    // 只在 root 之外存在，用来验证解析不会越出源树
    "@deepseek-ai/cordis": { version: "4.0.2" }
  });
}

test("按源布局镜像：嵌套的那份依赖与原位版本都被保留", () => {
  const { nm } = realisticTree();
  const plan = planClosure({ rootModulesDir: nm, platform: "win32", arch: "x64" });
  const byRel = new Map(plan.packages.map((p) => [p.rel, p]));

  assert.equal(byRel.get("@huggingface/transformers")?.version, "4.2.0");
  assert.equal(byRel.get("onnxruntime-common")?.version, "1.24.3", "顶层那份");
  assert.equal(
    byRel.get("onnxruntime-web/node_modules/onnxruntime-common")?.version,
    "1.24.0-dev",
    "嵌套那份必须按原层级保留，否则解析结果会被悄悄改掉"
  );
  assert.equal(plan.gaps.filter((g) => g.reason === "必需依赖未找到").length, 1);
  assert.deepEqual(plan.gaps[0], { name: "missing-required-thing", from: "@huggingface/jinja", reason: "必需依赖未找到" });
});

test("平台分片包：只带当前平台的，另一个记进 skipped", () => {
  const { nm } = realisticTree();
  const plan = planClosure({ rootModulesDir: nm, platform: "win32", arch: "x64" });
  const rels = plan.packages.map((p) => p.rel);
  assert.ok(rels.includes("@img/sharp-win32-x64"));
  assert.equal(rels.includes("@img/sharp-darwin-arm64"), false, "darwin 分片不该进闭包");
  assert.deepEqual(
    plan.skipped.map((s) => s.rel).sort(),
    ["@img/sharp-darwin-arm64", "darwin-only-pkg"].sort(),
    "两个平台不匹配的包都该被记下来"
  );
  // 交叉验证：换成 darwin/arm64 时，该带的是另外那个。
  const darwin = planClosure({ rootModulesDir: nm, platform: "darwin", arch: "arm64" });
  const darwinRels = darwin.packages.map((p) => p.rel);
  assert.ok(darwinRels.includes("@img/sharp-darwin-arm64"));
  assert.equal(darwinRels.includes("@img/sharp-win32-x64"), false);
});

test("peerDependencies 不进闭包（宿主提供的东西不该被复制进来）", () => {
  const { nm } = realisticTree();
  const plan = planClosure({ rootModulesDir: nm, platform: "win32", arch: "x64" });
  assert.equal(plan.packages.some((p) => p.rel === "@deepseek-ai/cordis"), false);
});

test("可选依赖缺失不算错，必需依赖缺失才记 gap", () => {
  const { nm } = realisticTree();
  const plan = planClosure({ rootModulesDir: nm, platform: "win32", arch: "x64" });
  assert.equal(plan.gaps.some((g) => g.name === "not-installed-optional"), false);
  assert.equal(plan.gaps.filter((g) => g.name === "missing-required-thing").length, 1);
  // 平台分片包在别的平台上缺席，同样不算 gap
  assert.equal(plan.gaps.some((g) => g.name === "@img/sharp-darwin-arm64"), false);
});

test("依赖成环也能终止，且每个包只出现一次", () => {
  const { nm } = realisticTree();
  const plan = planClosure({ rootModulesDir: nm, platform: "win32", arch: "x64" });
  const rels = plan.packages.map((p) => p.rel);
  assert.equal(rels.filter((r) => r === "adm-zip").length, 1);
  assert.equal(rels.filter((r) => r === "global-agent").length, 1);
});

test("条目上限命中时截断并如实上报，不静默丢包", () => {
  const { nm } = realisticTree();
  const plan = planClosure({ rootModulesDir: nm, platform: "win32", arch: "x64", maxPackages: 3 });
  assert.equal(plan.truncated, true);
  assert.equal(plan.packages.length, 3);
  assert.ok(DEFAULT_MAX_PACKAGES >= 100, "默认上限应当足够容纳真实闭包");
});

test("入口包不存在：只记一条 gap，不抛异常", () => {
  const { nm } = makeTree({});
  const plan = planClosure({ rootModulesDir: nm, entry: "@huggingface/transformers" });
  assert.deepEqual(plan.packages, []);
  assert.equal(plan.gaps.length, 1);
  assert.match(plan.gaps[0].reason, /入口包不存在/);
});

test("resolvePackageDir：优先取最近的一层，且绝不越出源树", () => {
  const { nm } = realisticTree();
  const web = join(nm, "onnxruntime-web");
  const nested = resolvePackageDir(web, "onnxruntime-common", nm);
  assert.equal(nested, join(nm, "onnxruntime-web", "node_modules", "onnxruntime-common"), "就近优先");
  assert.equal(resolvePackageDir(web, "adm-zip", nm), join(nm, "adm-zip"), "回退到顶层");
  assert.equal(resolvePackageDir(nm, "definitely-not-there", nm), null);

  // root 之外存在同名包时也不能解析到它——否则闭包就不是自包含的。
  const outside = join(dirname(dirname(nm)), "node_modules", "outside-only-pkg");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "outside-only-pkg", version: "1.0.0" }));
  assert.equal(resolvePackageDir(nm, "outside-only-pkg", nm), null, "源树之外的包不该被解析进来");
});

test("matchesPlatform 支持正向与 `!` 反向两种写法，缺省表示不限", () => {
  assert.equal(matchesPlatform({}, "win32", "x64"), true);
  assert.equal(matchesPlatform({ os: ["win32"] }, "win32", "x64"), true);
  assert.equal(matchesPlatform({ os: ["win32"] }, "darwin", "arm64"), false);
  assert.equal(matchesPlatform({ os: ["!darwin"] }, "win32", "x64"), true);
  assert.equal(matchesPlatform({ os: ["!darwin"] }, "darwin", "arm64"), false);
  assert.equal(matchesPlatform({ cpu: ["x64"] }, "win32", "arm64"), false);
});

test("matchesPlatform：libc 只在确认本机 libc 时才参与判断（拿不到证据就全放行）", () => {
  const musl = { os: ["linux"], cpu: ["x64"], libc: ["musl"] };
  const glibc = { os: ["linux"], cpu: ["x64"], libc: ["glibc"] };
  // 确认了（glibc / musl）就按 libc 排他。
  assert.equal(matchesPlatform(glibc, "linux", "x64", "glibc"), true);
  assert.equal(matchesPlatform(musl, "linux", "x64", "glibc"), false);
  assert.equal(matchesPlatform(musl, "linux", "x64", "musl"), true);
  // 没确认 = 不过滤：宁多下十几兆，也不赌错方向装出一份跑不起来的运行时。
  assert.equal(matchesPlatform(musl, "linux", "x64", null), true);
  assert.equal(matchesPlatform(musl, "linux", "x64"), true);
  // 不带 libc 字段的包（绝大多数）任何情况下都不因此被排除。
  assert.equal(matchesPlatform({ os: ["linux"] }, "linux", "x64", "glibc"), true);
});
