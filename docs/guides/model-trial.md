---
id: sleep-memory.guides.model-trial
title: 真实模型评测与单项目试用
type: guide
status: active
owner: maintainer
updated: 2026-11-26
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

`npm run eval:evidence` 只预检配置；加 `--live --max-calls 8` 验证概要足够、需要两层证据和预算不足三个合成场景。
每次请求最多等待 20 秒，报告默认保存在 `tmp/recall-evidence-model.json`，包含决策、来源 ID 和模型实报 Token。
模型输出 JSON 决策后由评测脚本调用真实插件工具，此验收不代表宿主原生工具调度。

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

## 叙述合成评测

先加载本机模型环境配置后执行 `npm run eval:narrative` 检查配置，再加 `-- --live` 运行 3 条合成经历。
生成和复核最多合计 6 次请求，覆盖失败结果、有限成功与日志内指令，报告默认写入 `tmp/narrative-evaluation.json`。
逐例人工核对反思是否改变日期、数值、承诺、否定条件或结果；模型复核通过不能代替人工判断。
评测只生成草稿且不保存版本；已保存的解释版本可通过 [v4 备份](../decisions/memory-narrative-backup.md)恢复，试用前先在独立目录验证。

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
试用前导出 v4 备份以覆盖记忆、审计、反馈及叙述历史，确认可在独立目录恢复后再观察实际使用。
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

## 30 轮人工台账（E7）

在插件源码目录初始化，`--project` 填准备试用的项目标识：

```bash
npm run trial:project -- --init --project dsh-plugins --file tmp/project-trial.json
npm run trial:project -- --file tmp/project-trial.json
npm run trial:project -- --file tmp/project-trial.json --report tmp/project-trial-report-01.json
```

初始化只生成 30 个待采样位置，不安装插件、不读取会话、不调用模型；台账及报告放在忽略的 `tmp/`。
初始化与报告导出均拒绝覆盖已有文件，复测报告另起文件名；日常标注直接编辑原台账。
选错项目时应新建台账，不能把其他项目的观察混进当前统计。

开始人工标注前补齐 `setup`，它记录实际生效的状态而非计划配置：

| 字段 | 填写方式 |
| --- | --- |
| `profile` | 试用的宿主 profile 名称 |
| `pluginRevision` | 实际加载的插件提交或版本标识 |
| `scopeProjectId` | `memory_manage scope` 返回的项目标识，须与台账项目一致 |
| `backupVerified` | 仅在 v4 备份已于独立目录恢复核对后改为 `true` |
| `configNote` | 记录实际启用项及模型名称，至少注明偏好、休眠、审核和规划模式 |

同一台账保持插件版本和配置固定；调整配置后新建台账并在 `configNote` 引用前一份。
不要在配置说明里填写 API Key，台账不需要凭据。

每个真实轮次填实际 `sessionId`、`messageId`、带时区的 `at`、`observedProjectId` 和 `case`。
同一消息不能重复计数；`case` 为 `preference-paraphrase`（偏好改写）、`ordinary-task`（普通任务）、`dormancy-wake`（休眠唤醒）或 `other`。
30 轮最终复核至少各覆盖前三类一次，不固定每类配额，也不把同一交互拆成多轮凑数。

`latencyMs` 记录当前轮记忆召回耗时，统一取运行面板的对应召回记录；没有记录时保留 `null`。
`reportedTokens` 只填该轮模型实报总 Token，估算值单独填 `estimatedTokens`；拿不到该轮用量时保留 `null`。
运行计数是当前加载以来的累计值，不能直接当作单轮消耗；重启或存在并发任务时不能随意差分。
最近召回结果只保留 20 次，观察后及时记录，避免回头把其他调用的结果配给当前消息。

未核对时 `review` 保持 `null`；核对后按以下形状填写，示例不计入真实轮次：

```json
{
  "reviewer": "实际标注者",
  "issues": ["missed-recall"],
  "evidenceRefs": ["本地证据位置或可追溯的消息引用"],
  "note": "写明预期适用的记忆、实际呈现和判断依据。",
  "wakeResult": "not-tested"
}
```

`issues: []` 表示人工核对后未发现列出的问题；同轮允许多个不同问题：

| 标签 | 含义 |
| --- | --- |
| `missed-storage` / `unwanted-storage` | 应记未记 / 不应记却写入 |
| `missed-recall` / `irrelevant-injection` | 应召回未召回 / 注入了无关记忆 |
| `incorrect-memory` / `outdated-memory` | 使用了错误记忆 / 使用了过时记忆 |
| `review-rejected` / `review-failed` | 审核明确拒绝 / 审核超时或调用失败 |

审核拒绝不一定是系统错误，需结合 `note` 的依据判断；脚本只按标签计数。
休眠唤醒场景的 `wakeResult` 必填 `success` 或 `failed`，其他场景填 `not-tested`；说明中引用睡眠批次与目标记忆。
汇总分别给出已标注数、待标注数、各类问题次数、场景覆盖、耗时 P50/P95 和已知／未知用量轮数。
实报与估算 Token 不相加；小样本 P95 常为最大值，不构成时延保证。

不足 30 轮为 `collecting`；满 30 轮但缺场景为 `coverage-incomplete`；存在问题或唤醒失败为 `needs-follow-up`；其余为 `ready-for-review`。
任何状态都不等于自动验收通过；脚本校验结构和范围，不能验证外部证据真实性或代替人工判断。
汇总报告不复制标注者、证据引用或说明正文。

E7 已提供台账与离线汇总；2026-11-26 已将桌面端本地链接目录快进至 `0ed369e`。
现有记忆已备份并在隔离目录通过 v4 导出恢复校验，桌面配置已启用审计、诊断、长期偏好、情境触发和休眠。
桌面记忆银行已核对：50 条活记录、1 条未参与自动召回和 4 条联想边，运行状态为空闲。
审计容量上限 100 MiB 与 v4 备份面板均读取正常，现有会话自动范围为 `deepseek-harness` 工作区。
正式台账为 `tmp/desktop-project-trial.json`，项目标识取界面返回的工作区 ID；安装证据见 `tmp/desktop-memory-install-result.json`。
当前真实轮次为 0/30，合成评测和台账单元测试不计入。

[审计备份契约](../decisions/memory-audit-backup.md) · [返回指南索引](README.md)
