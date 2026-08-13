import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
    assert.equal(m1.content, "人类编辑内容");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHumanEdits content is not polluted by file header", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([sampleMemory("preference", { id: "m1", content: "机器内容" })]);
    const m1 = mirror.readHumanEdits("preference").find((e) => e.id === "m1");
    assert.ok(m1, "detects m1");
    assert.equal(m1.content, "机器内容");
    assert.ok(!m1.content.includes("#"), "no H1 header in content");
    assert.ok(!m1.content.includes("dsh-memory 镜像"), "no mirror banner in content");
    assert.ok(!m1.content.includes("<!--"), "no html comment in content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body containing '---' survives round-trip (no silent truncation)", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const content = "第一段\n\n---\n\n第二段";
    mirror.sync([sampleMemory("project", { id: "p1", content })]);
    const p1 = mirror.readHumanEdits("project").find((e) => e.id === "p1");
    assert.ok(p1, "detects p1");
    assert.equal(p1.content, content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body lines resembling metadata are preserved", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const content = "- **ID**: 假条目\n- **重要性**: 5（正文里写的）";
    mirror.sync([sampleMemory("preference", { id: "m1", content })]);
    const m1 = mirror.readHumanEdits("preference").find((e) => e.id === "m1");
    assert.ok(m1, "detects m1");
    assert.equal(m1.content, content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync with empty array deletes stale mirror files", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([
      sampleMemory("preference"),
      sampleMemory("project"),
      sampleMemory("decision"),
      sampleMemory("history")
    ]);
    for (const type of Object.keys(TYPE_FILE)) {
      assert.ok(existsSync(join(dir, TYPE_FILE[type])), `${type} file exists`);
    }
    mirror.sync([]);
    for (const type of Object.keys(TYPE_FILE)) {
      assert.ok(!existsSync(join(dir, TYPE_FILE[type])), `${type} file removed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
