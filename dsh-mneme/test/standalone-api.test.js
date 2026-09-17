import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createStandaloneApi } from "../src/api-standalone.js";
import { Config, applyLightModePreset } from "../src/config.js";

// Real HTTP server on an OS-assigned port (port: 0), driven with fetch.
async function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0 });
  await api.ready;
  const base = `http://127.0.0.1:${api.port}`;
  const auth = { authorization: `Bearer ${api.token}` };
  return {
    store,
    service,
    settings,
    api,
    base,
    auth,
    close: () => {
      // Drop pooled keep-alive sockets so node --test can drain the loop.
      api.server.closeIdleConnections?.();
      api.server.close();
      store.close();
    }
  };
}

// --- auth ---------------------------------------------------------------------

test("GET /health is open without a token; every other route 401s", async () => {
  const { base, close } = await setup();
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    for (const path of ["/status", "/profile", "/rules", "/memories", "/memories/x", "/search?q=x"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} requires a token`);
      assert.deepEqual(await res.json(), { error: "unauthorized" });
    }

    const bad = await fetch(`${base}/status`, { headers: { authorization: "Bearer wrong-token" } });
    assert.equal(bad.status, 401, "wrong token rejected");
  } finally {
    close();
  }
});

test("GET /profile and /rules return saved settings", async () => {
  const { base, auth, settings, close } = await setup();
  try {
    settings.setProfile("我是后端工程师");
    settings.setRules(["先验证再修改", "默认使用中文回复"]);

    const profile = await fetch(`${base}/profile`, { headers: auth });
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), { profile: "我是后端工程师" });

    const rules = await fetch(`${base}/rules`, { headers: auth });
    assert.equal(rules.status, 200);
    assert.deepEqual(await rules.json(), { rules: ["先验证再修改", "默认使用中文回复"] });
  } finally {
    close();
  }
});

test("GET /profile and /rules return empty values when unset", async () => {
  const { base, auth, close } = await setup();
  try {
    const profile = await fetch(`${base}/profile`, { headers: auth });
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), { profile: "" });

    const rules = await fetch(`${base}/rules`, { headers: auth });
    assert.equal(rules.status, 200);
    assert.deepEqual(await rules.json(), { rules: [] });
  } finally {
    close();
  }
});

test("token is persisted into settings kv and reused across restarts", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const first = createStandaloneApi({ service, store, config: {}, settings, port: 0 });
  await first.ready;
  try {
    assert.equal(settings.getExternalApi().token, first.token, "generated token persisted");
    assert.ok(first.token.length >= 20, "token is a real random value");
    const second = createStandaloneApi({ service, store, config: {}, settings, port: 0 });
    await second.ready;
    assert.equal(second.token, first.token, "restart reuses the persisted token");
    second.server.closeIdleConnections?.();
    second.server.close();
  } finally {
    first.server.closeIdleConnections?.();
    first.server.close();
    store.close();
  }
});

// --- CRUD loop ------------------------------------------------------------------

test("POST/GET/DELETE /memories round trip", async () => {
  const { base, auth, close } = await setup();
  try {
    const post = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "preference", title: "语言", content: "始终用中文回复", importance: 4, tags: ["交流"] })
    });
    assert.equal(post.status, 201);
    const created = await post.json();
    assert.ok(created.id, "row id returned");
    assert.equal(created.title, "语言");
    assert.equal(created.importance, 4);

    const list = await fetch(`${base}/memories?limit=10`, { headers: auth });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.total, 1);
    assert.equal(listBody.items.length, 1);

    const got = await fetch(`${base}/memories/${created.id}`, { headers: auth });
    assert.equal(got.status, 200);
    assert.equal((await got.json()).content, "始终用中文回复");

    const del = await fetch(`${base}/memories/${created.id}`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });

    const gone = await fetch(`${base}/memories/${created.id}`, { headers: auth });
    assert.equal(gone.status, 404, "deleted row reads back as 404");
    const delAgain = await fetch(`${base}/memories/${created.id}`, { method: "DELETE", headers: auth });
    assert.equal(delAgain.status, 404, "deleting a missing row is 404, not a fake ok");
  } finally {
    close();
  }
});

test("POST /memories dedupes same title within a type (200 + merged content)", async () => {
  const { base, auth, close } = await setup();
  try {
    const first = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "mneme", content: "v1 内容" })
    });
    assert.equal(first.status, 201);
    const row1 = await first.json();

    const second = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "mneme", content: "v2 追加" })
    });
    assert.equal(second.status, 200, "merge, not a second creation");
    const row2 = await second.json();
    assert.equal(row2.id, row1.id, "same row reused");
    assert.ok(row2.content.includes("v1 内容") && row2.content.includes("v2 追加"), "content appended");

    const list = await fetch(`${base}/memories`, { headers: auth });
    assert.equal((await list.json()).total, 1, "no duplicate row created");
  } finally {
    close();
  }
});

test("POST /memories validation: invalid type, bad JSON, non-array tags → 400", async () => {
  const { base, auth, close } = await setup();
  try {
    const badType = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "diary", title: "t", content: "c" })
    });
    assert.equal(badType.status, 400);
    assert.deepEqual(await badType.json(), { error: "invalid-type" });

    const badJson = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{not json"
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "invalid-json" });

    const badTags = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "t", content: "c", tags: "x" })
    });
    assert.equal(badTags.status, 400);
    assert.deepEqual(await badTags.json(), { error: "tags-must-be-an-array" });

    const noTitle = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", content: "c" })
    });
    assert.equal(noTitle.status, 400);
    assert.deepEqual(await noTitle.json(), { error: "missing-title" });
  } finally {
    close();
  }
});

// --- list filters / status / search ---------------------------------------------

test("GET /memories honors type + minImportance filters and paging", async () => {
  const { base, auth, service, close } = await setup();
  try {
    service.saveWithDedupe({ type: "preference", title: "低", content: "i2", importance: 2 });
    service.saveWithDedupe({ type: "preference", title: "高", content: "i5", importance: 5 });
    service.saveWithDedupe({ type: "project", title: "项目", content: "i4", importance: 4 });

    const byType = await fetch(`${base}/memories?type=preference`, { headers: auth });
    assert.equal((await byType.json()).total, 2);

    const byImportance = await fetch(`${base}/memories?minImportance=4`, { headers: auth });
    const filtered = await byImportance.json();
    assert.equal(filtered.total, 2);
    assert.deepEqual(filtered.items.map((m) => m.title).sort(), ["项目", "高"]);

    const paged = await fetch(`${base}/memories?limit=2&offset=0&order=chrono`, { headers: auth });
    const page = await paged.json();
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
  } finally {
    close();
  }
});

test("GET /status reports version, per-type totals, entities and uptime", async () => {
  const { base, auth, service, close } = await setup();
  try {
    service.saveWithDedupe({ type: "preference", title: "p", content: "c" });
    service.saveWithDedupe({ type: "project", title: "j", content: "c" });
    service.saveWithDedupe({ type: "project", title: "j2", content: "c" });

    const res = await fetch(`${base}/status`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, "0.7.12");
    assert.equal(body.memories.total, 3);
    assert.equal(body.memories.byType.preference, 1);
    assert.equal(body.memories.byType.project, 2);
    assert.equal(body.entities, 0, "no extraction wired → empty entity table");
    assert.ok(Number.isInteger(body.uptime_s));
  } finally {
    close();
  }
});

test("GET /search finds saved memories; empty q returns empty keyword result", async () => {
  const { base, auth, close } = await setup();
  try {
    await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "记忆插件", content: "SQLite 全文检索" })
    });

    const res = await fetch(`${base}/search?q=${encodeURIComponent("全文检索")}&mode=keyword`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "keyword");
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].title, "记忆插件");

    const empty = await fetch(`${base}/search?q=`, { headers: auth });
    assert.deepEqual(await empty.json(), { items: [], mode: "keyword" });
  } finally {
    close();
  }
});

test("unknown path returns 404 json", async () => {
  const { base, auth, close } = await setup();
  try {
    const res = await fetch(`${base}/nope`, { headers: auth });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not-found" });
  } finally {
    close();
  }
});

// --- light-mode preset (applyLightModePreset) ------------------------------------

const LIGHT_OFF_FIELDS = [
  "entityExtractionEnabled",
  "autoDream",
  "sleepModeEnabled",
  "rerankEnabled",
  "autoReindexOnBoot",
  "hybridInject",
  "searchSemanticDedup",
  "selectiveInjectEnabled",
  "bm25SearchEnabled"
];

test("applyLightModePreset turns heavy features off and keeps the core loop", () => {
  const cfg = applyLightModePreset(Config({ lightMode: true }));
  for (const field of LIGHT_OFF_FIELDS) {
    assert.equal(cfg[field], false, `${field} forced off in light mode`);
  }
  // Core loop preserved.
  assert.equal(cfg.autoInject, true);
  assert.equal(cfg.autoSummarize, true);
  assert.equal(cfg.hotMemoryEnabled, true);
  assert.equal(cfg.memoryQualityFilter.enabled, true);
  // Unrelated knobs untouched.
  assert.equal(cfg.dreamThresholdCount, 10);
  assert.equal(cfg.dreamDelayMs, 2000);
  assert.equal(cfg.maxInjectedItems, 5);
});

test("applyLightModePreset keeps explicit non-preset values and is a no-op without lightMode", () => {
  const tuned = applyLightModePreset(Config({ lightMode: true, dreamThresholdCount: 30, maxInjectedItems: 8 }));
  assert.equal(tuned.dreamThresholdCount, 30, "operator values survive the preset");
  assert.equal(tuned.maxInjectedItems, 8);

  const plain = Config({});
  assert.equal(applyLightModePreset(plain), plain, "identity when lightMode is unset");
  const off = Config({ lightMode: false });
  assert.equal(applyLightModePreset(off), off, "identity when lightMode is false");
});

test("persisted panel_mode=light wins over a bundle config that did not ask for it", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  try {
    // Panel switched to light in a previous session; bundle config says nothing.
    settings.setPanelMode("light");
    const rawCfg = Config({});
    const lightMode = rawCfg.lightMode === true || settings.getPanelMode() === "light";
    const cfg = applyLightModePreset({ ...rawCfg, lightMode });
    assert.equal(lightMode, true, "persisted mode forces light");
    assert.equal(cfg.autoDream, false);
    assert.equal(cfg.entityExtractionEnabled, false);
    assert.equal(cfg.autoInject, true, "core injection stays on");

    // standard (default) never forces the preset even with a light bundle flag off.
    settings.setPanelMode("standard");
    const raw2 = Config({});
    assert.equal(raw2.lightMode === true || settings.getPanelMode() === "light", false);
  } finally {
    store.close();
  }
});

// --- #181：MCP 六件套的 API 面（PUT / save 透传 / archived 与 occurred 窗口）---

test("PUT /memories/:id patches fields and returns the DTO (unauthorized without token)", async () => {
  const { base, auth, service, close } = await setup();
  try {
    const created = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "preference", title: "编辑器", content: "用 vim", importance: 3 })
    })).json();

    const noAuth = await fetch(`${base}/memories/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "用 nvim" })
    });
    assert.equal(noAuth.status, 401, "PUT requires the Bearer token");

    const put = await fetch(`${base}/memories/${created.id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ content: "用 nvim", importance: 4, tags: ["工具"], reason: "用户改用 nvim 了" })
    });
    assert.equal(put.status, 200);
    const { memory } = await put.json();
    assert.equal(memory.content, "用 nvim");
    assert.equal(memory.importance, 4);
    assert.deepEqual(memory.tags, ["工具"]);

    // content 改写按 human_override 入档（与内部面板写路径一致）。
    const raw = service.getById(created.id);
    assert.equal(raw.content_history?.[0]?.source, "human_override");
    assert.equal(raw.content_history?.[0]?.content, "用 vim");
  } finally {
    close();
  }
});

test("PUT /memories/:id validation: bad fields → 400, empty patch → 400, missing id → 404", async () => {
  const { base, auth, close } = await setup();
  try {
    const put = (body, id = "whatever") => fetch(`${base}/memories/${id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal((await put({ title: "" })).status, 400);
    assert.equal((await put({ importance: 9 })).status, 400);
    assert.equal((await put({ tags: "x" })).status, 400);
    assert.equal((await put({ type: "nope" })).status, 400);
    assert.equal((await put({})).status, 400, "empty patch is no-fields");
    assert.equal((await put({ content: "x" }, "missing-id")).status, 404);
    assert.equal((await put({ agent_scope: 5 })).status, 400);
  } finally {
    close();
  }
});

test("PUT /memories/:id surfaces service failures as 500 instead of a hung request", async () => {
  const { base, auth, service, close } = await setup();
  try {
    const created = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "preference", title: "会抛错", content: "v1" })
    })).json();
    const original = service.update;
    service.update = () => { throw new Error("boom"); };
    try {
      const res = await fetch(`${base}/memories/${created.id}`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ content: "v2" })
      });
      assert.equal(res.status, 500, "service throw must not strand the request");
      assert.deepEqual(await res.json(), { error: "internal" });
    } finally {
      service.update = original;
    }
  } finally {
    close();
  }
});

test("POST /memories passes through sensitivity/occurred_at/scope and returns action", async () => {
  const { base, auth, close } = await setup();
  try {
    const post = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        type: "decision",
        title: "迁移",
        content: "迁到 sqlite 分支",
        sensitivity: "personal",
        occurred_at: "2026-01-15T10:00:00Z",
        agent_scope: "global"
      })
    });
    assert.equal(post.status, 201);
    const created = await post.json();
    assert.equal(created.action, "created", "action rides along for tool parity");
    assert.equal(created.sensitivity, "personal");
    // store 把 ISO 瞬时归一化成完整毫秒形式（2026-01-15T10:00:00Z → …T10:00:00.000Z）。
    assert.match(created.occurred_at, /^2026-01-15T10:00:00/);
    assert.equal(created.agent_scope, "global");
    assert.equal(created.agent_scope_source, "explicit");

    // 合并判据=同 type + 同标题 + 同 sensitivity + 同作用域三元（0.8.0 起去重键
    // 含 scope，跨作用域同标题本就分开存）：补齐 agent_scope 才 merged。
    const merged = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "decision", title: "迁移", content: "迁到 sqlite 分支（更新）", sensitivity: "personal", agent_scope: "global" })
    })).json();
    assert.equal(merged.action, "merged", "same dedupe key reports merged");

    const separate = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "decision", title: "迁移", content: "无标注版本" })
    })).json();
    assert.equal(separate.action, "created", "no sensitivity/scope → different dedupe key");

    const bad = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "decision", title: "x", content: "y", sensitivity: 5 })
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid-sensitivity");
  } finally {
    close();
  }
});

test("GET /memories supports include_archived and the occurred_at window", async () => {
  const { base, auth, service, close } = await setup();
  try {
    const save = (title, occurredAt) => fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "history", title, content: `body of ${title}`, ...(occurredAt ? { occurred_at: occurredAt } : {}) })
    });
    const january = await (await save("一月的事", "2026-01-15T10:00:00Z")).json();
    await save("二月的事", "2026-02-15T10:00:00Z");
    await save("无时间戳的事", null);

    const february = await (await fetch(`${base}/memories?occurred_from=2026-02-01`, { headers: auth })).json();
    // 「无时间戳的事」按 occurred_at→created_at 回退（写入日 2026-09），落在窗口内。
    assert.deepEqual(february.items.map((m) => m.title).sort(), ["二月的事", "无时间戳的事"]);
    assert.equal(february.total, 2, "total honors the same window");

    const upToJanuary = await (await fetch(`${base}/memories?occurred_to=2026-01-31`, { headers: auth })).json();
    assert.deepEqual(upToJanuary.items.map((m) => m.title), ["一月的事"]);

    service.setArchived(january.id, true);
    const active = await (await fetch(`${base}/memories`, { headers: auth })).json();
    assert.equal(active.total, 2, "archived rows stay hidden by default");
    const withArchived = await (await fetch(`${base}/memories?include_archived=true`, { headers: auth })).json();
    assert.equal(withArchived.total, 3, "include_archived=true surfaces archived rows");
  } finally {
    close();
  }
});

test("GET /search honors the occurred_at window", async () => {
  const { base, auth, close } = await setup();
  try {
    const save = (title, occurredAt) => fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "history", title, content: `记忆星球 ${title}`, ...(occurredAt ? { occurred_at: occurredAt } : {}) })
    });
    await save("旧事", "2026-01-15T10:00:00Z");
    await save("新事", "2026-03-15T10:00:00Z");

    const hit = await (await fetch(`${base}/search?q=${encodeURIComponent("记忆星球")}&occurred_from=2026-03-01`, { headers: auth })).json();
    assert.equal(hit.items.length, 1);
    assert.equal(hit.items[0].title, "新事");
  } finally {
    close();
  }
});
