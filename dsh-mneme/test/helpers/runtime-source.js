// test/helpers/runtime-source.js
// 共享的「可收编源」夹具：CLI（scripts/mneme-runtime.mjs 的 adopt）与面板服务层
// （src/runtime/adopt-service.js）两处的测试要造同一棵树。放这里是为了不让两份漂移 ——
// 尤其是闭包必须能解出 onnxruntime-node / sharp，否则测的就不是「收编」这件事了。

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 结构检查点名到「平台 + 架构」，所以夹具必须用本机平台，否则 CI 上必挂。 */
function writeNativeDir(nm) {
  mkdirSync(join(nm, "onnxruntime-node", "bin", "napi-v6", process.platform, process.arch), { recursive: true });
}

/**
 * 造一个最小可收编的 `<tmp>/node_modules`。
 *
 * transformers 必须把 onnxruntime-node / sharp 声明成自己的依赖，闭包计划才会收它们；
 * 否则 payload 里不会有这两个包，结构检查会因为「缺必需包」失败，测的就不是收编了。
 *
 * `withMissingDep: true` 时再声明一个装不上的必需依赖：planClosure 会记一条 gap，
 * 而 describePayload 只看那三个必需包 —— 这正是「结构说通过、闭包其实缺件」的场景。
 * @param {{withMissingDep?: boolean}} [opts] - 选项。
 * @returns {{base: string, nm: string, runtimeDir: string}} 临时根、源 node_modules、空白目标目录。
 */
export function makeSourceModules({ withMissingDep = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "mneme-src-"));
  const nm = join(base, "node_modules");
  const write = (rel, body) => {
    const full = join(nm, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  const dependencies = {
    "onnxruntime-node": "^1.24.3",
    sharp: "^0.34.5",
    ...(withMissingDep ? { "definitely-not-installed-pkg": "^1.0.0" } : {})
  };
  write(
    "@huggingface/transformers/package.json",
    JSON.stringify({ name: "@huggingface/transformers", version: "4.2.0", dependencies })
  );
  write("@huggingface/transformers/dist/transformers.node.mjs", "export const x = 1;\n");
  write("onnxruntime-node/package.json", JSON.stringify({ name: "onnxruntime-node", version: "1.24.3" }));
  write("sharp/package.json", JSON.stringify({ name: "sharp", version: "0.34.5" }));
  writeNativeDir(nm);
  return { base, nm, runtimeDir: mkdtempSync(join(tmpdir(), "mneme-dst-")) };
}

/**
 * 空源：连 transformers 都没有。这是「profile 里根本没装」或 `--from` 指错目录时的真实输入，
 * 也是曾经抛 TypeError 的那条路径。
 * @returns {{base: string, nm: string, runtimeDir: string}}
 */
export function makeEmptyModules() {
  const base = mkdtempSync(join(tmpdir(), "mneme-empty-"));
  const nm = join(base, "node_modules");
  mkdirSync(nm, { recursive: true });
  return { base, nm, runtimeDir: mkdtempSync(join(tmpdir(), "mneme-dst-")) };
}
