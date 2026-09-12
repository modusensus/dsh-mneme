import test from "node:test";
import assert from "node:assert/strict";
import { createEmbedder } from "../src/embedding.js";

// issue #135: the legacy OpenAI-compatible embedder is an object literal with no
// async init, so api.js's generic `"ready" in embedder` branch used to fall
// through to "assume usable" — the status card stayed green while baseUrl /
// apiKey / model were all empty and not a single vector could be produced
// ("绿色假阳性"). These tests pin the real predicate and the getter semantics.

const FULL = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "text-embedding-3-small"
};

/** Build the embedder against a settings double + a recording store. */
function make(cfg, { live = false } = {}) {
  const writes = [];
  const box = { cfg };
  const embedder = createEmbedder({
    store: { setEmbedding: (id, vector) => writes.push({ id, vector }) },
    settings: { getVectorConfig: () => (live ? box.cfg : cfg) },
    logger: { info() {}, warn() {} }
  });
  return { embedder, writes, box };
}

test("#135 legacy OpenAI embedder reports ready/configured from the config", () => {
  const { embedder } = make(FULL);
  assert.equal(embedder.ready, true, "fully configured → ready");
  assert.equal(embedder.configured, true);

  // Any of the four fields missing → not configured. `enabled` flips to false,
  // the rest are blanked (the shape the settings panel leaves behind when the
  // user never filled the vector section in).
  for (const key of ["enabled", "baseUrl", "apiKey", "model"]) {
    const broken = { ...FULL, [key]: key === "enabled" ? false : "" };
    const { embedder: e } = make(broken);
    assert.equal(e.configured, false, `blank ${key} → not configured`);
    assert.equal(e.ready, false, `blank ${key} → not ready`);
  }

  // Defensive: a settings double returning {} (or nothing) must not throw.
  assert.equal(make({}).embedder.ready, false);
  assert.equal(make(undefined).embedder.ready, false);
});

test("#135 ready/configured are live getters, not boot-time snapshots", () => {
  // The panel writes vector-config through settings; the legacy embedder reads
  // it per call (same as embed()), so fixing the config must not need a restart.
  const { embedder, box } = make(FULL, { live: true });
  assert.equal(embedder.ready, true);
  box.cfg = { ...FULL, apiKey: "" };
  assert.equal(embedder.ready, false, "getter re-reads the live config");
  assert.equal(embedder.configured, false);
  box.cfg = FULL;
  assert.equal(embedder.ready, true, "…and recovers once the config is complete");
});

test("#135 unconfigured embedder never reaches the network", async () => {
  const { embedder, writes } = make({ ...FULL, apiKey: "" });
  // A real fetch here would go out with an empty bearer token.
  assert.equal(await embedder.embed("hello"), null);
  assert.equal(await embedder.embedSingle("hello"), null);

  embedder.schedule({ id: "m1", title: "t", content: "c" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, [], "schedule() must not store an embedding");

  // A memory without an id is a no-op (never a store write with undefined id).
  embedder.schedule(null);
  embedder.schedule({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, []);
});

test("#135 unconfigured embedder reports no model fingerprint or dimension", () => {
  const { embedder } = make(FULL);
  assert.equal(embedder.name, "OpenAI", "explicit name for the status card");
  assert.equal(embedder.dimension, undefined, "no dimension before a first embed");
  // model#hex — same fingerprint format the local embedders use.
  assert.match(embedder.modelHash, /^text-embedding-3-small#[0-9a-f]+$/);
  assert.equal(make({ ...FULL, model: "" }).embedder.modelHash, undefined);
  assert.equal(make({ ...FULL, enabled: false }).embedder.modelHash, undefined);
});
