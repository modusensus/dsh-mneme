import test from "node:test";
import assert from "node:assert/strict";
import { makeEmptyModules, makeSourceModules } from "./helpers/runtime-source.js";

// 这个 CLI 脚本原先不在任何测试覆盖里：USAGE 模板字面量里多一个反引号就能让它整体语法错误，
// 而 CI 依然全绿 —— package.json 的 `test` 只跑 test/*.test.js，从不碰 scripts/。踩过一次。
//
// 这里动态 import 它：解析与求值都会真的发生，任何语法错都会让下面的测试直接炸。
// 脚本侧有 invokedDirectly 守卫，所以 import 不会顺带跑起 CLI。
const cli = await import("../scripts/mneme-runtime.mjs");

test("CLI 脚本能被解析并求值（语法错必须在这里现形，而不是发布出去）", () => {
  assert.equal(typeof cli.main, "function");
  assert.equal(typeof cli.parseArgs, "function");
  assert.equal(typeof cli.UsageError, "function");
});

test("CLI：--key value 与 --flag 各自解析正确", () => {
  assert.deepEqual(cli.parseArgs(["--runtime", "/rt", "--from", "/nm", "--json"]), {
    runtime: "/rt",
    from: "/nm",
    json: true
  });
  assert.deepEqual(cli.parseArgs(["--overwrite"]), { overwrite: true });
  assert.deepEqual(cli.parseArgs([]), {});
});

test("CLI：带值选项缺值必须是用法错误 —— 不能把 \"true\" 当路径用下去", () => {
  for (const key of ["runtime", "from", "cache-dir"]) {
    assert.throws(() => cli.parseArgs([`--${key}`]), cli.UsageError, `--${key} 缺值应当报用法错误`);
    // 后面紧跟另一个选项同样算缺值：不能把这个选项吞成上一个选项的值。
    assert.throws(() => cli.parseArgs([`--${key}`, "--json"]), cli.UsageError, `--${key} 后接选项也算缺值`);
  }
});

test("CLI：未知选项立刻报错，而不是静默忽略（打错字要立刻可见）", () => {
  assert.throws(() => cli.parseArgs(["--runtim", "/rt"]), cli.UsageError);
  assert.throws(() => cli.parseArgs(["-h"]), cli.UsageError);
  assert.throws(() => cli.parseArgs(["/rt"]), cli.UsageError);
});

/** 捕获 console.log，用来断言 CLI 打印给用户的那几行。 */
async function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), text: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

/**
 * 可收编源的夹具有两处要用（这里与 test/runtime-adopt-service.test.js），
 * 所以放在 test/helpers/runtime-source.js —— 两份漂移过一次就会有两种结论。
 */

test("CLI adopt：源里没有入口包时给出干净原因，不能抛 TypeError（评审阻塞项）", async () => {
  const src = makeEmptyModules();
  // 修之前这里会抛：adoptRuntime 失败时不带 payloadDir，却被当成路径喂给 describePayload。
  const { value, text } = await captureLog(() =>
    cli.runAdopt({ runtimeDir: src.runtimeDir, asJson: false, options: { from: src.nm } })
  );
  assert.equal(value, 1);
  assert.match(text, /收编失败：/, `应当打印干净原因，实际输出：${text}`);
  assert.match(text, /入口包/);
});

test("CLI adopt：必需传递依赖缺口必须让退出码变红（评审阻塞项）", async () => {
  const src = makeSourceModules({ withMissingDep: true });
  const { value, text } = await captureLog(() =>
    cli.runAdopt({ runtimeDir: src.runtimeDir, asJson: false, options: { from: src.nm } })
  );
  // 结构检查会「通过」——它只看三个必需包；缺口只有闭包计划知道。
  assert.match(text, /结构检查：通过/);
  assert.match(text, /缺失依赖：definitely-not-installed-pkg/);
  assert.match(text, /闭包完整性：未通过/);
  assert.equal(value, 1, "闭包缺件时退出码必须是 1，否则脚本化 gate 会在最需要它的时候误报健康");
});

test("CLI adopt：闭包完整时仍然报 0（防止上面那条修复过度触发）", async () => {
  const src = makeSourceModules();
  const { value, text } = await captureLog(() =>
    cli.runAdopt({ runtimeDir: src.runtimeDir, asJson: false, options: { from: src.nm } })
  );
  assert.match(text, /结构检查：通过/);
  assert.equal(value, 0, text);
});
