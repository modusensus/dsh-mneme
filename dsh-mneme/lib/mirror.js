import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const TYPE_FILE = {
  preference: "preferences.md",
  project: "projects.md",
  decision: "decisions.md",
  history: "history.md",
  summary: "summary.md"
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
  // last-rendered digest baseline: sha256(title \x00 content). service.js
  // compares the file hash against this to tell "untouched by a human" (machine
  // write wins) apart from a real human edit, so a not-yet-re-rendered store
  // update is not misread as a concurrent human edit.
  const digest = createHash("sha256")
    .update(`${m.title}\x00${m.content}`)
    .digest("hex");
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
  lines.push(`<!-- mirror-digest: ${digest} -->`);
  lines.push(m.content);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

/**
 * Render one type's memories into exactly the mirror-file text (header +
 * per-memory blocks, updated_at DESC like sync). sync() writes this to disk;
 * the /export endpoint returns the same text, so an exported markdown is
 * byte-compatible with a mirror file and can be fed straight back through
 * parseHumanEdits → mergeHumanEdits. Unknown type → undefined.
 */
export function renderMirrorText(type, memories) {
  const name = TYPE_FILE[type];
  if (!name) return undefined;
  const items = (memories ?? [])
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const header = `# ${name} — dsh-mneme 镜像\n\n<!-- 手工编辑此文件会被合并回记忆库（人工优先）。 -->\n\n`;
  const body = items.map(renderMemory).join("\n");
  return header + body;
}

/**
 * Parse mirror text back into {id, title, content} entries for human edits.
 * Pure text-in/edits-out core: readHumanEdits feeds it mirror file contents
 * and the /import endpoint feeds it user-pasted markdown, so both paths share
 * one parsing implementation (行为一致是硬约束——import 必须能吃回 export 与
 * 磁盘镜像)。Entries are anchored on "- **ID**: `...`" lines that are followed
 * by the "- **类型**:" metadata line (structural entry head): each entry's
 * block spans from its ID line up to the next ID line (or end of text). The
 * block head (the ID line plus the generated metadata run) and the trailing
 * structural "---" separator are stripped; everything in between is the entry
 * body, so user content containing "---", metadata-like lines, or even a
 * machine-format "- **ID**: `x`" line is preserved. The title is the "## "
 * heading preceding the ID line.
 */
export function parseHumanEdits(text) {
  // CRLF 归一化（readHumanEdits 原有的读取侧处理移入纯函数，Windows 手工编辑
  // 的文件与导入文本都能正确解析）。
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const edits = [];
  // Anchor on the ID line only when it is a structural entry head: the
  // machine-rendered ID line is always followed by the "- **类型**:" line.
  // A body line like "- **ID**: `x`" is not, so it never splits the block
  // or produces a ghost entry.
  const anchors = [...normalized.matchAll(/^- \*\*ID\*\*: `([^`]+)`\n- \*\*类型\*\*:/gm)];
  let prevEnd = 0;
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const blockStart = anchor.index;
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].index : normalized.length;

    // Title: last "## " heading before this ID line (file header region /
    // previous block tail). Body headings of earlier entries come before
    // the structural "---" + "## " of this entry, so the last match wins.
    const titleMatches = [...normalized.slice(prevEnd, blockStart).matchAll(/^## (.+)$/gm)];
    const titleMatch = titleMatches[titleMatches.length - 1];

    // Body: the ID line and the generated metadata run are structural head;
    // everything after them up to the trailing "---" separator is the body.
    let body = normalized
      .slice(blockStart, blockEnd)
      .replace(/^- \*\*ID\*\*: `[^`]+`\n?/, "")
      .replace(/^(- \*\*(类型|重要性|标签|更新时间|来源)\*\*:.*\n?)+/, "")
      .replace(/^<!-- mirror-digest: [a-f0-9]+ -->\n?/m, "");
    const separators = [...body.matchAll(/^---\s*$/gm)];
    const lastSep = separators[separators.length - 1];
    if (lastSep) body = body.slice(0, lastSep.index);
    body = body.trim();

    // The machine-written "更新时间" line records the store's updated_at at
    // render time — the version token for detecting a concurrent store write
    // during a three-way merge of human edits (see service.syncMirror).
    const block = normalized.slice(blockStart, blockEnd);
    const updatedMatch = block.match(/- \*\*更新时间\*\*: ([^\n]+)/);
    const digestMatch = block.match(/<!-- mirror-digest: ([a-f0-9]+) -->/);
    edits.push({
      id: anchor[1],
      title: titleMatch ? unescape(titleMatch[1]).trim() : undefined,
      content: body,
      updated_at: updatedMatch ? updatedMatch[1].trim() : undefined,
      digest: digestMatch ? digestMatch[1] : undefined
    });

    const lineEnd = normalized.indexOf("\n", blockStart);
    prevEnd = lineEnd === -1 ? normalized.length : lineEnd + 1;
  }
  return edits;
}

export function createMirror(dir) {
  mkdirSync(dir, { recursive: true });

  function filePath(type) {
    const name = TYPE_FILE[type];
    return name ? join(dir, name) : undefined;
  }

  /**
   * Read the mirror files and parse them back into human edits. The pure
   * parsing logic lives in the exported parseHumanEdits (shared with /import);
   * this wrapper only owns the "read file → text" side.
   */
  function readHumanEdits(type = undefined) {
    const types = type ? [type] : Object.keys(TYPE_FILE);
    const edits = [];
    for (const t of types) {
      const file = filePath(t);
      if (!file || !existsSync(file)) continue;
      edits.push(...parseHumanEdits(readFileSync(file, "utf8")));
    }
    return edits;
  }

  function sync(memories) {
    const byType = {};
    for (const m of memories) {
      (byType[m.type] ??= []).push(m);
    }
    // Per-type physical outcomes (audit peer D): a failed write for one type
    // must not abort the whole render. Each type is written (or pruned) in its
    // own try/catch and the result reported so the caller can persist per-type
    // committed/failed receipts — a file that was already written is a real
    // physical commit even when a sibling type errors.
    const results = {};
    for (const type of Object.keys(TYPE_FILE)) {
      try {
        const file = filePath(type);
        const items = (byType[type] ?? [])
          .slice()
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        if (items.length === 0) {
          // no memories of this type: drop any stale mirror file so deleted
          // memories do not "resurrect" via readHumanEdits
          rmSync(file, { force: true });
        } else {
          // 渲染走 renderMirrorText（与 /export 共用同一条渲染路径），磁盘镜像
          // 与导出文本永远同构。
          writeFileSync(file, renderMirrorText(type, items), "utf8");
        }
        results[type] = { ok: true };
      } catch (error) {
        results[type] = { ok: false, error: error?.message ?? String(error) };
      }
    }
    return results;
  }

  return { filePath, sync, readHumanEdits };
}
