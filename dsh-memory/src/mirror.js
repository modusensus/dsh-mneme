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
  function readHumanEdits(type = undefined) {
    const types = type ? [type] : Object.keys(TYPE_FILE);
    const edits = [];
    for (const t of types) {
      const file = filePath(t);
      if (!file || !existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const blocks = text.split(/^---\s*$/m);
      for (const block of blocks) {
        const idMatch = block.match(/^- \*\*ID\*\*: `([^`]+)`/m);
        if (!idMatch) continue;
        const id = idMatch[1];
        const titleMatch = block.match(/^## (.+)$/m);
        const content = block
          .replace(/^## .+\n?/m, "")
          .replace(/^# .+\n?/m, "")
          .replace(/<!--[\s\S]*?-->\n?/g, "")
          .replace(/^- \*\*(ID|类型|重要性|标签|更新时间|来源)\*\*:.*$/gm, "")
          .replace(/^\s*$/gm, "")
          .trim();
        edits.push({
          id,
          title: titleMatch ? titleMatch[1].replace(/\\([\\`*_[\]{}()#+.!|>~-])/g, "$1") : undefined,
          content
        });
      }
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
