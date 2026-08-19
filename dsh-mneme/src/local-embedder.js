// Fully-local embedding backends for dsh-mneme: ONNX via transformers.js,
// Ollama's HTTP API, and the OpenAI-compatible HTTP API (extracted from the
// old embedding.js logic). All classes share one interface so the orchestrator
// can pick a backend by provider name and degrade gracefully on failure.
// Methods throw on error — the caller decides the fallback chain.
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15000;

/** djb2 — stable, fast fingerprint for a provider/model string. */
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Full provider+model fingerprint used for index-consistency checks. */
function modelHash(model) {
  return `${model}#${hashString(model)}`;
}

/** Lazy default loader: dynamic import keeps module load cheap. */
async function defaultPipelineLoader(task, model, options) {
  const { env, pipeline } = await import("@huggingface/transformers");
  // issue #13: transformers.js's get_tokenizer_files() drops the caller's
  // cache_dir when it pre-checks tokenizer_config.json metadata, so the HEAD
  // request falls back to env.cacheDir and hits the network even when the
  // model is fully cached locally. Mirroring the cache_dir onto env.cacheDir
  // makes that pre-check resolve locally too — fully offline loading.
  if (options?.cache_dir) env.cacheDir = options.cache_dir;
  return pipeline(task, model, options);
}

/** Flatten a transformers.js Tensor [batch, dim] into number[][]. */
function tensorToRows(tensor) {
  const { data, dims } = tensor;
  const rowLen = dims[dims.length - 1] || 0;
  const rows = [];
  for (let i = 0; i < data.length; i += rowLen) {
    rows.push(Array.from(data.subarray(i, i + rowLen)));
  }
  // Single-text input may come back without the batch axis.
  if (rows.length === 0 && rowLen > 0) rows.push(Array.from(data));
  return rows;
}

/**
 * ONNX text embedder backed by transformers.js (onnxruntime-node underneath).
 * Runs fully offline with mean pooling + L2 normalization for BERT-style
 * models like bge-small-zh. `engineFactory` is injectable for tests.
 */
export class LocalEmbedder {
  constructor(opts = {}) {
    this.model = opts.model || "Xenova/bge-small-zh-v1.5";
    this._dimension = opts.dimension || 512;
    this.device = opts.device || "cpu";
    this.batchSize = opts.batchSize || 8;
    this.cacheDir =
      String(opts.cacheDir ?? "").trim() ||
      path.join(os.homedir(), ".dsh", "mneme", "models");
    this.useDtype = opts.useDtype || "q8";
    this.logger = opts.logger ?? null;
    // Test hook: replace the pipeline factory without touching modules.
    this.engineFactory = opts.engineFactory || defaultPipelineLoader;
    this.extractor = null;
    // issue #6: readiness flag for the service's scheduleEmbed gate. False until
    // init() succeeds, so "ready" in embedder is observable even pre-init.
    this.ready = false;
  }

  /** Load the model; throws when it cannot be loaded. Idempotent. */
  async init() {
    if (this.extractor) return this; // already initialized: no-op
    const options = {
      dtype: this.useDtype,
      device: this.device
    };
    if (this.cacheDir) options.cache_dir = this.cacheDir;
    this.extractor = await this.engineFactory("feature-extraction", this.model, options);
    this.ready = true; // service reads this to flush queued re-embeds
    this.logger?.info?.(
      `[dsh-mneme] local embedder ready: ${this.model} (dim=${this._dimension}, device=${this.device})`
    );
    return this;
  }

  /** Embed many texts with mean pooling; chunks at batchSize. */
  async embed(texts) {
    if (!Array.isArray(texts)) throw new TypeError("embed expects an array of strings");
    if (!this.extractor) throw new Error("LocalEmbedder not initialized");
    const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const tensor = await this.extractor(chunk, { pooling: "mean", normalize: true });
      out.push(...tensorToRows(tensor));
    }
    return out;
  }

  async embedSingle(text) {
    const rows = await this.embed([String(text)]);
    return rows[0];
  }

  get dimension() {
    return this._dimension;
  }

  get modelHash() {
    return modelHash(this.model);
  }

  dispose() {
    try {
      this.extractor?.dispose?.();
    } catch {
      // best-effort: some engines free resources on GC
    }
    this.extractor = null;
    this.ready = false;
  }
}

/** Chunk texts into batches of at most `size`. */
function chunk(texts, size) {
  const out = [];
  for (let i = 0; i < texts.length; i += size) out.push(texts.slice(i, i + size));
  return out;
}

/**
 * Ollama embedder over its native HTTP API. `dimension` is inferred from the
 * first response. init() verifies reachability and that the model exists.
 */
export class OllamaEmbedder {
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl ?? "http://localhost:11434").trim().replace(/\/+$/, "");
    this.model = String(opts.model ?? "nomic-embed-text").trim();
    this.logger = opts.logger ?? null;
    this._dimension = null;
  }

  async _post(body) {
    return fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  }

  /** Probe the server with a tiny prompt; throws when unreachable/missing. */
  async init() {
    const res = await this._post({ model: this.model, prompt: "ping" });
    if (!res.ok) throw new Error(`Ollama ${this.model} unavailable: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.embedding)) throw new Error(`Ollama ${this.model} returned no embedding`);
    this._dimension = body.embedding.length;
    this.logger?.info?.(
      `[dsh-mneme] ollama embedder ready: ${this.model} (dim=${this._dimension})`
    );
    return this;
  }

  async embed(texts) {
    if (!Array.isArray(texts)) throw new TypeError("embed expects an array of strings");
    const out = [];
    for (const text of texts) out.push(await this.embedSingle(text));
    return out;
  }

  async embedSingle(text) {
    const res = await this._post({ model: this.model, prompt: String(text).slice(0, 8000) });
    if (!res.ok) throw new Error(`Ollama embed failed: HTTP ${res.status}`);
    const body = await res.json();
    const vec = body?.embedding;
    if (!Array.isArray(vec) || !vec.length) throw new Error("Ollama returned no embedding");
    if (this._dimension == null) this._dimension = vec.length;
    return Array.from(vec);
  }

  get dimension() {
    return this._dimension ?? 0;
  }

  get modelHash() {
    return modelHash(this.model);
  }

  dispose() {
    this._dimension = null;
  }
}

/**
 * OpenAI-compatible embedder (OpenAI, SiliconFlow, Zhipu, local proxies).
 * Backward-compatible behavior lifted from embedding.js, but batchable and
 * throwing on failure instead of returning null.
 */
export class OpenAIEmbedder {
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.apiKey = String(opts.apiKey ?? "").trim();
    this.model = String(opts.model ?? "").trim();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger ?? null;
    this._dimension = null;
    // Accept both "https://host/v1" and a full path ending in /embeddings.
    this._url = /\/embeddings$/i.test(this.baseUrl)
      ? this.baseUrl
      : this.baseUrl ? `${this.baseUrl}/embeddings` : "";
  }

  async init() {
    if (!this._url || !this.apiKey || !this.model) {
      throw new Error("OpenAI embedder requires baseUrl, apiKey and model");
    }
    this.logger?.info?.(`[dsh-mneme] openai embedder ready: ${this.model}`);
    return this;
  }

  async embed(texts) {
    if (!Array.isArray(texts)) throw new TypeError("embed expects an array of strings");
    const out = [];
    for (const batch of chunk(texts, 32)) {
      const res = await fetch(this._url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model: this.model, input: batch.map((t) => String(t).slice(0, 8000)) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!res.ok) throw new Error(`Embedding API failed: HTTP ${res.status}`);
      const body = await res.json();
      const list = body?.data;
      if (!Array.isArray(list) || list.length !== batch.length) {
        throw new Error("Embedding API returned unexpected payload");
      }
      for (const item of list) {
        const vec = item?.embedding;
        if (!Array.isArray(vec) || !vec.length) throw new Error("Embedding API returned empty vector");
        if (this._dimension == null) this._dimension = vec.length;
        out.push(Array.from(vec));
      }
    }
    return out;
  }

  async embedSingle(text) {
    const rows = await this.embed([String(text)]);
    return rows[0];
  }

  get dimension() {
    return this._dimension ?? 0;
  }

  get modelHash() {
    return modelHash(this.model);
  }

  dispose() {
    this._dimension = null;
  }
}

/** Pick a backend instance by provider name. Throws on unknown providers. */
export function createEmbedderByProvider(provider, opts) {
  switch (String(provider ?? "").toLowerCase()) {
    case "local":
      return new LocalEmbedder(opts);
    case "ollama":
      return new OllamaEmbedder(opts);
    case "openai":
      return new OpenAIEmbedder(opts);
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
