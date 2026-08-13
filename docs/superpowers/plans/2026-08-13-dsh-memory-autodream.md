# dsh-memory autoDream 自动记忆整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automatic memory consolidation (autoDream) module to the dsh-memory plugin: threshold-triggered async reorganization that dedupes, merges, resolves conflicts, and generates a summary memory injected preferentially into future sessions.

**Architecture:** New `src/dream.js` module orchestrated from `src/index.js`, with schema extension in `store.js` (new `archived` column + `summary` type), write-hooks in `service.js`, injection priority change in `inject.js`, and 4 new config keys in `config.js`. Dream runs an LLM consolidation prompt producing a JSON decision list (`keep|merge|archive|conflict`), validates it server-side (fail-safe), applies decisions, then generates a single-instance `summary` memory. Trigger: after writes, when count > 10 or total chars > 5000, async with 2s delay and baseline reset to prevent loops.

**Tech Stack:** Node 24 (`node:sqlite`), plain ESM, `@deepseek-ai/dsh-llm` (stream + BlockAssembler), node:test. **Existing patterns to follow** (from the v0.1 implementation, all reviewed and verified):
- Test command: `node --test --test-isolation=none test/<file>.test.js` (sandbox forbids child-process spawn)
- LLM calls: `ctx.llm.stream(options)` + `BlockAssembler.blocks()` — NOT `assemble()` (no public no-arg form); chunks carry `{type:"text-delta", index, text}` in real protocol
- Plugin entry: `export const apply = (ctx, config) => {...}` as **arrow function** (function declarations get `new`-called by cordis 4 and their returned disposer is silently dropped)
- `inject` export must declare every service read from ctx: currently `["tools", "systemPrompt", "webServer", "llm"]`
- schemastery: use `z.natural()` not `z.number().integer()`
- `saveWithDedupe` returns `{action, memory}`; title-trim matching dedupes within type
- `syncMirror()` in service excludes forgotten via `store.list({limit:500, includeForgotten:false})`

---

## File Structure

```
dsh-memory/src/
├── store.js          # MODIFY: archived column (schema migration), setArchived, list/count/search archive filters, summary type allowed
├── service.js        # MODIFY: injectCandidates excludes archived; summary-aware; write hooks → dream.maybeSchedule
├── dream.js          # CREATE: maybeSchedule, runDream (LLM + validate + apply + summarize)
├── inject.js         # MODIFY: summary-first injection
├── config.js         # MODIFY: +4 config keys (autoDream, dreamThresholdCount/Chars, dreamDelayMs)
├── index.js          # MODIFY: wire dream module, dispose
└── lib/              # COPY at Task 10 (src → lib, keeps package main working)
test/
├── store.test.js     # MODIFY: migration + archived tests
├── service.test.js   # MODIFY: injectCandidates archive exclusion
├── dream.test.js     # CREATE: validation, application, scheduling, integration
├── inject.test.js    # MODIFY: summary-first
└── config.test.js    # CREATE (optional smoke)
```

**Module responsibilities:**
- `dream.js` — owns the whole dream lifecycle: `maybeSchedule(service)` threshold check + debounce; `runDream(ctx, service, config)` snapshot → LLM → `validateDecisions` → `applyDecisions` → summary. Pure functions `validateDecisions(decisions, snapshot)` and `applyDecisions(decisions, service)` are exported for unit testing without LLM.
- `store.js` — storage only: migration, `setArchived`, filter options.
- `service.js` — orchestration: write hooks call `dream.maybeSchedule`; injectCandidates returns summary-aware candidates.
- `inject.js` — rendering priority: summary block first, then high-importance items.

---

## Task 1: Store — archived column + schema migration

**Files:**
- Modify: `dsh-memory/src/store.js`
- Modify: `dsh-memory/test/store.test.js`

- [ ] **Step 1: Write failing tests (append to store.test.js)**

```js
test("schema migration adds archived column to legacy database", () => {
  const { DatabaseSync } = require("node:sqlite");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dsh-memory-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // Create a legacy db WITHOUT archived column
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy.close();
    // Open with createStore → should ALTER TABLE
    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    assert.ok(cols.includes("archived"), "archived column added");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setArchived marks entry archived; list excludes it by default", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const archived = store.setArchived(saved.id, true);
  assert.equal(archived.archived, true);
  assert.equal(store.list().length, 0, "excluded from default list");
  assert.equal(store.list({ includeArchived: true }).length, 1, "included with flag");
  assert.equal(store.count(), 0, "excluded from default count");
  assert.equal(store.count(undefined, { includeArchived: true }), 1);
  store.close();
});

test("search excludes archived by default", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "secret", content: "hidden content", importance: 3 });
  store.setArchived(saved.id, true);
  assert.equal(store.search("secret").length, 0);
  assert.equal(store.search("secret", { includeArchived: true }).length, 1);
  store.close();
});

test("save/update preserve archived flag", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.setArchived(saved.id, true);
  const updated = store.update(saved.id, { content: "new" });
  assert.equal(updated.archived, true, "update keeps archived");
  store.close();
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test --test-isolation=none test/store.test.js` (workdir `dsh-memory`)
Expected: FAIL (setArchived is not a function; archived column missing)

- [ ] **Step 3: Implement in store.js**

Changes:
1. SCHEMA: add `archived INTEGER NOT NULL DEFAULT 0` to CREATE TABLE (new dbs), and add a **migration block** after `db.exec(SCHEMA)`:

```js
// Schema migration: add archived column to legacy databases (idempotent)
const columns = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
if (!columns.includes("archived")) {
  db.exec("ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
}
```

2. `toRow`: add `archived: row.archived === 1`.

3. New method:

```js
function setArchived(id, archived) {
  db.prepare("UPDATE memories SET archived = ?, updated_at = ? WHERE id = ?")
    .run(archived ? 1 : 0, nowIso(), id);
  return getById(id);
}
```

4. `list`, `count`, `search`: add `includeArchived` option (default false → `archived = 0` filter), mirroring the existing `includeForgotten` pattern. `count(type, { includeForgotten = false, includeArchived = false } = {})`.

5. Export `setArchived` in the returned object.

- [ ] **Step 4: Run and confirm pass**

Run: `node --test --test-isolation=none test/store.test.js` (workdir `dsh-memory`)
Expected: PASS (17 tests: 13 existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/store.js dsh-memory/test/store.test.js
git commit -m "feat(store): archived column with migration, setArchived, archive filters"
```

---

## Task 2: Service — archive-aware + summary-aware + write hooks

**Files:**
- Modify: `dsh-memory/src/service.js`
- Modify: `dsh-memory/test/service.test.js`

- [ ] **Step 1: Write failing tests (append to service.test.js)**

```js
test("injectCandidates excludes archived entries", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "preference", title: "旧偏好", content: "old", importance: 5 });
  store.setArchived(saved.id, true);
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.ok(!candidates.some((c) => c.id === saved.id), "archived excluded");
});

test("summary memory is a candidate at top priority", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "总览内容", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.equal(candidates[0]?.type, "summary", "summary first");
});

test("write methods invoke onWrite hook when provided", () => {
  const { store } = setup();
  let called = 0;
  const svc = createService({ store, mirror: null, config: {}, onWrite: () => { called++; } });
  svc.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(called, 1, "saveWithDedupe hooks");
  svc.update(svc.all()[0].id, { content: "y" });
  assert.equal(called, 2, "update hooks");
  store.setArchived(svc.all()[0].id, true);
  assert.equal(called, 2, "setArchived does not hook (not a content write)");
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test --test-isolation=none test/service.test.js` (workdir `dsh-memory`)
Expected: FAIL (archived not excluded; summary not first; onWrite ignored)

- [ ] **Step 3: Implement in service.js**

1. `createService({ store, mirror, config, onWrite })` — accept optional `onWrite` callback; call it after successful content mutations (saveWithDedupe both branches, mergeHumanEdits when applied > 0, update, remove). NOT after setForget/setArchived.

2. `injectCandidates`: exclude archived (`!m.archived`); summary type sorts first, then existing preference-first logic:

```js
function injectCandidates({ maxItems = 5, threshold = 3 } = {}) {
  const items = store.list({ limit: 200, includeForgotten: false })
    .filter((m) => !m.archived && INJECT_TYPES.has(m.type) && !m.forgotten &&
      (m.type === "summary" || m.type === "preference" || m.importance >= threshold))
    .sort((a, b) => {
      const pa = a.type === "summary" ? 0 : a.type === "preference" ? 1 : 2;
      const pb = b.type === "summary" ? 0 : b.type === "preference" ? 1 : 2;
      return pa - pb || b.importance - a.importance;
    });
  return items.slice(0, maxItems);
}
```

Add `"summary"` to `INJECT_TYPES` set.

- [ ] **Step 4: Run and confirm pass**

Run: `node --test --test-isolation=none test/service.test.js` (workdir `dsh-memory`)
Expected: PASS (11 tests: 8 existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/service.js dsh-memory/test/service.test.js
git commit -m "feat(service): archive-aware inject candidates, summary priority, onWrite hook"
```

---

## Task 3: Config — 4 new keys

**Files:**
- Modify: `dsh-memory/src/config.js`

- [ ] **Step 1: Extend Config schema**

`dsh-memory/src/config.js`:
```js
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  maxInjectedItems: z.natural().min(1).max(20).default(5),
  importanceThreshold: z.natural().min(1).max(5).default(3),
  autoDream: z.boolean().default(true),
  dreamThresholdCount: z.natural().min(1).max(1000).default(10),
  dreamThresholdChars: z.natural().min(100).max(100000).default(5000),
  dreamDelayMs: z.natural().min(0).max(60000).default(2000)
});
```

- [ ] **Step 2: Verify defaults resolve**

Run: `node -e "import('./src/config.js').then(m => { const c = m.Config({}); console.log(JSON.stringify({autoDream: c.autoDream, count: c.dreamThresholdCount, chars: c.dreamThresholdChars, delay: c.dreamDelayMs})); })"` (workdir `dsh-memory`)
Expected: `{"autoDream":true,"count":10,"chars":5000,"delay":2000}` (requires schemastery resolvable via node_modules junction — works)

- [ ] **Step 3: Commit**

```bash
git add dsh-memory/src/config.js
git commit -m "feat(config): autoDream threshold and delay keys"
```

---

## Task 4: Dream — decision validation (pure)

**Files:**
- Create: `dsh-memory/src/dream.js`
- Create: `dsh-memory/test/dream.test.js`

- [ ] **Step 1: Write failing tests**

`dsh-memory/test/dream.test.js`:
```js
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
    { action: "merge", ids: ["b", "c"], title: "bc", content: "merged", importance: 4, keepSource: "b" },
    { action: "archive", ids: ["a"], reason: "dup" }
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
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test --test-isolation=none test/dream.test.js` (workdir `dsh-memory`)
Expected: FAIL (Cannot find module '../src/dream.js')

- [ ] **Step 3: Implement validateDecisions**

`dsh-memory/src/dream.js` (first part):
```js
const ACTIONS = new Set(["keep", "merge", "archive", "conflict"]);

/**
 * Validate a dream decision list against a snapshot of eligible memories.
 * @param decisions - LLM-produced decision list.
 * @param snapshot - Map<id, memory> of eligible (non-archived, non-summary) entries.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateDecisions(decisions, snapshot) {
  const errors = [];
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { ok: false, errors: ["decision list must be a non-empty array"] };
  }
  const claimed = new Set();
  for (const [index, d] of decisions.entries()) {
    const at = `decision[${index}]`;
    if (!d || typeof d !== "object" || !ACTIONS.has(d.action)) {
      errors.push(`${at}: invalid action ${JSON.stringify(d?.action)}`);
      continue;
    }
    const ids = d.action === "conflict" ? [d.winner, d.loser] : (d.ids ?? []);
    if (d.action === "conflict") {
      if (!d.winner || !d.loser || d.winner === d.loser) {
        errors.push(`${at}: conflict needs distinct winner and loser`);
        continue;
      }
    } else if (!Array.isArray(d.ids) || d.ids.length === 0) {
      errors.push(`${at}: ${d.action} needs non-empty ids`);
      continue;
    }
    for (const id of ids) {
      const mem = snapshot.get(id);
      if (!mem) {
        errors.push(`${at}: unknown id ${JSON.stringify(id)}`);
      } else if (mem.archived || mem.type === "summary") {
        errors.push(`${at}: id ${JSON.stringify(id)} is archived or summary (not eligible)`);
      }
      if (claimed.has(id)) {
        errors.push(`${at}: id ${JSON.stringify(id)} claimed by multiple decisions`);
      }
      claimed.add(id);
    }
    if (d.action === "merge") {
      if (!d.keepSource || !d.ids.includes(d.keepSource)) {
        errors.push(`${at}: merge keepSource must be one of ids`);
      }
      if (typeof d.title !== "string" || !d.title.trim() || typeof d.content !== "string" || !d.content.trim()) {
        errors.push(`${at}: merge needs non-empty title and content`);
      }
    }
  }
  // Every snapshot id must appear in at least one decision
  for (const id of snapshot.keys()) {
    if (!claimed.has(id)) errors.push(`memory ${JSON.stringify(id)} missing from decisions`);
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `node --test --test-isolation=none test/dream.test.js` (workdir `dsh-memory`)
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/dream.js dsh-memory/test/dream.test.js
git commit -m "feat(dream): decision validation (fail-safe gate)"
```

---

## Task 5: Dream — decision application (pure-ish)

**Files:**
- Modify: `dsh-memory/src/dream.js`
- Modify: `dsh-memory/test/dream.test.js`

- [ ] **Step 1: Write failing tests (append)**

```js
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { applyDecisions } from "../src/dream.js";

function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("applyDecisions merges: keepSource updated, others archived", () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const b = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const applied = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }
  ], service);
  assert.equal(applied, 1);
  const keeper = store.getById(b.id);
  assert.equal(keeper.content, "合并内容");
  assert.equal(keeper.title, "插件总览");
  assert.equal(keeper.importance, 5);
  assert.equal(store.getById(a.id).archived, true, "source archived");
});

test("applyDecisions conflict: winner kept, loser archived with provenance", () => {
  const { store, service } = dreamSetup();
  const w = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const l = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月15日", importance: 4 });
  applyDecisions([{ action: "conflict", winner: w.id, loser: l.id, reason: "更新" }], service);
  assert.equal(store.getById(l.id).archived, true);
  const winner = store.getById(w.id);
  assert.ok(winner.content.includes("8月20日"), "winner content intact");
  assert.ok(winner.content.includes("已否决旧信息"), "provenance note appended");
});

test("applyDecisions archive and keep", () => {
  const { store, service } = dreamSetup();
  const k = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const a = service.saveWithDedupe({ type: "project", title: "废弃", content: "过时" });
  applyDecisions([
    { action: "keep", ids: [k.id] },
    { action: "archive", ids: [a.id], reason: "过时" }
  ], service);
  assert.equal(store.getById(k.id).archived, false);
  assert.equal(store.getById(a.id).archived, true);
});

test("applyDecisions returns count and never throws on unknown id (skip)", () => {
  const { store, service } = dreamSetup();
  const k = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const applied = applyDecisions([{ action: "archive", ids: ["ghost"], reason: "x" }], service);
  assert.equal(applied, 0);
  assert.equal(store.getById(k.id).archived, false);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test --test-isolation=none test/dream.test.js` (workdir `dsh-memory`)
Expected: FAIL (applyDecisions not exported)

- [ ] **Step 3: Implement applyDecisions (append to dream.js)**

```js
/**
 * Apply a validated decision list to the service. Caller must validate first.
 * @returns number of applied mutations.
 */
export function applyDecisions(decisions, service) {
  let applied = 0;
  for (const d of decisions) {
    try {
      if (d.action === "keep") continue;
      if (d.action === "archive") {
        for (const id of d.ids) {
          const mem = service.getById(id);
          if (mem && !mem.archived) { service.setArchived(id, true); applied++; }
        }
      } else if (d.action === "merge") {
        const keeper = service.getById(d.keepSource);
        if (!keeper || keeper.archived) continue;
        service.update(d.keepSource, {
          title: d.title,
          content: d.content,
          importance: d.importance ?? Math.max(keeper.importance, ...d.ids.map((id) => service.getById(id)?.importance ?? 1))
        });
        for (const id of d.ids) {
          if (id !== d.keepSource) {
            const mem = service.getById(id);
            if (mem && !mem.archived) { service.setArchived(id, true); applied++; }
          }
        }
        applied++;
      } else if (d.action === "conflict") {
        const winner = service.getById(d.winner);
        const loser = service.getById(d.loser);
        if (!winner || !loser) continue;
        service.update(d.winner, {
          content: `${winner.content}\n\n（已否决旧信息：${loser.content.slice(0, 100)}）`
        });
        service.setArchived(d.loser, true);
        applied++;
      }
    } catch (error) {
      // Skip individual bad decision; never corrupt the store
      continue;
    }
  }
  return applied;
}
```

> Note: `service` must expose `setArchived` as a passthrough to store — **add it** in Task 2's service extension if not already present (add `setArchived: (id, f) => store.setArchived(id, f)` to the passthrough list).

- [ ] **Step 4: Run and confirm pass**

Run: `node --test --test-isolation=none test/dream.test.js` (workdir `dsh-memory`)
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/dream.js dsh-memory/test/dream.test.js
git commit -m "feat(dream): decision application (merge/archive/conflict with provenance)"
```

---

## Task 6: Dream — scheduling + full run + summary

**Files:**
- Modify: `dsh-memory/src/dream.js`
- Modify: `dsh-memory/test/dream.test.js`

- [ ] **Step 1: Write failing tests (append)**

```js
test("maybeSchedule triggers when count exceeds threshold", () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; },
    thresholdCount: 3,
    thresholdChars: 5000,
    delayMs: 0
  });
  for (let i = 0; i < 3; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(100) });
  const pending = dream.maybeSchedule(service);
  assert.equal(pending, true, "scheduled");
  assert.equal(runs, 0, "not run yet (async)");
  store.close();
});

test("maybeSchedule does not trigger below threshold", () => {
  const { store, service } = dreamSetup();
  const dream = createDreamScheduler({ onRun: async () => {}, thresholdCount: 10, thresholdChars: 5000, delayMs: 0 });
  service.saveWithDedupe({ type: "project", title: "only", content: "x" });
  assert.equal(dream.maybeSchedule(service), false);
  store.close();
});

test("runDream stores summary and applies merge decisions", async () => {
  const { store, service } = dreamSetup();
  const llmOutput = JSON.stringify([
    { action: "keep", ids: [] },
    { action: "archive", ids: [], reason: "x" }
  ]);
  // build a fake ctx.llm that returns decisions on first call and summary on second
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        const text = calls === 1
          ? JSON.stringify([
              { action: "keep", ids: [] }
            ])
          : "记忆库总览摘要文本";
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", text };
        yield { type: "block-end", block: { type: "text" } };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
  // seed 1 memory so snapshot is non-empty
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { maxTokens: 100 });
  assert.equal(result.ok, true);
  const summary = store.all().find((m) => m.type === "summary");
  assert.ok(summary, "summary created");
  assert.equal(summary.title, "记忆库总览");
  assert.equal(summary.content, "记忆库总览摘要文本");
  store.close();
});

test("runDream fails safe on invalid decisions", async () => {
  const { store, service } = dreamSetup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        yield { type: "block-start", block: { type: "text" } };
        yield { type: "text-delta", text: calls === 1 ? "not json at all" : "summary" };
        yield { type: "block-end", block: { type: "text" } };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false, "invalid decisions rejected");
  assert.equal(store.all().filter((m) => m.type === "summary").length, 0, "no summary on failure");
  store.close();
});

test("scheduler fires async and resets baseline", async () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5
  });
  for (let i = 0; i < 2; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(50) });
  dream.maybeSchedule(service);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 1, "ran once");
  // still above threshold but baseline reset → no immediate re-trigger
  assert.equal(dream.maybeSchedule(service), false, "baseline prevents loop");
  store.close();
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test --test-isolation=none test/dream.test.js` (workdir `dsh-memory`)
Expected: FAIL (createDreamScheduler not exported)

- [ ] **Step 3: Implement scheduler + runDream (append to dream.js)**

```js
const SUMMARY_PROMPT = `你是记忆库摘要助手。根据整理后的记忆，生成一段 150-200 字的记忆库总览，覆盖：用户偏好、活跃项目、关键决策。之后作为会话上下文注入。只输出摘要文本，不要其他内容。`;

const CONSOLIDATION_PROMPT = `你是记忆库整理助手。下面是全部记忆条目（id、类型、标题、内容、重要性、更新时间）。
请执行记忆巩固（consolidation）：
1. 识别主题相近的条目 → 输出 merge（合并为更精炼的摘要，保留信息最完整的 id 作为 keepSource）
2. 识别重复/过时信息 → 输出 archive
3. 识别内容矛盾的条目 → 输出 conflict（根据时间新旧、来源完整性、信息具体程度判断 winner/loser）
4. 无问题的条目 → 输出 keep

规则：
- 每条记忆至少出现在一个决策中
- merge 的 keepSource 必须是 ids 之一
- 不要编造 ids；只使用提供的 id
- 重要性 1-5，合并后取最高
- 只输出 JSON 数组，不要其他文字`;

function totalChars(memories) {
  return memories.reduce((sum, m) => sum + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0);
}

async function streamText(ctx, options) {
  const assembler = new BlockAssembler();
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    assembler.push(chunk);
    if (chunk.type === "finish") {
      if (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted") return undefined;
    }
  }
  return text || assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("");
}

export function createDreamScheduler({ onRun, thresholdCount = 10, thresholdChars = 5000, delayMs = 2000 }) {
  let pendingTimer = null;
  let running = false;
  let baseline = { count: 0, chars: 0 };

  function shouldTrigger(service) {
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    const count = memories.length;
    const chars = totalChars(memories);
    const overBase = count > baseline.count + thresholdCount || chars > baseline.chars + thresholdChars;
    const overAbs = count > thresholdCount || chars > thresholdChars;
    return { trigger: overAbs && overBase, count, chars };
  }

  function maybeSchedule(service) {
    if (running || pendingTimer) return false;
    const { trigger, count, chars } = shouldTrigger(service);
    if (!trigger) return false;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      running = true;
      const p = Promise.resolve(onRun ? onRun() : Promise.resolve())
        .catch(() => {})
        .finally(() => {
          running = false;
          baseline = { count, chars }; // reset baseline to current snapshot
        });
    }, delayMs);
    return true;
  }

  function dispose() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  async function runDream(ctx, service, config) {
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary");
    if (memories.length === 0) return { ok: true, applied: 0, skipped: true };
    const snapshot = new Map(memories.map((m) => [m.id, m]));
    const route = resolveRoute(ctx, service);
    if (!route) return { ok: false, error: "no llm route" };

    const listText = [...snapshot.values()].map((m) =>
      `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`
    ).join("\n");

    const decisionText = await streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.maxTokens ?? 4096,
      messages: [
        { role: "system", content: [{ type: "text", text: CONSOLIDATION_PROMPT }] },
        { role: "user", content: [{ type: "text", text: listText }] }
      ]
    });
    if (decisionText === undefined) return { ok: false, error: "llm failed" };

    let decisions;
    try {
      const start = decisionText.indexOf("[");
      const end = decisionText.lastIndexOf("]");
      decisions = JSON.parse(decisionText.slice(start, end + 1));
    } catch {
      return { ok: false, error: "invalid decisions json" };
    }
    const { ok, errors } = validateDecisions(decisions, snapshot);
    if (!ok) return { ok: false, error: `invalid decisions: ${errors.join("; ")}` };

    const applied = applyDecisions(decisions, service);

    // Summary generation (second LLM call)
    const summaryText = await streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      maxTokens: config.maxTokens ?? 2048,
      messages: [
        { role: "system", content: [{ type: "text", text: SUMMARY_PROMPT }] },
        { role: "user", content: [{ type: "text", text: service.all().filter((m) => !m.archived && m.type !== "summary").map((m) => `- ${m.title}: ${m.content}`).join("\n") }] }
      ]
    });
    if (summaryText !== undefined && summaryText.trim()) {
      service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: summaryText.trim(), importance: 5, source: "dream" });
    }
    return { ok: true, applied };
  }

  return { maybeSchedule, runDream, dispose };
}

function resolveRoute(ctx, service) {
  // Prefer explicit config via ctx? We don't have session here; use default from any memory source field is overkill.
  // Simplest: require ctx.llm callers to pass route via config, or derive from env default.
  // For v1: use a fixed default pair passed in config or fall back to deepseek defaults.
  return { provider: "deepseek", model: "deepseek-chat" };
}
```

> **ROUTE RESOLUTION — RESOLVED (research done by controller 2026-08-13):** dream runs outside any session, so there is no `session.requestHeader()`. The correct mechanism is **`ctx.agentDefaultModel.currentSelection()`** (verified: `@deepseek-ai/dsh-agent-default-model` lib/index.js line 56, returns `{provider, model, reasoningEffort?}`; the service is part of the dsh-base bundle composition, available in the web profile). Fallback chain in `resolveRoute(ctx)`:
> 1. `ctx.agentDefaultModel?.currentSelection?.()` → `{provider, model}` if both present
> 2. `config.dreamProvider && config.dreamModel` (add these two keys to config.js in Task 6 — `z.string()` optional, no default)
> 3. `undefined` → `runDream` returns `{ok:false, error:"no llm route"}` (fail-safe, no crash)
> The `inject` export must include `"agentDefaultModel"` when the plugin reads it — verify the service is provided by an ancestor fiber in the web composition (dsh-base bundle provides it); if `ctx.agentDefaultModel` access throws without inject, add it to the inject list in Task 8 and re-verify with the real-cordis probe in Task 10.
> Also verify: the streamText `assembler.push(chunk)` may throw on the mock `{block:...}` shapes used in tests — tests use real-protocol shapes (`{type:"text-delta", text}`) so this is consistent; the real protocol has `{type:"text-delta", index, text}` which is handled.

Also import at top of dream.js: `import { BlockAssembler } from "@deepseek-ai/dsh-llm";` and the summary type must be allowed by store.save (TYPES set) — **Task 1 Step 3 must add "summary" to TYPES**; if not, add it there now.

- [ ] **Step 4: Run and confirm pass**

Run: `node --test --test-isolation=none test/dream.test.js` (workdir `dsh-memory`)
Expected: PASS (16 tests: 7 validation + 4 application + 5 scheduling/run)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/dream.js dsh-memory/test/dream.test.js
git commit -m "feat(dream): scheduler with threshold check, full run with summary generation"
```

---

## Task 7: Inject — summary-first rendering

**Files:**
- Modify: `dsh-memory/src/inject.js`
- Modify: `dsh-memory/test/inject.test.js`

- [ ] **Step 1: Write failing test (append)**

```js
test("renders summary block first when summary candidate exists", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "这是总览摘要", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  const text = contexts[0].text({});
  const summaryIdx = text.indexOf("这是总览摘要");
  const prefIdx = text.indexOf("语言");
  assert.ok(summaryIdx !== -1, "summary present");
  assert.ok(prefIdx !== -1, "preference present");
  assert.ok(summaryIdx < prefIdx, "summary rendered first");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-isolation=none test/inject.test.js` (workdir `dsh-memory`)
Expected: FAIL (summary not rendered first — service.injectCandidates already orders summary first per Task 2, so this may pass; if it passes, verify ordering and mark the test as regression coverage)

> Note: Task 2 already sorts summary first in injectCandidates, so inject.js may need no change. Verify the existing render loop; if candidates are already summary-first, this test is pure regression coverage and the task is a no-op implementation-wise. If render needs no change, commit the test alone with message `test(inject): summary-first regression coverage`.

- [ ] **Step 3: Adjust inject.js only if needed** (see Step 2 note — likely no change)

- [ ] **Step 4: Run and confirm pass**

Run: `node --test --test-isolation=none test/inject.test.js` (workdir `dsh-memory`)
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/inject.js dsh-memory/test/inject.test.js
git commit -m "test(inject): summary-first injection coverage"
```

---

## Task 8: Index wiring — dream lifecycle

**Files:**
- Modify: `dsh-memory/src/index.js`

- [ ] **Step 1: Wire dream into apply**

Changes to `dsh-memory/src/index.js`:
1. Import: `import { createDreamScheduler } from "./dream.js";`
2. In `apply`, after service creation:

```js
  let dream = null;
  if (cfg.autoDream) {
    dream = createDreamScheduler({
      thresholdCount: cfg.dreamThresholdCount,
      thresholdChars: cfg.dreamThresholdChars,
      delayMs: cfg.dreamDelayMs,
      onRun: () => dream ? dream.runDream(ctx, service, cfg) : Promise.resolve()
    });
    // hook writes
    service.setDreamHook(() => dream.maybeSchedule(service));
  }
```

3. In the dispose closure: `if (dream) dream.dispose();` (before `store.close()`).

4. The `inject` export already includes `"llm"` — keep it.

- [ ] **Step 2: Verify wiring with a smoke probe**

Write `dsh-memory/probe-dream.mjs` (delete after):
```js
import { apply } from "./src/index.js";
const registered = { tools: [], contexts: [], routes: [] };
const ctx = {
  inject: (deps, cb) => { cb(ctx); return {}; },
  on: () => () => {},
  logger: { warn: () => {} },
  tools: { register: (t) => { registered.tools.push(t); return () => {}; } },
  systemPrompt: { context: (c) => { registered.contexts.push(c); return () => {}; } },
  webServer: { register: (r) => { registered.routes.push(r); return () => {}; } },
  llm: { stream: async function* () { return; } }
};
const dispose = apply(ctx, { memoryDir: ".probe-dream-mem" });
console.log("tools:", registered.tools.length, "contexts:", registered.contexts.length, "routes:", registered.routes.length);
dispose();
console.log("dispose ok");
```
Run: `node probe-dream.mjs` (workdir `dsh-memory`)
Expected: `tools: 6 contexts: 1 routes: 3` + `dispose ok`; `.probe-dream-mem` cleaned up afterwards.

- [ ] **Step 3: Commit**

```bash
git add dsh-memory/src/index.js
git commit -m "feat(index): wire dream scheduler with write hook and dispose"
```

---

## Task 9: Full test suite + src→lib sync

**Files:**
- All of `dsh-memory/src/` and `dsh-memory/lib/`

- [ ] **Step 1: Run full suite**

Run: `node --test --test-isolation=none test/*.test.js` (workdir `dsh-memory`)
Expected: ALL PASS (64 existing + new dream 16 + store 4 + service 3 + inject 1 = ~88; exact count depends on what was added)

- [ ] **Step 2: Sync src → lib**

```powershell
Copy-Item src\*.js lib\ -Force
```

- [ ] **Step 3: Verify byte-identical**

Run (PowerShell): `Get-ChildItem src\*.js | ForEach-Object { $l = "lib\$($_.Name)"; if (-not (Test-Path $l)) { Write-Host "MISSING $l" } elseif ((Get-FileHash $_.FullName).Hash -ne (Get-FileHash $l).Hash) { Write-Host "DIFF $($_.Name)" } }; Write-Host "sync check done"` (workdir `dsh-memory`)
Expected: `sync check done` with no MISSING/DIFF lines

- [ ] **Step 4: Smoke — module loads**

Run: `node -e "import('./lib/index.js').then(m => console.log('exports:', Object.keys(m).join(',')))"` (workdir `dsh-memory`)
Expected: `exports: Config,apply,inject,name`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: sync src to lib for dream module"
```

---

## Task 10: Integration verification with real cordis

**Files:**
- Probe only (deleted after)

- [ ] **Step 1: Write real-cordis lifecycle probe** (modeled on the v0.1 final-review probe that caught the inject/arrow-apply bugs)

`dsh-memory/probe-real-dream.mjs`:
```js
import { Context } from "@deepseek-ai/cordis";
// Load plugin entry exactly as cordis loader would
const mod = await import("./lib/index.js");
console.log("exports:", Object.keys(mod).join(","));
console.log("inject:", JSON.stringify(mod.inject));
console.log("apply is arrow (no prototype):", mod.apply.prototype === undefined);

// Simulate cordis fiber: check that every ctx service read is declared in inject
const ctx = new Context();
const missing = [];
for (const key of ["tools", "systemPrompt", "webServer", "llm"]) {
  try { const v = ctx[key]; if (!v) missing.push(`${key}:undefined`); }
  catch (e) { missing.push(`${key}:${e.message}`); }
}
console.log("ctx service check:", missing.length ? missing.join(" | ") : "all resolvable after provide");
```

> The probe verifies the *contract shape*; full boot requires the real profile (`dsh web`), which the user restarts. Report the probe result and note the restart requirement.

- [ ] **Step 2: Verify the plugin entry is still loadable by the profile loader**

Run: `node -e "import('file:///D:/deepseek%20harness/dsh-memory/lib/index.js').then(m => console.log('loads:', Object.keys(m).join(',')))"` (workdir anywhere)
Expected: loads Config,apply,inject,name

- [ ] **Step 3: Update the profile patch config with dream keys** (requires user-permission write to `C:\Users\石晴\.dsh\profiles\web\cordis.patch.yml` — the parent agent applies this, mirroring the Task-11 pattern; the executor prepares the exact YAML):

```yaml
# dsh-memory 记忆库插件（insert 追加到根 entry 列表）
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        memoryDir: ~/.dsh/memory
        autoInject: true
        autoSummarize: true
        maxInjectedItems: 5
        importanceThreshold: 3
        autoDream: true
        dreamThresholdCount: 10
        dreamThresholdChars: 5000
        dreamDelayMs: 2000
```

- [ ] **Step 4: Clean probes, commit**

```bash
Remove-Item probe-real-dream.mjs -ErrorAction SilentlyContinue
git add -A
git commit -m "chore: verify dream wiring against cordis contract"
```

---

## Self-Review (run before execution handoff)

**1. Spec coverage:**
- Archived state + migration → Task 1 ✅
- Threshold trigger + async scheduling + baseline reset → Task 6 ✅
- LLM decision list (keep/merge/archive/conflict) → Tasks 4-6 ✅
- Dedupe via merge (keep complete + recent) → Task 5 merge logic ✅
- Conflict resolution (winner kept, loser archived, provenance) → Task 5 ✅
- Summary generation (single instance, excluded from dream scope) → Task 6 ✅
- Summary-first injection → Tasks 2, 7 ✅
- Config keys (autoDream, dreamThresholdCount/Chars, dreamDelayMs) → Task 3 ✅
- Fail-safe on invalid LLM output → Tasks 4, 6 ✅
- Web panel archive visibility → noted as optional enhancement in design (not in scope for this plan) — acceptable per design §10 note
- lib sync → Task 9 ✅
- Real-cordis integration verification → Task 10 ✅

**2. Placeholder scan:** The only marked-uncertain item is `resolveRoute` in Task 6 — it has an explicit instruction to replace with the real `ctx.agentDefaultModel` mechanism or config keys, with the decision reported. This is a directed investigation step, not a placeholder. `purpose: "compaction"` is used for dream LLM calls (existing valid purpose in dsh-llm).

**3. Type consistency:**
- `createDreamScheduler({onRun, thresholdCount, thresholdChars, delayMs})` → `{maybeSchedule, runDream, dispose}` — used identically in Tasks 6, 8
- `validateDecisions(decisions, snapshot)` → `{ok, errors}`; `applyDecisions(decisions, service)` → number — consistent across tests and implementation
- `store.setArchived(id, bool)` returns memory; `service.setArchived` passthrough added in Task 2; list/count/search `includeArchived` option consistent
- `type: "summary"` added to store TYPES in Task 1 and INJECT_TYPES in Task 2 — must both happen for tests to pass
- Config keys match between config.js (Task 3), cordis.patch.yml (Task 10), and dream scheduler usage (Task 6)
- Test counts: store 13+4=17, service 8+3=11, dream 7+4+5=16, inject 3+1=4 → total 64+4+3+16+1=88 (exact depends on implementation)

**Known risks (documented for the executor):**
- `resolveRoute` needs the real agent-default-model API — investigate `dsh-agent-default-model` README/lib before finalizing Task 6; fallback is config keys `dreamProvider`/`dreamModel` (add to config.js).
- Real `llm/stream` chunk shape is `{type:"text-delta", index, text}` — the `streamText` helper handles both `chunk.text` and assembler fallback; mock tests use real-protocol shapes.
- The `agent-default-model` service may be optional in the composition; the fallback chain must not throw.
- Baseline reset uses the snapshot at schedule time; if writes happen between schedule and run, the baseline may be slightly stale — acceptable (next write re-triggers).
