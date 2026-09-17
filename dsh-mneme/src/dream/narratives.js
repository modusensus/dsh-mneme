// 叙述条（#164 对齐）纯函数件：tag 主题聚类 + 证据求交。LLM 编排放 dream.js
// （复用其审计/流式/effort 回退基建）；本模块零 I/O，无桩可测。
//
// 设计要点：
// - 主题键 = 共享 tag（确定性的跨 run 稳定键 → 叙述条标题稳定，saveWithDedupe
//   去重可原地刷新，不会每 run 产出重复行）；
// - 证据求交 = 模型给出的 evidence 只保留真实属于本簇成员的 id（防捏造），
//   交空回落为全簇成员（叙述仍成立，证据取全集）。

export const NARRATIVE_MAX_PER_RUN = 3;

/**
 * 按共享 tag 把记忆聚成主题簇。只保留成员数 ≥minCluster 的簇，按簇大小降序
 * 截前 cap 个（一轮最多合成 cap 条叙述）。返回 [{ tag, members: [memory] }]。
 */
export function clusterByTag(memories, { minCluster = 3, cap = NARRATIVE_MAX_PER_RUN } = {}) {
  const byTag = new Map();
  for (const m of memories) {
    for (const tag of Array.isArray(m.tags) ? m.tags : []) {
      if (typeof tag !== "string" || !tag.trim()) continue;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(m);
    }
  }
  return [...byTag.entries()]
    .filter(([, members]) => members.length >= minCluster)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, cap)
    .map(([tag, members]) => ({ tag, members }));
}

/**
 * 证据求交：只保留真实属于本簇成员的 id；交空回落为全簇成员 id。
 * @param {unknown} modelEvidence 模型输出的 evidence（不可信）
 * @param {Array<{id: string}>} members 本簇成员
 * @returns {string[]}
 */
export function intersectEvidence(modelEvidence, members) {
  const memberIds = new Set(members.map((m) => m.id));
  const valid = (Array.isArray(modelEvidence) ? modelEvidence : [])
    .filter((id) => typeof id === "string" && memberIds.has(id));
  if (valid.length) return valid;
  return members.map((m) => m.id);
}
