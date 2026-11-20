---
id: sleep-memory.decisions.source-tracing
title: 多层来源追溯与审核时限验收
type: decision
status: active
owner: maintainer
updated: 2026-11-20
source_of_truth: code-and-script
---

# 多层来源追溯与审核时限验收

本批以 `f9d1556` 为基线，完成 C1 的只读来源展开与默认审核时限实测。
本批不改写概要或事实；后续 C2 已完成[深层再巩固](memory-reconsolidation.md)，C3 已完成[模型按需逐层取证](memory-progressive-recall.md)。

## 只读接口

```json
{
  "action": "traceSources",
  "id": "smm_summary",
  "projectId": "示例项目",
  "maxDepth": 3,
  "maxNodes": 30,
  "maxEstimatedTokens": 2000
}
```

通过 `memory_manage` 调用；项目范围沿用显式参数、会话绑定、工作区和配置回退。
三个预算均可省略，默认如上；深度范围 `1..8`，条数 `1..100`，Token 估算预算 `300..16000`。
只沿 `consolidates` 边遍历，每个节点严格限定为起点所属项目，全局起点只展开全局来源。
不跟随联想边，也不自动替换旧证据为纠正后的新事实；历史证据会标记当前有效性。
原有 `get` 继续返回一层来源和完整原文，字段与分页规则保持兼容。

| 返回字段 | 含义 |
| --- | --- |
| `rootId`、`projectId` | 本次追溯起点与范围 |
| `items` | 去重后的来源记录及首次到达路径，不包含起点 |
| `items[].path`、`depth` | 从起点开始的 ID 路径及边数 |
| `items[].content`、`truncated` | 最多 300 字符的原文预览及截断标记 |
| `items[].leaf` | 没有下层巩固来源，不等于已证实为原始事实 |
| `items[].current`、`state` | 当前事实有效性与 active/review/invalid 状态 |
| `items[].accessState` | 保存的休眠标记，读取不会改变它 |
| `stopped` | 循环、重复、缺失、跨范围、深度、条数、Token 和遍历上限计数 |
| `complete` | 本次遍历是否仅有重复引用跳过，不代表证据内容正确或预览未截断 |
| `estimatedTokens` | 完整格式化 JSON 的保守字符估算，包含路径、说明及计数 |

按存储边顺序深度优先展开，重复节点只返回首次到达路径，不枚举所有路径或保证最短路径。
每次最多检查 1000 条边；超出限制返回部分结果，未检查部分不推测总数。
输出为当前读取快照，不返回跨请求续传游标；可增加预算或以中间记录为新起点继续追溯。
宽图达到上限时，可通过原 `get` 的来源分页继续定位具体记录。
跨范围和缺失引用只返回计数，不输出目标正文或 ID。
起点过长导致预算无法容纳基本响应时返回 `budget_too_small`。
图遍历受限不等于全流程延迟有保证，现有有效性视图仍需读取全库快照。

## 管理面板与验证

原文弹窗增加“多层来源追溯”，可选择 `1/3/5/8` 层，界面固定最多 30 条和 3000 Token 估算。
点击后才读取，显示路径、状态和停止原因；“读取来源原文”单独读取完整内容。
完整原文读取不受前一次预览预算约束；“从此记录继续追溯”会建立新的起点。
使用现有 Remote 管理入口，不新增网络服务或存储域。

已验证嵌套来源、共享成员、循环、缺失、项目隔离、旧事实、休眠状态及各项预算。
客户端契约验证真实 Remote 调用和原文展开，真实宿主验证重载后路径与原文一致。
追溯和界面原文读取不强化、不唤醒、不新增睡眠审计；本批未执行真实记忆删除。
smoke 73 个场景和 Node 测试 195 项通过，原有检索基线指标保持一致。
规范扫描将接口文案中的“Token 预算”与邻近 `export` 操作判为 `RISK-PII-001`，人工核对为关键词误报而非凭据输出。

## 默认 3 秒审核实测

2026-11-20 使用已配置的 `deepseek-v4.1-flash` 顺序对照同一组 6 条合成样本。
样本为 `reg-01,reg-07,reg-13,reg-15,reg-19,reg-21`，两轮样本 SHA-256 相同。

| 审核时限 | 需要审核 | 审核通过 | 审核超时 | 当前要求覆盖 |
| --- | --- | --- | --- | --- |
| 3000 毫秒 | 4 | 0 | 4 | 2 条均正确跳过 |
| 30000 毫秒 | 4 | 4 | 0 | 2 条均正确跳过 |

30 秒组四次审核约耗时 `4.85/6.34/5.69/8.67` 秒，服务端合计实报 4090 Token。
3 秒组均约在 3 秒结束且未注入，服务端未返回用量；报告的 0 实报 Token 不代表实际费用为零。
这次结果说明候选覆盖已达标，但该路由此次无法在默认等待时限内完成审核。
样本数量有限且两轮并非同时执行，不能将其外推为稳定成功率或性能承诺。
报告保留在 `tmp/provenance-c1-review-3s.json` 与 `tmp/provenance-c1-review-30s.json`。

复现命令：

```bash
node --env-file=tmp/live-model.env tests/preference-eval.mjs --live --enabled --ids reg-01,reg-07,reg-13,reg-15,reg-19,reg-21 --max-calls 6 --review-timeout-ms 3000 --report tmp/review-3s.json
```

换成 `--review-timeout-ms 30000` 并使用不同报告文件即可对照。
C1 验收时默认审核时限仍为 3000 毫秒，个人 profile 未修改。
后续已将未显式配置的时限调整为 15000 毫秒并增加可选缓存，实测及升级边界见[审核等待时限与短期结果缓存](memory-review-latency.md)。

[后续路线](memory-next-plan.md) · [返回决策索引](README.md)
