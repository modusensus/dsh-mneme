// 发版流水线的徽章对齐（release.yml 的 badge job 调用；手动可跑 npm run badge:sync）。
//
// 做三件事：
//   1. 跑一遍全量测试（npm test），取最后的 `pass N` 汇总数；
//   2. 把双 README 的 tests 徽章（img.shields.io/badge/tests-N%20passed）与
//      开发命令注释（# N 个测试 / # N tests）刷成该数字；
//   3. 有变化就写回文件（由调用方决定是否 commit/push），无变化静默退出。
//
// 测试失败（fail>0 或进程非零退出）时以非零退出且不改任何文件——徽章永远
// 不可能指向一次没跑绿的套件。历史版本表里的「N 测试全绿」是各版本当时的
// 真实记录，刻意不在替换范围内（正则只打徽章与 `#` 注释两种形状）。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

// 1) 全量测试
let output;
try {
  output = execSync("npm test", {
    cwd: join(repoRoot, "dsh-mneme"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
} catch (error) {
  const tail = String(error.stdout ?? "").split("\n").slice(-25).join("\n");
  console.error("npm test 未跑绿，徽章不更新：\n" + tail);
  process.exit(1);
}

// 2) 取汇总 pass 数（spec reporter 的 `ℹ pass N`；取最后一处防逐用例行干扰）
const matches = [...output.matchAll(/pass (\d+)/g)];
const pass = matches.length ? Number(matches[matches.length - 1][1]) : 0;
if (!pass) {
  console.error("无法从测试输出解析 pass 数，徽章不更新");
  process.exit(1);
}

// 3) 刷双 README（徽章 + 两行开发命令注释）
const targets = [
  join(repoRoot, "README.md"),
  join(repoRoot, "dsh-mneme", "README.md")
];
let changed = 0;
for (const file of targets) {
  let text = readFileSync(file, "utf8");
  const next = text
    .replace(/tests-\d+%20passed-/g, `tests-${pass}%20passed-`)
    .replace(/(#\s*)\d+( 个测试)/g, `$1${pass}$2`)
    .replace(/(#\s*)\d+( tests)/g, `$1${pass}$2`);
  if (next !== text) {
    writeFileSync(file, next);
    changed += 1;
    console.log(`updated: ${file}`);
  }
}
console.log(`pass=${pass}, files changed=${changed}`);
