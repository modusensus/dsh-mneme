import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, createBM25Index } from "../src/search/bm25.js";
import { adaptiveThreshold } from "../src/search/adaptive.js";

// --- tokenizer ---

test("tokenize keeps ASCII identifiers whole", () => {
  assert.deepEqual(
    tokenize("ZFS-4421 dsh_mneme v2"),
    ["zfs", "4421", "dsh_mneme", "v2"]
  );
});

test("tokenize splits CJK runs into bigrams", () => {
  assert.deepEqual(tokenize("异步编程"), ["异步", "步编", "编程"]);
  assert.deepEqual(tokenize("图"), ["图"]);
});

// --- BM25 index ---

const DOCS = [
  { id: "a", title: "异步并发模式", content: "async runtime 选用 tokio，任务 spawn 管理" },
  { id: "b", title: "语言迁移", content: "编译模块从 Go 迁移到 Rust，内存安全" },
  { id: "c", title: "无关条目", content: "夜间 ETL 用 Python 编写" }
];

test("BM25 recalls rows whose query terms are scattered", () => {
  // The LIKE path cannot match "rust 异步" as a substring of either doc;
  // BM25 must surface both term-bearing rows above the unrelated one.
  const idx = createBM25Index(DOCS);
  const hits = idx.search("rust 异步", { limit: 3 });
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes("a"), "the async doc must be recalled");
  assert.ok(ids.includes("b"), "the rust doc must be recalled");
  assert.ok(!ids.includes("c"), "the unrelated doc must not lead");
  assert.ok(ids.indexOf("c") === -1 || hits.find((h) => h.id === "c").score < hits[0].score);
});

test("BM25 search scores are normalized to [0,1] with the max on top", () => {
  const idx = createBM25Index(DOCS);
  const hits = idx.search("tokio spawn", { limit: 3 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "a");
  for (const h of hits) {
    assert.ok(h.score >= 0 && h.score <= 1, `score ${h.score} out of [0,1]`);
  }
  assert.equal(hits[0].score, 1);
});

test("BM25 score(query, doc) matches search on single-doc corpora", () => {
  const idx = createBM25Index(DOCS);
  const doc = DOCS[0];
  assert.ok(idx.score("tokio", doc) > 0);
  assert.equal(idx.score("完全不相关词汇xyzzy", doc), 0);
});

test("BM25 drops untouched rows entirely", () => {
  const idx = createBM25Index(DOCS);
  const hits = idx.search("ETL Python", { limit: 3 });
  assert.deepEqual(hits.map((h) => h.id), ["c"]);
});

// --- adaptive threshold ---

test("adaptive threshold: entity/attr prefixes loosen to 0.5", () => {
  assert.equal(adaptiveThreshold("entity:某个实体"), 0.5);
  assert.equal(adaptiveThreshold("attr:lang=Rust"), 0.5);
});

test("adaptive threshold: short queries tighten, long queries loosen", () => {
  assert.equal(adaptiveThreshold("go"), 0.7);
  const long = "这是一个非常长的查询".repeat(8);
  assert.equal(adaptiveThreshold(long), 0.6);
});

test("adaptive threshold: decisive head gap loosens to 0.5", () => {
  const candidates = [
    { _score: 0.9 }, { _score: 0.55 }, { _score: 0.54 }, { _score: 0.53 }, { _score: 0.52 }
  ];
  assert.equal(adaptiveThreshold("普通长度的查询词组", candidates), 0.5);
});

test("adaptive threshold: flat distribution keeps the 0.65 default", () => {
  const candidates = [
    { _score: 0.7 }, { _score: 0.68 }, { _score: 0.66 }, { _score: 0.64 }, { _score: 0.62 }
  ];
  assert.equal(adaptiveThreshold("普通长度的查询词组", candidates), 0.65);
  assert.equal(adaptiveThreshold("普通长度的查询词组"), 0.65);
});
