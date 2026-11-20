---
id: sleep-memory.guides.model-trial
title: 真实模型评测与单项目试用
type: guide
status: active
owner: maintainer
updated: 2026-11-20
source_of_truth: code-and-script
---

# 真实模型评测与单项目试用

截至 2026-11-20，已通过本地忽略的环境配置调用 `deepseek-v4.1-flash` 完成合成样本评测。
首次评测发现短语言偏好已写入但不同问法未进入候选，修复后两条定向复测均召回且通过审核。
样本数量有限，结果不代表真实项目的总体准确率。

## 真实模型预检

```bash
npm run eval:model -- --check
```

预检只检查 `MEMORY_EVAL_BASE_URL`、`MEMORY_EVAL_API_KEY`、`MEMORY_EVAL_MODEL` 是否存在。
报告默认保存到 `tmp/live-model-evaluation.json`，缺配置时状态为 `configuration-required`。
脚本不读取个人 profile、已有会话或真实记忆，也不自动获取凭据。

通过当前 shell 的环境变量设置这三个值；不要将 Key 写入版本库或报告。
`MEMORY_EVAL_BASE_URL` 填兼容接口的根地址，脚本在末尾添加 `/chat/completions`。
接口必须使用 HTTPS 或本机 HTTP，拒绝携带凭据和查询参数的地址。
配置好后运行：

```bash
npm run eval:model -- --max-calls 18 --report tmp/live-model-evaluation.json
```

默认最多 18 次请求，每次最多请求 2400 个输出 Token，达到调用上限后明确失败。
报告记录服务端实报 Token 与本地字符估算，未配置价格表时不换算金额。
`eval:model` 的学习超时为 60 秒，审核超时为 30 秒，质量评测配置不修改个人 profile。
`eval:preferences` 默认使用当前 15 秒审核时限；可用 `--review-timeout-ms 3000` 对照旧默认值，历史结果见[审核时限验收](../decisions/memory-source-tracing.md#默认-3-秒审核实测)。
加 `--cache-seconds 60 --repeats 2` 可分别观察首次请求和重复请求，边界与实测见[审核缓存说明](../decisions/memory-review-latency.md)。

## 合成样本与报告

固定 6 个场景覆盖项目约定、短偏好、迁移教训、临时进度、未确认问题和可疑引用。
每个场景使用独立内存实例，通过真实学习与审核代码执行。
评测只发送脚本自带的合成资料，每条记忆保留证据与情境条件。
每个场景分别查询相关任务和负例任务，记录实际注入与模型调用情况。
评测关闭跨轮注入去重，避免前一个查询使负例跳过审核。
项目约定增加共享词语的困难负例，语言偏好的负例单独标记待人工判断且不计入确定误注入。

`storageMatchesLabel` 只比较应记标签与是否写入，不能证明语义正确。
人工仍须核对正文、证据、情境条件和适用范围，报告逐例标记 `needsHumanReview`。
零候选不会调用审核模型，相关任务没有注入时应进一步区分检索缺口与审核拒绝。
运行面板的“最近召回结果”可区分候选未命中、审核失败、超时、预算不足和内容版本变化。
配置缺失时正常执行命令退出码为 2，模型调用失败或学习等待超时退出码为 1。
报告保留模型名和查询文本，截断响应若返回用量也会计入失败请求成本。

## 单项目试用配置

以下配置只应用于选定的试用 profile，示例不会自动改写个人环境：

```yaml
projectId: trial-project
sleepAuditEnabled: true
sleepAuditMaxBytes: 104857600
contextualRecallEnabled: true
recallPlanMode: shadow
learningPolicyMode: evidence
feedbackEnabled: true
feedbackRankingEnabled: false
salientScoringEnabled: false
semanticRecallEnabled: false
```

显式项目范围、持久会话绑定与工作区范围优先于配置回退。
已有项目记忆不会因修改配置而自动迁移，先确认 `memory_manage scope` 的结果。
试用前导出 v2 记忆与审计备份，确认可在独立目录恢复后再观察实际使用。
审计模式暂停物理遗忘，容量上限只限制新增睡眠批次，不自动裁剪证据。

先累计 30 个真实项目轮次，按用户认可、无关、错误和过时标注实际呈现。
分别记录应记但漏记、误写、误注入、审核拒绝、延迟和实报 Token。
影子规划比较只反映本地规划的候选差异，情境触发本轮没有独立的影子开关。
每次调整一个因素，再决定是否从 `shadow` 切到 `local`。
任何配置切换都保留已写入的记忆与审计，关闭开关不等于撤销数据变化。

休眠试用另行设置 `dormancyEnabled: true`，先用 `memory_sleep dryRun:true` 查看影响。
分层半衰期、休眠阈值与唤醒回滚见[分层衰减、休眠与偏好召回](../decisions/memory-dormancy.md)。
长期表达偏好需另开 `preferenceRecallEnabled: true`，先运行 `npm run eval:preferences -- --enabled --split all`。
60 条固定事实样本与真实学习评测分别验收，命令和首次失败记录见[偏好验收说明](../decisions/memory-recall-preferences.md)。

本轮未完成个人 profile 安装、配置 reconcile 或真实项目轮次采样。
这些事项与合成模型评测分别验收，不能互相替代。

[审计备份契约](../decisions/memory-audit-backup.md) · [返回指南索引](README.md)
