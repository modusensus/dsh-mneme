import test from "node:test";
import assert from "node:assert/strict";

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
