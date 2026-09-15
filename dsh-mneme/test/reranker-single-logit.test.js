import test from "node:test";
import assert from "node:assert/strict";
import { LocalReranker } from "../src/reranker.js";

// 回归（issue #188）：Xenova/bge-reranker-base 是单 logit 交叉编码器——每个
// (query, passage) 对只输出 1 个 logit。tc 策略此前在 cols===1 时把 l1 退化成
// l0，sigmoid(l0 - l1) = sigmoid(0) = 0.5：所有候选分数恒为常量，重排静默失效
// （不抛错、日志照常 ready、语义状态照常 reranker="ready"，只有分数是死的）。
// 单 logit 头的正类概率是 sigmoid(logit)；sigmoid(l1 - l0) 只对双 logit 头
// （num_labels=2 的导出，如 bge-reranker-v2-m3）成立。修复后按 cols 分支，
// 两路各有回归；另加「分数全等 → warn 一次」的静默失效绊线。

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function candidates(ids) {
  return ids.map((id) => ({ id, title: `T-${id}`, content: `C-${id}` }));
}

// 只支持 text-classification 的假引擎：cascade 先试 "rerank"（transformers
// 4.2.0 无此任务，真机上也必然先失败），随后落到 tc。
function makeTcFactory(dims, data) {
  return async (task) => {
    if (task === "rerank") throw new Error("unsupported task: rerank");
    assert.equal(task, "text-classification");
    return {
      tokenizer: (texts, _opts) => ({ texts }),
      model: async (inputs) => ({ logits: { dims, data: Float64Array.from(data.slice(0, inputs.texts.length * dims[1])) } })
    };
  };
}

test("#188: single-logit head scores sigmoid(logit) instead of constant 0.5", async () => {
  // 报告的实测 logits：相关 -0.556、无关 -10.193，区分度近 10——模型判断得
  // 很好，只是旧公式把它们全抹成 0.5000。
  const r = new LocalReranker({
    engineFactory: makeTcFactory([3, 1], [-0.5561, -10.193, 8.7])
  });
  await r.init();
  const out = await r.rerank("查询", candidates(["rel", "noise", "hit"]));
  // sigmoid(-0.5561)≈0.3645 保留；sigmoid(-10.193)≈3.7e-5 被 0.1 阈值滤掉；
  // sigmoid(8.7)≈0.9998 居首。修复前三者全 0.5、顺序不变。
  assert.deepEqual(out.map((x) => x.id), ["hit", "rel"]);
  assert.ok(Math.abs(out[0].score - sigmoid(8.7)) < 1e-6, "hit = sigmoid(logit)");
  assert.ok(Math.abs(out[1].score - sigmoid(-0.5561)) < 1e-6, "rel = sigmoid(logit)");
  r.dispose();
});

test("#188: dual-logit head keeps softmax-positive-class semantics", async () => {
  // l0=-2,l1=2 → sigmoid(4)；l0=1,l1=1.5 → sigmoid(0.5)——与原实现逐字节等价。
  const r = new LocalReranker({
    engineFactory: makeTcFactory([2, 2], [-2, 2, 1, 1.5])
  });
  await r.init();
  const out = await r.rerank("查询", candidates(["a", "b"]));
  assert.deepEqual(out.map((x) => x.id), ["a", "b"]);
  assert.ok(Math.abs(out[0].score - sigmoid(4)) < 1e-6);
  assert.ok(Math.abs(out[1].score - sigmoid(0.5)) < 1e-6);
  r.dispose();
});

test("#188: constant-score batch warns once (silent-failure tripwire)", async () => {
  const warns = [];
  const r = new LocalReranker({
    scorePair: async () => 0.5,
    logger: { warn: (m) => warns.push(m), info: () => {} }
  });
  await r.rerank("查询", candidates(["a", "b", "c"]));
  await r.rerank("查询", candidates(["a", "b", "c"]));
  assert.equal(warns.length, 1, "constant-score batch warns exactly once across calls");
  r.dispose();
});
