import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export const TYPE_FILE = {
  preference: "preferences.md",
  project: "projects.md",
  decision: "decisions.md",
  history: "history.md"
};

const ESCAPE = /([\\`*_[\]{}()#+.!|>~-])/g;
const UNESCAPE = new RegExp("\\\\" + ESCAPE.source, "g");

function esc(text) {
  return String(text).replace(ESCAPE, "\\$1");
}

function unescape(text) {
  return String(text).replace(UNESCAPE, "$1");
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
   * Parse a mirror file back into {id, title, content} entries for human edits.
   * Entries are anchored on "- **ID**: `...`" lines: each entry's block spans
   * from its ID line up to the next ID line (or end of file). The block head
   * (the ID line plus the generated metadata run) and the trailing structural
   * "---" separator are stripped; everything in between is the entry body, so
   * user content containing "---" or metadata-like lines is preserved. The
   * title is the "## " heading preceding the ID line.
   */
  function readHumanEdits(type = undefined) {
    const types = type ? [type] : Object.keys(TYPE_FILE);
    const edits = [];
    for (const t of types) {
      const file = filePath(t);
      if (!file || !existsSync(file)) continue;
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const anchors = [...text.matchAll(/^- \*\*ID\*\*: `([^`]+)`/gm)];
      let prevEnd = 0;
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const blockStart = anchor.index;
        const blockEnd = i + 1 < anchors.length ? anchors[i + 1].index : text.length;

        // Title: last "## " heading before this ID line (file header region /
        // previous block tail). Body headings of earlier entries come before
        // the structural "---" + "## " of this entry, so the last match wins.
        const titleMatches = [...text.slice(prevEnd, blockStart).matchAll(/^## (.+)$/gm)];
        const titleMatch = titleMatches[titleMatches.length - 1];

        // Body: the ID line and the generated metadata run are structural head;
        // everything after them up to the trailing "---" separator is the body.
        let body = text
          .slice(blockStart, blockEnd)
          .replace(/^- \*\*ID\*\*: `[^`]+`\n?/, "")
          .replace(/^(- \*\*(类型|重要性|标签|更新时间|来源)\*\*:.*\n?)+/, "");
        const separators = [...body.matchAll(/^---\s*$/gm)];
        const lastSep = separators[separators.length - 1];
        if (lastSep) body = body.slice(0, lastSep.index);
        body = body.trim();

        edits.push({
          id: anchor[1],
          title: titleMatch ? unescape(titleMatch[1]).trim() : undefined,
          content: body
        });

        const lineEnd = text.indexOf("\n", blockStart);
        prevEnd = lineEnd === -1 ? text.length : lineEnd + 1;
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
      const file = filePath(type);
      const items = (byType[type] ?? [])
        .slice()
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      if (items.length === 0) {
        // no memories of this type: drop any stale mirror file so deleted
        // memories do not "resurrect" via readHumanEdits
        rmSync(file, { force: true });
        continue;
      }
      const header = `# ${TYPE_FILE[type]} — dsh-memory 镜像\n\n<!-- 手工编辑此文件会被合并回记忆库（人工优先）。 -->\n\n`;
      const body = items.map(renderMemory).join("\n");
      writeFileSync(file, header + body, "utf8");
    }
  }

  return { filePath, sync, readHumanEdits };
}
