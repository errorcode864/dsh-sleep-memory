<div align="center">

<img src="icon.svg" width="112" alt="dsh-sleep-memory 图标"/>

# dsh-sleep-memory

_让 Agent 在睡眠中巩固记忆，在醒来时想起该想起的事_

**为 DeepSeek Harness 提供跨会话持久记忆的插件：写入、召回、睡眠期巩固与遗忘，一条龙管理**

**每轮对话前自动注入相关记忆，带显著情绪的瞬间会被悄悄沉淀下来**

记忆分层 · 睡眠整理 · 扩散激活 · 自动注入 · 情绪记忆 · 记忆银行面板

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) | 简体中文

</div>

> [!NOTE]
> 本项目属个人自用性质，代码完全开源，欢迎 Fork 或参考。若部署遇到问题或想深度二开，建议先了解 DeepSeek Harness 的插件机制。

为 DeepSeek Harness Agent 提供跨会话的持久记忆：存储（`memory_write`）、检索（`memory_recall`）、睡眠期整理（`memory_sleep`，记忆巩固与遗忘）、记忆库管理（`memory_manage`：列表 / 删除 / 统计）。检索结果还会在每轮对话前自动注入上下文（无需模型主动调用）；带显著情绪的用户消息由 LLM 打分后自动沉淀为显著情绪记忆。侧边栏 GUI 面板（「记忆银行」）可浏览记忆库、查看显著情绪空间与做梦联想边、手动触发睡眠整理。设计映射 Google Research *Sleep-time Compute*（arXiv:2606.03979）与 Ebbinghaus 遗忘曲线。

## 安装

零依赖的 DSH 插件 bundle（`name: dsh-sleep-memory`），由插件管理器消费。推荐在 DSH 的「插件 → 添加插件 → 安装第三方插件」里粘贴 git 地址安装：

```
git+https://github.com/errorcode864/dsh-sleep-memory.git
```

- **本地开发**（源码即安装）：把检出目录以 `node_modules/dsh-sleep-memory` 链接进某个 profile（junction 或 `file:` 依赖），并在 profile `package.json` 的 `bundles` 中加入 `dsh-sleep-memory`。`index.js` 改动经插件禁用/启用热重载；`client.js` 改动刷新页面生效。

## 当前状态：M10-C

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 存储域 + 写入/召回两个工具 + BM25 检索 + 显著情绪记忆 + 记忆化呈现 | ✅ |
| M2 | 睡眠整理：NREM 聚类沉淀 → deep 层；归档降级；Ebbinghaus 衰减；彻底遗忘；REM 联想边 | ✅ |
| M3 | 联想图 + 扩散激活召回 | ✅ |
| M4 | 双分支自动注入（隐式召回 + LLM 效价×强度评分） | ✅ |
| M5 | Web 卡片 / 插件图标 / 双语 README | ✅ |
| M6 | 记忆库管理工具（`memory_manage`：列表 / 删除 / 统计）+ 管理卡片 | ✅ |
| M7 | 显著情绪注入措辞（✦[显著·激励] / ⚠️[显著·警示] 标签与固定图例头） | ✅ |
| M8 | 语义扩展召回（注入路径 LLM 查询改写 × 混合 BM25） | ✅ |
| M9 | 记忆银行 GUI 面板（浏览 / 情绪空间 / 联想边 / 睡眠触发） | ✅ |
| M10 | 时间窗召回（`memory_recall` 按记录 `createdAt` 的 `since`/`until` 过滤） | ✅ |
| M10-B | 包更名为 `dsh-sleep-memory` + 发布就绪 + 文档 | ✅ |
| M10-C | 插件详情页内联配置（`plugins.bundle.config` 槽位，经宿主 `configEditor` 持久化） | ✅ 本次交付 |

## 记忆分层

| 层 | 语义 | 生产者 |
| --- | --- | --- |
| `surface` | 表层记忆，快速衰减 | `memory_write` |
| `salient` | 显著情绪记忆（效价 −1~+1 × 强度 0~1），永不衰减；负效价 ⚠️ 警示 / 正效价 ✦ 激励 | `memory_write`（需过显著阈值） |
| `deep` | 睡眠整理产出的深层沉淀（概要 + 指向成员的 consolidates 边） | `memory_sleep` |
| `archive` | 久远的独立梗概（层降级 + gist，仍可召回） | `memory_sleep` |

## 呈现即修饰（铁律）

`memory_recall` 默认 `fidelity: "recall"`：近期记忆基本如实，久远记忆按当前强度截断为印象梗概并附 `drift` 元数据（模糊程度 + 说明）。**底层原始记录永不改写**（归档梗概存独立 `gist` 字段）；`fidelity: "raw"` 永远可取回原文。被深度沉淀取代（`supersededBy`）的表层记忆默认不再召回，由 deep 概要接棒，deep 命中附 `linkedMemories` 关联数。

## 睡眠整理（memory_sleep）

一次睡眠按四个阶段处理当前记录快照，返回逐条列明动作的报告：

1. **衰减（Ebbinghaus）**：每条非 salient 记忆按 `强度 × 2^(−闲置天数 / (半衰期 × (1 + 重要度)))` 重算；salient 豁免。
2. **巩固（NREM）**：相似度达阈值的低强度表层记忆聚成一簇 → 生成一条 deep 概要记录，成员标记 `supersededBy` 并各自生成 `gist`；未入簇且强度已触底的单条降级为 `archive`。
3. **遗忘清除**：归档记录强度衰减至下限且闲置超过 `deleteArchiveAfterDays` 天的，从存储中**彻底删除**（唯一不可逆操作，报告逐条列出 id/内容预览/闲置天数）。强度未触底或闲置不足则保留（双守卫）。
4. **做梦（REM）**：在留存的非 salient 记录间按词向量相似度添加**双向** `dream-associate` 联想边（供 `memory_recall` 扩散激活使用）。

用法：模型可随时调用 `memory_sleep`（支持 `dryRun: true` 只算不写、先看报告再执行）；另默认每 `sleepIntervalMinutes` 分钟自动执行一次（`0` 关闭定时）。同一次只允许一个睡眠在跑，并发调用返回 `busy`。

已知语义边界：

- 定时器为进程本地：桌面重启后计时归零，不会补跑错过的周期；长期闲置后可手动调用 `memory_sleep` 补一次。
- 所有决策基于周期开始的快照；周期内并发写入以睡眠结果覆盖（丢掉的命中增益会在下次召回时重建）。
- 深层沉淀受 `maxRecords` 容量约束：满时本轮跳过巩固（报告 `capacityLimited: true`），不淘汰现有记忆。

## 扩散激活召回（M3）

`memory_recall` 在 BM25 直接命中之外，沿 REM 阶段生成的 `dream-associate` 联想边向外扩散激活：查 A 能带出与之做梦关联过的 B。边的存储是单向的（挂在源记录上），但扩散按双向语义遍历（出边 + 入边），所以任一侧命中都能带出另一侧。

- **激活分数** = 直接命中分数 × 边权重 × `spreadDecay^跳数` × 邻居当前强度；低于 `spreadMinActivation` 丢弃，超过 `spreadDepth` 跳停止。
- **`via` 标记**：关联命中附 `via: { from, relation, hops }`（from 为上一跳记录 id，多跳时指向链上一环），排在全部直接命中之后，按激活分数降序；直接命中永不带 `via`，同一记录只出现一次（已是直接命中的邻居不再以关联身份重复）。
- **不计入强化**：关联命中不回写 `accessCount`/`strength`——被联想唤醒不等于被真正回忆；只有直接命中照常强化。
- **过滤一致**：`supersededBy` 记录不扩散；`layers` 参数同时约束直接命中与扩散邻居；`recallBudget` 之外的关联命中数量由 `spreadMaxNeighbors` 单独限制。

## 时间窗召回（M10）

`memory_recall` 接受可选的 `since`/`until` 毫秒时间戳，按记录的 `createdAt` 过滤：两端均为闭区间，在 BM25 打分前做硬预过滤，并同步传入扩散激活（窗口外的联想邻居同样被排除）。缺省不设界；注入路径不带时间过滤、行为不变。非法值（负数、非整数或 `since > until`）以 `invalid_args` 拒绝。

## 双分支自动注入（M4）

`memory_recall` 之外，插件在每轮对话的第一个 step 自动挂两条旁路，无需模型主动调用：

**分支一：隐式召回注入。** 监听 `agent/pre-step` waterfall，从本步最后一条用户消息提取查询，运行与工具召回完全相同的管线（BM25 + salience 加成 + 扩散激活），取分数达 `injectMinScore` 的直接命中（至多 `injectBudget` 条，每条截断至 `injectMaxCharsPerHit` 字符），作为一条带 `source.kind: "sleep-memory"` 标记的 user 消息插入到触发消息之后。注入文本以「[sleep-memory 记忆库自动唤起]」开头，声明「这不是用户说的话」，并附一句固定的 ✦/⚠️ 标记图例，防止模型把记忆当作用户发言或误读显著情绪的极性：

```
[sleep-memory 记忆库自动唤起] 以下是你的持久记忆库中与用户当前消息相关的记忆，仅供参考（这不是用户说的话）。✦ 为激励线索（指向值得重复的选择），⚠️ 为警示线索（相似情境再现时优先回顾教训）：
- [表层] 记忆正文……
- ✦[显著·激励] 用户消息带显著积极情绪（激励线索，valence=0.80, arousal=0.80）：……
- ⚠️[显著·警示] 用户消息带显著消极情绪（警示线索，valence=-0.90, arousal=0.70）：……
- [表层] 关联正文……（由联想边带出）
```

- **强化语义与工具召回一致**：注入命中的直接记忆照常写回 `accessCount`/`strength`；关联命中不强化。
- **幂等与透传**：decision 非 enter、非首个 step、无用户消息、或已含 sleep-memory 来源消息时原样返回，绝不重复注入；注入自身失败时返回原 decision，不阻塞对话。
- **日志一致性**：注入消息是真实 user 消息，随会话日志持久化，满足「模型可见 ⟺ 已记录」。

**分支二：LLM 情绪评分。** 同一事件上对用户消息 fire-and-forget 地调用可选 `llm` 服务，让模型按效价（valence，−1~+1）× 唤醒度（arousal，0~1）为消息打分；通过显著阈值（与 `memory_write` 共用 `salienceValenceThreshold`/`salienceArousalThreshold`）的消息自动沉淀为一条 `auto-salient` 标签的 salient 记忆，正文以「警示线索」（valence < 0）或「激励线索」（valence ≥ 0）开头并附当时的 valence/arousal 值，让模型从 content 本身读出情绪方向。评分不写入 `memory_write` 的既有记录，也不等待结果——失败（无 `llm` 服务、超时、输出不可解析、finish 非 stop、容量已满）一律静默放弃，绝不阻塞或污染当前轮。同一消息只评分一次。

## 语义扩展召回（M8）

`semanticRecallEnabled`（默认关）开启后，注入路径在检索前先用当前路由的模型把用户消息改写成检索词（同义词、近义表达、相关实体、英文等价词，一行一词，`semanticMaxTerms` 封顶），再在同一候选集上对扩展词算一次 BM25，按权重与原词分相加：`score = BM25(原词) + semanticRecallWeight × BM25(扩展词)`。改写让「说法不同但指同一件事」的记忆也能命中（例如「波塞冬号」扩出「海神」）。

扩展调用与情绪评分共用同一套调用规约（块数组消息、流式累积、超时中止）；任何失败——无 `llm` 服务、路由非法、超时、finish 非 stop、输出不可解析——都静默退化为纯 BM25，绝不阻塞注入。扩展词只由注入路径传入；`memory_recall` 工具路径的查询由模型自己组织，不做扩展。开启后每轮注入多一次轻量 LLM 调用（`semanticRecallTimeoutMs` 默认 3 秒，短于评分超时以守住注入延迟）。

## Web 工具卡片（M5）

四个工具全部投喂富 `generic` Web 卡片：调用卡带标题与输入预览；结果卡完全由 `output.presentationMeta` 持久化为 `result.meta` 的可回放 JSON 派生，呈现函数是 args + result 的纯函数，直播流式与日志回放渲染一致。未知或畸形的元数据回退为裸 generic 卡片。

- `memory_write`：成功卡标明层级与类型及记录 id；被拒绝（参数非法、未过显著阈值、容量已满）时展示错误码与说明。
- `memory_recall`：逐条命中带层级、drift 标记、分数与联想标注，底部统计联想带出条数；零命中给出可操作提示。
- `memory_sleep`：报告卡展示记录前后条数、各阶段计数（巩固/归档/衰减/遗忘/REM 联想边）、容量标记与预演说明。
- `memory_manage`：`list` 展示 total/offset/limit 与逐条列表（层级、重要度、内容预览）；`forget` 标明已删除条数（含级联）；`stats` 展示各层计数、容量、被取代数、边数与最旧/最新记录 id。

## 插件图标与本地化（M5）

`icon.svg`（靛蓝夜空中的新月与星座）经 manifest 的 `icon` 字段交付；`locale/en.json` 与 `locale/zh.json` 提供插件管理页展示的标题与描述。

## 记忆银行 GUI 面板（M9）

插件附带一个 client 模块（`./client`），在侧边栏注册「记忆银行」入口，后端为 Node 侧 Remote 服务 `sleepMemoryApi`（`ctx.reflect.provide`），声明四个方法：`stats`、`list`（层级过滤 + 子串搜索 + offset 分页）、`edges`、`runSleep`（支持 `dryRun`）。读方法绝不写入；`runSleep` 是唯一写操作，复用与工具相同的 `runSleepCycle`。失败返回结构化错误，错误码为 `sleep-memory/<code>`（`bad-layer`/`bad-limit`/`bad-offset`/`bad-request`）。

面板有三个标签页：

- **浏览**：统计卡片（总数、各层计数、容量、被取代数、边数、最旧/最新记录）加记录列表（层级过滤、防抖子串搜索、「加载更多」增量分页）；每行展示层级、类型、重要度、标签与按 2000 字符截断的正文预览。
- **情绪空间**：salient 记忆在效价（−1~+1）× 唤醒度（0~1）空间的 SVG 散点图，按效价分为 ✦ 激励（valence ≥ 0）与 ⚠️ 警示（valence < 0）两半，悬停显示详情。
- **联想边**：REM 阶段产生的联想边按关系类型（`dream-associate` / `consolidates`）分组展示，每条注明两端记录及其层级。

页头操作「立即睡眠」与「预演」调用 `runSleep` 并展示 SleepReport 徽章（巩固/归档/衰减/遗忘/新增边）。所有文案由 locale 托管（内嵌 zh/en 词典注册在插件 locale 命名空间下），样式只使用 `--dsw-*` 令牌，模块销毁时完整清理（HMR 安全）。

## 插件配置区（M10-C）

client 模块注册 `plugins.bundle.config` 槽位（key = 包名 `dsh-sleep-memory`），插件管理页会在此插件的详情页上渲染内联配置区，位置在描述与包行之间：

| 字段 | 控件 | 范围 |
| --- | --- | --- |
| `injectEnabled` | 复选框 | 开/关 |
| `recallBudget` | 数字输入 | 1–50 |
| `injectBudget` | 数字输入 | 0–10 |
| `sleepIntervalMinutes` | 数字输入 | 0–10080（0 关闭定时） |

- 字段值经插件的 `getConfig` 桥接方法加载：每个字段携带当前值、schema 默认值、`overridden` 标记、类型及（整数字段的）min/max 范围。
- 字段只要出现在 profile 配置覆盖层即记为覆盖（按存在性判断，不做值比较）；每个被覆盖字段提供重置入口，重置即移除该键、回落到插件默认值。
- 保存调用 `setConfig`：先校验，再经宿主 `configEditor` 持久化（对 `sleep-memory` 行执行 `edit(entry, change)`）：编辑器按插件 `Config` schema 复验、写入 profile 覆盖层并触发 Loader reconcile，改动即时生效；值未变化的提交按 no-op 跳过，`{ key: null }` 表示重置。
- 失败在配置区下方渲染一行内联错误；配置编辑器或插件行不可用时，配置区直接展示加载错误而非控件。

## 配置

M1（写入与召回）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `recallBudget` | 5 | 单次召回条数上限 |
| `maxContentChars` | 8000 | 单条记忆正文字符上限 |
| `maxTags` / `maxKeywords` | 8 / 12 | 标签与关键词数量上限 |
| `salienceRecallBoost` | 0.5 | 显著情绪记忆检索加成系数 |
| `strengthRecallGain` | 0.1 | 每次命中对强度的增益 |
| `salienceValenceThreshold` | 0.6 | 写入 salient 所需 \|valence\| 阈值 |
| `salienceArousalThreshold` | 0.7 | 写入 salient 所需 arousal 阈值 |
| `maxRecords` | 20000 | 记忆条数上限（满时拒绝写入而非静默淘汰） |

M2（睡眠整理）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sleepIntervalMinutes` | 360 | 定时睡眠间隔分钟数，0 关闭定时 |
| `decayHalfLifeDays` | 14 | 衰减基准半衰期（天），随重要度放大 |
| `consolidateStrengthLine` | 0.55 | 表层记忆参与沉淀的强度线 |
| `consolidateMinSimilarity` | 0.45 | 聚类所需词向量余弦相似度 |
| `archiveStrengthFloor` | 0.35 | 归档降级/删除判定的强度下限 |
| `deleteArchiveAfterDays` | 90 | 归档记录触发彻底删除的闲置天数 |
| `dreamEdgesPerRecord` | 2 | 每条记录最多新增的联想边数 |
| `dreamMaxCandidates` | 300 | REM 阶段参与联想的记录数上限 |
| `deepSummaryMaxChars` | 1200 | deep 概要正文字符上限 |

M3（扩散激活召回）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `spreadDepth` | 1 | 扩散最大跳数（0 关闭扩散） |
| `spreadDecay` | 0.5 | 每跳激活衰减系数 |
| `spreadMaxNeighbors` | 3 | 单次召回关联命中上限 |
| `spreadMinActivation` | 0.05 | 关联命中的最低激活分数 |

M4（双分支自动注入）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `injectEnabled` | true | 关闭后注入分支整体停用（工具召回不受影响） |
| `injectBudget` | 3 | 单次注入的直接命中条数上限，0 关闭注入 |
| `injectMinScore` | 0.5 | 注入命中的最低检索分数 |
| `injectMaxCharsPerHit` | 400 | 单条注入记忆的正文截断长度 |
| `salientScoringEnabled` | true | 关闭后情绪评分分支停用 |
| `salientScoringTimeoutMs` | 30000 | 情绪评分单次调用超时（毫秒） |

M6（记忆库管理）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `manageListMaxItems` | 50 | `memory_manage` `list` 默认单页条数（单次请求上限 1~500） |
| `manageListPreviewChars` | 120 | `list` 结果中每条记录的内容预览长度 |

M8（语义扩展召回）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `semanticRecallEnabled` | false | 开启后注入召回前用 LLM 把查询改写成检索词做混合召回 |
| `semanticRecallWeight` | 0.5 | 扩展词 BM25 分的加权系数（0~1，与原词分相加） |
| `semanticRecallTimeoutMs` | 3000 | 扩展调用超时（毫秒；注入路径延迟敏感，短于评分超时） |
| `semanticMaxTerms` | 8 | 参与混合召回的扩展检索词上限（1~20） |

配置错误在插件加载期抛出（fail loud）。

## 本地验证

回归测试同时覆盖 DSH `0.2.1-rc.5` 的单条删除接口和新版宿主的批量删除接口，并严格拒绝对缺失记录调用 `update()`，防止 mock 掩盖真实存储约束。新版使用 `deleteMany()`；旧版按顺序等待 `delete()` 完成，单次失败即中止，已完成的删除不会回滚。睡眠生成 deep 记忆使用 `put()`，已有记录继续使用 `update()`。

```sh
node smoke.mjs   # mock ctx 驱动 73 个行为场景（M1 写入/召回 + M2 四阶段睡眠 + M3 扩散召回 + M4 注入与评分 + M5 卡片投影 + M6 管理工具 + M8 语义扩展召回 + M9 GUI Remote 服务 + M10 时间窗召回）
```

## 已知边界

- 检索为全表内存 BM25，记录量在数万级内足够；更大规模（分词索引外置等）后续评估。
- `memory_write` 的情绪仍由调用方模型自评给出；注入时点的 LLM 评分通过声明式注入的 `llm` 服务访问（与内置模型消费者一致的属性访问方式），服务缺失或调用失败时该分支静默跳过（不产生显著记忆），不影响其他功能。
- 自动注入每轮向上下文追加一条 user 消息，消耗 token 预算；用 `injectBudget`/`injectMaxCharsPerHit` 控制规模，`injectEnabled: false` 退回纯工具召回。
- 扩散只沿 `dream-associate` 边传播，`consolidates` 边（deep → 成员）不参与扩散；BM25 高频虚词（如「的」）可能造成弱直接命中，属于 M1 检索语义。
- GUI 面板除触发睡眠（`runSleep`，支持预演）外均为只读；记录编辑通过 `memory_manage`/`memory_write` 完成。列表行正文按 2000 字符截断（全文仍可通过 `memory_recall` 召回），且面板是单文件本地 client 模块、无独立单测——行为由 `smoke.mjs` 的 M9 服务场景覆盖，最终需在浏览器中目测确认。

## License

[MIT](./LICENSE) © errorcode864
