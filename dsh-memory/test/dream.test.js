import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions } from "../src/dream.js";

function snapshot(ids) {
  return new Map(ids.map((id, i) => [id, { id, type: i % 2 ? "project" : "preference", title: `t${i}`, content: `c${i}`, importance: 3, archived: false, forgotten: false }]));
}

test("valid decision list passes", () => {
  const snap = snapshot(["a", "b", "c"]);
  const decisions = [
    { action: "keep", ids: ["a"], reason: "ok" },
    { action: "merge", ids: ["b", "c"], title: "bc", content: "merged", importance: 4, keepSource: "b" }
  ];
  const { ok, errors } = validateDecisions(decisions, snap);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("unknown id rejects whole list", () => {
  const snap = snapshot(["a"]);
  const { ok, errors } = validateDecisions([{ action: "archive", ids: ["zzz"], reason: "x" }], snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("zzz")));
});

test("invalid action rejects", () => {
  const snap = snapshot(["a"]);
  const { ok } = validateDecisions([{ action: "explode", ids: ["a"] }], snap);
  assert.equal(ok, false);
});

test("merge keepSource must be in ids", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([{ action: "merge", ids: ["a"], keepSource: "b", title: "t", content: "c" }], snap);
  assert.equal(ok, false);
});

test("conflict winner and loser must exist and differ", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([{ action: "conflict", winner: "a", loser: "a" }], snap);
  assert.equal(ok, false);
  const { ok: ok2 } = validateDecisions([{ action: "conflict", winner: "a", loser: "zzz" }], snap);
  assert.equal(ok2, false);
});

test("duplicate primary ids across decisions reject", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([
    { action: "archive", ids: ["a"] },
    { action: "keep", ids: ["a"] }
  ], snap);
  assert.equal(ok, false, "a claimed twice");
});

test("archived or summary entries cannot be decision targets", () => {
  const snap = new Map([["arch", { id: "arch", type: "project", title: "t", content: "c", importance: 3, archived: true, forgotten: false }]]);
  const { ok } = validateDecisions([{ action: "archive", ids: ["arch"] }], snap);
  assert.equal(ok, false);
});

test("empty decision list rejects", () => {
  const { ok, errors } = validateDecisions([], snapshot(["a"]));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("non-empty array")));
});

test("empty ids rejects", () => {
  const { ok } = validateDecisions([{ action: "archive", ids: [] }], snapshot(["a"]));
  assert.equal(ok, false);
});

test("merge requires non-empty title and content", () => {
  const snap = snapshot(["a"]);
  const base = { action: "merge", ids: ["a"], keepSource: "a" };
  for (const [title, content] of [["", "x"], ["t", ""], [undefined, "x"], ["t", undefined]]) {
    const { ok } = validateDecisions([{ ...base, title, content }], snap);
    assert.equal(ok, false, `title=${JSON.stringify(title)} content=${JSON.stringify(content)}`);
  }
});

test("summary entries cannot be decision targets", () => {
  const snap = new Map([["s", { id: "s", type: "summary", title: "t", content: "c", importance: 3, archived: false, forgotten: false }]]);
  const { ok } = validateDecisions([{ action: "archive", ids: ["s"] }], snap);
  assert.equal(ok, false);
});

test("every snapshot memory must be covered by a decision", () => {
  const snap = snapshot(["a", "b"]);
  const { ok, errors } = validateDecisions([{ action: "keep", ids: ["a"] }], snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing from decisions")));
});

test("duplicate ids within one decision reject", () => {
  const { ok } = validateDecisions([{ action: "keep", ids: ["a", "a"] }], snapshot(["a"]));
  assert.equal(ok, false);
});
