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
    /** Tagging switches (autoTag opt-in LLM pass + manual tag editing gate). */
    getAutoTagConfig() {
      const raw = getSetting("autoTag");
      let stored = {};
      if (raw) {
        try {
          const j = JSON.parse(raw);
          if (j && typeof j === "object") stored = j;
        } catch { /* fall through to defaults */ }
      }
      return {
        autoTagEnabled: stored.autoTagEnabled === true,
        manualTagEnabled: stored.manualTagEnabled === true
      };
    },
    setAutoTagConfig(partial) {
      const cur = (() => {
        const raw = getSetting("autoTag");
        try {
          const j = JSON.parse(raw);
          return j && typeof j === "object" ? j : {};
        } catch { return {}; }
      })();
      const cfg = {
        autoTagEnabled: partial.autoTagEnabled === undefined ? cur.autoTagEnabled === true : partial.autoTagEnabled === true,
        manualTagEnabled: partial.manualTagEnabled === undefined ? cur.manualTagEnabled === true : partial.manualTagEnabled === true
      };
      setSetting("autoTag", JSON.stringify(cfg));
      return cfg;
    }
  };
}
