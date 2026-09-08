// User-configurable settings: profile (user self-description), rules (behavior
// rules the agent must follow), and custom slash commands. Stored in the same
// SQLite database via dedicated tables, isolated from the memories store.
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_commands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

// DSH command names must match this (lowercase, start with a letter).
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;

/** Parse a JSON array out of a stored string, tolerant of corruption. */
function parseList(raw) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// --- feature flags（功能开关）白名单 -----------------------------------------
// 面板可逐项开关的后端能力。设计约束：
// 1. 键名与类型必须和 config.js schema 同名同型，这份白名单是唯一校验源
//    （api.js 复用它计算 effective），schema 增删能力键时要同步改这里。
// 2. 持久化（kv "feature_flags"）只落白名单键；读到未知键、类型损坏或越界的
//    值一律丢弃而不是报错——kv 会残留旧版本写入的键，读路径必须向前兼容。
// 3. 写入是逐键校验的合并写：未知键/类型/范围不符抛 TypeError（消息含键名，
//    供 API 透传给前端定位），校验不通过不落库，坏值永远进不了 kv。
const FEATURE_FLAG_BOOLEANS = [
  "autoInject",
  "autoSummarize",
  "hotMemoryEnabled",
  "entityExtractionEnabled",
  "codingRetrospect",
  "autoDream",
  "sleepModeEnabled",
  "heatEnabled",
  "hybridInject",
  "selectiveInjectEnabled",
  "searchSemanticDedup",
  "rerankEnabled",
  "adaptiveThresholdEnabled",
  "reflectionUpdateEnabled",
  "reflectionFailureTracking",
  "bm25SearchEnabled",
  "conflictFreezeEnabled",
  "trustEpistemicWeighting",
  // 嵌套对象开关：config.js 里是 memoryQualityFilter / llmAudit 对象的 enabled
  // 子字段。kv 按点号键平铺存（"memoryQualityFilter.enabled": false），index.js
  // 合并时展开回嵌套对象，api.js 的 effective 从对象子字段取值。
  "memoryQualityFilter.enabled",
  "llmAudit.enabled"
];
// 整数开关的闭区间，与 config.js 里 z.natural().min().max() 对齐。
const FEATURE_FLAG_INT_RANGES = {
  distillRateLimitIntervalMs: [0, 60000],
  distillRateLimitRetries: [0, 10],
  distillRateLimitBaseDelayMs: [100, 60000],
  distillMaxChars: [1000, 200000],
  codingBoostFactor: [1, 5]
};
// 自由字符串开关（与 config.js 的 z.string() 同名同型）：trim 后 ≤200 字符，
// 空串合法（= 跟随主对话模型/默认路径，面板显示 placeholder）。
const FEATURE_FLAG_STRINGS = [
  "dreamProvider",
  "dreamModel",
  "localEmbedModel",
  "ollamaModel"
];
// URL 字符串开关：trim 后必须为空或合法 http/https URL（new URL() 校验协议，
// 拒绝其余协议——这是 SSRF 防线的一部分）。
const FEATURE_FLAG_URLS = ["ollamaBaseUrl"];
// 枚举开关（与 config.js 的 z.union(z.const(...)) 对齐）：仅允许列出的值。
const FEATURE_FLAG_ENUMS = {
  embedProvider: ["openai", "local", "ollama"]
};
const FEATURE_FLAG_STRING_MAX = 200;

// 供 api.js 复用同一份白名单（effective 只在白名单键上计算）。
export const FEATURE_FLAG_SPEC = {
  booleans: FEATURE_FLAG_BOOLEANS,
  ints: FEATURE_FLAG_INT_RANGES,
  strings: FEATURE_FLAG_STRINGS,
  urls: FEATURE_FLAG_URLS,
  enums: FEATURE_FLAG_ENUMS
};

/** ollamaBaseUrl 的协议白名单：只接受 http/https（SSRF 防线的一部分）。 */
function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** 校验单个开关值；不合法抛 TypeError（消息含键名）。 */
function validateFlag(key, value) {
  if (FEATURE_FLAG_BOOLEANS.includes(key)) {
    if (typeof value !== "boolean") {
      throw new TypeError(`feature flag "${key}" must be a boolean`);
    }
    return value;
  }
  const range = FEATURE_FLAG_INT_RANGES[key];
  if (range) {
    const [min, max] = range;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(`feature flag "${key}" must be an integer in [${min}, ${max}]`);
    }
    return value;
  }
  if (FEATURE_FLAG_STRINGS.includes(key)) {
    if (typeof value !== "string") {
      throw new TypeError(`feature flag "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length > FEATURE_FLAG_STRING_MAX) {
      throw new TypeError(`feature flag "${key}" must be at most ${FEATURE_FLAG_STRING_MAX} characters`);
    }
    return trimmed; // 空串合法 = 跟随默认
  }
  if (FEATURE_FLAG_URLS.includes(key)) {
    if (typeof value !== "string") {
      throw new TypeError(`feature flag "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed && !isHttpUrl(trimmed)) {
      throw new TypeError(`feature flag "${key}" must be empty or a valid http(s) URL`);
    }
    return trimmed; // 空串合法 = 跟随默认
  }
  const allowed = FEATURE_FLAG_ENUMS[key];
  if (allowed) {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new TypeError(`feature flag "${key}" must be one of: ${allowed.join(", ")}`);
    }
    return value;
  }
  throw new TypeError(`unknown feature flag "${key}"`);
}

/** 清洗已存的 feature_flags 对象：只保留白名单键，类型/范围损坏的键丢弃。 */
function sanitizeFlags(raw) {
  const out = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const key of FEATURE_FLAG_BOOLEANS) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  for (const [key, [min, max]] of Object.entries(FEATURE_FLAG_INT_RANGES)) {
    if (Number.isInteger(raw[key]) && raw[key] >= min && raw[key] <= max) out[key] = raw[key];
  }
  for (const key of FEATURE_FLAG_STRINGS) {
    if (typeof raw[key] === "string" && raw[key].trim().length <= FEATURE_FLAG_STRING_MAX) {
      out[key] = raw[key].trim();
    }
  }
  for (const key of FEATURE_FLAG_URLS) {
    if (typeof raw[key] === "string") {
      const trimmed = raw[key].trim();
      if (!trimmed || isHttpUrl(trimmed)) out[key] = trimmed;
    }
  }
  for (const [key, allowed] of Object.entries(FEATURE_FLAG_ENUMS)) {
    if (allowed.includes(raw[key])) out[key] = raw[key];
  }
  return out;
}

export function createSettings(db) {
  db.exec(SCHEMA);

  function getSetting(key) {
    const row = db.prepare("SELECT value FROM user_settings WHERE key = ?").get(key);
    return row?.value ?? undefined;
  }

  function setSetting(key, value) {
    db.prepare(
      `INSERT INTO user_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  function toCommand(row) {
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instruction: row.instruction,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  return {
    /** The user's self-description (free text) or "" when unset. */
    getProfile() {
      return getSetting("profile") ?? "";
    },
    setProfile(text) {
      setSetting("profile", String(text ?? ""));
    },

    /** Behavior rules as an array of strings. */
    getRules() {
      return parseList(getSetting("rules") ?? "[]").filter((r) => typeof r === "string");
    },
    setRules(rules) {
      const list = Array.isArray(rules) ? rules.filter((r) => typeof r === "string") : [];
      setSetting("rules", JSON.stringify(list));
    },

    /** All custom commands, sorted by name. */
    listCommands() {
      const rows = db.prepare("SELECT * FROM custom_commands ORDER BY name ASC").all();
      return rows.map(toCommand);
    },

    /**
     * Add or replace a custom command by name.
     * @returns the stored command.
     * @throws when name is invalid or does not match DSH's command-name grammar.
     */
    addCommand({ name, description = "", instruction }) {
      const cmdName = String(name ?? "").trim();
      if (!COMMAND_NAME.test(cmdName)) {
        throw new Error(`invalid command name "${cmdName}": must match /^[a-z][a-z0-9_-]*$/`);
      }
      if (typeof instruction !== "string" || !instruction.trim()) {
        throw new Error("command instruction must be a non-empty string");
      }
      const now = new Date().toISOString();
      const existing = db.prepare("SELECT id FROM custom_commands WHERE name = ?").get(cmdName);
      if (existing) {
        db.prepare(
          "UPDATE custom_commands SET description = ?, instruction = ?, updated_at = ? WHERE id = ?"
        ).run(String(description ?? ""), instruction, now, existing.id);
        return toCommand(db.prepare("SELECT * FROM custom_commands WHERE id = ?").get(existing.id));
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO custom_commands (id, name, description, instruction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, cmdName, String(description ?? ""), instruction, now, now);
      return toCommand(db.prepare("SELECT * FROM custom_commands WHERE id = ?").get(id));
    },

    /** Remove a custom command by id; returns true when removed. */
    removeCommand(id) {
      const result = db.prepare("DELETE FROM custom_commands WHERE id = ?").run(id);
      return result.changes > 0;
    },

    /** Vector-search provider config (OpenAI-compatible embeddings endpoint). */
    getVectorConfig() {
      const raw = getSetting("vector");
      if (!raw) return undefined;
      try {
        const cfg = JSON.parse(raw);
        return typeof cfg === "object" && cfg !== null ? cfg : undefined;
      } catch {
        return undefined;
      }
    },
    setVectorConfig({ enabled, baseUrl, apiKey, model }) {
      const cfg = {
        enabled: enabled === true || enabled === 1,
        baseUrl: String(baseUrl ?? "").trim().replace(/\/+$/, ""),
        apiKey: String(apiKey ?? "").trim(),
        model: String(model ?? "").trim()
      };
      setSetting("vector", JSON.stringify(cfg));
      return cfg;
    },

    /**
     * Standalone external API settings (kv "external_api"): {enabled, port,
     * token}. The Bearer token is auto-generated on first boot and persisted
     * here. Partial writes preserve the keys they don't mention.
     */
    getExternalApi() {
      const raw = getSetting("external_api");
      if (!raw) return undefined;
      try {
        const cfg = JSON.parse(raw);
        return typeof cfg === "object" && cfg !== null ? cfg : undefined;
      } catch {
        return undefined;
      }
    },
    setExternalApi(patch = {}) {
      const prev = this.getExternalApi() ?? {};
      const port = Number(patch.port ?? prev.port);
      const host = typeof patch.host === "string" && patch.host.trim() ? patch.host.trim() : (prev.host ?? "127.0.0.1");
      const cfg = {
        enabled: patch.enabled !== undefined ? patch.enabled === true : prev.enabled === true,
        port: Number.isInteger(port) && port > 0 ? port : 8790,
        host,
        token: String(patch.token ?? prev.token ?? "")
      };
      setSetting("external_api", JSON.stringify(cfg));
      return cfg;
    },

    /**
     * Web panel mode (kv "panel_mode"): "light" (low-resource preset) or
     * "standard" (full feature set). Unset reads as "standard".
     */
    getPanelMode() {
      return getSetting("panel_mode") === "light" ? "light" : "standard";
    },
    setPanelMode(mode) {
      setSetting("panel_mode", mode === "light" ? "light" : "standard");
    },

    /**
     * Feature flags（kv "feature_flags"）：面板对后端能力的显式覆盖。读取只
     * 返回白名单内的合法键（默认 {}），写入是逐键校验后的合并持久化。
     */
    getFeatureFlags() {
      const raw = getSetting("feature_flags");
      if (!raw) return {};
      try {
        return sanitizeFlags(JSON.parse(raw));
      } catch {
        return {};
      }
    },
    setFeatureFlags(patch) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new TypeError("feature flags patch must be a plain object");
      }
      const merged = this.getFeatureFlags();
      for (const [key, value] of Object.entries(patch)) {
        merged[key] = validateFlag(key, value);
      }
      setSetting("feature_flags", JSON.stringify(merged));
      return merged;
    }
  };
}
