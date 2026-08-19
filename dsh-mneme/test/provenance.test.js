import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

const openMemory = () => createStore(":memory:");

// Memory provenance (v0.5.x): every memory born from a session carries its
// session_id so v0.6.0 reasoning-path / interest-drift analysis can rebuild
// the derivation chain later. session_id is birth provenance — set once at
// creation, preserved by merges, never fabricated when no session exists.

test("save persists session_id and returns it", () => {
  const store = openMemory();
  const saved = store.save({
    type: "preference",
    title: "A",
    content: "c",
    tags: [],
    importance: 3,
    source: "tool",
    session_id: "session-42"
  });
  assert.equal(saved.session_id, "session-42");
  assert.equal(store.getById(saved.id).session_id, "session-42");
  store.close();
});

test("save without session_id leaves it undefined (never fabricated)", () => {
  const store = openMemory();
  const saved = store.save({ type: "history", title: "B", content: "c" });
  assert.equal(saved.session_id, undefined);
  store.close();
});

test("dedupe merge keeps the ORIGINAL session_id (provenance = birth)", () => {
  const store = openMemory();
  const service = createService({ store, mirror: null, config: {} });
  service.saveWithDedupe({
    type: "preference", title: "语言", content: "中文", session_id: "session-1"
  });
  const merged = service.saveWithDedupe({
    type: "preference", title: "语言", content: "中文 + 英文", session_id: "session-2"
  });
  assert.equal(merged.action, "merged");
  assert.equal(store.getById(merged.memory.id).session_id, "session-1");
  store.close();
});

test("memory_save tool records exec.agent.session.id as session_id", async () => {
  const store = openMemory();
  const service = createService({ store, mirror: null, config: {} });
  const ctx = { tools: { register() { return () => {}; } } };
  const tools = createTools(ctx, service, {}, undefined);
  const saveTool = tools.find((t) => t.name === "memory_save");
  const out = await saveTool.execute(
    { type: "decision", title: "T", content: "c" },
    { agent: { session: { id: "session-tool-9" } } }
  );
  assert.equal(store.getById(out.id).session_id, "session-tool-9");
  store.close();
});

test("memory_save tool without agent context leaves session_id null", async () => {
  const store = openMemory();
  const service = createService({ store, mirror: null, config: {} });
  const ctx = { tools: { register() { return () => {}; } } };
  const tools = createTools(ctx, service, {}, undefined);
  const saveTool = tools.find((t) => t.name === "memory_save");
  const out = await saveTool.execute({ type: "decision", title: "T2", content: "c" }, {});
  assert.equal(store.getById(out.id).session_id, undefined);
  store.close();
});

test("legacy DB without session_id column migrates and saves with provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-prov-"));
  const dbPath = join(dir, "legacy.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
    forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    source TEXT, content_history TEXT, embedding TEXT,
    epistemic_status TEXT NOT NULL DEFAULT 'subjective',
    last_accessed_at TEXT, _full_content TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  db.close();
  const store = createStore(dbPath);
  const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  assert.ok(cols.includes("session_id"), "session_id column added by migration");
  const saved = store.save({
    type: "history", title: "旧库", content: "迁移后仍可溯源", session_id: "session-legacy"
  });
  assert.equal(store.getById(saved.id).session_id, "session-legacy");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
