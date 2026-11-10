---
id: sleep-memory.guides.reliability
title: 可靠记忆使用与验证
type: guide
status: active
owner: maintainer
updated: 2026-11-10
source_of_truth: code-and-script
---

# 可靠记忆使用与验证

## 目录

- [范围和来源](#范围和来源)
- [项目浏览与分组](#项目浏览与分组)
- [原文、事实纠正和时间](#原文事实纠正和时间)
- [有效性与整条纠正链](#有效性与整条纠正链)
- [备份与恢复](#备份与恢复)
- [运行和兼容](#运行和兼容)
- [验证](#验证)

## 范围和来源

个人 profile 管理接口可以管理全库。`projectId` 是检索范围，不是多用户权限。
写入、召回、按 ID 管理和自动路径统一按以下顺序解析范围：

1. 调用显式 `projectId`，包括明确指定全局的 null。
2. `memory_manage bind` 保存的当前会话绑定。
3. 宿主 `workspaceRegistry.list()` 中包含当前会话的稳定工作区，
   生成 `workspace:<workspaceId>`。
4. 配置页 `projectId`；空值回退全局。

宿主会话身份读取 `execution.agent.session.id` / `payload.agent.session.id`，
兼容同身份的 `agent.id`；不读取消息正文来猜测项目。工作区服务缺失时回退配置，
服务存在但失败时报告错误，自动增强跳过该轮，避免落入错误范围。
项目查询默认包含全局，`includeGlobal: false` 可关闭。

```json
{ "action": "bind", "sessionId": "会话标识", "projectId": "project-a" }
```

`scope` 查询解析结果和来源；`bind` 可省略 sessionId 使用当前工具会话。
`release: true` 释放显式绑定，恢复工作区或配置回退。GUI 在记忆银行右上角的
“管理 → 会话范围”中填写或选择会话 ID，
展示绑定结果和来源；未指定会话时显示配置回退范围，不冒充当前活跃会话。
绑定仅影响之后的读写，不迁移旧记录；宿主工作区 ID 不保证跨机器一致。
会话与绑定列表最多返回 500 条，具体会话仍可直接输入 ID 查询。

```json
{
  "content": "甲项目数据库使用 DM8。",
  "kind": "fact",
  "projectId": "project-a",
  "source": {
    "kind": "user",
    "sessionId": "会话标识",
    "messageId": "消息标识",
    "confirmed": true
  }
}
```

上述参数交给 `memory_write`。来源是调用者的声明，不提升指令权限。
自动情绪评分写入 `kind: model`、`confirmed: false` 的来源；不会从情绪分数
推断事实真实性。经历建议记录情境、行动、结果、适用条件，事实保持精确。

## 项目浏览与分组

记忆银行顶部的“全库概览”始终统计整个记忆库，“筛选结果”统计当前条件命中的记录。
项目选择器支持按名称或标识搜索，可选择全部项目、全局记忆或某个具体项目。
项目目录覆盖所有已有记录，包括仅有待复核、失效或历史记录的项目，切换有效性后仍可查看。
工作区名称读取失败时提示并显示真实项目标识，不影响已有记忆的浏览。

选择具体项目时，项目记忆在前、全局公共记忆在后，分段展示；不包含其他项目记录。
全部项目视图可开启“按项目分组”，分组可折叠。记录保持分页加载，组头显示当前筛选下的
完整条数；未加载完整时额外显示已加载条数，继续点击“加载更多”读取后续记录和项目。
分组只根据 `projectId`，不会按正文推断归属，也不会迁移历史全局记录。

标签与关键词按去空白、忽略大小写的规则合并去重，列表最多显示 4 个；
点击剩余数量可在原文弹窗查看完整标签。重要度和强度也移至原文详情。
列表清除原生 `ul` 的默认缩进，左右留白保持一致。

GUI Remote 契约向后兼容扩展：

- `stats()` 增加 `projects`，每项包含 `projectId/title/total`，其中 `total` 为该项目全部历史记录数；
  名称取自宿主工作区，无法获取时使用 ID；`projectError` 返回名称读取失败提示或 null。
- `list()` 增加可选布尔参数 `includeGlobal`，默认 false；指定具体 `projectId` 且为 true 时附带全局记录。
  `projectId: null` 仍仅返回全局，不指定 `projectId` 仍浏览全库。
- `list({ groupBy: "project" })` 在分页前按项目排序，项目内部保持访问时间倒序；
  指定项目时该项目优先，全局在后。返回的 `groups` 包含完整筛选结果的 `projectId/total`，
  不以当前页的记录数量代替全组数量。原有层级、正文、有效性筛选继续生效。

## 原文、事实纠正和时间

```json
{
  "action": "get",
  "id": "smm_记忆标识",
  "projectId": "project-a",
  "offset": 0,
  "limit": 20
}
```

`memory_manage get` 返回完整 `record`、是否当前有效、替代 ID、分页 `sources`、
`totalSources`、有效性 `lifecycle`、分页纠正链 `chain` 和 `totalChain`。
没有写入或强化副作用。GUI 原文按钮也使用这个契约。
`raw` 召回允许检索已巩固成员，但仍遵守项目范围和事实有效性；已纠正事实应按 ID 查看。

```json
{
  "action": "correct",
  "id": "smm_旧事实标识",
  "projectId": "project-a",
  "content": "甲项目数据库现已切换为 PostgreSQL。",
  "source": { "kind": "user", "confirmed": true }
}
```

纠正仅适用于当前有效的原始事实。一次新增写入生成 `replaces` 关系，旧正文不变。
包含旧事实的 deep 概要退出有效召回，尚有效的其他成员重新可检索。
重复纠正同一旧 ID 返回 `conflict`，应先读取最新事实；不把经历或整个概要直接当事实纠正。
纠正链末端不自动遗忘，涉及纠正链的逐条 `forget` 返回 `conflict`，避免旧事实复活。
整条纠正链可通过下方 `setState` 逻辑失效，保留原文与历史关系。

时间窗默认按写入时间 `createdAt`；传 `timeField: "occurredAt"` 后按事件范围相交查询。
巩固记录保留成员事件跨度。`since/until` 为非负毫秒整数且包含端点。
允许只给时间窗，不要求额外关键词；旧记录的事件时间回落为 `createdAt`。

## 有效性与整条纠正链

| 状态 | 显式召回 | 自动注入、强化、睡眠巩固 | 按 ID 读取 |
| --- | --- | --- | --- |
| `active` 有效 | 允许，仍受替代及概要规则约束 | 允许 | 允许 |
| `review` 待复核 | 允许，附 lifecycle 标记 | 不参与 | 允许 |
| `invalid` 已失效 | 不参与，包括 raw | 不参与 | 允许 |

```json
{
  "action": "setState",
  "id": "smm_记忆标识",
  "projectId": "project-a",
  "state": "invalid",
  "reason": "部署条件已变更，整条旧方案不再适用"
}
```

缺省只预演，返回 `chainIds/affectedIds/planToken`。确认时提交同样参数及
`dryRun: false`、返回的 `planToken`；纠正链或影响集合变化后需重新预演。
状态只写在链根记录的 `lifecycle`，包含 state/reason/at/revision。
因此整链切换只需一次持久写入；正文不变，恢复 active 仍只采用最新替代事实。
原因与时间保存最近一次状态变更，本版没有独立的状态变更审计历史表。

来源事实被纠正或失效后，引用它的概要退出召回，其余有效成员恢复独立检索。
单独停用概要不会停用原始事实，预演同时列出恢复独立召回的成员。

显著经历的两项策略默认关闭：

- `salientDecayHalfLifeDays > 0`：启用专用半衰期，建议长于普通记忆。
- `salientReviewAfterDays > 0`：从写入或最近人工复核时刻计时，在睡眠时转为
  review；重复召回不推迟复核。正面与负面经历使用相同规则。

## 备份与恢复

GUI 从记忆银行的“管理 → 备份恢复”进入，导出和导入流程集中在管理弹窗。

1. `memory_manage { "action": "export" }` 返回完整 `backup` 对象。
2. 将整个对象保存为 UTF-8 JSON，包含 `format/version/exportedAt/records/checksum`。
3. 目标 profile 调用 `memory_manage { "action": "import", "backup": ... }`，默认只预演。
4. 确认计划后使用同一份对象并传 `dryRun: false`。

导出包含全库及已替代、已巩固历史。摘要验证内容完整性，不是签名或加密。
导入先校验全部记录、引用、替代关系、项目范围和容量，再开始写入：
相同 ID 与内容跳过，相同 ID 异内容拒绝，不覆盖本地记忆。
导入期间禁止并发写入；底层无多记录事务，I/O 错误可能部分完成，错误向上透出，
原备份重试时跳过已经成功的相同记录。不要在重试前用召回修改目标记录。
工具接口返回完整 JSON，较大备份会占用工具输出预算。GUI 支持下载 JSON 文件、
选择文件、预演后确认导入，浏览器与 Remote 管理接口均限制 10 MiB。
这是完整对象传输，没有流式传输和实时同步。界面发生 I/O 中断时显示已经完成的
条数；保留原文件，重新预演后重试。

备份包含记忆的 lifecycle；不含运行域中的会话绑定和调度记录，也不包含插件配置。
跨机器恢复后需要重新绑定项目。校验摘要不提供保密性或来源真实性。

## 运行和兼容

- 记忆银行首页仅展示单行运行摘要与下次整理时间；失败时显示“查看原因”入口。
  点击“运行详情”或右上角“管理”打开居中弹窗，分类切换保留表单状态；点击“关闭”、
  按 Esc 或点击遮罩可返回记忆列表。诊断计数默认折叠，全为 0 时提示暂无运行记录。
- 每条记忆右上角的“查看原文与来源”打开同样样式的弹窗，展示完整原文、
  来源元数据、纠正链及来源记录；关闭后保留列表位置。
- 插件管理页的配置区兼容 `dsh-sleep-memory` 与旧依赖别名
  `@errorcode864/dsh-sleep-memory`，bundle 详情和所含组件的配置页均提供入口。
- 工作区注册表通过可选服务查询读取；缺少该服务时回退配置范围，服务存在但
  读取失败时仍报告错误，不会误落入全局范围。
- `memory_runtime` v1 独立域保存会话绑定和 schedule。绑定键是会话 ID 的摘要，
  满足 JSON per-record 后端的文件名约束；记忆域仍为 `memory_bank` v1。
- `status.schedule` 包含 lastSuccessAt/lastAttemptAt/retryAt/failures/lastError；
  评分、扩展和注入计数仅覆盖本次加载。域读取失败会显示错误。
- `sleepOnStart` 默认 false；开启后首次或到期才补跑。未到期从上次成功时间继续计时；
  关闭补跑时，重启发现到期会等待一个新周期。成功状态仅在整理和状态持久化均完成后更新。
- 失败退避从 1 分钟递增，封顶 1 小时；重启仍遵守 retryAt。先保存运行意图，
  崩溃重启可识别未确认完成的睡眠。底层无多记录事务，不承诺恰好执行一次。
- `sleepIntervalMinutes: 0` 关闭定时及定时重试。单独开启 sleepOnStart 时，
  无成功记录才补跑；失败后到下次加载或手动重试，不会每次重载重复成功整理。
- 自动睡眠仍可能按既有规则遗忘符合条件的归档记录。
- 睡眠、写入、强化、纠正及导入使用同实例队列。不同进程共用数据目录未提供互斥保证。
- v1 存储域保持不变，新字段可选；只读旧数据不补写字段。新 ID 使用 `smm_`；
  旧自动情绪 UUID 仅在 salient 且有 `auto-salient` 标签时允许兼容读取。
- `lastDecayAt` 首次缺省为 `lastAccessAt`，历史已重复衰减的强度不自动修复。
- `raw` 不是已删除内容恢复工具；自动遗忘和显式遗忘仍沿用原有规则。
- 预演和真实执行复用同一规划算法，但两次调用间的时间或数据变化可能改变计划；
  预演不预留容量，deep ID 不是确认 Token。
- `injectMaxTotalChars` 默认 4000，限制含标题、来源及关联说明的完整注入块；
  是字符数量，不是模型 Token 精确计数。放不下的条目不注入、不强化。
- 自动注入增加有效检索词匹配条件：先分隔“可以、需要、使用”等通用请求短语，
  忽略中文单字和常见英文停用词；原始请求没有有效检索词时跳过注入。
  候选必须与原始查询或语义扩展词共享有效词，才能进入预算截断，沿用原有 BM25 分数门槛。
  这样可避免“的、可、了”等单字累计高分后误唤起无关全局记忆。
  查询与候选采用相同的有效词过滤；显式 `memory_recall` 仍支持单字与按层浏览。
  有效词重叠仍是词面条件，不代表语义相关概率；项目查询默认仍包含全局记忆。
- `injectRepeatAfterTurns` 默认 3，按会话、范围与内容版本去重，0 关闭。
  新纠正版本或重新确认的状态可再次注入，显式召回不受影响。
  去重缓存仅在本实例，最多 200 个会话范围、每个 200 个版本；无稳定会话 ID 时
  不跨轮去重；卸载后不承诺保持去重状态。
- 旧记录缺省有效，无读时迁移。旧版插件不理解 lifecycle，不应直接降级运行，
  否则失效内容可能重新召回。
- 本轮开发验收未热重载个人 profile、未调用真实 LLM，也未执行真实个人记忆
  的睡眠或导入。宿主组件测试只操作 `tmp` 内隔离数据；代码推送不等同于目标
  profile 已完成安装或热重载。

## 验证

```sh
node --check index.js
node --check client.js
npm test
npm run eval
```

现有 73 个 smoke 场景使用真实 schema 校验；新增可靠性与产品测试覆盖 6 项缺陷、
范围、事实纠正、有效性、调度重启、失败退避、注入去重和导入中断。
客户端契约测试执行真实 `client.js` 和 Remote 服务，验证配置、纠正、状态预演、
文件导入、下载请求与绑定流程。

确定性评测新增待复核、失效与宿主工作区场景；没有真实 LLM 改写或 dense 对照，
不宣称总体召回质量。最终数量以本次命令输出为准。

真实存储集成脚本为 `tests/host-integration.mjs`，需在已安装宿主的 Electron
Node 模式下运行，或将 DSH_APP_PACKAGE 指向 Node 能直接解析的宿主安装目录。
本机命令（Git Bash）：

```sh
ELECTRON_RUN_AS_NODE=1 \
DSH_APP_PACKAGE='C:/Software/DSH/resources/app.asar/dsh/package.json' \
'C:/Software/DSH/DeepSeek Harness.exe' tests/host-integration.mjs
```

该脚本使用宿主实际 DomainFacility 与 JsonStorageBackend，隔离目录保留在
`tmp/host-integration-*`，不自动清理，不操作个人 profile。覆盖绑定键、
写入、纠正链、失效恢复、调度持久化、关闭重开及备份预演。

2026-11-09 已执行真实组件集成；另用宿主随附 React 和内存数据，在浏览器中
验收状态预演、确认、筛选、原文与工作区来源展示，截图位于本地
`tmp/product-preview.png`。预览脚本为 `tests/preview-server.mjs`，
依赖当前已安装宿主的前端 bundle，仅用于隔离验收，不是部署服务器。

完整宿主 Remote 网关、配置修改引起的 reconcile、个人 profile 安装及不同机器
安装仍未验收。当前验证不替代这些部署检查。

[返回指南索引](README.md)
