# Security Policy

> **English** | [中文](#安全策略)

---

## Supported Versions

We actively maintain the latest minor version. Security fixes are backported to the latest patch release.

| Version | Supported | Status |
|---|---|---|
| 0.3.x | ✅ Yes | Active development |
| 0.2.x | ⚠️ Best-effort | Critical fixes only |
| < 0.2.0 | ❌ No | Please upgrade |

---

## Reporting a Vulnerability

### Please DO NOT

- Open a public issue for security vulnerabilities
- Post exploit details in discussions or comments
- Submit PRs that expose security flaws without prior coordination

### Please DO

1. **Email** `guanqishi26@gmail.com` (or open a **private security advisory** via GitHub)
2. Include:
   - A clear description of the vulnerability
   - Steps to reproduce (minimal test case preferred)
   - Impact assessment (data exposure? local-only? remote?)
   - Affected versions
   - Your proposed fix (if any)

### Response Timeline

| Phase | Time | Action |
|---|---|---|
| Acknowledgment | Within 48 hours | We confirm receipt and assign a tracking ID |
| Initial Assessment | Within 7 days | We validate severity and scope |
| Fix Development | Severity-dependent | Critical: ≤ 14 days; High: ≤ 30 days; Medium/Low: next release |
| Disclosure | Coordinated | We publish a security advisory and release patch simultaneously |

### Severity Classification

We follow the [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) standard:

- **Critical** (9.0–10.0): Remote code execution, unauthorized data exfiltration, bypass of core security controls
- **High** (7.0–8.9): Local privilege escalation, significant data integrity compromise, DoS with high impact
- **Medium** (4.0–6.9): Information disclosure under specific conditions, partial bypass of controls
- **Low** (0.1–3.9): Minor information leakage, defense-in-depth improvements

---

## Security Design Principles

### 1. Local-First, Zero-Network

- All embeddings, reranking, and memory consolidation run locally
- Memory text **never** leaves the device
- No telemetry, no analytics, no remote logging

### 2. Fail-Safe by Default

- Any component failure (LLM, embedder, reranker) degrades gracefully to keyword search
- Malformed input never crashes the plugin or corrupts the database
- Concurrent write conflicts are resolved via CAS (compare-and-swap) guards

### 3. Audit Everything

- Every `autoDream` run generates a cryptographically verifiable receipt
- Every memory update creates a `failure_memories` audit trail
- Every search records a `recall_run` for later inspection

### 4. Human Sovereignty

- All memories are mirrored to human-editable Markdown files
- Machine writes vs. human edits are distinguished via digest baselines
- Users can fully reconstruct the database from Markdown mirrors alone

---

## Security Audit History

### v0.2.10 — Security Hardening

| ID | Finding | Severity | Status |
|---|---|---|---|
| F-NEW-01 | Concurrent write race on `store.js` | **Critical** | ✅ Fixed (CAS guard + atomic write) |
| F-NEW-02 | Transactional inconsistency during mirror sync | **High** | ✅ Fixed (transactional mirror + rollback) |
| F-NEW-03 | Mirror health state not validated before overwrite | **High** | ✅ Fixed (digest baseline + FSM validation) |

### v0.3.4 — Dependency Security

| CVE | Package | Severity | Status |
|---|---|---|---|
| CVE-2026-39244 | `adm-zip` 0.5.18 | **High** | ✅ Fixed (upgraded to 0.6.0) |

### Ongoing

- Automated dependency scanning via **OrbisAI Security**
- Community security reviews welcome via private advisory

---

## Disclosure Policy

We practice **coordinated disclosure**:

1. Reporter submits vulnerability privately
2. We investigate, develop fix, and prepare advisory
3. We notify reporter of fix timeline
4. We release patch + publish advisory simultaneously
5. We credit the reporter (with their consent) in the advisory

We do **not** pursue legal action against security researchers who:
- Act in good faith
- Do not exploit vulnerabilities beyond proof-of-concept
- Do not access data belonging to others
- Allow reasonable time for us to respond before public disclosure

---

## Security-Related Configuration

```yaml
# Hardened configuration example
dsh-mneme:
  # Disable autoDream if you want full manual control
  autoDream: false
  
  # Enable conflict freeze for sensitive environments
  conflictFreezeEnabled: true
  
  # Use local-only embedding (no network)
  embedProvider: local
  
  # Enable full audit trail
  auditRecalls: true
  auditDreams: true
  
  # API key masking (if using OpenAI provider)
  apiKeyMasking: true
```

---

## Contact

- **Security Team**: `guanqishi26@gmail.com`
- **Private Advisory**: [GitHub Security Advisories](https://github.com/modusensus/dsh-mneme/security/advisories)
- **GPG Key**: Available upon request for encrypted communication

---

---

# 安全策略

> **中文** | [English](#security-policy)

---

## 支持版本

我们积极维护最新的 minor 版本。安全修复会 backport 到最新的 patch 版本。

| 版本 | 支持状态 | 说明 |
|---|---|---|
| 0.3.x | ✅ 支持 | 活跃开发中 |
| 0.2.x | ⚠️ 尽力维护 | 仅关键修复 |
| < 0.2.0 | ❌ 不支持 | 请升级 |

---

## 报告漏洞

### 请不要

- 在公开 issue 中披露安全漏洞
- 在讨论区或评论中发布漏洞利用细节
- 未经事先协调就提交暴露安全缺陷的 PR

### 请这样做

1. **发送邮件**至 `guanqishi26@gmail.com`（或通过 GitHub 提交**私有安全公告**）
2. 邮件内容请包含：
   - 漏洞的清晰描述
   - 复现步骤（优先提供最小测试用例）
   - 影响评估（数据泄露？仅本地？远程？）
   - 受影响的版本
   - 你建议的修复方案（如有）

### 响应时间线

| 阶段 | 时间 | 行动 |
|---|---|---|
| 确认收到 | 48 小时内 | 我们确认收到并分配追踪 ID |
| 初步评估 | 7 天内 | 我们验证严重程度和影响范围 |
| 修复开发 | 按严重程度 | 严重：≤ 14 天；高：≤ 30 天；中/低：下个版本 |
| 披露 | 协调披露 | 我们同时发布安全公告和补丁版本 |

### 严重程度分级

我们遵循 [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) 标准：

- **严重** (9.0–10.0)：远程代码执行、未授权数据外泄、核心安全控制绕过
- **高** (7.0–8.9)：本地权限提升、重大数据完整性破坏、高影响 DoS
- **中** (4.0–6.9)：特定条件下的信息泄露、部分控制绕过
- **低** (0.1–3.9)：轻微信息泄露、纵深防御改进

---

## 安全设计原则

### 1. 本地优先，零网络

- 所有 embedding、rerank、记忆整理均在本地运行
- 记忆文本**永不**离开设备
- 无遥测、无分析、无远程日志

### 2. 默认 Fail-Safe

- 任何组件故障（LLM、embedder、reranker）均优雅降级到关键词搜索
- 畸形输入不会导致插件崩溃或数据库损坏
- 并发写入冲突通过 CAS（比较并交换）守卫解决

### 3. 全面审计

- 每次 `autoDream` 运行生成密码学可验证的 receipt
- 每次记忆更新创建 `failure_memories` 审计轨迹
- 每次搜索记录 `recall_run` 供后续检查

### 4. 人类主权

- 所有记忆镜像到人类可编辑的 Markdown 文件
- 机器写入 vs 人工编辑通过 digest 基线区分
- 用户可仅凭 Markdown 镜像完整重建数据库

---

## 安全审计历史

### v0.2.10 — 安全加固

| ID | 发现 | 严重程度 | 状态 |
|---|---|---|---|
| F-NEW-01 | `store.js` 并发写入竞态 | **严重** | ✅ 已修复（CAS 守卫 + 原子写入） |
| F-NEW-02 | 镜像同步期间事务不一致 | **高** | ✅ 已修复（事务化镜像 + 回滚） |
| F-NEW-03 | 覆盖前未验证镜像健康状态 | **高** | ✅ 已修复（digest 基线 + FSM 验证） |

### v0.3.4 — 依赖安全

| CVE | 包 | 严重程度 | 状态 |
|---|---|---|---|
| CVE-2026-39244 | `adm-zip` 0.5.18 | **高** | ✅ 已修复（升级至 0.6.0） |

### 持续进行

- 通过 **OrbisAI Security** 进行自动化依赖扫描
- 欢迎社区通过私有公告提交安全审查

---

## 披露政策

我们实行**协调披露**：

1. 报告者私下提交漏洞
2. 我们调查、开发修复并准备公告
3. 我们通知报告者修复时间线
4. 我们同时发布补丁和安全公告
5. 我们在公告中致谢报告者（经其同意）

我们**不会**对以下安全研究人员采取法律行动：
- 出于善意行事
- 不将漏洞利用超出概念验证范围
- 不访问属于他人的数据
- 在公开披露前给予我们合理的响应时间

---

## 安全相关配置

```yaml
# 加固配置示例
dsh-mneme:
  # 如需完全手动控制，可禁用 autoDream
  autoDream: false
  
  # 敏感环境启用冲突冻结
  conflictFreezeEnabled: true
  
  # 仅使用本地 embedding（无网络）
  embedProvider: local
  
  # 启用完整审计轨迹
  auditRecalls: true
  auditDreams: true
  
  # API 密钥掩码（如使用 OpenAI provider）
  apiKeyMasking: true
```

---

## 联系方式

- **安全团队**：`guanqishi26@gmail.com`
- **私有公告**：[GitHub Security Advisories](https://github.com/modusensus/dsh-mneme/security/advisories)
- **GPG 密钥**：如需加密通信，可应请求提供

---

*Last updated: 2026-08-16*  
*Policy version: 1.0*
