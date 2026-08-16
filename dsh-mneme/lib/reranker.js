import os from "node:os";
import path from "node:path";

// Cross-encoder re-ranker for dsh-mneme recall candidates. Uses
// bge-reranker-base through transformers.js: tries the native `rerank` task
// first, then the sequence-classification head (sigmoid on the logit delta),
// and finally feature-extraction over concatenated query+passage (cosine).
// Every strategy funnels into scorePair(query, passage) so tests can inject a
// fake scorer and never download a model. Failures throw — the caller degrades
// back to the original candidate order.
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Same provider#hash fingerprint convention as the embedders. */
function modelHash(model) {
  return `${model}#${hashString(model)}`;
}

/** Lazy default pipeline factory: dynamic import keeps module load cheap. */
async function defaultPipelineLoader(task, model, options) {
  const { pipeline } = await import("@huggingface/transformers");
  return pipeline(task, model, options);
}

/** Flatten a transformers.js Tensor [batch, seq, dim] into number[][] rows. */
function tensorToRows(tensor) {
  const { data, dims } = tensor;
  const dim = dims[dims.length - 1] || 0;
  const rows = [];
  for (let i = 0; i < data.length; i += dim) rows.push(Array.from(data.subarray(i, i + dim)));
  if (rows.length === 0 && dim > 0) rows.push(Array.from(data));
  return rows;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// Pipeline strategies, best to worst. `rerank` is unsupported by the bundled
// transformers.js (v4.2.0) and rejects cheaply before any model download, so
// the cascade normally lands on the classification head.
const STRATEGIES = [
  ["rerank", "rerank"],
  ["text-classification", "tc"],
  ["feature-extraction", "fe"]
];

export class LocalReranker {
  constructor(opts = {}) {
    this.model = opts.model || "Xenova/bge-reranker-base";
    this.batchSize = opts.batchSize || 8;
    this.maxCandidates = opts.maxCandidates || 30;
    this.scoreThreshold = opts.scoreThreshold ?? 0.1;
    this.device = opts.device || "cpu";
    this.cacheDir =
      String(opts.cacheDir ?? "").trim() ||
      path.join(os.homedir(), ".dsh", "mneme", "models");
    this.logger = opts.logger ?? null;
    this.engineFactory = opts.engineFactory || defaultPipelineLoader;
    // Injectable seam: async (query, passage) => number. When set, init()
    // skips model loading entirely so tests never hit the network.
    this.scorePair = opts.scorePair ?? null;
    this.pipeline = null;
    this._batchScorer = null;
    this._queryVec = null;
    this._queryKey = null;
  }

  /** Load the model; throws when no strategy can be bound. */
  async init() {
    if (this.scorePair) return this;
    let lastErr = null;
    for (const [task, strategy] of STRATEGIES) {
      try {
        this.pipeline = await this.engineFactory(task, this.model, this._engineOptions());
        this._bindBatchScorer(strategy);
        this.logger?.info?.(
          `[dsh-mneme] local reranker ready: ${this.model} (strategy=${strategy}, device=${this.device})`
        );
        return this;
      } catch (err) {
        lastErr = err;
        this.logger?.warn?.(
          `[dsh-mneme] reranker task "${task}" unavailable for ${this.model}: ${String(err?.message ?? err)}`
        );
      }
    }
    throw new Error(`LocalReranker failed to load ${this.model}: ${String(lastErr?.message ?? lastErr)}`);
  }

  _engineOptions() {
    const options = { device: this.device };
    if (this.cacheDir) options.cache_dir = this.cacheDir;
    return options;
  }

  /** Bind a batch scorer for the chosen strategy. */
  _bindBatchScorer(strategy) {
    if (strategy === "rerank") {
      // Native cross-encoder task (transformers.js >= 4.6): { query, documents }
      // returns one score per document.
      this._batchScorer = async (query, passages) => {
        const out = await this.pipeline({ query, documents: passages });
        if (!Array.isArray(out)) throw new Error("rerank pipeline returned unexpected output");
        return out.map((r) => clamp01(typeof r?.score === "number" ? r.score : 0));
      };
    } else if (strategy === "tc") {
      // Classification head: tokenize (query, passage) pairs, score with
      // sigmoid(l1 - l0) so relevance lands in [0, 1].
      this._batchScorer = async (query, passages) => {
        const { tokenizer, model } = this.pipeline;
        const inputs = tokenizer(passages.map(() => query), {
          text_pair: passages,
          padding: true,
          truncation: true
        });
        const logits = await model(inputs).then((o) => o.logits);
        const dims = logits.dims;
        const cols = dims[dims.length - 1] || 2;
        const rows = [];
        for (let i = 0; i < dims[0]; i++) {
          const base = i * cols;
          const l0 = logits.data[base];
          const l1 = cols > 1 ? logits.data[base + 1] : l0;
          // sigmoid(l1 - l0) == softmax probability of the positive class.
          rows.push(clamp01(1 / (1 + Math.exp(l0 - l1))));
        }
        return rows;
      };
    } else {
      // Feature extraction: mean-pool the concatenated pair and compare with
      // the query embedding via cosine. Degraded but model-agnostic.
      // The query vector is cached per query string, so a new query always
      // recomputes it instead of reusing a stale vector from the previous call.
      this._queryVec = null;
      this._queryKey = null;
      this._batchScorer = async (query, passages) => {
        if (this._queryKey !== query) {
          const t = await this.pipeline([query], { pooling: "mean", normalize: true });
          this._queryVec = tensorToRows(t)[0];
          this._queryKey = query;
        }
        const t = await this.pipeline(passages.map((p) => `${query}\n${p}`), {
          pooling: "mean",
          normalize: true
        });
        return tensorToRows(t).map((v) => clamp01(cosine(this._queryVec, v)));
      };
    }
  }

  /** Score one batch of passages; injected scorePair scores pair by pair. */
  async _scores(query, passages) {
    if (this._batchScorer) return this._batchScorer(query, passages);
    return Promise.all(passages.map((p) => (p ? this.scorePair(query, p) : 0)));
  }

  /**
   * Re-rank recall candidates. Returns [{ id, score }] filtered by
   * scoreThreshold and sorted by descending score. Throws on engine failure —
   * the caller degrades to the original candidate order.
   */
  async rerank(query, candidates) {
    if (!Array.isArray(candidates)) throw new TypeError("rerank expects an array of candidates");
    const list = candidates.slice(0, this.maxCandidates);
    if (!list.length) return [];
    const q = String(query ?? "");
    const results = [];
    for (let i = 0; i < list.length; i += this.batchSize) {
      const chunk = list.slice(i, i + this.batchSize);
      const passages = chunk.map((c) => [c.title, c.content].filter(Boolean).join("\n"));
      const scores = await this._scores(q, passages);
      if (!Array.isArray(scores) || scores.length !== chunk.length) {
        throw new Error("reranker scorer returned mismatched scores");
      }
      for (let j = 0; j < chunk.length; j++) {
        results.push({ id: chunk[j].id, score: clamp01(Number(scores[j]) || 0) });
      }
    }
    return results
      .filter((r) => r.score >= this.scoreThreshold)
      .sort((a, b) => b.score - a.score);
  }

  get modelHash() {
    return modelHash(this.model);
  }

  dispose() {
    try {
      this.pipeline?.dispose?.();
    } catch {
      // best-effort: some engines free resources on GC
    }
    this.pipeline = null;
    this._queryVec = null;
    this._queryKey = null;
  }
}
