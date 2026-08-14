import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalEmbedder,
  OllamaEmbedder,
  OpenAIEmbedder,
  createEmbedderByProvider
} from "../src/local-embedder.js";

/** Build a transformers.js-like Tensor: [rows x dim] flat data + dims. */
function fakeTensor(rows) {
  const flat = Float32Array.from(rows.flat());
  return { data: flat, dims: rows.length ? [rows.length, rows[0].length] : [0] };
}

/** Fake extractor: deterministic [batch, dim], records option passthrough. */
function makeFakeExtractor(dim, calls = []) {
  const fn = async (texts, opts) => {
    calls.push({ count: texts.length, opts });
    return fakeTensor(
      texts.map((_, i) => Array.from({ length: dim }, (__, j) => (i + 1) * 0.1 + j * 0.01))
    );
  };
  fn.dispose = () => {
    fn.disposed = true;
  };
  return fn;
}

/** Stub globalThis.fetch, returning the original on restore. */
function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => {
    globalThis.fetch = real;
  };
}

function okJson(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test("LocalEmbedder init loads via injected engineFactory with cache_dir", async () => {
  let seen = null;
  const loader = async (task, model, options) => {
    seen = { task, model, options };
    return makeFakeExtractor(512);
  };
  const e = new LocalEmbedder({ cacheDir: "/tmp/model-cache", engineFactory: loader });
  await e.init();
  assert.equal(seen.task, "feature-extraction");
  assert.equal(seen.model, "Xenova/bge-small-zh-v1.5");
  assert.equal(seen.options.cache_dir, "/tmp/model-cache");
  assert.equal(seen.options.dtype, "q8");
  assert.equal(seen.options.device, "cpu");
});

test("LocalEmbedder embed returns [n, dim] with mean pooling and chunking", async () => {
  const calls = [];
  const e = new LocalEmbedder({
    model: "Xenova/bge-small-zh-v1.5",
    batchSize: 2,
    engineFactory: async () => makeFakeExtractor(512, calls)
  });
  await e.init();
  const vecs = await e.embed(["你好", "hello world", "测试文本"]);
  assert.equal(vecs.length, 3);
  for (const v of vecs) {
    assert.equal(v.length, 512);
    assert.ok(v.every(Number.isFinite));
  }
  // 3 texts at batchSize 2 -> two extractor calls.
  assert.deepEqual(calls.map((c) => c.count), [2, 1]);
  assert.deepEqual(calls[0].opts, { pooling: "mean", normalize: true });
});

test("LocalEmbedder embedSingle returns a single vector", async () => {
  const e = new LocalEmbedder({ engineFactory: async () => makeFakeExtractor(384) });
  await e.init();
  const v = await e.embedSingle("single");
  assert.equal(v.length, 384);
});

test("LocalEmbedder dimension and modelHash are stable", () => {
  const a = new LocalEmbedder({ model: "Xenova/bge-small-zh-v1.5" });
  const b = new LocalEmbedder({ model: "Xenova/bge-small-zh-v1.5" });
  assert.equal(a.dimension, 512);
  assert.equal(a.modelHash, b.modelHash);
  assert.match(a.modelHash, /^Xenova\/bge-small-zh-v1\.5#[0-9a-f]+$/);
  // Different model -> different hash.
  assert.notEqual(a.modelHash, new LocalEmbedder({ model: "other/model" }).modelHash);
});

test("LocalEmbedder throws before init and after dispose", async () => {
  const e = new LocalEmbedder({ engineFactory: async () => makeFakeExtractor(512) });
  await assert.rejects(() => e.embed(["x"]), /not initialized/);
  await e.init();
  const disposed = makeFakeExtractor(512);
  e.dispose();
  assert.ok(disposed.disposed || e.extractor === null);
  await assert.rejects(() => e.embed(["x"]), /not initialized/);
});

test("OllamaEmbedder init probes server and infers dimension", async () => {
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, "http://localhost:11434/api/embeddings");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "nomic-embed-text");
    assert.equal(body.prompt, "ping");
    return okJson(200, { embedding: Array.from({ length: 768 }, (_, i) => i / 768) });
  });
  try {
    const e = new OllamaEmbedder({ baseUrl: "http://localhost:11434", model: "nomic-embed-text" });
    await e.init();
    assert.equal(e.dimension, 768);
  } finally {
    restore();
  }
});

test("OllamaEmbedder embed loops single requests", async () => {
  const prompts = [];
  const restore = stubFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body.prompt);
    return okJson(200, { embedding: [0.5, 0.25, 0.125] });
  });
  try {
    const e = new OllamaEmbedder({});
    await e.init();
    const vecs = await e.embed(["one", "two"]);
    assert.deepEqual(prompts, ["ping", "one", "two"]);
    assert.equal(vecs.length, 2);
    assert.deepEqual(vecs[0], [0.5, 0.25, 0.125]);
    assert.equal(e.dimension, 3);
  } finally {
    restore();
  }
});

test("OllamaEmbedder init throws when unreachable", async () => {
  const restore = stubFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const e = new OllamaEmbedder({});
    await assert.rejects(() => e.init(), /ECONNREFUSED/);
  } finally {
    restore();
  }
});

test("OllamaEmbedder embed throws on HTTP error", async () => {
  const restore = stubFetch(async () => okJson(404, { error: "model not found" }));
  try {
    const e = new OllamaEmbedder({});
    await assert.rejects(() => e.embedSingle("x"), /HTTP 404/);
  } finally {
    restore();
  }
});

test("OllamaEmbedder modelHash is stable", () => {
  const a = new OllamaEmbedder({ model: "nomic-embed-text" });
  const b = new OllamaEmbedder({ model: "nomic-embed-text" });
  assert.equal(a.modelHash, b.modelHash);
  assert.notEqual(a.modelHash, new OllamaEmbedder({ model: "bge-m3" }).modelHash);
});

test("OpenAIEmbedder init requires config and calls /embeddings", async () => {
  const e = new OpenAIEmbedder({ baseUrl: "http://localhost:8000/v1", apiKey: "k", model: "m" });
  assert.equal(e._url, "http://localhost:8000/v1/embeddings");
  await e.init();

  const bad = new OpenAIEmbedder({ baseUrl: "", apiKey: "", model: "" });
  await assert.rejects(() => bad.init(), /requires baseUrl, apiKey and model/);
});

test("OpenAIEmbedder embed batch posts array and parses data", async () => {
  let captured = null;
  const restore = stubFetch(async (url, init) => {
    captured = { url, init };
    return okJson(200, {
      data: [
        { embedding: [0.1, 0.2, 0.3] },
        { embedding: [0.4, 0.5, 0.6] }
      ]
    });
  });
  try {
    const e = new OpenAIEmbedder({ baseUrl: "https://x/v1", apiKey: "sk-abc", model: "text-embed" });
    await e.init();
    const vecs = await e.embed(["a", "b"]);
    assert.equal(captured.url, "https://x/v1/embeddings");
    assert.equal(captured.init.headers.Authorization, "Bearer sk-abc");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, "text-embed");
    assert.deepEqual(body.input, ["a", "b"]);
    assert.equal(vecs.length, 2);
    assert.equal(e.dimension, 3);
  } finally {
    restore();
  }
});

test("OpenAIEmbedder throws on non-ok response", async () => {
  const restore = stubFetch(async () => okJson(500, {}));
  try {
    const e = new OpenAIEmbedder({ baseUrl: "https://x/v1", apiKey: "k", model: "m" });
    await assert.rejects(() => e.embed(["x"]), /HTTP 500/);
  } finally {
    restore();
  }
});

test("createEmbedderByProvider returns the right class per provider", () => {
  assert.ok(createEmbedderByProvider("local") instanceof LocalEmbedder);
  assert.ok(createEmbedderByProvider("ollama") instanceof OllamaEmbedder);
  assert.ok(createEmbedderByProvider("openai") instanceof OpenAIEmbedder);
  assert.ok(createEmbedderByProvider("LOCAL") instanceof LocalEmbedder);
  assert.throws(() => createEmbedderByProvider("watson"), /Unknown embedding provider/);
});
