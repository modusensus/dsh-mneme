# v0.4.0 桉桉拍板决定

1️⃣ sleepEnabled 默认 false？
确认，默认 false。
理由：
Sleep 是重量级后台任务，首次启用用户可能吓一跳（"我的记忆怎么变短了"）
需要用户主动了解分层压缩机制后再开启
与 entityExtractionEnabled 保持一致（都是先验证再开启）
2️⃣ strictness 默认 normal？
确认，默认 normal。
三级定义：
表格
级别	行为	适用场景
gentle	只处理置信度 > 0.9 的冲突，保守合并	用户初次尝试 Sleep
normal	与 autoDream 同级，标准裁决逻辑	默认，平衡整理与风险
aggressive	低置信度也裁决，大量 merge/archive	记忆库膨胀严重时手动开启
3️⃣ 旧 sleep.js 只参考不复用？
可以，但先澄清：v0.3.9 官方代码里没有 sleep.js。
你提到的"旧 sleep.js"可能是：
你自己写的实验代码（v0.3.9 之前尝试的）
agent 生成的草稿
如果是你自己写的：
只参考不复用 ✅ 完全没问题
策划书里的 sleep.js 是全新设计（AbortController、四 Phase、可中断），和任何旧草稿架构不同
如果是 agent 之前生成的：
同样建议重写，因为策划书引入了：
AbortController 中断机制（旧代码可能没有）
四 Phase 分离（冲突/归档/模式/关系）
type='sleep' 的 receipt 审计
4️⃣ _full_content：新增列 vs 塞进 content？
推荐：新增列 _full_content。
方案对比
表格
维度	新增列 _full_content	塞进 content（JSON 或分隔符）
查询性能	✅ 不影响现有查询	❌ content 变长，FTS5 索引膨胀
向后兼容	✅ 旧代码不感知新列	❌ 需要改所有读取 content 的地方
Markdown 镜像	✅ 只同步 content（摘要），_full_content 不暴露	❌ 镜像文件变长，人类可读性下降
恢复操作	✅ UPDATE memories SET content = _full_content 一键恢复	❌ 需要解析字符串提取原文
Schema 复杂度	❌ 多一列	✅ 无 schema 变更
推荐实现
sql
-- 新增列（nullable，只有压缩过的记忆才有值）
ALTER TABLE memories ADD COLUMN _full_content TEXT;

-- 查询时默认不返回（避免拖慢）
-- 需要恢复时单独查询
JavaScript
// store.js 新增方法
getFullContent(memoryId) {
  return db.prepare("SELECT _full_content FROM memories WHERE id = ?").get(memoryId)?._full_content;
}

restoreContent(memoryId) {
  db.prepare("UPDATE memories SET content = _full_content, _full_content = NULL WHERE id = ?").run(memoryId);
}
什么时候塞进 content？
如果不想改 schema（比如 v0.4.0 坚持零 schema 变更），可以用 HTML 注释标记：
markdown
用户目前主要使用 Rust。

<!-- dsh-mneme-full-content
用户目前主要使用 Rust 进行系统开发，之前使用 Python 的经验作为辅助。对性能敏感场景优先考虑 Rust。-->
但我不推荐，因为：
Markdown 镜像变长，人类可读性下降
需要正则提取，增加查询复杂度
无法一键恢复

开始吧