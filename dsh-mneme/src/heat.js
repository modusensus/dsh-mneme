// dsh-mneme/src/heat.js
// 热度（heat）纯函数模块：基于类遗忘曲线计算 memory 的当前热度。
// 零数据库依赖，不引入任何外部依赖。

/**
 * 默认的 per-type 衰减因子 λ。
 * λ = 0 表示该类型免疫热度衰减，热度恒为 1.0。
 */
export const TYPE_DECAY_DEFAULTS = Object.freeze({
  preference: 0,    // 免疫：用户画像需长期保持
  pattern: 0,       // 免疫：发现型稳定规律
  summary: 0,       // 免疫：已是压缩产物
  project: 0.0008,  // 慢衰减
  decision: 0.002,  // 中速衰减
  history: 0.006,   // 较快（会话摘要不断被合并）
});

const HOUR_MS = 3600000;
const DEFAULT_ALPHA = 1.2;
const DEFAULT_LAMBDA = 0.002;

/**
 * 将可能的日期值统一转成毫秒时间戳。
 * 支持 Date、number、ISO 字符串；无法解析时返回 NaN。
 */
function toTimestamp(value) {
  if (value === null || value === undefined) return NaN;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : NaN;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  return NaN;
}

/**
 * 获取用于计算热度的参考时间点 ref。
 * 优先取 last_accessed_at；缺失时退到 created_at。
 * 绝不 fallback 到 updated_at。
 */
function getRef(memory) {
  if (!memory || typeof memory !== 'object') return NaN;
  return toTimestamp(memory.last_accessed_at ?? memory.created_at);
}

/**
 * 解析并校验配置，提供安全的 alpha 与衰减表。
 */
function resolveConfig(config) {
  const safe = config && typeof config === 'object' ? config : {};

  let alpha = safe.heatGlobalAlpha ?? DEFAULT_ALPHA;
  if (!Number.isFinite(alpha) || alpha <= 0) {
    alpha = DEFAULT_ALPHA;
  }

  const decayMap = safe.heatTypeDecay ?? TYPE_DECAY_DEFAULTS;

  return { alpha, decayMap };
}

/**
 * 构建热度信号对象，便于调试与后续扩展。
 *
 * @param {object} memory - memory 记录
 * @param {object} config - 插件配置
 * @param {number} [now=Date.now()] - 当前毫秒时间戳
 * @returns {{ type, ref, lambda, alpha, deltaHours }}
 */
export function buildHeatSignals(memory, config, now = Date.now()) {
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const ref = getRef(memory);
  const { alpha, decayMap } = resolveConfig(config);

  const type = memory?.type;

  // 取对应类型的 λ，未知类型走默认
  let lambda = decayMap[type];
  if (!Number.isFinite(lambda)) {
    lambda = DEFAULT_LAMBDA;
  }
  // λ < 0 视为非法，回退到默认；λ === 0 保留为免疫
  if (lambda < 0) {
    lambda = DEFAULT_LAMBDA;
  }

  let deltaHours;
  if (!Number.isFinite(ref)) {
    deltaHours = NaN;
  } else if (nowMs < ref) {
    deltaHours = 0;
  } else {
    deltaHours = (nowMs - ref) / HOUR_MS;
  }

  return { type, ref, lambda, alpha, deltaHours };
}

/**
 * 计算 memory 的热度 H ∈ [0, 1]。
 *
 * 公式：H = 1 / (1 + λ · ΔtHours)^α
 *
 * @param {object} memory - memory 记录
 * @param {number} [now=Date.now()] - 当前毫秒时间戳
 * @param {object} [config={}] - 插件配置
 * @returns {number} 热度值
 */
export function computeHeat(memory, now = Date.now(), config = {}) {
  const signals = buildHeatSignals(memory, config, now);
  const { alpha, lambda, deltaHours, ref } = signals;

  // 无有效参考时间、或未来时间，热度视为满格
  if (!Number.isFinite(ref) || deltaHours <= 0) {
    return 1.0;
  }

  // λ = 0 的类型免疫，热度恒满
  if (lambda === 0) {
    return 1.0;
  }

  const heat = 1 / Math.pow(1 + lambda * deltaHours, alpha);

  // 防止浮点误差越界
  return Math.min(1, Math.max(0, heat));
}