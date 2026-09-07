// 发布前校验 src/ 与 lib/ 一致性。
//
// npm 包实际加载 lib/（package main → lib/index.js），而 root 层 `npm publish`
// 不触发 dsh-mneme/ 的 prepack → sync 同步。历史教训：PR #60 只改了 src 忘了同步
// lib，v0.7.8 发出去的 npm 包跑的还是旧代码（issue #65）。此脚本让这类漂移在发布时
// 直接 fail，而不是带着旧产物上线。
//
// 用法：node scripts/check-sync.js （root package.json 的 prepack 钩子自动调用）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url))); // dsh-mneme/
const srcDir = join(root, "src");
const libDir = join(root, "lib");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const bad = [];
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const dest = join(libDir, rel);
  if (!existsSync(dest)) {
    bad.push(`missing  lib/${rel}`);
  } else if (!readFileSync(file).equals(readFileSync(dest))) {
    bad.push(`differ   lib/${rel}`);
  }
}
if (bad.length) {
  console.error(`✗ src/ 与 lib/ 不一致（${bad.length} 处）——npm 包实际加载 lib/，请先 npm run sync 并提交：`);
  for (const line of bad) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`✓ src/ 与 lib/ 一致（${walk(srcDir).length} 个文件）`);
