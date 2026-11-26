---
id: sleep-memory.decisions.review-latency
title: 审核等待时限与短期结果缓存
type: decision
status: active
owner: maintainer
updated: 2026-11-20
source_of_truth: code-and-script
---

# 审核等待时限与短期结果缓存

本批承接 C1 的审核时限实测，先改善等待配置和重复审核，再推进 C2。
当前模型曾无法在 3 秒内完成审核，延长等待上限提高完成机会，但不会缩短首次模型请求。

## 配置与升级

| 配置 | 默认 | 范围与行为 |
| --- | --- | --- |
| `recallReviewTimeoutMs` | `15000` | `500..30000` 毫秒，超时跳过本轮注入 |
| `recallReviewCacheSeconds` | `0` | `0..300` 秒，`0` 关闭，实例内最多 128 项 |

未显式配置的实例升级后采用 15 秒审核上限，已有显式值继续生效。
配置页新增两个数值输入；需要保留旧等待上限时显式设置 `recallReviewTimeoutMs: 3000`。
这只控制审核等待，不包含候选检索、可选查询扩展、写入或主模型生成时间。
个人 profile 本批未修改，缓存需要单独开启，例如 `recallReviewCacheSeconds: 60`。

## 缓存契约

缓存键为完整问题、稳定会话 ID、项目、模型路由及其参数、审核输入、候选版本和审核提示词的摘要。
问题使用未截断文本；版本包含正文、有效性、用户证据、来源、触发条件及休眠状态。
候选集合或顺序变化会重新审核，强化计数本身不改变版本。
不同会话或项目不共用结果，无稳定会话 ID 时不缓存；不做同义问题推断或跨问题复用。

只保存成功解析的审核决定，包括明确拒绝；超时、取消、服务错误、响应格式错误及迟到结果不缓存。
缓存不保存问题正文、记忆正文、模型响应或凭据，只保存摘要键、通过的 ID 和过期时刻。
TTL 从成功写入时开始，命中只更新淘汰顺序，不延长有效期；失效条目在读取或容量淘汰时移出。
缓存只在当前实例有效，不参与备份，重载重新审核。
相同请求同时到达时各自处理，不共享尚未完成的模型请求，因此一个请求的取消不影响另一个。

缓存仅替代重复的模型审核，后续范围、版本、有效性、去重、预算和唤醒审计仍照常执行。
新写入的相反偏好仍会在呈现前复核；旧缓存不能让已纠正事实重新生效。
缓存键不感知同名模型路由内部的服务变更，必要时关闭缓存或重载实例。

## 诊断与评测

`review` 状态增加累计 `durationMs`、`timeouts` 和 `cache.hits/misses/entries`。
最近召回增加 `diagnostics.reviewDurationMs` 与 `reviewCache`，命中仍属于 `review: completed`。
`reviewCache` 区分 hit、miss、disabled、no-session、not-stored、not-used。
通过与拒绝计数包含缓存决定，实际模型调用及 Token 以 `metrics.models.review` 为准。
界面显示等待上限、超时次数和缓存计数，每条召回可看到审核耗时及是否复用。

```bash
node --env-file=tmp/live-model.env tests/preference-eval.mjs --live --enabled --ids reg-07,reg-15 --max-calls 4 --review-timeout-ms 15000 --cache-seconds 60 --repeats 2 --report tmp/review-cache.json
```

偏好评测默认时限同步为 15 秒，`--cache-seconds` 默认 0，`--repeats` 支持 1 至 3。
重复轮次使用同一会话；样本之间隔离，每次记录注入结果、审核诊断和调用消耗。
标签统计与 P50/P95 仍以首次轮次计算，重复轮次写在 `repetitions`；失败数和调用数覆盖全部轮次。
评测为观察缓存显式关闭注入去重，生产去重规则保持原配置。
通用 `eval:model` 的质量评测继续显式使用 30 秒，不与偏好评测的默认值混淆。

## 2026-11-20 验收结果

首轮 6 条样本遭遇 3 次超时和 3 次 HTTP 503，达到 6 次 HTTP 调用上限后另有 2 次审核尝试被本地拒绝。
两个当前要求覆盖场景正确跳过；这轮没有成功填充缓存，不能计作缓存性能验收。
随后单例服务复核及两条 15 秒时限复测成功，首次失败报告保留。

| 样本 | 等待上限 | 首次完整召回 | 重复完整召回 | HTTP 调用 |
| --- | --- | --- | --- | --- |
| reg-01 | 30 秒 | 6737 毫秒 | 3 毫秒 | 1 |
| reg-07 | 15 秒 | 13327 毫秒 | 10 毫秒 | 1 |
| reg-15 | 15 秒 | 5369 毫秒 | 2 毫秒 | 1 |

三个重复轮次均命中缓存且正确注入，审核自身耗时为 0 至 1 毫秒；两次 15 秒请求合计实报 2213 Token。
这里只证明这组样本的缓存复用和调用减少，不代表首次请求稳定成功，也不解决模型服务的 HTTP 503。
原始报告为 `tmp/review-latency-15s-cache.json`、`tmp/review-latency-service-check.json`、`tmp/review-latency-15s-check.json`。

测试覆盖隔离、版本、TTL、淘汰、拒绝缓存、失败不缓存、并发取消、注入预算和去重。
真实宿主存储验证同实例复用、重载重新审核，60 条离线偏好样本继续符合标签。
smoke 73 个场景、Node 测试 206 项通过，默认检索基线和文档检查通过。
规范扫描的两处 `RISK-PII-001` 提示均为提示词和接口文案关键词共现，人工核对没有实际凭据输出。
未部署个人 profile，尚未完成真实项目 30 轮观察或浏览器视觉验收。

[多层来源追溯](memory-source-tracing.md) · [后续路线](memory-next-plan.md) · [返回决策索引](README.md)
