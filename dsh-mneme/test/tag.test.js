// v0.6.2 Tag 系统测试。
// 覆盖：parser parseTags/sanitizeTags（正常/多标签去重/非法/超长/中文/连字符）/
// store.setMemoryTags 幂等（同 memory 只存一条、覆盖写、清空即删）/
// tag: 搜索（基础/多标签 AND/与关键词组合/不存在 tag）/
// autoDream tag（写 entity_attrs/fail-safe/限频/runDream 集成）/
// mirror 渲染（有 tag 出 #行、无 tag 不渲染 + service 打标后文件同步）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createMirror } from "../src/mirror.js";
import { parseTags, sanitizeTags, MAX_TAG_LENGTH } from "../src/parser/tag.js";
import { runAutoTag } from "../src/dream/tag-extractor.js";
import { createDreamScheduler } from "../src/dream.js";

function openStore() {
  return createStore(":memory:");
}

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

function makeMirrorService(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-tag-"));
  const store = createStore(":memory:");
  const mirror = createMirror(join(dir, "mirror"));
  const service = createService({ store, mirror, config, logger: { warn: () => {} } });
  return { store, service, dir, file: (t) => join(dir, "mirror", `${t}.md`) };
}

function seed(service, title, content, type = "preference") {
  return service.saveWithDedupe({ type, title, content, importance: 3 }).memory;
}

// ============================================================ parser

test("parseTags: plain #tags are extracted in order", () => {
  assert.deepEqual(parseTags("今天用 #linux 学了 #bash 脚本"), ["linux", "bash"]);
});

test("parseTags: multiple tags on one line dedupe (first occurrence wins)", () => {
  assert.deepEqual(parseTags("#a #b #a #c"), ["a", "b", "c"]);
});

test("parseTags: illegal and non-tag markers are ignored", () => {
  assert.deepEqual(parseTags("## 标题 和 #"), [], "markdown heading and a bare # yield nothing");
  assert.deepEqual(parseTags("#foo#bar"), ["foo", "bar"], "back-to-back tags both parse");
  assert.deepEqual(parseTags(""), []);
  assert.deepEqual(parseTags(undefined), []);
  assert.deepEqual(parseTags(null), []);
});

test("parseTags: over-long tags (> 20 chars) are dropped", () => {
  const long = "a".repeat(MAX_TAG_LENGTH + 1);
  const ok = "b".repeat(MAX_TAG_LENGTH);
  assert.deepEqual(parseTags(`#${long} 和 #${ok}`), [ok]);
});

test("parseTags: CJK + edge-hyphen tags work", () => {
  assert.deepEqual(parseTags("#考研 资料与 #深度学习-入门-"), ["考研", "深度学习-入门"]);
});

test("sanitizeTags: LLM-style arrays are validated/deduped and tolerate leading #", () => {
  assert.deepEqual(sanitizeTags(["linux", " 考研 ", "#bash", "linux", "a/b", "x".repeat(30)]), [
    "linux", "考研", "bash"
  ]);
  assert.deepEqual(sanitizeTags("not-an-array"), []);
});

// ============================================================ storage

test("setMemoryTags writes exactly one live tags row (idempotent overwrite)", () => {
  const store = openStore();
  const mem = store.save({ type: "preference", title: "Alpha", content: "c", tags: [] });
  store.setMemoryTags(mem.id, ["linux", "考研"]);
  assert.deepEqual(store.getMemoryTags(mem.id), ["linux", "考研"]);
  const live = store.getAttrsByMemory(mem.id).filter((a) => a.attr_key === "tags" && !a.valid_until);
  assert.equal(live.length, 1, "one live tags row per memory");
  // overwrite keeps one live row, value replaced
  store.setMemoryTags(mem.id, ["bash", "linux"]);
  assert.deepEqual(store.getMemoryTags(mem.id), ["bash", "linux"]);
  const live2 = store.getAttrsByMemory(mem.id).filter((a) => a.attr_key === "tags" && !a.valid_until);
  assert.equal(live2.length, 1, "still exactly one live row after overwrite");
  store.close();
});

test("setMemoryTags clears the row when the tag list is empty", () => {
  const store = openStore();
  const mem = store.save({ type: "preference", title: "Alpha", content: "c", tags: [] });
  store.setMemoryTags(mem.id, ["linux"]);
  assert.deepEqual(store.getMemoryTags(mem.id), ["linux"]);
  store.setMemoryTags(mem.id, []);
  assert.deepEqual(store.getMemoryTags(mem.id), []);
  const live = store.getAttrsByMemory(mem.id).filter((a) => a.attr_key === "tags" && !a.valid_until);
  assert.equal(live.length, 0, "no live tags row after clear");
  store.close();
});

// ============================================================ tag: search

test("searchMemories: tag:xxx returns only memories carrying that tag", async () => {
  const { store, service } = makeService();
  const a = seed(service, "Linux 笔记", "内核与发行版");
  const b = seed(service, "考研计划", "公共管理学 631");
  store.setMemoryTags(a.id, ["linux"]);
  store.setMemoryTags(b.id, ["考研"]);
  const hits = await service.searchMemories("tag:linux");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, a.id);
  assert.equal(hits[0].source, "tag");
  assert.equal((await service.searchMemories("tag:考研"))[0].id, b.id);
  store.close();
});

test("searchMemories: multiple tag: tokens use AND (must carry every tag)", async () => {
  const { store, service } = makeService();
  const both = seed(service, "两者皆有", "正文");
  const one = seed(service, "只有一个", "正文");
  store.setMemoryTags(both.id, ["a", "b"]);
  store.setMemoryTags(one.id, ["a"]);
  const hits = await service.searchMemories("tag:a tag:b");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, both.id);
  store.close();
});

test("searchMemories: tag: combines with keyword text (ranked intersection)", async () => {
  const { store, service } = makeService();
  const hit = seed(service, "内核调度", "进程调度器与负载均衡");
  const other = seed(service, "内核编译", "无关关键词");
  store.setMemoryTags(hit.id, ["linux"]);
  store.setMemoryTags(other.id, ["linux"]);
  const hits = await service.searchMemories("tag:linux 调度");
  assert.equal(hits.length, 1, "only the tagged memory whose content mentions 调度");
  assert.equal(hits[0].id, hit.id);
  assert.equal(hits[0].source, "tag");
  store.close();
});

test("searchMemories: non-existent tag returns []", async () => {
  const { store, service } = makeService();
  const a = seed(service, "Alpha", "正文");
  store.setMemoryTags(a.id, ["linux"]);
  assert.deepEqual(await service.searchMemories("tag:不存在的标签"), []);
  store.close();
});

// ============================================================ autoDream tag

/** Minimal LLM ctx whose stream yields a queue of texts, one per call. */
function makeCtx(calls) {
  let n = 0;
  return {
    llm: {
      stream: async function* () {
        n++;
        const text = calls[Math.min(n - 1, calls.length - 1)];
        if (text !== undefined) yield { type: "text-delta", text };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {}, info: () => {} }
  };
}

test("runAutoTag writes validated tags into entity_attrs", async () => {
  const { store, service } = makeService();
  const a = seed(service, "Linux", "内核");
  const b = seed(service, "考研", "公共管理");
  const text = JSON.stringify([
    { id: a.id, tags: ["linux", "内核"] },
    { id: b.id, tags: ["考研", "公共管理"] }
  ]);
  const ctx = makeCtx([text]);
  const result = await runAutoTag({ ctx, service, config: { dreamProvider: "d", dreamModel: "m" } });
  assert.equal(result.ok, true);
  assert.equal(result.tagged, 2);
  assert.deepEqual(store.getMemoryTags(a.id), ["linux", "内核"]);
  assert.deepEqual(store.getMemoryTags(b.id), ["考研", "公共管理"]);
  store.close();
});

test("runAutoTag fail-safe: garbage / aborted LLM output never throws and writes nothing", async () => {
  const { store, service } = makeService();
  const a = seed(service, "Alpha", "正文");
  // garbage JSON → skipped, no writes
  const r1 = await runAutoTag({
    ctx: makeCtx(["not json at all"]),
    service,
    config: { dreamProvider: "d", dreamModel: "m" }
  });
  assert.equal(r1.ok, false);
  assert.deepEqual(store.getMemoryTags(a.id), []);
  // unknown id / illegal tags are dropped, valid ones still land
  const text = JSON.stringify([
    { id: "不存在", tags: ["x"] },
    { id: a.id, tags: ["ok-tag", "a/b", "y".repeat(30)] }
  ]);
  const r2 = await runAutoTag({ ctx: makeCtx([text]), service, config: { dreamProvider: "d", dreamModel: "m" } });
  assert.equal(r2.ok, true);
  assert.deepEqual(store.getMemoryTags(a.id), ["ok-tag"], "illegal/over-long dropped, valid kept");
  store.close();
});

test("runAutoTag respects autoTagMaxPerRun cap", async () => {
  const { store, service } = makeService();
  const mems = [];
  for (let i = 0; i < 5; i++) mems.push(seed(service, `M${i}`, "正文"));
  const text = JSON.stringify(mems.map((m, i) => ({ id: m.id, tags: [`t${i}`] })));
  const ctx = makeCtx([text]);
  const result = await runAutoTag({ ctx, service, config: { dreamProvider: "d", dreamModel: "m", autoTagMaxPerRun: 2 } });
  assert.equal(result.tagged, 2, "only 2 of 5 memories tagged (cap)");
  const tagged = mems.filter((m) => store.getMemoryTags(m.id).length);
  assert.equal(tagged.length, 2, "exactly 2 memories carry tags");
  const untagged = mems.filter((m) => !store.getMemoryTags(m.id).length);
  assert.equal(untagged.length, 3, "the rest are untouched");
  store.close();
});

test("runDream auto-tags retained memories after consolidation when autoTagEnabled=true", async () => {
  const { store, service } = makeService({ autoTagEnabled: true });
  const a = seed(service, "旧1", "第一段");
  const b = seed(service, "旧2", "第二段");
  const keep = (id) => JSON.stringify([{ action: "keep", ids: [id] }]);
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        if (calls === 1) yield { type: "text-delta", text: keep(a.id) }; // consolidation
        else if (calls === 2) yield { type: "text-delta", text: JSON.stringify([{ id: a.id, tags: ["内核"] }]) }; // auto-tag
        else yield { type: "text-delta", text: "总览" }; // summary
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {}, info: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", autoTagEnabled: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(store.getMemoryTags(a.id), ["内核"], "auto-tag landed after consolidation");
  store.close();
});

// ============================================================ mirror rendering

test("mirror renderMemory draws a #tag line under the title only when tags exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-tag-mirror-"));
  const mirror = createMirror(join(dir, "m"));
  const now = new Date().toISOString();
  mirror.sync([
    { id: "m1", type: "preference", title: "Alpha", content: "正文", importance: 3, updated_at: now, tags: [], entityTags: ["linux", "考研"] },
    { id: "m2", type: "project", title: "Beta", content: "正文2", importance: 3, updated_at: now, tags: [], entityTags: [] }
  ]);
  const pref = readFileSync(join(dir, "m", "preferences.md"), "utf8");
  assert.match(pref, /## Alpha/);
  assert.match(pref, /^#linux #考研$/m, "tag line rendered under the title");
  const proj = readFileSync(join(dir, "m", "projects.md"), "utf8");
  assert.match(proj, /## Beta/);
  assert.doesNotMatch(proj, /^#[^#\s]/m, "no # tag line when the memory has no tags");
  rmSync(dir, { recursive: true, force: true });
});

test("service.setMemoryTags re-renders the mirror with the #tag line", () => {
  const { store, service, file, dir } = makeMirrorService();
  const { memory } = service.saveWithDedupe({ type: "preference", title: "Alpha", content: "正文" });
  const r = service.setMemoryTags(memory.id, ["bash"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tags, ["bash"]);
  const pref = readFileSync(file("preferences"), "utf8");
  assert.match(pref, /^#bash$/m, "mirror file updated with the # tag line");
  // no tag line after clearing
  service.setMemoryTags(memory.id, []);
  const cleared = readFileSync(file("preferences"), "utf8");
  assert.doesNotMatch(cleared, /^#[^#\s]/m, "tag line removed after clearing");
  assert.deepEqual(store.getMemoryTags(memory.id), []);
  rmSync(dir, { recursive: true, force: true });
});

test("service.setMemoryTags respects manualTagEnabled=false gate", () => {
  const { service } = makeService({ manualTagEnabled: false });
  const a = seed(service, "Alpha", "正文");
  const r = service.setMemoryTags(a.id, ["linux"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /manualTagEnabled/);
});
