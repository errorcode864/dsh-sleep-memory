---
id: sleep-memory.decisions.recall-preferences
title: 召回诊断与长期表达偏好
type: decision
status: active
owner: maintainer
updated: 2026-11-20
source_of_truth: code-and-script
---

# 召回诊断与长期表达偏好

本批按[开发路线](memory-next-plan.md)实施 A 和 B，保留前一批休眠与审计契约。
配置、诊断和面板仍使用宿主现有接口，不增加依赖或模型服务。

## A：诊断契约

`recallDiagnosticsEnabled` 默认 `true`，在 `metrics.recentRecalls` 增加 `diagnostics`。
关闭后继续保存既有计数和返回 ID，省略详细原因；不改变召回、强化或模型调用。
只保留本次加载最近 20 次记录，不持久化问题、记忆正文或模型响应。

| 字段 | 含义 |
| --- | --- |
| `stage` | 最后进入的 candidate、review、selection、write 或 return 阶段 |
| `review` | completed、disabled、empty、timeout、cancelled、failed 或 not-required |
| `selectedCount` | 通过呈现筛选的条数 |
| `wakeCount` | 筛选结果中计划唤醒的条数，不代表写入已经成功 |
| `reasons` | 每类过滤或失败原因的计数，可能同时存在多种原因 |
| `outcome` | returned、empty 或 failed；实际返回 ID 以 `returnedIds` 为准 |

原因覆盖空库、范围、层级、时间、有效性、无匹配、精确实体、休眠、去重、审核和预算。
另记录取消、范围或版本变化、关联路径缺失、审计容量不足及呈现前写入失败。
审核拒绝与调用失败、超时分开；审核响应格式错误也属于审核失败。
显式检索不经过相关性审核，沿用既有错误返回方式并记录诊断。
范围过滤和空候选只能解释本次检索流程，不能据此断言用户期望的事实不存在。

运行面板增加“最近召回结果”，展示时间、候选数、通过数、返回数、耗时及中文原因。
诊断在返回或失败后统一完成，呈现前写入失败不再被计为成功返回。

## B：偏好适用规则

`preferenceRecallEnabled` 默认 `false`，开启后为自动注入补充语言、详略与格式三类候选。
与 `contextualRecallEnabled` 独立，后者继续处理情境条件和原有语言问法匹配。
证据来自已验证用户引文，或声明由用户确认的事实；不迁移、不重写历史记忆。
暂只解析单一且明确的表达偏好；复合偏好、条件偏好和未识别表达保留原检索流程。

当前任务的明确要求优先，临时覆盖只影响当轮；后续恢复长期偏好且不会被旧去重间隔挡住。
同类别项目偏好优先于全局偏好，同范围相互矛盾的偏好暂不自动应用。
被覆盖偏好也不能从联想路径绕回，第三人称描述与工具指令不生成用户偏好候选。
明确长期更新沿用 `memory_manage correct` 和事实版本；未确认冲突继续待复核。
纠正记录必须有自己的用户来源才能派生偏好，不沿用被替代记录的旧引文证明新内容。
学习证据纳入审核快照版本，审核期间证据变化会使本次结果失效；已有持久反馈的版本格式保持兼容。

新增候选仍受项目、有效性、审核和原有预算约束，不能压过当前用户要求。
普通任务不会仅因记录属于偏好就唤醒休眠记录，仍需明确情境或合法关联路径。
当前规则不处理任意代码约定，也不保证能识别所有自然语言覆盖方式。

## 评测与复现

```bash
npm test
npm run eval:preferences -- --split all --report tmp/preference-baseline.json
npm run eval:preferences -- --enabled --split all --report tmp/preference-enabled.json
node --env-file=tmp/live-model.env tests/preference-eval.mjs --live --enabled --ids reg-01,reg-07,reg-13,reg-15,reg-19,reg-21 --max-calls 6
```

样本包含 36 条回归与 24 条按来源主题区分的留出，报告保存样本 SHA-256 以检查前后是否一致。
留出集未据测试结果加入特例，但同样由开发者构造，不代表独立第三方盲测。
固定事实评测将学习与检索分开；真实学习质量另用 `evaluateModelPipeline` 验证。
脚本报告候选漏召回、筛选后漏召回、误注入、审核失败、P50/P95 和实报 Token。
真实调用上限默认 12 次；`--split`、`--ids` 可限制样本范围，失败保留逐例结果。

2026-11-20：关闭偏好应用时，回归样本候选漏召回 14 条，留出样本 13 条；开启后两组均符合全部标签。
固定事实真实模型首次评测覆盖 14 条，其中 8 条应注入；6 条成功，2 条审核响应失败，6 条不应注入均未注入。
两条失败样本分别复测成功；首次报告保留，不能将复测拼接为首次全通过。
首次报告的 `reviewFailures` 曾只累计模型传输失败而漏算解析失败，现已修正；旧报告以逐例诊断为准。
真实学习的语言、详略和格式 3 个样本均有原文证据，普通任务注入成功且临时覆盖时未注入。
真实宿主完成偏好落盘、重载、临时覆盖、恢复应用和诊断检查；默认检索的旧基线指标保持一致。
本批 smoke 73 个场景和 Node 测试 188 项通过，文档索引及打包检查通过。
规范扫描保留一处既有 `RISK-PII-001` 误报：学习提示词的“不要记完整日志、密码、Token”触发关键词共现，人工核对没有实际敏感数据输出。

A、B 验收时质量评测审核超时为 30 秒，生产默认当时为 3 秒；后续调整见[审核等待时限与短期结果缓存](memory-review-latency.md)。
本批未改个人 profile，浏览器视觉验收与真实项目 30 轮标注仍未完成。

[模型试用指南](../guides/model-trial.md) · [返回决策索引](README.md)
