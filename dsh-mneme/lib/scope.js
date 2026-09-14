// v0.8.0 A1（issue #17）：写入端 scope 解析。
//
// 身份模型（issue #17 的核心约定）：session 只是「载体」，记忆挂在持久化身份
// 标签上——agent_scope = session header 的 agentPreset（跨会话稳定的 agent 模板
// 身份），workspace_scope = 会话工作目录（registry 反查的 canonical path 优先，
// header.cwd 兜底）。session_id 永不作为作用域键。
//
// 硬约束：解析失败绝不阻塞写入——任何一步取不到就落 NULL（读侧 NULL = 未标注
// = 全局可见），任何异常都被吞掉（registry 故障 warn 一次后降级）。
//
// v0.8.1（issue #170 复核项 2）：scopeEnabled 的闸门从解析器挪到「写标注」处
// （memory_save 的 auto 分支）。解析器恒返回会话身份（真取不到才是 null）——
// 读取侧（strictVisibility / memory_get / inject）与显式声明都依赖它：flag 关
// 只关「自动标注」，不能连读取身份一起关，否则 strictScope 硬墙被静默拆掉
// （fail-open）。

/**
 * @param {object} deps
 * @param {object} [deps.ctx] 宿主上下文（可能带 workspaceRegistry；旧版 dsh 没有）
 * @param {object} [deps.config] 已解析配置（读 scopeEnabled）
 * @param {object} [deps.logger]
 * @returns {(exec: object) => {agent_scope: string|null, workspace_scope: string|null}|null}
 */
export function createScopeResolver({ ctx, config, logger } = {}) {
  let warned = false;
  const warnOnce = (msg) => {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(msg);
    } catch {
      // logger 自身故障同样不能影响写入路径
    }
  };

  return function resolveWriteScope(exec) {
    let session = null;
    try {
      session = exec?.agent?.session ?? null;
    } catch {
      session = null;
    }

    // 持久化 header（issue #17 的身份契约）：session.header 是创建时冻结的
    // SessionHeader（含 agentPreset/cwd）。⚠️ 不能先读 requestHeader()——那返回
    // EpochHeader（请求级模型路由头，首个请求后即为真值），会把 session.header
    // 遮蔽掉，agentPreset/cwd 双双取空（本地 web 复验 2026-09-13 实测踩中）。
    // 仅当宿主没有 .header 属性时才降级尝试 requestHeader().config（旧形状）。
    let header = null;
    try {
      header = session?.header ?? session?.requestHeader?.()?.config ?? null;
    } catch {
      header = null;
    }

    let agentScope = null;
    const preset = header?.agentPreset;
    if (typeof preset === "string" && preset.trim()) agentScope = preset.trim();

    // workspace：registry 反查优先（成员资格 = id 命中 + header canonical cwd
    // 校验过，path 已 realpath 归一），失败回退 header.cwd，再失败留 NULL。
    let workspaceScope = null;
    try {
      const list = ctx?.workspaceRegistry?.list?.();
      const sessionId = session?.id;
      if (Array.isArray(list) && sessionId != null) {
        const hit = list.find(
          (ws) => Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId)
        );
        if (typeof hit?.path === "string" && hit.path.trim()) workspaceScope = hit.path.trim();
      }
    } catch (e) {
      warnOnce(
        `[dsh-mneme] workspaceRegistry lookup failed, falling back to session header cwd: ${String(e)}`
      );
    }
    if (!workspaceScope) {
      const cwd = header?.cwd;
      if (typeof cwd === "string" && cwd.trim()) workspaceScope = cwd.trim();
    }

    return { agent_scope: agentScope, workspace_scope: workspaceScope };
  };
}

/**
 * v0.8.1 底座（issue #170）：显式 scope 参数（memory_save / memory_update /
 * 面板编辑）的归一化。约定：
 *   - 省略（undefined，由调用方判断）= 该维不声明，回落载体自动标注；
 *   - "global"（大小写不敏感）/ "*" / 空白 = 显式声明全局 → 存储 NULL
 *     （行上的 agent_scope_source='explicit' 承担「显式全局」与「从未标注」
 *     的区分，NULL 本身继续表示全局可见）；
 *   - 其余非空 trim 字符串 = 收窄到该标签。
 * 脏输入（非字符串）落 NULL（等同声明全局）——与 resolveWriteScope 的「解析
 * 绝不阻塞写入」同一哲学：显式声明是用户意图，形状不对时宁可放宽不报错。
 *
 * @param {unknown} raw 工具/HTTP 参数原值
 * @returns {string|null} 归一化后的标签值（null=显式全局）
 */
export function normalizeExplicitScope(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s === "*" || s.toLowerCase() === "global") return null;
  return s;
}
