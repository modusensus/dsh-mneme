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
// scopeEnabled 关闭时 resolveWriteScope 返回 null，调用方一个字段都不该标注，
// 写入与去重行为和 A1 之前逐字节一致。

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
    if (config?.scopeEnabled !== true) return null;

    let session = null;
    try {
      session = exec?.agent?.session ?? null;
    } catch {
      session = null;
    }

    // 持久化 header：优先 live 的 requestHeader()，旧宿主只有静态 .header 属性。
    let header = null;
    try {
      header = session?.requestHeader?.() ?? session?.header ?? null;
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
