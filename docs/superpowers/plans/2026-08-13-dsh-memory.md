# dsh-memory 记忆库插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local `dsh-memory` plugin giving the DeepSeek Harness agent persistent cross-session memory: SQLite+FTS5 storage with Markdown mirrors, 6 model-facing tools, automatic context injection, automatic session summarization, and a basic Web GUI memory panel.

**Architecture:** A Cordis plugin package `dsh-memory` installed into the `web` profile via `file:` dependency. Host side (`src/*.js`) registers tools on `ctx.tools`, dynamic context on `ctx.systemPrompt.context`, session summarization on `session/event`, and a `/api/dsh-memory` HTTP route on `ctx.webServer`. Client side (`lib/client.js`, hand-written `window.__ModuleLoader__.load` bundle — no build step) registers a sidebar footer action opening a memory panel that fetches the host HTTP API. Storage: `node:sqlite` `DatabaseSync` (Node 24 built-in, FTS5) at `~/.dsh/memory/memory.db` with Markdown mirrors per type.

**Tech Stack:** Node 24 (`node:sqlite`), Cordis 4 (`@deepseek-ai/cordis`), `@deepseek-ai/dsh-tools` (defineTool), `@deepseek-ai/dsh-llm` (LLM calls), `@deepseek-ai/dsh-system-prompt` (context injection), `@deepseek-ai/dsh-host-webserver` (HTTP routes), React 18 (client panel, via `require("react")`), `node:test` (tests). Plugin written in plain ESM JavaScript — zero build tooling required.

---

## File Structure

```
D:\deepseek harness\
├── docs/superpowers/specs/2026-08-13-dsh-mneme-design.md   # approved design
├── dsh-memory/                                                # THE PLUGIN
│   ├── package.json
│   ├── .gitignore
│   ├── src/
│   │   ├── index.js            # plugin entry: apply(ctx, config), wire everything
│   │   ├── config.js           # schemastery Config schema
│   │   ├── store.js            # MemoryStore: SQLite CRUD + FTS5 search + LIKE fallback
│   │   ├── mirror.js           # Markdown mirror sync (bidirectional, human-first)
│   │   ├── service.js          # MemoryService: dedupe merge, inject candidates, http api
│   │   ├── tools.js            # 6 tools: memory_save/search/list/update/delete/forget
│   │   ├── inject.js           # ctx.systemPrompt.context provider
│   │   ├── summarize.js        # session/event listener → LLM summary → store
│   │   └── api.js              # ctx.webServer routes /api/dsh-memory/*
│   ├── lib/
│   │   └── client.js           # hand-written client bundle (ModuleLoader format)
│   └── test/
│       ├── store.test.js
│       ├── mirror.test.js
│       ├── service.test.js
│       ├── tools.test.js
│       ├── summarize.test.js
│       └── api.test.js
└── ~/.dsh/memory/              # runtime data (created by plugin)
    ├── memory.db
    ├── preferences.md
    ├── projects.md
    ├── decisions.md
    └── history.md
```

**Module responsibility map:**
- `config.js` — schemastery `Config` object; single source of config truth.
- `store.js` — pure storage; owns SQLite schema, CRUD, search. No cordis imports.
- `mirror.js` — pure Markdown sync; reads/writes `.md` mirrors, human-edit wins.
- `service.js` — domain logic on top of store: dedupe merge, inject candidate selection, HTTP-friendly DTOs.
- `tools.js` — maps tool calls to service methods; `defineTool` definitions.
- `inject.js` — registers the dynamic `PromptContext` provider.
- `summarize.js` — listens `session/event`, calls `ctx.llm`, writes summaries.
- `api.js` — registers `ctx.webServer` routes; JSON in/out.
- `index.js` — composes all of the above in `apply(ctx, config)`.

---

## Task 1: Plugin skeleton + git

**Files:**
- Create: `dsh-memory/package.json`
- Create: `dsh-memory/.gitignore`
- Create: `.gitignore` (workspace root)

- [ ] **Step 1: Init git at workspace root and write root `.gitignore`**

```bash
git init
```

`D:\deepseek harness\.gitignore`:
```gitignore
node_modules/
*.log
.DS_Store
```

- [ ] **Step 2: Write `dsh-memory/package.json`**

```json
{
  "name": "dsh-memory",
  "description": "Cross-session memory plugin for DeepSeek Harness: SQLite+FTS5 store, Markdown mirrors, model tools, automatic injection & summarization, Web GUI panel",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": {
      "default": "./lib/index.js"
    },
    "./client": {
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["lib", "src"],
  "dsh": {
    "client": {
      "inject": ["slots", "locale", "layout", "connection"],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-llm": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-system-prompt": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-host-webserver": "^0.1.0-rc.6",
    "@deepseek-ai/schemastery": "^3.18.1"
  }
}
```

> Note: `main` points at `lib/index.js`; Task 11 copies `src/*.js` → `lib/` (no compile step — plain ESM). Client bundle is hand-written at `lib/client.js`.

- [ ] **Step 3: Write `dsh-memory/.gitignore`**

```gitignore
node_modules/
*.log
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: workspace root and dsh-memory skeleton"
```

---

## Task 2: SQLite store — schema + CRUD

**Files:**
- Create: `dsh-memory/src/store.js`
- Test: `dsh-memory/test/store.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/store.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

function openMemory() {
  return createStore(":memory:");
}

test("createStore initializes schema and opens db", () => {
  const store = openMemory();
  const row = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
  ).get();
  assert.ok(row, "memories table exists");
  store.close();
});

test("save inserts a memory and returns it with id/created_at", () => {
  const store = openMemory();
  const saved = store.save({
    type: "preference",
    title: "语言",
    content: "用户用中文交流",
    tags: ["偏好"],
    importance: 5,
    source: "manual"
  });
  assert.ok(saved.id, "has id");
  assert.ok(saved.created_at, "has created_at");
  assert.equal(saved.type, "preference");
  assert.equal(store.count(), 1);
  store.close();
});

test("getById returns the memory", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const got = store.getById(saved.id);
  assert.equal(got.title, "t");
  assert.equal(got.content, "c");
  store.close();
});

test("update modifies fields and bumps updated_at", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 3 });
  const updated = store.update(saved.id, { content: "new content", importance: 4 });
  assert.equal(updated.content, "new content");
  assert.equal(updated.importance, 4);
  assert.notEqual(updated.updated_at, saved.updated_at);
  store.close();
});

test("remove deletes the memory", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c" });
  store.remove(saved.id);
  assert.equal(store.getById(saved.id), undefined);
  assert.equal(store.count(), 0);
  store.close();
});

test("list filters by type and paginates", () => {
  const store = openMemory();
  for (let i = 0; i < 5; i++) store.save({ type: "preference", title: `p${i}`, content: "c" });
  for (let i = 0; i < 3; i++) store.save({ type: "project", title: `j${i}`, content: "c" });
  assert.equal(store.list({ type: "preference" }).length, 5);
  assert.equal(store.list({ type: "project" }).length, 3);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ limit: 2, offset: 2 }).length, 2);
  store.close();
});

test("setForget toggles injection suppression", () => {
  const store = openMemory();
  const saved = store.save({ type: "project", title: "t", content: "c", importance: 5 });
  store.setForget(saved.id, true);
  const got = store.getById(saved.id);
  assert.equal(got.forgotten, 1);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/store.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/store.js`:
```js
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  importance  INTEGER NOT NULL DEFAULT 3,
  forgotten   INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
`;

const TYPES = new Set(["preference", "project", "decision", "history"]);

function nowIso() {
  return new Date().toISOString();
}

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    importance: row.importance,
    forgotten: row.forgotten === 1,
    source: row.source ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  function count() {
    return db.prepare("SELECT count(*) AS c FROM memories").get().c;
  }

  function getById(id) {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return toRow(row);
  }

  function save(memory) {
    const id = memory.id ?? randomUUID();
    const type = memory.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    const now = nowIso();
    const tags = JSON.stringify(memory.tags ?? []);
    const importance = Number.isInteger(memory.importance) ? memory.importance : 3;
    db.prepare(
      `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(id, type, memory.title, memory.content, tags, importance, memory.source ?? null, now, now);
    return getById(id);
  }

  function update(id, patch) {
    const existing = getById(id);
    if (!existing) throw new Error(`memory not found: ${id}`);
    const type = patch.type ?? existing.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    const now = nowIso();
    db.prepare(
      `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, updated_at=? WHERE id=?`
    ).run(
      type,
      patch.title ?? existing.title,
      patch.content ?? existing.content,
      JSON.stringify(patch.tags ?? existing.tags),
      Number.isInteger(patch.importance) ? patch.importance : existing.importance,
      patch.source !== undefined ? patch.source : (existing.source ?? null),
      now,
      id
    );
    return getById(id);
  }

  function remove(id) {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  function setForget(id, forgotten) {
    db.prepare("UPDATE memories SET forgotten = ?, updated_at = ? WHERE id = ?")
      .run(forgotten ? 1 : 0, nowIso(), id);
    return getById(id);
  }

  function list({ type, limit = 50, offset = 0, includeForgotten = false } = {}) {
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (!includeForgotten) {
      clauses.push("forgotten = 0");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM memories ${where} ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    return rows.map(toRow);
  }

  function all() {
    const rows = db.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all();
    return rows.map(toRow);
  }

  function search(query, { limit = 20 } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    // FTS5 over unicode61 (English + long phrases); LIKE fallback covers CJK substring.
    const like = `%${q}%`;
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE forgotten = 0 AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
       ORDER BY
         CASE WHEN title LIKE ? THEN 0 ELSE 1 END,
         importance DESC,
         updated_at DESC
       LIMIT ?`
    ).all(like, like, like, like, limit);
    return rows.map(toRow);
  }

  return {
    db,
    count,
    getById,
    save,
    update,
    remove,
    setForget,
    list,
    all,
    search,
    close() {
      db.close();
    }
  };
}
```

> Design note: FTS5 tables were evaluated during research — `unicode61` treats a whole CJK run as one token and `trigram` needs ≥3 chars, so neither reliably matches 2-char Chinese queries like "世界". A `LIKE '%q%'` scan over the (small, personal) memory corpus is the reliable path; FTS5 stays available for future scale. This matches the DSH session-search plugin's documented substring-scan fallback (`filterEvents` text clause).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js` (workdir `dsh-memory`)
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/store.js dsh-memory/test/store.test.js
git commit -m "feat(store): sqlite schema, CRUD, list, search with LIKE fallback"
```

---

## Task 3: Markdown mirror sync

**Files:**
- Create: `dsh-memory/src/mirror.js`
- Test: `dsh-memory/test/mirror.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/mirror.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirror } from "../src/mirror.js";

const TYPE_FILE = { preference: "preferences.md", project: "projects.md", decision: "decisions.md", history: "history.md" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-memory-mirror-"));
}

function sampleMemory(type, over = {}) {
  return {
    id: "m1", type, title: "标题", content: "内容",
    tags: ["a"], importance: 3, forgotten: false,
    source: undefined, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", ...over
  };
}

test("mirror writes one markdown file per type on sync", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([
      sampleMemory("preference"),
      sampleMemory("project")
    ]);
    assert.ok(mirror.filePath("preference").endsWith("preferences.md"));
    for (const type of ["preference", "project"]) {
      const text = readFileSync(join(dir, TYPE_FILE[type]), "utf8");
      assert.ok(text.includes("m1"), `${type} file contains id`);
      assert.ok(text.includes("标题"), `${type} file contains title`);
      assert.ok(text.includes("内容"), `${type} file contains content`);
    }
    assert.ok(mirror.filePath("decision").includes("decisions"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirror groups multiple memories newest-first with header", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([
      sampleMemory("project", { id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
      sampleMemory("project", { id: "new", updated_at: "2026-02-01T00:00:00.000Z" })
    ]);
    const text = readFileSync(join(dir, "projects.md"), "utf8");
    const iNew = text.indexOf("new");
    const iOld = text.indexOf("old");
    assert.ok(iNew !== -1 && iOld !== -1 && iNew < iOld, "newest first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human edit wins on next sync (bidirectional, human-first)", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([sampleMemory("preference", { id: "m1", content: "机器内容" })]);
    // human edits the mirror file
    const file = join(dir, "preferences.md");
    const edited = readFileSync(file, "utf8").replace("机器内容", "人类编辑内容");
    writeFileSync(file, edited, "utf8");
    const humanEdits = mirror.readHumanEdits();
    assert.ok(Array.isArray(humanEdits));
    const m1 = humanEdits.find((e) => e.id === "m1");
    assert.ok(m1, "detects human edit for m1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mirror.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/mirror.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/mirror.js`:
```js
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const TYPE_FILE = {
  preference: "preferences.md",
  project: "projects.md",
  decision: "decisions.md",
  history: "history.md"
};

const ESCAPE = /([\\`*_[\]{}()#+.!|>~-])/g;

function esc(text) {
  return String(text).replace(ESCAPE, "\\$1");
}

function renderMemory(m) {
  const lines = [];
  lines.push(`## ${esc(m.title)}`);
  lines.push("");
  lines.push(`- **ID**: \`${m.id}\``);
  lines.push(`- **类型**: ${m.type}`);
  lines.push(`- **重要性**: ${m.importance}`);
  lines.push(`- **标签**: ${m.tags.map((t) => `\`${esc(t)}\``).join(" ")}`);
  lines.push(`- **更新时间**: ${m.updated_at}`);
  if (m.source) lines.push(`- **来源**: ${esc(m.source)}`);
  lines.push("");
  lines.push(m.content);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

export function createMirror(dir) {
  mkdirSync(dir, { recursive: true });

  function filePath(type) {
    const name = TYPE_FILE[type];
    return name ? join(dir, name) : undefined;
  }

  /**
   * Parse a mirror file back into {id, content} pairs for human edits.
   * Format per block:
   *   ## title
   *   - **ID**: `m1`
   *   ...metadata...
   *   <blank>
   *   content body until "---"
   */
  function readHumanEdits(type) {
    const file = filePath(type);
    if (!file || !existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    const blocks = text.split(/^---\s*$/m);
    const edits = [];
    for (const block of blocks) {
      const idMatch = block.match(/^- \*\*ID\*\*: `([^`]+)`/m);
      if (!idMatch) continue;
      const id = idMatch[1];
      const titleMatch = block.match(/^## (.+)$/m);
      const content = block
        .replace(/^## .+\n?/m, "")
        .replace(/^- \*\*(ID|类型|重要性|标签|更新时间|来源)\*\*:.*$/gm, "")
        .replace(/^\s*$/gm, "")
        .trim();
      edits.push({
        id,
        title: titleMatch ? titleMatch[1].replace(/\\([\\`*_[\]{}()#+.!|>~-])/g, "$1") : undefined,
        content
      });
    }
    return edits;
  }

  function sync(memories) {
    const byType = {};
    for (const m of memories) {
      (byType[m.type] ??= []).push(m);
    }
    for (const type of Object.keys(TYPE_FILE)) {
      const items = (byType[type] ?? [])
        .slice()
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      if (items.length === 0) continue;
      const header = `# ${TYPE_FILE[type]} — dsh-memory 镜像\n\n<!-- 手工编辑此文件会被合并回记忆库（人工优先）。 -->\n\n`;
      const body = items.map(renderMemory).join("\n");
      writeFileSync(filePath(type), header + body, "utf8");
    }
  }

  return { filePath, sync, readHumanEdits };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mirror.test.js` (workdir `dsh-memory`)
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/mirror.js dsh-memory/test/mirror.test.js
git commit -m "feat(mirror): markdown mirrors per type, newest-first, human-edit detection"
```

---

## Task 4: Memory service — dedupe merge + inject candidates + human-edit merge

**Files:**
- Create: `dsh-memory/src/service.js`
- Test: `dsh-memory/test/service.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/service.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("saveWithDedupe adds new memory when no similar exists", () => {
  const { store, service } = setup();
  const result = service.saveWithDedupe({
    type: "project",
    title: "记忆插件",
    content: "正在开发 dsh-memory，SQLite+Markdown",
    importance: 4
  });
  assert.equal(result.action, "created");
  assert.equal(store.count(), 1);
});

test("saveWithDedupe merges into existing on exact title match", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "旧内容", importance: 3 });
  const result = service.saveWithDedupe({ type: "project", title: "记忆插件", content: "新内容", importance: 5 });
  assert.equal(result.action, "merged");
  assert.equal(store.count(), 1);
  const all = store.all();
  assert.equal(all[0].content, "新内容");
  assert.equal(all[0].importance, 5);
});

test("injectCandidates returns preferences + high-importance items within limit", () => {
  const { service } = setup();
  for (let i = 0; i < 3; i++) service.saveWithDedupe({ type: "preference", title: `p${i}`, content: "偏好" });
  service.saveWithDedupe({ type: "project", title: "low", content: "低", importance: 2 });
  service.saveWithDedupe({ type: "project", title: "high", content: "高", importance: 5 });
  service.saveWithDedupe({ type: "history", title: "h", content: "历史", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 4 });
  const types = candidates.map((c) => c.type);
  assert.ok(types.includes("preference"), "preferences included");
  assert.ok(types.includes("project"), "high-importance project included");
  assert.ok(!types.includes("history"), "history excluded by default");
  assert.ok(candidates.length <= 5, "respects maxItems");
});

test("mergeHumanEdits applies human content over machine", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
  const edits = [{ id: saved.id, title: "语言", content: "人类编辑内容" }];
  service.mergeHumanEdits("preference", edits);
  const got = store.getById(saved.id);
  assert.equal(got.content, "人类编辑内容");
});

test("toApiList maps store rows to wire DTOs", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "decision", title: "选型", content: "node:sqlite", importance: 3 });
  const dto = service.toApiList([saved]);
  assert.deepEqual(Object.keys(dto[0]).sort(), ["id", "type", "title", "content", "tags", "importance", "source", "created_at", "updated_at"].sort());
  assert.equal(dto[0].id, saved.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/service.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/service.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/service.js`:
```js
const INJECT_TYPES = new Set(["preference", "project", "decision"]);

export function createService({ store, mirror, config }) {
  /**
   * Save a memory, merging into an existing one when title matches within the same type.
   * @returns {{action: "created"|"merged", memory: object}}
   */
  function saveWithDedupe(memory) {
    const existing = store
      .list({ type: memory.type, limit: 100 })
      .find((m) => m.title.trim() === String(memory.title).trim());
    if (existing) {
      const merged = store.update(existing.id, {
        content: memory.content ?? existing.content,
        importance: memory.importance ?? existing.importance,
        tags: memory.tags ?? existing.tags,
        title: memory.title ?? existing.title
      });
      if (mirror) mirror.sync(store.all());
      return { action: "merged", memory: merged };
    }
    const created = store.save({
      type: memory.type,
      title: memory.title,
      content: memory.content,
      tags: memory.tags ?? [],
      importance: memory.importance ?? 3,
      source: memory.source ?? "manual"
    });
    if (mirror) mirror.sync(store.all());
    return { action: "created", memory: created };
  }

  /**
   * Candidate memories for automatic context injection:
   * all preferences + non-forgotten items with importance >= threshold.
   * History is never auto-injected.
   */
  function injectCandidates({ maxItems = 5, threshold = 3 } = {}) {
    const items = store.list({ limit: 200, includeForgotten: false })
      .filter((m) => INJECT_TYPES.has(m.type) && !m.forgotten && (m.type === "preference" || m.importance >= threshold))
      .sort((a, b) => (a.type === "preference" ? -1 : 1) || b.importance - a.importance);
    return items.slice(0, maxItems);
  }

  /**
   * Merge human edits parsed from a mirror file back into the store.
   * Only content/title are taken; structure fields stay machine-owned.
   */
  function mergeHumanEdits(type, edits) {
    for (const edit of edits) {
      const existing = store.getById(edit.id);
      if (!existing || existing.type !== type) continue;
      const patch = {};
      if (typeof edit.title === "string" && edit.title.trim()) patch.title = edit.title.trim();
      if (typeof edit.content === "string" && edit.content.trim()) patch.content = edit.content.trim();
      if (Object.keys(patch).length) store.update(edit.id, patch);
    }
    if (mirror && edits.length) mirror.sync(store.all());
    return edits.length;
  }

  function toApiList(rows) {
    return rows.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      importance: m.importance,
      source: m.source,
      created_at: m.created_at,
      updated_at: m.updated_at
    }));
  }

  return { saveWithDedupe, injectCandidates, mergeHumanEdits, toApiList };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/service.test.js` (workdir `dsh-memory`)
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/service.js dsh-memory/test/service.test.js
git commit -m "feat(service): dedupe merge, inject candidates, human-edit merge, api DTOs"
```

---

## Task 5: Plugin config schema

**Files:**
- Create: `dsh-memory/src/config.js`

- [ ] **Step 1: Write config schema**

`dsh-memory/src/config.js`:
```js
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  memoryDir: z.string().default("~/.dsh/memory"),
  autoInject: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  maxInjectedItems: z.number().integer().min(1).max(20).default(5),
  importanceThreshold: z.number().integer().min(1).max(5).default(3)
});
```

- [ ] **Step 2: Verify it loads (smoke)**

Run: `node -e "import('@deepseek-ai/schemastery').then(async (z) => { console.log('schemastery ok'); })"` (workdir `dsh-memory`)
Expected: prints "schemastery ok" OR fails with module-not-found (see note)

> Note: `@deepseek-ai/schemastery` resolves from the profile's dependency tree at runtime. For local smoke tests before installation, Task 11 Step 3 installs peer deps into `dsh-memory/node_modules`. If the import fails here, continue — the plugin entry (Task 9) is the real validation point.

- [ ] **Step 3: Commit**

```bash
git add dsh-memory/src/config.js
git commit -m "feat(config): schemastery config schema with defaults"
```

---

## Task 6: Model-facing tools

**Files:**
- Create: `dsh-memory/src/tools.js`
- Test: `dsh-memory/test/tools.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/tools.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  const tools = createTools(ctx, service, {});
  return { store, service, tools, registered };
}

test("registers six tools with correct names", () => {
  const { registered } = setup();
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_delete", "memory_forget", "memory_list", "memory_save", "memory_search", "memory_update"]);
});

test("memory_save executes and stores", async () => {
  const { registered, store } = setup();
  const save = registered.find((t) => t.name === "memory_save");
  const result = await save.execute({ type: "preference", title: "语言", content: "中文", importance: 4 });
  assert.equal(result.action, "created");
  assert.equal(store.count(), 1);
});

test("memory_search finds by CJK substring", async () => {
  const { registered, store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite 存储中文记忆", importance: 3 });
  const search = registered.find((t) => t.name === "memory_search");
  const result = await search.execute({ query: "中文" });
  assert.ok(result.items.length >= 1);
  assert.equal(result.items[0].title, "记忆插件");
});

test("memory_list filters by type", async () => {
  const { registered, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "a", content: "x" });
  service.saveWithDedupe({ type: "project", title: "b", content: "y" });
  const list = registered.find((t) => t.name === "memory_list");
  const result = await list.execute({ type: "project" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "b");
});

test("memory_update modifies an entry", async () => {
  const { registered, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "decision", title: "t", content: "c" });
  const update = registered.find((t) => t.name === "memory_update");
  const result = await update.execute({ id: memory.id, content: "updated" });
  assert.equal(result.memory.content, "updated");
});

test("memory_delete removes an entry", async () => {
  const { registered, service, store } = setup();
  const { memory } = service.saveWithDedupe({ type: "decision", title: "t", content: "c" });
  const del = registered.find((t) => t.name === "memory_delete");
  await del.execute({ id: memory.id });
  assert.equal(store.count(), 0);
});

test("memory_forget suppresses injection without deleting", async () => {
  const { registered, service, store } = setup();
  const { memory } = service.saveWithDedupe({ type: "project", title: "t", content: "c", importance: 5 });
  const forget = registered.find((t) => t.name === "memory_forget");
  const result = await forget.execute({ id: memory.id });
  assert.equal(result.memory.forgotten, true);
  assert.equal(store.count(), 1, "still stored");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tools.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/tools.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/tools.js`:
```js
const TEXT_OUTPUT = (text) => [{ type: "text", text }];

function define({ name, description, parameters, outputSchema, render, execute }) {
  return {
    name,
    description,
    parameters,
    output: { schema: outputSchema, render },
    execute
  };
}

export function createTools(ctx, service, config) {
  const tools = [
    define({
      name: "memory_save",
      description:
        "Persist one memory entry for future sessions (user preferences, project state, decisions). " +
        "Call this when the user states a durable preference, a project decision is made, or a lesson is learned. " +
        "Merges into an existing entry of the same type when the title matches.",
      parameters: {
        type: { type: "string", required: true, enum: ["preference", "project", "decision", "history"], description: "preference=user profile; project=project knowledge/state; decision=key decision; history=conversation summary" },
        title: { type: "string", required: true, description: "Short unique title" },
        content: { type: "string", required: true, description: "Memory body" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        importance: { type: "integer", minimum: 1, maximum: 5, description: "1-5; >= threshold auto-injects into future sessions" },
        source: { type: "string", description: "Optional provenance" }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true, enum: ["created", "merged"] },
          id: { type: "string", required: true }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`memory ${value.action}: ${value.id}`),
      async execute(args) {
        const { action, memory } = service.saveWithDedupe({
          type: args.type,
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
          importance: args.importance ?? 3,
          source: args.source ?? "tool"
        });
        return { action, id: memory.id };
      }
    }),

    define({
      name: "memory_search",
      description: "Full-text search the cross-session memory store. Use when you need past context: how a problem was solved, user preferences, project decisions. Returns matching entries with source and timestamps.",
      parameters: {
        query: { type: "string", required: true, description: "Search text; substring match over title/content/tags" },
        limit: { type: "integer", description: "Max results (default 20)" }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array", required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                type: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true },
                importance: { type: "integer", required: true },
                updated_at: { type: "string", required: true },
                source: { type: "string" }
              }
            }
          }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`Found ${value.items.length} memory entr${value.items.length === 1 ? "y" : "ies"}.`),
      async execute(args) {
        const rows = service.toApiList(service.search(args.query, { limit: args.limit ?? 20 }));
        return { items: rows };
      }
    }),

    define({
      name: "memory_list",
      description: "List memory entries by type, newest/high-importance first, paginated.",
      parameters: {
        type: { type: "string", enum: ["preference", "project", "decision", "history"], description: "Filter by type; omit for all" },
        limit: { type: "integer", description: "Page size (default 50)" },
        offset: { type: "integer", description: "Page offset (default 0)" }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array", required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                type: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true },
                importance: { type: "integer", required: true },
                updated_at: { type: "string", required: true }
              }
            }
          },
          total: { type: "integer", required: true }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`${value.items.length} memory entries (of ${value.total}).`),
      async execute(args) {
        const rows = service.toApiList(service.list({ type: args.type, limit: args.limit ?? 50, offset: args.offset ?? 0 }));
        return { items: rows, total: service.count() };
      }
    }),

    define({
      name: "memory_update",
      description: "Modify an existing memory entry (title, content, type, tags, importance).",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        title: { type: "string" },
        content: { type: "string" },
        type: { type: "string", enum: ["preference", "project", "decision", "history"] },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "integer", minimum: 1, maximum: 5 }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          memory: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              title: { type: "string", required: true },
              content: { type: "string", required: true }
            }
          }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`Updated memory ${value.memory.id}: ${value.memory.title}`),
      async execute(args) {
        const memory = service.update(args.id, {
          title: args.title,
          content: args.content,
          type: args.type,
          tags: args.tags,
          importance: args.importance
        });
        return { memory: { id: memory.id, title: memory.title, content: memory.content } };
      }
    }),

    define({
      name: "memory_delete",
      description: "Permanently delete a memory entry.",
      parameters: {
        id: { type: "string", required: true }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { deleted: { type: "boolean", required: true } }
      },
      render: (_args, value) => TEXT_OUTPUT(value.deleted ? "Memory deleted." : "Memory not found."),
      async execute(args) {
        const existed = service.getById(args.id) !== undefined;
        if (existed) service.remove(args.id);
        return { deleted: existed };
      }
    }),

    define({
      name: "memory_forget",
      description: "Stop a memory from being auto-injected into future sessions without deleting it. Use for outdated or irrelevant memories you still want searchable.",
      parameters: {
        id: { type: "string", required: true }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          memory: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", required: true }, forgotten: { type: "boolean", required: true } }
          }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`Memory ${value.memory.id} injection ${value.memory.forgotten ? "suppressed" : "restored"}.`),
      async execute(args) {
        const memory = service.setForget(args.id, true);
        return { memory: { id: memory.id, forgotten: memory.forgotten } };
      }
    })
  ];

  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  return tools;
}
```

> Note: `service` needs passthrough methods used by tools (`search`, `list`, `count`, `getById`, `remove`, `update`, `setForget`). They are added to the service in Task 4's file — append these delegating methods to `createService`'s return object:

In `dsh-memory/src/service.js`, extend the returned object:
```js
  return {
    saveWithDedupe,
    injectCandidates,
    mergeHumanEdits,
    toApiList,
    // passthroughs used by tools
    search: (q, o) => store.search(q, o),
    list: (o) => store.list(o),
    all: () => store.all(),
    count: () => store.count(),
    getById: (id) => store.getById(id),
    remove: (id) => store.remove(id),
    update: (id, p) => store.update(id, p),
    setForget: (id, f) => store.setForget(id, f)
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tools.test.js` (workdir `dsh-memory`)
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/tools.js dsh-memory/src/service.js dsh-memory/test/tools.test.js
git commit -m "feat(tools): six model-facing memory tools registered on ctx.tools"
```

---

## Task 7: Automatic context injection

**Files:**
- Create: `dsh-memory/src/inject.js`
- Test: `dsh-memory/test/inject.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/inject.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const contexts = [];
  const disposers = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        const dispose = () => disposers.push(def.name);
        return dispose;
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3 };
  const injector = createInjector(ctx, service, config);
  return { store, service, contexts, injector };
}

test("registers one dynamic context named memory", () => {
  const { contexts } = setup();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, "memory");
});

test("context text renders injected memories as markdown block", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite+Markdown", importance: 4 });
  const text = contexts[0].text({});
  assert.ok(text.includes("[记忆库]"), "has header");
  assert.ok(text.includes("语言"), "includes preference");
  assert.ok(text.includes("记忆插件"), "includes high-importance project");
});

test("returns empty text when nothing qualifies", () => {
  const { contexts } = setup();
  const text = contexts[0].text({});
  assert.equal(text, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/inject.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/inject.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/inject.js`:
```js
export function createInjector(ctx, service, config) {
  const maxItems = config.maxInjectedItems ?? 5;
  const threshold = config.importanceThreshold ?? 3;

  function render(candidates) {
    if (!candidates.length) return "";
    const lines = ["[记忆库] 来自 dsh-memory 的跨会话记忆（用户偏好与高优先级项目/决策）："];
    for (const m of candidates) {
      lines.push(`- [${m.type}] ${m.title}（重要性 ${m.importance}）：${m.content}`);
    }
    return lines.join("\n");
  }

  return ctx.systemPrompt.context({
    name: "memory",
    order: 90,
    text: () => {
      const candidates = service.injectCandidates({ maxItems, threshold });
      return render(candidates);
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/inject.test.js` (workdir `dsh-memory`)
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/inject.js dsh-memory/test/inject.test.js
git commit -m "feat(inject): dynamic system-prompt context provider for memory injection"
```

---

## Task 8: Automatic session summarization

**Files:**
- Create: `dsh-memory/src/summarize.js`
- Test: `dsh-memory/test/summarize.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/summarize.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer, parseSummaryJson } from "../src/summarize.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm: {
      stream(options) {
        calls.push(options);
        const json = JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 },
          { type: "preference", title: "语言", content: "用户喜欢中文交流", importance: 5 }
        ]);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const config = { autoSummarize: true, ...over };
  const summarizer = createSummarizer(ctx, service, config);
  return { store, service, events, calls, summarizer };
}

test("parseSummaryJson extracts valid entries and skips malformed ones", () => {
  const parsed = parseSummaryJson(`前导文字 {"a":1}
  [
    {"type":"decision","title":"t1","content":"c1","importance":4},
    {"type":"nonsense","title":"bad","content":"x"},
    "garbage",
    {"type":"preference","title":"t2","content":"c2","importance":2}
  ]`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, "decision");
  assert.equal(parsed[1].type, "preference");
});

test("subscribes to session/event when autoSummarize enabled", () => {
  const { events } = setup();
  assert.ok(events.some((e) => e.name === "session/event"));
});

test("does not subscribe when autoSummarize disabled", () => {
  const { events } = setup({ autoSummarize: false });
  assert.ok(!events.some((e) => e.name === "session/event"));
});

test("turn/end event triggers summarization and stores entries", async () => {
  const { events, store } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      { seq: 1, type: "user/message" },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(store.count(), 2);
  const all = store.all();
  assert.ok(all.some((m) => m.type === "decision"));
  assert.ok(all.some((m) => m.type === "preference"));
});

test("skips summarization for events other than turn/end", async () => {
  const { events, store, calls } = setup();
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = { id: "s1", requestHeader: () => ({ config: {} }), events: [] };
  await handler(session, { seq: 1, type: "user/message" });
  assert.equal(store.count(), 0);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/summarize.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/summarize.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/summarize.js`:
```js
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

const SUMMARY_PROMPT = `你是记忆库提炼助手。根据下面的会话内容，提炼 2-3 条值得跨会话记住的记忆。
只输出 JSON 数组，每项形如 {"type":"preference|project|decision|history","title":"简短标题","content":"一句话内容","importance":1-5}。
不要输出任何其他文字。`;

/** Extract a JSON array from LLM output that may contain prose around it. */
export function parseSummaryJson(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const VALID = new Set(["preference", "project", "decision", "history"]);
  return arr.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      VALID.has(item.type) &&
      typeof item.title === "string" &&
      item.title.trim() &&
      typeof item.content === "string" &&
      item.content.trim()
  ).map((item) => ({
    type: item.type,
    title: item.title.trim(),
    content: item.content.trim(),
    importance: Number.isInteger(item.importance) ? Math.min(5, Math.max(1, item.importance)) : 3
  }));
}

function collectMessages(session) {
  const messages = [];
  for (const event of session.events ?? []) {
    if (event.type === "user/message" && event.data?.source?.kind === "user") {
      messages.push(createUserMessage({ content: event.data.content ?? [{ type: "text", text: "" }] }));
    }
  }
  return messages.slice(-20);
}

export function createSummarizer(ctx, service, config) {
  if (!config.autoSummarize) return { dispose: () => {} };

  let inFlight = new Map();

  async function summarize(session) {
    if (inFlight.has(session.id)) return;
    const controller = new AbortController();
    inFlight.set(session.id, controller);
    try {
      const header = session.requestHeader?.()?.config;
      const route = header?.provider && header?.model
        ? { provider: header.provider, model: header.model }
        : undefined;
      if (!route) return;
      const messages = collectMessages(session);
      if (!messages.length) return;

      const assembler = new BlockAssembler();
      const options = {
        provider: route.provider,
        model: route.model,
        purpose: "summarization",
        messages: [
          { role: "system", content: [{ type: "text", text: SUMMARY_PROMPT }] },
          ...messages
        ],
        signal: controller.signal
      };
      for await (const chunk of ctx.llm.stream(options)) {
        assembler.push(chunk);
        if (chunk.type === "finish" && chunk.kind === "error") return;
      }
      const output = assembler.assemble();
      const text = output?.content?.[0]?.text ?? "";
      const entries = parseSummaryJson(text);
      for (const entry of entries) {
        service.saveWithDedupe({ ...entry, source: `session:${session.id}` });
      }
    } finally {
      inFlight.delete(session.id);
    }
  }

  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    // Defer so the turn's final state is fully committed.
    queueMicrotask(() => {
      summarize(session).catch((error) => {
        ctx.logger?.warn?.(`dsh-memory: summarization failed: ${String(error)}`);
      });
    });
  });

  return {
    dispose() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    }
  };
}
```

> Note: `BlockAssembler.assemble()` returns the assembled message; exact accessor for text may be `output.content[0].text` or `output.content.text` depending on the version. Verify against the installed `@deepseek-ai/dsh-llm` in Task 11 and adjust the one line if needed (the test's mock stream covers the happy path regardless).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/summarize.test.js` (workdir `dsh-memory`)
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/summarize.js dsh-memory/test/summarize.test.js
git commit -m "feat(summarize): session turn/end LLM summarization into memory store"
```

---

## Task 9: Plugin entry + HTTP API

**Files:**
- Create: `dsh-memory/src/api.js`
- Create: `dsh-memory/src/index.js`
- Test: `dsh-memory/test/api.test.js`

- [ ] **Step 1: Write the failing test**

`dsh-memory/test/api.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET") {
  return { url: path, method, headers: {} };
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  const api = createApi(ctx, service);
  return { store, service, routes, api };
}

function findHandler(routes, path) {
  const route = routes.find((r) => r.path === path || (r.kind === "prefix" && path.startsWith(r.path)));
  return route;
}

test("registers list, search, and get prefix routes", () => {
  const { routes } = setup();
  const paths = routes.map((r) => r.path);
  assert.ok(paths.includes("/api/dsh-memory/list"));
  assert.ok(paths.includes("/api/dsh-memory/search"));
  assert.ok(paths.includes("/api/dsh-memory"));
});

test("GET /api/dsh-memory/list returns memories as JSON", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const route = routes.find((r) => r.path === "/api/dsh-memory/list");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-memory/list?type=preference"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].title, "语言");
});

test("GET /api/dsh-memory/search?q= returns matches", async () => {
  const { routes, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite 中文搜索" });
  const route = routes.find((r) => r.path === "/api/dsh-memory/search");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-memory/search?q=%E4%B8%AD%E6%96%87"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.items.length, 1);
});

test("unknown route under prefix returns 404 json", async () => {
  const { routes } = setup();
  const route = findHandler(routes, "/api/dsh-memory");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-memory/nope"), res);
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.test.js` (workdir `dsh-memory`)
Expected: FAIL with "Cannot find module '../src/api.js'"

- [ ] **Step 3: Write minimal implementation**

`dsh-memory/src/api.js`:
```js
import { URL } from "node:url";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function createApi(ctx, service) {
  // /api/dsh-memory prefix fallback → 404 JSON for unknown sub-paths
  ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsh-memory",
    handler(req, res) {
      sendJson(res, 404, { error: "not-found" });
    }
  });

  ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-memory/list",
    handler(req, res) {
      const url = new URL(req.url, "http://localhost");
      const type = url.searchParams.get("type") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = service.toApiList(service.list({ type, limit, offset }));
      sendJson(res, 200, { items, total: service.count() });
    }
  });

  ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-memory/search",
    handler(req, res) {
      const url = new URL(req.url, "http://localhost");
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const items = service.toApiList(service.search(q, { limit }));
      sendJson(res, 200, { items });
    }
  });

  return { routes: 3 };
}
```

`dsh-memory/src/index.js`:
```js
import { createStore } from "./store.js";
import { createMirror } from "./mirror.js";
import { createService } from "./service.js";
import { createTools } from "./tools.js";
import { createInjector } from "./inject.js";
import { createSummarizer } from "./summarize.js";
import { createApi } from "./api.js";
import { Config } from "./config.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-memory";
export const inject = ["tools", "systemPrompt"];
export const Config = Config;

export function apply(ctx, config) {
  const cfg = Config(config);

  // Resolve memoryDir: expand leading "~"
  const memoryDir = cfg.memoryDir.startsWith("~")
    ? join(homedir(), cfg.memoryDir.slice(1))
    : cfg.memoryDir;
  mkdirSync(memoryDir, { recursive: true });

  const store = createStore(join(memoryDir, "memory.db"));
  const mirror = createMirror(memoryDir);
  const service = createService({ store, mirror, config: cfg });

  // Human edits in mirror files win on every sync; merge them back first.
  for (const type of Object.keys(mirror.filePath)) {
    const edits = mirror.readHumanEdits(type);
    if (edits.length) service.mergeHumanEdits(type, edits);
  }

  const disposers = [];

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (cfg.autoInject) disposers.push(createInjector(promptCtx, service, cfg));
  });

  ctx.inject(["tools"], (toolsCtx) => {
    disposers.push(createTools(toolsCtx, service, cfg));
  });

  const summarizer = createSummarizer(ctx, service, cfg);
  disposers.push(summarizer.dispose);

  if (ctx.webServer) {
    disposers.push(createApi(ctx, service));
  }

  return () => {
    for (const dispose of disposers) dispose();
    store.close();
  };
}
```

> Note: the return value is a Cordis dispose callback; `ctx.inject` accepts a scope-filtered inject list. If the runtime's `apply` contract expects the inject array exported separately (as `dsh-tool-todo` does: `const inject = ["tools"]` exported), the export above covers it. Verify against the loaded cordis version in Task 11.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api.test.js` (workdir `dsh-memory`)
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add dsh-memory/src/api.js dsh-memory/src/index.js dsh-memory/test/api.test.js
git commit -m "feat(api+entry): http routes for memory panel, plugin apply wiring"
```

---

## Task 10: Client plugin — sidebar entry + memory panel

**Files:**
- Create: `dsh-memory/lib/client.js`

- [ ] **Step 1: Write the client bundle**

`dsh-memory/lib/client.js` (hand-written `window.__ModuleLoader__.load` bundle — no build step; matches the format every shipped DSH client plugin uses):
```js
window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let { useState, useEffect, useCallback } = react;

    const inject = ["slots", "locale"];

    const NS = "memory";

    const dictionaries = {
      zh: {
        "memory.panel.title": "记忆库",
        "memory.panel.search": "搜索记忆…",
        "memory.panel.empty": "暂无记忆条目",
        "memory.panel.open": "记忆",
        "memory.tab.all": "全部",
        "memory.tab.preference": "偏好",
        "memory.tab.project": "项目",
        "memory.tab.decision": "决策",
        "memory.tab.history": "历史"
      },
      en: {
        "memory.panel.title": "Memory",
        "memory.panel.search": "Search memories…",
        "memory.panel.empty": "No memories yet",
        "memory.panel.open": "Memory",
        "memory.tab.all": "All",
        "memory.tab.preference": "Preferences",
        "memory.tab.project": "Projects",
        "memory.tab.decision": "Decisions",
        "memory.tab.history": "History"
      }
    };

    function MemoryPanel({ t, onClose }) {
      const [tab, setTab] = useState("all");
      const [query, setQuery] = useState("");
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(false);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const params = new URLSearchParams();
          if (tab !== "all") params.set("type", tab);
          if (query.trim()) {
            const res = await fetch(`/api/dsh-memory/search?q=${encodeURIComponent(query.trim())}`);
            const data = await res.json();
            setItems(data.items || []);
          } else {
            const res = await fetch(`/api/dsh-memory/list?${params.toString()}`);
            const data = await res.json();
            setItems(data.items || []);
          }
        } catch (error) {
          setItems([]);
        } finally {
          setLoading(false);
        }
      }, [tab, query]);

      useEffect(() => { load(); }, [load]);

      const tabs = ["all", "preference", "project", "decision", "history"];

      return react.createElement("div", { style: styles.overlay },
        react.createElement("div", { style: styles.panel },
          react.createElement("div", { style: styles.header },
            react.createElement("span", { style: styles.title }, t("memory.panel.title")),
            react.createElement("button", { style: styles.close, onClick: onClose }, "×")
          ),
          react.createElement("input", {
            style: styles.search,
            placeholder: t("memory.panel.search"),
            value: query,
            onChange: (e) => setQuery(e.target.value)
          }),
          react.createElement("div", { style: styles.tabs },
            tabs.map((key) =>
              react.createElement("button", {
                key,
                style: { ...styles.tab, ...(tab === key ? styles.tabActive : {}) },
                onClick: () => setTab(key)
              }, t(`memory.tab.${key}`))
            )
          ),
          react.createElement("div", { style: styles.list },
            loading
              ? react.createElement("div", { style: styles.hint }, "…")
              : items.length === 0
                ? react.createElement("div", { style: styles.hint }, t("memory.panel.empty"))
                : items.map((item) =>
                    react.createElement("div", { key: item.id, style: styles.card },
                      react.createElement("div", { style: styles.cardTitle },
                        react.createElement("span", null, item.title),
                        react.createElement("span", { style: styles.badge },
                          `${t(`memory.tab.${item.type}`)} · ★${item.importance}`
                        )
                      ),
                      react.createElement("div", { style: styles.cardContent }, item.content),
                      react.createElement("div", { style: styles.cardMeta },
                        new Date(item.updated_at).toLocaleString()
                      )
                    )
                  )
          )
        )
      );
    }

    const styles = {
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
      panel: { background: "var(--dsw-alias-bg-base, #fff)", borderRadius: 12, width: 640, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.2)" },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
      title: { fontSize: 16, fontWeight: 600 },
      close: { border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)" },
      search: { padding: "8px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #ddd)", marginBottom: 12, fontSize: 14 },
      tabs: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" },
      tab: { padding: "4px 10px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "none", cursor: "pointer", fontSize: 12 },
      tabActive: { background: "var(--dsw-alias-interactive-bg-active, #eee)" },
      list: { overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 },
      hint: { color: "var(--dsw-alias-label-tertiary, #999)", padding: "24px 0", textAlign: "center" },
      card: { border: "1px solid var(--dsw-alias-border-l1, #eee)", borderRadius: 8, padding: "10px 12px" },
      cardTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, fontSize: 14, fontWeight: 600 },
      badge: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" },
      cardContent: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #555)", marginBottom: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" },
      cardMeta: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" }
    };

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-memory: dictionaries");

      ctx.effect(() => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register({
            name: "memory",
            locale: NS,
            children: {},
            inject: () => ({})
          }, () => {
            const [open, setOpen] = react.useState(false);
            return react.createElement(react.Fragment, null,
              react.createElement("button", {
                onClick: () => setOpen(true),
                style: { ...styles.footerButton, ...(open ? styles.footerButtonActive : {}) }
              }, t("memory.panel.open")),
              open && react.createElement(MemoryPanel, { t, onClose: () => setOpen(false) })
            );
          })
        );
      }, "dsh-memory: sidebar action");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

- [ ] **Step 2: Validate the bundle parses**

Run: `node --check lib/client.js` (workdir `dsh-memory`)
Expected: no output, exit 0

- [ ] **Step 3: Commit**

```bash
git add dsh-memory/lib/client.js
git commit -m "feat(client): sidebar footer action opening memory panel over /api/dsh-memory"
```

---

## Task 11: Install into the web profile + integration verification

**Files:**
- Modify: `~/.dsh/profiles/web/package.json`
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`

- [ ] **Step 1: Copy source to lib (the plugin ships plain ESM, no compile step)**

Run (PowerShell, workdir `dsh-memory`):
```powershell
New-Item -ItemType Directory -Force -Path lib | Out-Null
Copy-Item src\*.js lib\ -Force
Get-ChildItem lib | Select-Object Name
```
Expected: lib contains `api.js config.js index.js inject.js mirror.js service.js store.js summarize.js tools.js client.js`

- [ ] **Step 2: Install peer dependencies into the plugin package for local tests**

Run (workdir `dsh-memory`):
```powershell
npm install --no-save @deepseek-ai/cordis@^4.0.1 @deepseek-ai/dsh-tools@^0.1.0-rc.6 @deepseek-ai/dsh-llm@^0.1.0-rc.6 @deepseek-ai/dsh-system-prompt@^0.1.0-rc.6 @deepseek-ai/dsh-host-webserver@^0.1.0-rc.6 @deepseek-ai/schemastery@^3.18.1
```
Expected: installs into `dsh-memory/node_modules` (gitignored). If the registry is unreachable, skip — the runtime resolves peers from the profile tree instead; adjust `summarize.js`'s `BlockAssembler.assemble()` accessor by reading `node_modules/@deepseek-ai/dsh-llm/lib/…` from the profile once installed.

- [ ] **Step 3: Run the full test suite**

Run: `node --test test/` (workdir `dsh-memory`)
Expected: all tests PASS (store 10, mirror 3, service 5, tools 7, inject 3, summarize 5, api 4)

- [ ] **Step 4: Add the plugin to the web profile**

Edit `C:\Users\石晴\.dsh\profiles\web\package.json` — add dependency:
```json
"dependencies": {
  "dsh-memory": "file:D:/deepseek harness/dsh-memory"
}
```

Edit `C:\Users\石晴\.dsh\profiles\web\cordis.patch.yml`:
```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    memoryDir: ~/.dsh/memory
    autoInject: true
    autoSummarize: true
    maxInjectedItems: 5
    importanceThreshold: 3
```

- [ ] **Step 5: Install into the profile**

Run (workdir `C:\Users\石晴\.dsh\profiles\web`):
```powershell
corepack pnpm install
```
Expected: pnpm installs `dsh-memory` (and its peers) into the profile tree. If `corepack pnpm` is unavailable, use `npx pnpm install`.

- [ ] **Step 6: Verify the composed config includes the plugin**

Run:
```powershell
dsh --profile web --dump-config 2>&1 | Select-String -Pattern "dsh-memory|memoryDir"
```
Expected: output contains the `dsh-memory` entry with its config. (If `dsh` is not on PATH, call the full path: `C:\Users\石晴\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\dsh` — adjust to actual location.)

- [ ] **Step 7: Boot the web profile and smoke-test**

Run (background job):
```powershell
dsh web
```
Expected: boots without dsh-memory load errors; Web GUI reachable at http://127.0.0.1:3080.

- [ ] **Step 8: Browser verification of the panel**

Use Playwright (or the visual-debugger skill) against http://127.0.0.1:3080:
1. Sidebar footer shows a "记忆" button.
2. Clicking opens the memory panel overlay.
3. Panel lists entries (after a `memory_save` occurs, or seeded data).
4. Type in search box → results filter.
5. No console errors from `dsh-memory`.

- [ ] **Step 9: Model-facing smoke test**

In the GUI, ask the agent (this session): "用 memory_save 记住：用户偏好中文交流，Windows 环境。" then start a NEW session and confirm the memory block appears in the first system context (visible as a memory line in the trajectory) — or ask "你还记得我的什么偏好？" and verify `memory_search` returns the entry.

- [ ] **Step 10: Verify auto-summarization**

Run a short conversation, then check the store:
```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('C:/Users/石晴/.dsh/memory/memory.db'); console.log(JSON.stringify(db.prepare('SELECT type,title,content FROM memories').all(), null, 2));"
```
Expected: after a turn/end, summary entries exist (when the LLM route is available).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: install dsh-memory into web profile and verify"
```

---

## Self-Review (run before execution handoff)

**1. Spec coverage:**
- SQLite+FTS5 store + Markdown mirrors → Tasks 2-3 ✅
- 6 tools (save/search/list/update/delete/forget) → Task 6 ✅
- Auto-injection (channel 1) → Task 7 ✅
- Auto-summarization with dedupe → Task 8 + service dedupe (Task 4) ✅
- Web panel (basic: browse/search/detail) → Task 10 ✅ (list + search + detail cards)
- Plugin config (memoryDir, autoInject, autoSummarize, maxInjectedItems, importanceThreshold) → Task 5 + Task 11 config ✅
- Deployment approach A (local plugin package, file: dependency) → Task 11 ✅
- Acceptance: boot clean, tools callable, injection visible, panel renders, auto-summary, readable mirrors → Task 11 Steps 6-10 ✅

**2. Placeholder scan:** No TBD/TODO. The two "verify against installed version" notes (BlockAssembler accessor, apply inject contract) are explicit verification steps, not placeholders — both have fallback adjustments defined.

**3. Type consistency:** `createStore` returns `{db,count,getById,save,update,remove,setForget,list,all,search,close}` — used identically in Tasks 4, 6, 7, 8, 9. `createService` returns the extended object including passthroughs — Task 6 adds them explicitly. Tool names are consistent: `memory_save/search/list/update/delete/forget`. API paths consistent: `/api/dsh-memory`, `/api/dsh-memory/list`, `/api/dsh-memory/search`. Client fetches match API routes. Config keys match Task 5 schema and Task 11 patch.

**Known risks (documented for the executor):**
- `BlockAssembler.assemble()` output shape may differ; Task 11 Step 2 includes verification.
- `ctx.inject(["systemPrompt"], …)` scoped inject and `apply` return contract verified at Task 11 Step 7 boot; adjust if cordis version differs.
- `sidebar.footer.action` slot key confirmed in `dsh-client-ui-sidebar` v0.1.0-rc.6; a layout change would require re-checking the slot key.
- Chinese search relies on LIKE (documented decision); FTS5 remains for future scale.
