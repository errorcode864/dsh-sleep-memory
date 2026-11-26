---
id: sleep-memory.decisions.audit-backup
title: 审计容量与备份恢复
type: decision
status: active
owner: maintainer
updated: 2026-11-20
source_of_truth: code-and-script
---

# 审计容量与备份恢复

本轮基线为 `56f9515`，沿用现有功能 worktree 与 JavaScript 实现。
用户已确认推进真实模型试用准备、审计容量与备份恢复。
不增加 npm 依赖，不调整已有记忆的衰减和巩固规则。

## 审计容量

`memory_manage sleepStats` 返回批次状态分布、修改项数、最早与最新批次时间。
`retainedBytes` 为各批次 JSON 的 UTF-8 字节总和，不代表物理磁盘占用。
`sleepAuditMaxBytes` 默认 `0` 表示不限，取值范围为 `0` 至 `2147483647`。
配置页可设置该值，审计面板可读取容量。

新增睡眠批次落盘前计算容量，超限抛出 `audit_capacity` 且不修改记忆。
失败仍沿用持久调度退避，增大配置后可继续。
回滚、未完成批次恢复与备份导入优先保留证据，因此允许超过该上限。
`sleepStats.overLimit` 可识别已达上限的状态。
本轮不自动裁剪历史，不执行物理清理；导出后也不会自行移除本地证据。

## 备份范围

默认 `export` 继续返回 v1，默认 `import` 继续接受 v1。
`export includeAudit:true` 返回 v2：

```json
{
  "format": "dsh-sleep-memory",
  "version": 2,
  "scope": "memory-and-sleep-audit",
  "exportedAt": 0,
  "records": [],
  "audits": [],
  "checksum": "对 records 与 audits 的规范化 SHA-256"
}
```

v2 包含全库原文、来源、纠正关系、情境条件与完整睡眠审计。
不包含会话绑定、调度、学习任务、用户反馈、profile 配置或模型凭据。
它是记忆与审计备份，不能作为完整 profile 迁移包。
后续 D 新增可选 [v3 反馈备份](memory-outcome-feedback.md#持久历史与备份)，v1、v2 的范围保持不变。
E3 新增 [v4 叙述备份](memory-narrative-backup.md)，在 v3 上增加已保存的解释版本，仍不是完整 profile 迁移包。
导出会先完成本地恢复，不输出 `prepared` 或 `rolling-back` 的待执行批次。

## 导入与中断恢复

v2 导入先全量验证格式、摘要、记忆关联与审计 schema。
同 ID 同内容跳过，同 ID 异内容拒绝；审计批次不得重复或处于待执行状态。
只新增记录，不覆盖已有事实、审计和任何项目配置。
默认预演，确认时提交本次 `planToken`；计划变化后须重新预演。
已全部导入的相同备份重复确认不新增内容。

`memory_backup_state` v1 保存固定的恢复计划，状态为 `prepared/complete`。
先持久保存计划，再写记忆，最后写审计并标记完成。
I/O 中断原样透出，下一次记忆访问先完成原计划，重启也能继续。
恢复前核对全部 ID 的本地版本，冲突时阻止写入和普通记忆读取。
恢复完成后计划仅保留校验摘要和时间，不继续保存内容副本。
底层没有跨域事务，该机制提供可恢复的一致性，不承诺多个进程并发导入。

## 工具与界面

```json
{ "action": "sleepStats" }
```

```json
{ "action": "export", "includeAudit": true }
```

v2 与 v1 使用同一个“管理 → 备份恢复”入口。
选择文件后展示待新增记忆和审计数量，确认按钮携带服务端预演凭据。
GUI 文件与响应仍限制为 10 MiB，超过时使用工具接口处理。
历史和容量接口保持只读，不强化记忆。

## 验证与后续

可选[叙述历史](memory-narrative.md)使用独立存储域，v1～v3 不包含该域；v4 已补齐预演、引用校验与跨域恢复。

故障用例覆盖恢复计划失败、记忆写入失败、审计写入失败、重载续写和本地冲突。
真实宿主使用独立目录验证跨域导入中断后恢复，导出内容逐项一致。
客户端契约验证 v2 下载、预演与确认，并验证容量配置和显示。
恢复完成标记写入失败后只补标记，相同备份重复确认不重写记忆。
浏览器已核对容量显示和备份入口，下载完成状态及截图因自动审批服务的账户并发限制未验收。
长期容量曲线与真实模型效果由[模型试用指南](../guides/model-trial.md)分别记录。

[返回决策索引](README.md)
