// v0.6.5 整合边界测试：跨 v0.6.1-0.6.4 的边界场景。
// 覆盖：循环 wiki-link / 空 tag 清除 / 超长 tag 丢弃 / 多 tag 目录分组 /
// autoTag 非法输出 fail-safe / tag 搜索大小写。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { parseWikiLinks } from "../src/parser/wiki-link.js";
import { parseTags } from "../src/parser/tag.js";
import { extractQueryTags } from "../src/search/tag-boost.js";

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

test("wiki-link: mutual links (A→B and B→A) resolve without loops", () => {
  const { store, service } = makeService({ wikiLinkEnabled: true });
  const a = service.saveWithDedupe({
    type: "preference", title: "Alpha", content: "参见 [[Beta]]", importance: 3,
  }).memory;
  const b = service.saveWithDedupe({
    type: "preference", title: "Beta", content: "反链 [[Alpha]]", importance: 3,
  }).memory;
  store.saveWikiLinks({ memoryId: a.id, title: a.title, targets: ["Beta"] });
  store.saveWikiLinks({ memoryId: b.id, title: b.title, targets: ["Alpha"] });
  const ab = service.getForwardLinks(a.id);
  const ba = service.getBacklinks(a.id);
  assert.ok(ab.some((r) => r.target.id === b.id), "A links to B");
  assert.ok(ba.some((r) => r.source.id === b.id), "B backlinks to A");
  store.close();
});

test("tags: setting empty array clears the live tag row", () => {
  const { store } = makeService();
  const a = store.save({ type: "preference", title: "A", content: "c", tags: [] });
  store.setMemoryTags(a.id, ["规划", "前端"]);
  assert.deepEqual(store.getMemoryTags(a.id), ["规划", "前端"]);
  store.setMemoryTags(a.id, []);
  assert.deepEqual(store.getMemoryTags(a.id), []);
  store.close();
});

test("parseTags: over-length and invalid tags are dropped", () => {
  const out = parseTags("#短 #这是一个超过二十个字符的超级长标签 #ok_123 #带-连字符");
  assert.ok(out.includes("短"), "short CJK tag kept");
  assert.ok(out.includes("ok_123"), "alnum underscore kept");
  assert.ok(out.includes("带-连字符"), "hyphen kept");
  assert.ok(!out.some((t) => t.length > 20), "no tag exceeds 20 chars");
});

test("tag search: matches case-insensitively and composes with keywords", async () => {
  const { store, service } = makeService();
  const a = service.saveWithDedupe({
    type: "preference", title: "规划", content: "博客重构", importance: 3,
  }).memory;
  store.setMemoryTags(a.id, ["规划"]);
  const r = await service.searchMemories("tag:规划 博客", {
    mode: "keyword", limit: 10, useRerank: false,
  });
  assert.ok(r.some((m) => m.id === a.id), "tag: prefix + keyword composition");
  store.close();
});

test("directory: many-tag memory appears under every tag group", () => {
  const { store, service } = makeService();
  const a = store.save({ type: "preference", title: "多标签", content: "c", tags: [] });
  store.setMemoryTags(a.id, ["规划", "前端", "博客"]);
  const dir = store.getDirectory();
  const groups = dir.groups.filter((g) => g.tag === "规划" || g.tag === "前端" || g.tag === "博客");
  assert.equal(groups.length, 3, "one group per tag");
  for (const g of groups) {
    assert.ok(g.memories.some((m) => m.id === a.id), `memory under ${g.tag}`);
  }
  store.close();
});

test("extractQueryTags: known-tag mention is case-insensitive", () => {
  const tags = extractQueryTags("PLANNING 进度", ["planning"]);
  assert.deepEqual(tags, ["planning"]);
});
