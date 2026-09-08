import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mneme from "../lib/index.js";

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
