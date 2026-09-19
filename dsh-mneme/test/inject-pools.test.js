import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createTools } from "../src/tools.js";
import { MEMORY_GUIDE_SECTION } from "../src/guide.js";

// 回归（issue #249 第一批）：注入形态的两件事——
// ①能力说明（injectGuidanceEnabled）：工具描述补判断指引 + order 150 一次性
//   总则段（常驻段必须同会话稳定，不逐轮复读）；
// ②B1 pin 池（pinnedInjectBudget）：约束/偏好不进相关性竞争与跨轮轮换、逐字
//   保真、排在块内排序之前，且有独立小预算（不占 maxInjectedItems 名额）。
// 两个键都默认关/零，默认档下注入块与改动前逐字节一致（本文件第一例锁这条）。

const userMsg = (text) => ({
  type: "user/message",
  data: { source: { kind: "user" }, content: [{ type: "text", text }] }
});

function setup(over = {}) {
  const store = createStore(":memory:");
  // 同一份 config 同时交给 service 与 injector——生产里是同一个 cfg 对象，
  // 而 pin 池的预算读取发生在 service 内、能力说明的开关读取发生在 injector 内。
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const contexts = [];
  const sections = [];
  const ctx = {
    systemPrompt: {
      context(def) { contexts.push(def); return () => {}; },
      section(def) { sections.push(def); return () => {}; }
    }
  };
  createInjector(ctx, service, settings, config);
  const text = (query = "") => contexts[0].text({
    agent: { session: { id: "s1", snapshotEvents: () => (query ? [userMsg(query)] : []) } }
  });
  return { store, service, contexts, sections, text };
}

const types = (body) => [...body.matchAll(/- \[(\w+)\]/g)].map((m) => m[1]);
const leadPreference = (body) => body.match(/- \[preference\] ([^（(]*)/)?.[1]?.trim();

test("#249: default (pinned budget 0) keeps the legacy order and adds no annotation", () => {
  const { service, text } = setup({});
  service.saveWithDedupe({ type: "summary", title: "总览", content: "总览内容", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "偏好A", content: "偏好内容", importance: 5 });
  const body = text();
  // 现状档位：蒸馏摘要(0) 先于偏好(1)。pin 关闭时不得出现「偏好前置」这一改动。
  assert.deepEqual(types(body), ["summary", "preference"], "budget 0 → legacy priority order");
  assert.ok(!body.includes("未展示"), "pool off → no overflow annotation");
});

test("#249: pinned entries lead the block and sit outside maxInjectedItems", () => {
  const { service, text } = setup({ maxInjectedItems: 2, pinnedInjectBudget: 2 });
  service.saveWithDedupe({ type: "summary", title: "总览", content: "总览内容", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "偏好A", content: "偏好甲内容", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "偏好B", content: "偏好乙内容", importance: 5 });
  service.saveWithDedupe({ type: "decision", title: "决定甲", content: "决定内容", importance: 5 });
  const body = text();
  const seq = types(body);
  assert.deepEqual(seq.slice(0, 2), ["preference", "preference"], "pin pool leads the block");
  assert.deepEqual(seq.slice(2), ["summary", "decision"], "general slots still fill to maxItems");
  assert.equal(seq.length, 4, "pinned entries do not consume maxInjectedItems slots");
});

test("#249: over-budget pinned entries are annotated, never silently dropped", () => {
  const { service, text } = setup({ maxInjectedItems: 1, pinnedInjectBudget: 1 });
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "preference", title: `偏好${i}`, content: `第 ${i} 条偏好内容`, importance: 5 });
  }
  const body = text();
  assert.ok(body.includes("另有 2 条未展示"), `annotation must carry the hidden count: ${body}`);
});

test("#249: pinned entries are exempt from cross-turn rotation", () => {
  const { service, text } = setup({ maxInjectedItems: 1, pinnedInjectBudget: 1, injectRotationTurns: 2 });
  service.saveWithDedupe({ type: "preference", title: "偏好A", content: "偏好甲内容", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "偏好B", content: "偏好乙内容", importance: 5 });
  service.saveWithDedupe({ type: "decision", title: "决定甲", content: "决定内容", importance: 5 });
  service.saveWithDedupe({ type: "decision", title: "决定乙", content: "另一决定", importance: 5 });
  const first = leadPreference(text("第一个问题"));
  const second = leadPreference(text("第二个问题"));
  assert.ok(first, "pin entry is rendered in turn 1");
  assert.equal(first, second, "pin stays at the block head across turns (not rotated away)");
});

test("#249: pinned content is verbatim below the hard ceiling", () => {
  const { service, text } = setup({ maxInjectedItems: 1, pinnedInjectBudget: 1, injectContentMaxChars: 60 });
  const long = "约束原文".repeat(60); // 240 chars, 4× the per-entry cap
  service.saveWithDedupe({ type: "preference", title: "长偏好", content: long, importance: 5 });
  const body = text();
  assert.ok(body.includes(long), "240-char pinned body goes in verbatim (injectContentMaxChars does not apply)");
  assert.ok(!body.includes("已截断"), "no truncation hint needed below the ceiling");
});

test("#249: pinned content still honours the hard ceiling and says so", () => {
  const { service, text } = setup({ maxInjectedItems: 1, pinnedInjectBudget: 1 });
  const huge = "超长约束".repeat(900); // 3600 chars
  service.saveWithDedupe({ type: "preference", title: "超长偏好", content: huge, importance: 5 });
  const body = text();
  assert.ok(!body.includes(huge), "a runaway pinned entry cannot flood the standing block");
  assert.ok(body.includes("已截断"), "the cut is reported, never silent");
});

test("#249: pinned content does not eat the general block budget", () => {
  // 一条 pin 就够击穿 MAX_BLOCK（PINNED_CONTENT_MAX 2000 > MAX_BLOCK 1500）：pin
  // 若照旧扣共享预算，budget 变负后同一轮的所有普通候选都会被压成标题行。
  const { service, text } = setup({ maxInjectedItems: 2, pinnedInjectBudget: 1 });
  const longPinned = "约束原文".repeat(470); // 1880 字符，仍在 2000 硬顶内（不带截断）
  service.saveWithDedupe({ type: "preference", title: "长约束", content: longPinned, importance: 5 });
  service.saveWithDedupe({ type: "summary", title: "总览", content: "总览正文必须带出来", importance: 5 });
  const body = text();
  assert.ok(body.includes(longPinned), "pin 逐字保真");
  assert.ok(body.includes("总览正文必须带出来"), "普通候选照旧拿完整正文：pin 不占共享预算");
});

test("#249: capability guide is off by default, registered once when on", () => {
  const off = setup({});
  assert.equal(off.sections.length, 0, "default off → no prompt section registered");

  const on = setup({ injectGuidanceEnabled: true });
  assert.equal(on.sections.length, 1, "exactly one guide section");
  assert.equal(on.sections[0].name, "memory-guide");
  assert.equal(on.sections[0].order, 150, "插件指引段的既有 order 惯例");
  assert.equal(on.sections[0].text, MEMORY_GUIDE_SECTION, "常量文本 → 同会话内稳定");
  // 不可逆工具（memory_delete）的克制指引必须在场：这是全 guide 里唯一有数据
  // 损失后果的一句，被误删掉的回归要能立刻转红。
  assert.ok(MEMORY_GUIDE_SECTION.includes("memory_delete"), "guide keeps the irreversible-tool warning");
  // 优先序那条不得让模型拿 memory_search 去核对当前指令/仓库：它只搜记忆库，
  // 搜不到「现在」——把它写成验证手段会换来一轮无效查询 + 继续采信陈旧记忆。
  assert.ok(
    MEMORY_GUIDE_SECTION.includes("memory_search searches stored memories only"),
    "precedence rule points at the instruction/repository, not at memory_search"
  );
  // 不逐轮复读：通则只出现在一次性段落，每轮内容块里不重复。
  on.service.saveWithDedupe({ type: "preference", title: "偏好A", content: "偏好内容", importance: 5 });
  assert.ok(!on.text().includes("[dsh-mneme memory]"), "guide text must not ride the per-turn block");
});

test("#249: capability guide extends only the judgement-heavy tool descriptions", () => {
  const toolsFor = (flags) => {
    const store = createStore(":memory:");
    const service = createService({ store, mirror: null, config: {} });
    const registered = [];
    const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
    createTools(ctx, service, { ...flags }, null);
    return new Map(registered.map((t) => [t.name, t.description]));
  };
  const off = toolsFor({});
  const on = toolsFor({ injectGuidanceEnabled: true });
  const changed = [...off.keys()].filter((name) => off.get(name) !== on.get(name)).sort();
  assert.deepEqual(changed, ["memory_save", "memory_search"], "only the two 'when to use' tools gain guidance");
  for (const name of changed) {
    assert.ok(on.get(name).startsWith(off.get(name)), `${name}: guidance is appended, original text untouched`);
  }
});
