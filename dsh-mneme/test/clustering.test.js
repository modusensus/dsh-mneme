import test from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, kMeans, clusterMemories, findPotentialConflicts } from "../src/dream/clustering.js";

test("cosineSimilarity: identical vectors => 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity: orthogonal vectors => 0 (approx)", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test("cosineSimilarity: mismatched or empty lengths => 0", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity: zero-norm vector => 0", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

// Three well-separated point groups in the plane.
const GROUP1 = [[0, 0], [0, 0.1], [0.1, 0], [0.1, 0.1]];
const GROUP2 = [[10, 10], [10, 10.1], [10.1, 10], [10.1, 10.1]];
const GROUP3 = [[-10, -10], [-10, -9.9], [-9.9, -10], [-9.9, -9.9]];
const SEPARATED = [...GROUP1, ...GROUP2, ...GROUP3];

test("kMeans: three separated groups cluster correctly (labels may permute)", () => {
  const clusters = kMeans(SEPARATED, 3, { maxIter: 100 });
  assert.equal(clusters.length, 3);
  // Content-based check: each cluster must fit exactly one expected group.
  const expectedGroups = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]];
  for (const c of clusters) {
    assert.ok(c.length >= 1);
    const fits = expectedGroups.filter((g) => c.every((idx) => g.includes(idx)));
    assert.equal(fits.length, 1, `cluster ${JSON.stringify(c)} spans multiple groups`);
  }
  // Every index assigned exactly once.
  assert.deepEqual(clusters.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("kMeans: k >= n returns a single cluster of all indices", () => {
  assert.deepEqual(kMeans(SEPARATED, 12), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]);
  assert.deepEqual(kMeans(SEPARATED, 0), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]);
});

test("kMeans: empty input => no clusters", () => {
  assert.deepEqual(kMeans([], 3), []);
});

test("kMeans: empty clusters get reseeded and still terminate", () => {
  // Many points near two poles with k=3 forces one cluster empty on seed.
  const vectors = [
    ...Array.from({ length: 30 }, () => [0, 0]),
    ...Array.from({ length: 30 }, () => [1, 1])
  ];
  const clusters = kMeans(vectors, 3, { maxIter: 50 });
  assert.equal(clusters.length, 3);
  assert.equal(clusters.flat().length, vectors.length);
});

test("clusterMemories: preserves object references and group count", () => {
  const memories = SEPARATED.map((v, i) => ({ id: `m${i}`, type: "project", title: `t${i}` }));
  const groups = clusterMemories(memories, SEPARATED, 3);
  assert.equal(groups.length, 3);
  assert.equal(groups.flat().length, memories.length);
  // Reference identity preserved: every group member is an object from input.
  const all = groups.flat();
  for (const m of all) assert.ok(memories.includes(m), "cluster contains a foreign object");
  // Full coverage: each source object appears exactly once across groups.
  assert.equal(new Set(all).size, memories.length);
  assert.equal(groups.flat().find((m) => m.id === "m5"), memories[5]);
});

test("findPotentialConflicts: only same-type highly-similar pairs reported", () => {
  const memories = [
    { id: "a", type: "preference", content: "like cold coffee" },
    { id: "b", type: "preference", content: "hate cold coffee" },
    { id: "c", type: "project", content: "ship the plugin" }
  ];
  const vectors = [
    [1, 0, 0],
    [0.99, 0.02, 0],   // nearly parallel to a, same type => conflict
    [0, 1, 0]          // different type, ignored even if near
  ];
  const pairs = findPotentialConflicts(memories, vectors, 0.85);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, memories[0]);
  assert.equal(pairs[0].b, memories[1]);
  assert.ok(pairs[0].similarity > 0.85);
});

test("findPotentialConflicts: below threshold or different type => no pairs", () => {
  const memories = [
    { id: "x", type: "preference" },
    { id: "y", type: "project" }
  ];
  assert.deepEqual(findPotentialConflicts(memories, [[1, 0], [0, 1]]), []);
  assert.deepEqual(findPotentialConflicts(memories, [[1, 0], [0.9, 0.1]], 0.95), []);
});
