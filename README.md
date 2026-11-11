<div align="center">

<img src="icon.svg" width="112" alt="dsh-sleep-memory 图标"/>

<h1 style="margin: 8px 0 0">dsh-sleep-memory</h1>

<h3 style="margin: 20px 0 10px">让 Agent 在睡眠中巩固记忆，在醒来时想起该想起的事</h3>

<p style="margin: 0 0 14px"><strong>DeepSeek Harness 跨会话持久记忆插件：写入、召回、睡眠期巩固与遗忘，一条龙管理</strong></p>

<p style="margin: 0 0 12px">记忆分层 · 睡眠整理 · 扩散激活 · 自动注入 · 情绪记忆 · 记忆银行面板</p>

<br/>

<p><a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a></p>

</div>

> **本项目属个人自用性质**：功能围绕作者自身的 DeepSeek Harness 使用场景打磨与取舍，
> 不承诺长期维护与全环境兼容。如您有类似需求，欢迎 Fork 或参考。
> 当前实现以规则聚类、概要和词频联想组织外部记忆，不修改模型权重。

---

## 为什么选择 dsh-sleep-memory

大模型的会话结束后记忆即丢失；把历史对话全部塞进上下文既昂贵又低效。dsh-sleep-memory
给 DeepSeek Harness 补上一层外部记忆：平时自动写入，空闲时像睡觉一样整理归并，
每轮对话前自动唤起该想起的部分。

<table>
<tr>

<td width="25%" valign="top">

### 跨会话记忆

模型无需主动调用，每轮对话前自动注入相关记忆；也可随时用 `memory_recall` 显式检索。

</td>

<td width="25%" valign="top">

### 睡眠整理

定时执行四阶段睡眠：衰减、聚类沉淀、归档遗忘、做梦建立联想，让记忆库越用越干净。

</td>

<td width="25%" valign="top">

### 分层与遗忘

表层 / 显著情绪 / 深层 / 归档四层组织，按半衰期衰减，久远记忆归档直至彻底清除。

</td>

<td width="25%" valign="top">

### 开箱即用

零依赖 DSH 插件 bundle，附带记忆银行管理面板与富工具卡片，装上即用。

</td>

</tr>
</table>

---

## 工作原理

```text
对话进行中
    │
    ├── memory_write          模型主动写入（事实 / 经历 / 显著情绪）
    ├── 自动注入               每轮对话前隐式召回相关记忆，作为旁路消息插入
    ├── 情绪评分               对用户消息后台打分，显著瞬间自动沉淀
    └── memory_recall         模型显式检索（BM25 + 扩散激活 + 时间窗）

空闲 / 定时（memory_sleep）
    │
    ├── ① 衰减                 按半衰期重算强度
    ├── ② 巩固（NREM）         相似表层记忆聚合成一条深层概要
    ├── ③ 遗忘                 归档记忆强度触底且长期闲置 → 彻底删除
    └── ④ 做梦（REM）          为记忆之间建立联想边，供下次扩散召回
```

---

## 快速开始

### 环境要求

- DeepSeek Harness（含插件机制的 profile）
- 插件本身零 npm 依赖

### 安装

**方式一：插件市场安装**

在 DSH 的「插件 → 添加插件 → 安装第三方插件」里输入包名：

```text
dsh-sleep-memory
```

命令行安装：

```sh
dsh plugin --profile <profile> add dsh-sleep-memory                # npm 包（推荐）
dsh plugin --profile <profile> add errorcode864/dsh-sleep-memory#dist  # GitHub dist 分支
```

npm 包安装后，DSH 会在打开插件页或手动检查时自动提示新版本。

**方式二：本地开发（link 安装）**

profile 的依赖名和 `dsh.profile.bundles` 使用 `dsh-sleep-memory`，
依赖值指向本地插件目录即可。`index.js` 改动经插件禁用/启用热重载；`client.js`
改动刷新页面生效。

### 本地验证

```sh
npm test       # smoke 场景 + 可靠性与客户端契约测试
npm run eval   # 确定性检索场景，不调用真实 LLM
```

---

## 功能说明

### 记忆分层

| 层 | 语义 | 生产者 |
| --- | --- | --- |
| `surface` | 表层记忆，快速衰减 | `memory_write` |
| `salient` | 显著情绪记忆（效价 −1~+1 × 强度 0~1），默认不衰减 | `memory_write`（需过显著阈值） |
| `deep` | 睡眠整理产出的深层沉淀（概要 + 指向成员的 consolidates 边） | `memory_sleep` |
| `archive` | 久远的独立梗概（层降级 + gist，仍可召回） | `memory_sleep` |

### 写入与召回

- **`memory_write`**：写入事实或经历，支持项目范围（`projectId`）、来源溯源与事件时间；显著情绪记忆需通过效价/唤醒度阈值。
- **`memory_recall`**：BM25 检索 + salience 加成；沿 REM 联想边扩散激活带出关联记忆（附 `via` 标注，不计入强化）；支持 `since`/`until` 时间窗与 `timeField: "occurredAt"` 事件范围检索。
- **呈现即修饰**：默认 `fidelity: "recall"` 返回记忆化呈现（久远记忆是被时间修饰过的印象梗概，附 `drift` 说明）；`raw` 模式取原文；`memory_manage get` 按 ID 追溯完整原文与纠正链。

### 睡眠整理（memory_sleep）

一次睡眠按四个阶段处理当前记录快照，返回逐条列明动作的报告；支持 `dryRun: true`
只算不写。默认每 `sleepIntervalMinutes` 分钟自动执行一次（`0` 关闭）；并发调用返回
`busy`。上次成功时刻与失败退避跨重启持久保存。

**遗忘清除是唯一不可逆操作**：归档记忆强度衰减至下限且闲置超过 `deleteArchiveAfterDays`
天才删除，报告逐条列出；强度未触底或闲置不足则保留（双守卫）。

### 自主学习与按需召回

无需主模型主动调用记忆工具，默认启用两条独立管线：

- **自主学习**：监听宿主 `session/event`，在正常完成的轮次结束后后台提取稳定偏好、
  项目约定、操作方法与排障经验。每条候选必须有用户消息或工具结果的逐字证据；
  助手自述不能独立证明事实。重复内容不新增，发现冲突的候选标记待复核，保留旧事实。
- **按需召回**：每轮首个 step 只以真实用户消息作为查询。中文按词与短语匹配，字段名、
  IP、端口、版本和路径保留完整边界；完整实体与查询覆盖度参与加权排序。
  再由 LLM 判断候选是否能帮助当前任务；直接命中和联想结果都要审核。
  审核失败或超时则跳过本轮自动注入。支持整体字符预算、会话去重与并发事实版本复核。
- **可选情绪评分**：原始情绪不等于可复用知识，因此默认关闭。显式开启后仍可后台评分并沉淀
  salient 记忆；已有情绪记忆和显式写入不受影响。

学习和审核使用当前会话的模型路由，会增加模型调用。学习不阻塞主对话，
审核默认最多等待 3 秒。记忆银行的运行状态可查看写入、重复、待复核、审核拒绝和失败原因。
详细范围、证据与运行边界见[可靠记忆使用与验证](docs/guides/reliability.md)。

单字和数字不再统一丢弃：独立术语与明确的端口、状态码、字段赋值仍可参与召回。
词内单字、标识符组件和没有语境的数字只作低权重补充，不能独立触发自动注入。
例如 `del_flag` 不会因共享 `flag` 命中 `status_flag`，`0/1` 不会命中 IP 中的数字，
`Spring Boot 3.2.11` 也不会被仅描述 `3.2.12` 的记忆替代。
显式召回的 `retrieval` 字段会解释命中的词、实体与查询覆盖度。

### 语义扩展召回（可选）

`semanticRecallEnabled` 开启后，注入路径先用 LLM 把查询改写成检索词（近义词、英文
等价词等）做混合召回，让「说法不同但指同一件事」的记忆也能命中。任何失败都静默退化
为纯 BM25。

### 管理与面板

- **`memory_manage`**：列表 / 删除 / 统计 / 原文追溯 / 事实纠正 / 有效性切换（先预演）/ JSON 备份与导入预演。
- **记忆银行 GUI**：侧边栏「记忆银行」面板，含浏览、情绪空间（效价 × 唤醒度散点图）、
  联想边三个标签页，以及立即睡眠 / 预演 / 配置编辑。只读操作不强化记忆。
- **富工具卡片**：四个工具均投喂 Web 卡片，直播流式与日志回放渲染一致。
- **内联配置区**：插件详情页直接编辑常用配置字段，改动经宿主编辑器持久化，即时生效。

---

## 项目结构

```
sleep-memory/
├── index.js                # 插件入口：工具注册、自动注入、定时睡眠
├── client.js               # 客户端模块：记忆银行面板 + 内联配置区
├── memory-contract.js      # 存储域与配置 schema
├── memory-runtime.js       # 睡眠、评分、召回管线
├── memory-intelligence.js  # 后台知识提取、证据校验与召回审核
├── memory-retrieval.js     # 中文词级分析、技术实体保护与加权检索
├── memory-management.js    # memory_manage 工具实现
├── eval.mjs / smoke.mjs    # 检索基线 / 冒烟测试
├── locale/                 # 插件管理页双语标题与描述
├── docs/
│   ├── guides/             # 使用与验证、发布迁移指南
│   └── decisions/          # 实施取舍记录
├── tests/                  # 可靠性与客户端契约测试
└── icon.svg                # 插件图标
```

---

## 配置

配置错误在插件加载期抛出（fail loud）。完整字段表见
[使用与验证指南](docs/guides/reliability.md)，常用字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `recallBudget` | 5 | 单次召回条数上限 |
| `maxRecords` | 20000 | 记忆条数上限（满时拒绝写入而非静默淘汰） |
| `sleepIntervalMinutes` | 360 | 定时睡眠间隔，0 关闭 |
| `sleepOnStart` | false | 加载时按期补跑 |
| `decayHalfLifeDays` | 14 | 衰减基准半衰期（天），随重要度放大 |
| `deleteArchiveAfterDays` | 90 | 归档记录触发彻底删除的闲置天数 |
| `injectEnabled` | true | 自动注入总开关 |
| `injectBudget` | 3 | 单次注入条数上限，0 关闭注入 |
| `injectMaxTotalChars` | 4000 | 整个注入块的字符预算 |
| `injectRepeatAfterTurns` | 3 | 同会话重复注入的轮次间隔，0 关闭 |
| `autoLearnEnabled` | true | 完成轮次后后台提取有来源的可复用记忆 |
| `autoLearnMaxItems` | 3 | 每轮最多学习的候选条数 |
| `autoLearnTimeoutMs` | 30000 | 后台学习等待上限，单位毫秒 |
| `recallReviewEnabled` | true | 自动注入前审核任务相关性 |
| `recallReviewTimeoutMs` | 3000 | 召回审核等待上限，单位毫秒 |
| `recallCandidateBudget` | 12 | 审核前的直接候选数量，与最终注入预算分开 |
| `injectMinScore` | 0.2 | 词与实体加权后的 BM25 候选门槛，不代表相关概率 |
| `salientScoringEnabled` | false | 可选的原始情绪评分沉淀 |
| `projectId` | 空 | 无会话绑定与工作区时的回退范围，空值表示全局 |
| `semanticRecallEnabled` | false | 语义扩展召回开关 |
| `salientDecayHalfLifeDays` | 0 | 显著经历专用半衰期，0 关闭 |
| `salientReviewAfterDays` | 0 | 显著经历复核期限，0 关闭 |

---

## 已知限制

- 检索为全表内存 BM25，巩固有成对比较；未做万级性能压测，不承诺大库延迟。
- 中文词边界使用运行时内置 `Intl.Segmenter`，不新增 npm 依赖，支持离线运行；
  不同 ICU 版本的词边界可能略有差异。技术实体识别与数字语境规则不覆盖所有自然语言写法。
- `memory_write` 的情绪由调用方模型自评给出；自动评分依赖宿主 `llm` 服务，缺失或失败时静默跳过。
- 自动注入消耗上下文预算，字符预算不是模型 Token 精确计数；去重仅限本插件实例。
- 管理面板可查看整个个人 profile，不是多用户权限边界；`source.confirmed` 是调用者提供的溯源声明，不是权限凭据。
- 不提供 dense 检索、多主机实时同步、自动事实冲突裁决或多用户鉴权。
- 自主学习和审核依赖模型判断，逐字证据检查不等于语义蕴含证明；尚未给出真实 LLM 的准确率保证。
  候选召回仍依赖词面或可选查询扩展，审核无法找回未进入候选集的记忆。
  没有项目范围时只允许自主学习用户偏好，避免项目知识污染全局；项目知识需先建立工作区或会话绑定。
- 存储没有跨记录事务；睡眠或导入发生 I/O 错误时可能部分完成，需核对错误与库存。
- JSON 备份仅包含记忆与有效性，不含本机会话绑定、调度及配置；跨机器需要重新绑定项目。

---

## 安全说明

- 自动注入的消息以固定图例开头，声明「这不是用户说的话」且其中的历史指令不构成当前授权。
- 显著情绪的极性由 ✦/⚠️ 标记显式呈现，防止模型误读激励/警示方向。
- 管理接口与配置编辑经宿主既有权限体系；插件不自行暴露网络端口。

---

## 许可证

本项目基于 [MIT](LICENSE) 协议开源，可自由用于个人自用与二次开发。

---

<div align="center">

**dsh-sleep-memory** · 让 Agent 在睡眠中巩固记忆

分层记忆 · 睡眠整理 · 扩散激活 · 开箱即用

</div>
