import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mneme from "../src/index.js";

// webServer 可选依赖回归（v0.7.24 修复）：v0.7.23 曾把 webServer 从 inject 声明
// 中去掉想支持 headless，但 apply 里 `if (ctx.webServer)` 在 cordis 4 的 Proxy
// 下访问未注入属性会抛 "cannot get property without inject"（不会返回
// undefined），桌面端插件树直接加载失败。本测试用真实 cordis Context 复现两种
// 宿主形态，守住「有 webServer 时注册 API 路由 / 无 webServer 时不崩」两条底线。
//
// 修复后 webServer 保留在 inject（cordis 等待宿主服务就绪后再 apply，路由注册
// 不落时序），apply 守卫用 ctx.reflect.get 而非直接属性访问。headless 宿主
// 缺 webServer 时 fiber 静默不激活（与 v0.7.22 一致），不抛错。

function buildHost(withWebServer) {
  const ctx = new Context();
  const apiRoutes = [];
  ctx.provide("tools", { register() { return () => {}; } });
  ctx.provide("commands", { register() { return () => {}; } });
  ctx.provide("systemPrompt", { context() { return () => {}; } });
  ctx.provide("agentDefaultModel", { currentSelection() { return { provider: "mock", model: "mock" }; } });
  ctx.provide("llm", {
    async *stream() { yield { type: "finish", reason: { kind: "stop" } }; }
  });
  if (withWebServer) {
    ctx.provide("webServer", { register(route) { apiRoutes.push(route); return () => {}; } });
  }
  return { ctx, apiRoutes };
}

test("desktop host (webServer present): plugin boots and registers API routes", async () => {
  const { ctx, apiRoutes } = buildHost(true);
  const fiber = ctx.plugin(mneme, { memoryDir: mkdtempSync(join(tmpdir(), "mneme-desk-")) });
  await fiber;
  assert.ok(apiRoutes.length > 0, "webServer routes must be registered on desktop");
  assert.ok(apiRoutes.some((r) => r.kind === "exact"), "expect exact routes, got: " + apiRoutes.map((r) => r.kind).join(","));
});

test("headless host (no webServer): plugin must not throw", async () => {
  const { ctx } = buildHost(false);
  const fiber = ctx.plugin(mneme, { memoryDir: mkdtempSync(join(tmpdir(), "mneme-head-")) });
  // INACTIVE fiber 静默等待依赖，fiber promise 不会 reject；只要不抛错即为通过。
  await fiber;
  assert.ok(true, "headless load must not throw");
});

/** Boot the plugin with ctx.logger.warn captured. */
async function bootCapturingWarnings(config) {
  const { ctx } = buildHost(true);
  const warnings = [];
  const original = ctx.logger.warn.bind(ctx.logger);
  ctx.logger.warn = (...args) => { warnings.push(args.join(" ")); original(...args); };
  await ctx.plugin(mneme, config);
  return warnings;
}

// issue #135：向量层未配置时启动必须留下痕迹。此前 legacy OpenAI embedder 恒报
// ready=true，于是向量层「绿的但全哑」可以静默存在很久 —— 本机这样过了数周，
// 语义召回、语义去重、rerank、sleep 冲突检测全部失效而面板一切正常。
// embedProvider 默认就是 "openai"，所以「默认配置 + 空 vector-config」必现。
test("unconfigured vector layer warns once at boot (issue #135)", async () => {
  const warnings = await bootCapturingWarnings({ memoryDir: mkdtempSync(join(tmpdir(), "mneme-warn-")) });
  const vectorWarnings = warnings.filter((w) => w.includes("向量层未配置"));
  assert.equal(vectorWarnings.length, 1, "exactly one warning, not one per use:\n" + warnings.join("\n"));
  // 告警必须点名实际受影响的能力，否则用户不知道该去修什么。
  for (const feature of ["语义召回", "rerank", "sleep", "dream"]) {
    assert.ok(vectorWarnings[0].includes(feature), `warning must name ${feature}: ${vectorWarnings[0]}`);
  }
});

// 轻量模式是有意的选择、不是配置错误：不能刷这条告警（整条向量管线本就不装配）。
test("light mode does not warn about the vector layer (issue #135)", async () => {
  const warnings = await bootCapturingWarnings({
    memoryDir: mkdtempSync(join(tmpdir(), "mneme-light-")),
    lightMode: true
  });
  assert.deepEqual(warnings.filter((w) => w.includes("向量层未配置")), []);
});
