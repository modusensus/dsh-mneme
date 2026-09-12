import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { adoptHostRuntime, hostModulesDir, provisionRuntime } from "../src/runtime/provision.js";
import { makeEmptyModules, makeSourceModules } from "./helpers/runtime-source.js";

// PR-C：面板「一键收编」的服务层。守两件事：
//   ① 源目录由插件自身路径推出 —— 面板不传参，也不把「从任意目录收编」变成对外能力；
//   ② ok 必须同时看「结构完整」与「闭包无缺口」—— 与 CLI 退出码同一条判据，
//      否则面板会把「入口一 import 就炸」的收编显示成成功。

test("hostModulesDir：从插件自身位置往上三级就是宿主 node_modules", () => {
  const fake = pathToFileURL(
    join(tmpdir(), "proj", "node_modules", "@modusensus", "dsh-mneme", "lib", "api.js")
  ).href;
  assert.equal(hostModulesDir(fake), join(tmpdir(), "proj", "node_modules"));
});

test("adoptHostRuntime：源里没有入口包时返回失败结论，不抛异常（曾经抛 TypeError）", () => {
  const src = makeEmptyModules();
  const result = adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /入口包/);
});

test("adoptHostRuntime：闭包缺件必须 ok:false（结构通过不等于可用）", () => {
  const src = makeSourceModules({ withMissingDep: true });
  const result = adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.gaps, ["definitely-not-installed-pkg"]);
  // 结构检查本身是通过的 —— 缺口只有闭包计划知道，这正是要守的那条缝。
  assert.deepEqual(result.missing, []);
  assert.equal(result.packages, 3);
});

test("adoptHostRuntime：闭包完整时报出结论与规模", () => {
  const src = makeSourceModules();
  const result = adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "adopted");
  assert.match(result.payloadId, /^transformers-4\.2\.0-node-/);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.packages, 3);
  assert.ok(result.files > 0 && result.bytes > 0);
  assert.ok(["hardlink", "copy", "mixed"].includes(result.materialize), result.materialize);
});

test("adoptHostRuntime：目标已存在默认不覆盖，带 overwrite 才重建（面板据此区分「缺」与「坏」）", () => {
  const src = makeSourceModules();
  assert.equal(adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir }).ok, true);

  const again = adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir });
  assert.equal(again.ok, false);
  assert.match(again.reason, /目标已存在/);

  const forced = adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir, overwrite: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
});

test("provisionRuntime：本机有可收编的源时走收编，不联网", async () => {
  const src = makeSourceModules();
  const result = await provisionRuntime({
    hostModulesDir: src.nm,
    runtimeDir: src.runtimeDir,
    // 一旦它去下载就会命中这个必抛的 fetch —— 从而证明这次确实没有联网。
    fetchImpl: () => {
      throw new Error("不该联网");
    }
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.strategy, "adopt", "有源时应当走收编而不是下载");
  assert.ok(result.packages > 0);
});

test("adoptHostRuntime：收编结果不完整时也必须带 reason（不能是 undefined）", () => {
  const src = makeSourceModules({ withMissingDep: true });
  const result = adoptHostRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir });
  assert.equal(result.ok, false);
  assert.equal(result.status, "incomplete");
  // 评审指出的正是这条：缺 reason 时，给用户的话会变成「收编失败：undefined」。
  assert.match(result.reason, /收编结果不完整/);
  assert.match(result.reason, /缺依赖/);
});

test("provisionRuntime：同一个目录的不同写法必须共用一把锁（否则仍会被并发写）", async () => {
  const src = makeSourceModules();
  // 尾部分隔符是最常见的等价写法（配置里手填、或别处 join 出来的形态）；
  // 归一化之前它与 src.runtimeDir 是两个键，于是第二次会重跑一遍收编，
  // 撞上「目标已存在」—— 用户看到的是「取件失败」，而不是接上正在进行的那次。
  const sameDirOtherSpelling = src.runtimeDir + sep;
  const [a, b] = await Promise.all([
    provisionRuntime({ hostModulesDir: src.nm, runtimeDir: src.runtimeDir }),
    provisionRuntime({ hostModulesDir: src.nm, runtimeDir: sameDirOtherSpelling })
  ]);
  assert.equal(a.ok, true, a.reason);
  assert.equal(a, b, "等价路径应当复用同一次取件（同一个结论对象）");
});
