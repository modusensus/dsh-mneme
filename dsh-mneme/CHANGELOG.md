# Changelog

## [0.4.1] - 2026-08-18

### 新增

- **autoSummarize 支持自定义模型**：新增 `summarizeProvider` / `summarizeModel` 配置项，可指定独立模型用于会话摘要提取。空字符串时保持原有行为（使用当前会话模型）。推荐使用轻量模型（如 qwen3.6-plus）以节省主模型 token 消耗。（#8, @lqs50）

## [0.3.9] - 2026-08-17

### 核心修复（社区审计反馈）

- **A. 事务原子性收敛**：`compareAndUpdate` 的 CAS 更新与 `generation` 递增现由 `runAtomically` 封装至单一数据库事务。CAS miss 不再递增 generation，彻底消除崩溃后 `DB=CAS-New / mirror=Old / dirty=false` 且无债务的状态分裂窗口。
- **B. 降级状态透传**：mirror 状态写入失败时 `service.update` / `compareAndUpdate` 不再返回静默成功。失败时附加 `_mirror` 属性 `{status: 'degraded', error}`，上层可感知底层存储降级。
- **D. 逐 type 物理终态结算**：修复 project 文件已提交、decision 失败时两 type 被批量标 failed 的缺陷。`mirror.sync` 现逐 type 返回结果，`syncMirror` 依据实际落盘状态将各 type 独立持久化为 committed / failed。
- **F. Generation 强整数校验与脏值拦截**：`setMirrorState` 用 `Number.isInteger` fail-closed；SQL 层新增 `CHECK generation = CAST(generation AS INTEGER)`；迁移逻辑扫描历史遗留的 `-7 / 1.5` 等非整数脏值并抛错阻断，杜绝静默沿用。

### 基础设施与契约对齐

- **并发初始化优化**：`PRAGMA busy_timeout` 严格先于 `PRAGMA journal_mode=WAL` 执行，消除 8 进程并发初始化的 `database is locked`。
- **E2E 契约对齐**：断言对齐 7 个模型工具 / 9 条 exact 路由（prefix fallback 不计入）。
- **回归测试**：450/450 全绿（此前 446/447 有 1 个并发失败）。

## [0.3.8]

- audit peer 复验 6 项运行时阻断全部修复。
- desired generation 同事务原子递增（崩溃窗口不再静默跳过）。
- 逐 type committed / failed / pending 回执，健康端点区分 ok / degraded / unknown。
- generation 上界 / 负数 CHECK。
