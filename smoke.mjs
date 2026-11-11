/**
 * 本地 smoke：用 mock ctx/storageDomain 驱动 apply，验证四个工具的完整行为
 * （M1 写入/召回 + M2 睡眠整理 + M6 记忆管理）。
 * 用法：node smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyPlugin } from './index.js'

// 旧 smoke 验证工具与词面检索契约，智能管线由独立测试覆盖。
const apply = (context, config) => applyPlugin(context, {
  autoLearnEnabled: false, recallReviewEnabled: false, salientScoringEnabled: true, ...config,
})

const recordParsers = new WeakMap()
/** 内存版 KvTable：默认镜像 rc.5 接口，可选新版批量删除；缺失记录不能 update，读取返回快照迭代器。 */
function makeTable({ batchDelete = false } = {}) {
  const map = new Map()
  const table = {
    get size() { return map.size },
    get(id) { return map.get(id) },
    keys() { return [...map.keys()][Symbol.iterator]() },
    entries() { return [...map.entries()][Symbol.iterator]() },
    async put(id, value) {
      recordParsers.get(table)?.parse(value)
      assert.equal(id, value.id, '存储键必须与记忆 ID 一致')
      map.set(id, value)
    },
    async update(id, updater) {
      if (!map.has(id)) throw new Error(`记忆记录不存在：${id}`)
      const next = updater(map.get(id))
      recordParsers.get(table)?.parse(next)
      map.set(id, next)
      return next
    },
    async delete(id) { return map.delete(id) },
  }
  if (batchDelete) {
    table.deleteMany = async (ids) => {
      let removed = 0
      for (const id of new Set(ids)) {
        if (map.delete(id)) removed += 1
      }
      return removed
    }
  }
  return table
}

const table = makeTable()
// 形状对齐 storage-domain 真实 Domain 接口：表句柄经 table(name) 方法获取。
const domain = {
  spec: null,
  table(name) { if (name !== 'records') throw new Error(`declares no table '${name}'`); return table },
}
const registered = []
const effects = []
const handlers = new Map()
const ctx = {
  storageDomain: { open: async (spec) => {
    if (spec.name === 'memory_runtime') {
      const runtimeTable = makeTable()
      recordParsers.set(runtimeTable, spec.tables.records.valueSchema)
      return { table: () => runtimeTable, close: async () => {} }
    }
    domain.spec = spec
    recordParsers.set(table, spec.tables.records.valueSchema)
    return domain
  } },
  tools: { register: (def) => { registered.push(def) } },
  effect: (fn) => { effects.push(fn) },
  on: (event, handler) => { handlers.set(event, handler) },
  get: () => undefined,
  reflect: { provide: () => {} },
}

apply(ctx, {})

assert.equal(registered.length, 4, '应注册四个工具')
const write = registered.find((tool) => tool.name === 'memory_write')
const recall = registered.find((tool) => tool.name === 'memory_recall')
const sleep = registered.find((tool) => tool.name === 'memory_sleep')
const manage = registered.find((tool) => tool.name === 'memory_manage')
assert.ok(write?.execute && recall?.execute && sleep?.execute && manage?.execute, '四个工具都应有 execute')
assert.equal(domain.spec.name, 'memory_bank', '存储域名正确')

// 1. fact 写入
const fact = await write.execute({ content: '用户偏好深色主题，讨厌动画闪烁', kind: 'fact', tags: ['偏好', 'UI'], keywords: ['主题'] })
assert.equal(fact.layer, 'surface', '默认写入 surface')

// 2. 显著负情绪 → avoidance
const fear = await write.execute({ content: '用户曾因未备份丢失整周工作，极度懊悔', kind: 'experience', layer: 'salient', valence: -0.9, arousal: 0.8 })
assert.equal(fear.code, undefined, '显著情绪应写入成功')
assert.equal(fear.salient.branch, 'avoidance', '负效价 → avoidance')

// 3. 弱情绪 → not_salient
const weak = await write.execute({ content: '今天天气不错', kind: 'experience', layer: 'salient', valence: -0.2, arousal: 0.3 })
assert.equal(weak.code, 'not_salient', '未达阈值的情绪应被拒绝')

// 4. 缺 salient 字段 → not_salient
const missing = await write.execute({ content: '缺情绪字段', kind: 'experience', layer: 'salient' })
assert.equal(missing.code, 'not_salient')

// 5. 超长内容 → invalid_args
const tooLong = await write.execute({ content: 'x'.repeat(9000), kind: 'fact' })
assert.equal(tooLong.code, 'invalid_args')

// 6. BM25 召回 + 呈现
const recalled = await recall.execute({ query: '用户喜欢什么主题' })
assert.ok(recalled.count >= 1, '应召回偏好记忆')
const hit = recalled.hits.find((h) => h.id === fact.id)
assert.ok(hit, '偏好记忆应在命中列表')
assert.equal(hit.drift.applied, false, 'surface 记忆不做修饰')
assert.equal(hit.content, '用户偏好深色主题，讨厌动画闪烁', 'surface 呈现原文')

// 7. 命中强化：strength 0.6 → 0.7
assert.ok(Math.abs(table.get(fact.id).strength - 0.7) < 1e-9, '命中后 strength 应 +0.1')
assert.equal(table.get(fact.id).accessCount, 1, '命中后 accessCount 应 +1')

// 8. raw 模式取原文 + salient ⚠️
const raw = await recall.execute({ query: '备份丢失', fidelity: 'raw' })
const rawHit = raw.hits.find((h) => h.id === fear.id)
assert.ok(rawHit, 'raw 模式应命中显著记忆')
assert.equal(rawHit.content, '用户曾因未备份丢失整周工作，极度懊悔', 'raw 返回原文')

// 9. layers 过滤列出 salient
const salientOnly = await recall.execute({ layers: ['salient'] })
const salientHit = salientOnly.hits.find((h) => h.id === fear.id)
assert.ok(salientHit, 'salient 过滤应命中')
assert.match(salientHit.salient.reaction, /⚠️/, '负效价应带警示标注')

// 10. 无 query 无 layers → invalid_args
const unconditional = await recall.execute({})
assert.equal(unconditional.code, 'invalid_args')

// 11. recall 呈现层截断：伪造一条低 strength 的 archive 记忆
const now = Date.now()
await table.put('smm_fake_archive', {
  id: 'smm_fake_archive', kind: 'experience',
  content: '这是一条很久以前的漫长记录，应该只呈现开头的印象梗概而截断后半部分内容',
  layer: 'archive', tags: [], keywords: [], importance: 0.3, strength: 0.2,
  valence: null, arousal: null, accessCount: 0, lastAccessAt: now, createdAt: now - 90 * 86_400_000,
  updatedAt: now, rewriteCount: 0, edges: [], supersededBy: null, gist: null,
})
const agedRecall = await recall.execute({ query: '很久以前的漫长记录' })
const agedHit = agedRecall.hits.find((h) => h.id === 'smm_fake_archive')
assert.ok(agedHit, 'archive 记忆应可召回')
assert.ok(agedHit.content.endsWith('……'), '低强度 archive 记忆呈现应截断')
assert.equal(agedHit.drift.applied, true, 'archive 呈现应标记 drift')
assert.ok(agedHit.drift.fadedness > 0, 'fadedness 应大于 0')
// 铁律：呈现截断不改底层原文
assert.ok(table.get('smm_fake_archive').content.endsWith('截断后半部分内容'), '底层原文不被改写')

// 12. 坏配置 fail loud
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { recallBudget: 'many' }), /recallBudget/, '坏配置应在加载期抛出')

// 13. presentCall 形状
assert.deepEqual(write.presentCall({ layer: 'salient' }), { card: 'generic', title: '记忆写入 · salient', kind: 'other' })
assert.deepEqual(recall.presentCall({ query: '偏好' }), { card: 'generic', title: '记忆检索 · 偏好', kind: 'read' })

// ---- M2 睡眠整理 -----------------------------------------------------------

const DAY = 86_400_000
/** 独立插件实例：隔离的表 + 注册表 + 事件捕获，实例间互不污染。services 以属性形式注入（对齐声明式注入），services.get 提供可选服务（configEditor 等经 ctx.get 读取）。 */
function makeInstance(config, tableOverride, services = {}) {
  const t = tableOverride ?? makeTable()
  const regs = []
  const fx = []
  const hs = new Map()
  const provided = new Map()
  apply({
    storageDomain: {
      open: async (spec) => {
        if (spec.name === 'memory_runtime') {
          const runtimeTable = makeTable()
          recordParsers.set(runtimeTable, spec.tables.records.valueSchema)
          return { table: () => runtimeTable, close: async () => {} }
        }
        recordParsers.set(t, spec.tables.records.valueSchema)
        return ({
        table: (name) => {
          if (name !== 'records') throw new Error(`declares no table '${name}'`)
          return t
        },
        })
      },
    },
    tools: { register: (def) => { regs.push(def) } },
    effect: (fn) => { fx.push(fn) },
    on: (event, handler) => { hs.set(event, handler) },
    llm: services.llm,
    get: services.get ?? (() => undefined),
    reflect: { provide: (key, value) => { provided.set(key, value) } },
  }, config)
  const find = (name) => regs.find((tool) => tool.name === name)
  return { table: t, effects: fx, handlers: hs, provided, write: find('memory_write'), recall: find('memory_recall'), sleep: find('memory_sleep'), manage: find('memory_manage') }
}

/** 造一条字段完整的记忆记录（形状对齐 memory_write 的持久格式），overrides 覆盖任意字段。 */
function fixture(id, overrides = {}) {
  const nowMs = Date.now()
  return {
    id, kind: 'fact', content: id, layer: 'surface', tags: [], keywords: [],
    importance: 0.3, strength: 0.6, valence: null, arousal: null, accessCount: 0,
    lastAccessAt: nowMs, createdAt: nowMs, updatedAt: nowMs, rewriteCount: 0,
    edges: [], supersededBy: null, gist: null, ...overrides,
  }
}

// 14. M2 配置 fail loud
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { sleepIntervalMinutes: -1 }), /sleepIntervalMinutes/, '定时分钟数越界应抛出')
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { decayHalfLifeDays: 0 }), /decayHalfLifeDays/, '半衰期越界应抛出')

// 15. 一次完整睡眠周期：衰减 + salient 豁免 + NREM 沉淀 + 单例归档 + REM 联想边
const A = makeInstance({})
const T = Date.now()
await A.table.put('smm_c1', fixture('smm_c1', {
  content: '项目使用 pnpm 管理依赖，workspace 协议链接本地包。',
  strength: 0.3, lastAccessAt: T - 14 * DAY, createdAt: T - 30 * DAY,
}))
await A.table.put('smm_c2', fixture('smm_c2', {
  content: '项目使用 pnpm 管理 workspace 依赖，本地包以 workspace 协议链接。',
  strength: 0.25, lastAccessAt: T - 14 * DAY, createdAt: T - 28 * DAY,
}))
await A.table.put('smm_c3', fixture('smm_c3', {
  content: '完全无关的话题：企鹅生活在南半球。', strength: 0.2, lastAccessAt: T - 14 * DAY,
}))
await A.table.put('smm_s1', fixture('smm_s1', {
  layer: 'salient', kind: 'experience', content: '第一次发布产品时的巨大喜悦。',
  strength: 0.95, valence: 0.9, arousal: 0.8, lastAccessAt: T - 14 * DAY,
}))
await A.table.put('smm_d1', fixture('smm_d1', {
  content: '深夜写代码的效率更高，安静环境帮助专注。', strength: 0.9,
}))
await A.table.put('smm_d2', fixture('smm_d2', {
  content: '深夜写代码效率更高，安静的环境有助于专注。', strength: 0.85,
}))
const reportA = await A.sleep.execute({})
assert.equal(reportA.code, undefined, '睡眠应成功执行')
assert.equal(reportA.dryRun, false)
assert.equal(reportA.consolidatedCount, 1, 'c1/c2 应沉淀为一簇')
assert.ok(reportA.consolidated[0].members.includes('smm_c1') && reportA.consolidated[0].members.includes('smm_c2'))
assert.equal(reportA.archivedCount, 1, 'c3 无同伴应归档')
assert.equal(reportA.archived[0].id, 'smm_c3')
assert.ok(reportA.decayedCount >= 3, 'c1/c2/c3 应计入衰减')
assert.equal(reportA.edgesAdded, 1, 'd1/d2 应生成一对联想边')
// salient 豁免：强度分毫不动
assert.equal(A.table.get('smm_s1').strength, 0.95, 'salient 不衰减')
// 沉淀产物：成员被取代 + 生成梗概 + 强度衰减
const c1 = A.table.get('smm_c1')
assert.ok(c1.supersededBy?.startsWith('smm_'), 'c1 应标记 supersededBy')
assert.ok(c1.gist, '被取代成员应生成梗概')
assert.ok(c1.strength < 0.3 && c1.strength > 0.1, 'c1 强度应衰减')
const deepId = c1.supersededBy
const deep = A.table.get(deepId)
assert.equal(deep.layer, 'deep')
assert.equal(deep.kind, 'fact')
assert.ok(deep.content.startsWith('【沉淀】'), 'deep 概要以沉淀标记开头')
assert.ok(deep.content.includes('pnpm'), 'deep 概要列出成员要点')
assert.equal(deep.edges.length, 2, 'deep 到每个成员一条 consolidates 边')
assert.ok(deep.edges.every((edge) => edge.relation === 'consolidates'))
// c3 归档 + gist；铁律：原文永不改写
const c3 = A.table.get('smm_c3')
assert.equal(c3.layer, 'archive')
assert.ok(c3.gist?.includes('企鹅'), '归档生成梗概')
assert.ok(c3.content.includes('企鹅生活在南半球'), '归档不改写原文')
assert.equal(c3.supersededBy, null)
assert.equal(A.table.size, 7, '新增一条 deep 记录')
assert.equal(reportA.recordsAfter, 7)
assert.equal(reportA.capacityLimited, false)
// REM 双向边
const d1 = A.table.get('smm_d1')
const d2 = A.table.get('smm_d2')
assert.ok(d1.edges.some((edge) => edge.target === 'smm_d2' && edge.relation === 'dream-associate'))
assert.ok(d2.edges.some((edge) => edge.target === 'smm_d1' && edge.relation === 'dream-associate'), '联想边应双向')

// 16. 沉淀后召回：被取代的表层记忆退场，deep 概要接棒且带关联数
const afterSleep = await A.recall.execute({ query: 'pnpm 依赖管理' })
assert.ok(!afterSleep.hits.some((hit) => hit.id === 'smm_c1' || hit.id === 'smm_c2'), 'superseded 记录默认不再召回')
const deepHit = afterSleep.hits.find((hit) => hit.id === deepId)
assert.ok(deepHit, 'deep 概要应可召回')
assert.equal(deepHit.layer, 'deep')
assert.ok(deepHit.linkedMemories >= 2, 'deep 呈现带关联记忆数')

// 17. 彻底遗忘：强度下限 + 闲置天数双守卫，删除逐条入报告
const B = makeInstance({ decayHalfLifeDays: 100 })
await B.table.put('smm_old1', fixture('smm_old1', {
  layer: 'archive', content: '旧手机号码 13900000000 已停用。',
  strength: 0.1, lastAccessAt: T - 200 * DAY, createdAt: T - 300 * DAY,
}))
await B.table.put('smm_keep2', fixture('smm_keep2', {
  layer: 'archive', content: '护照办理需要提前预约排队。',
  strength: 0.9, importance: 0, lastAccessAt: T - 100 * DAY, createdAt: T - 200 * DAY,
}))
await B.table.put('smm_keep3', fixture('smm_keep3', {
  layer: 'archive', content: '健身房年卡还剩三个月有效期。',
  strength: 0.5, lastAccessAt: T - 50 * DAY, createdAt: T - 80 * DAY,
}))
const reportB = await B.sleep.execute({})
assert.equal(reportB.deletedCount, 1)
assert.equal(reportB.deleted[0].id, 'smm_old1')
assert.ok(reportB.deleted[0].idleDays > 199 && reportB.deleted[0].idleDays < 201, '报告列出闲置天数')
assert.ok(reportB.deleted[0].contentPreview.includes('13900000000'), '删除条目带内容预览')
assert.ok(B.table.get('smm_old1') === undefined, '过期归档被彻底删除')
assert.ok(B.table.get('smm_keep2') !== undefined, '强度未触底的归档不删（强度守卫）')
assert.ok(B.table.get('smm_keep3') !== undefined, '闲置不足的归档不删（天数守卫）')
assert.equal(B.table.size, 2)
assert.equal(reportB.edgesAdded, 0, '互不相似的记录不生成联想边')

// 18. dryRun：只算不写
const C = makeInstance({ decayHalfLifeDays: 100 })
await C.table.put('smm_old1', fixture('smm_old1', {
  layer: 'archive', content: '待删除的旧记录。', strength: 0.05, lastAccessAt: T - 200 * DAY,
}))
await C.table.put('smm_alive', fixture('smm_alive', { content: '仍然活跃的记忆。', strength: 0.9 }))
const reportC = await C.sleep.execute({ dryRun: true })
assert.equal(reportC.dryRun, true)
assert.equal(reportC.deletedCount, 1, 'dryRun 报告仍列出将要删除的条目')
assert.ok(C.table.get('smm_old1') !== undefined, 'dryRun 不删除')
assert.equal(C.table.get('smm_old1').strength, 0.05, 'dryRun 不落盘衰减')
assert.equal(C.table.size, 2, 'dryRun 不新增记录')

// 19. busy：单飞锁——进行中的睡眠拒绝并发调用
const hangTable = makeTable()
hangTable.update = async () => new Promise(() => {})
await hangTable.put('smm_hang1', fixture('smm_hang1', {
  content: '挂起用的记录。', strength: 0.5, lastAccessAt: T - 20 * DAY,
}))
const D = makeInstance({}, hangTable)
const slowSleep = D.sleep.execute({})
assert.equal((await D.sleep.execute({})).code, 'busy', '进行中再次睡眠应返回 busy')

// 20. 定时器：sleepIntervalMinutes > 0 挂可清理的 interval；0 不挂
const regsE = []
const fxE = []
apply({
  storageDomain: { open: async () => ({ table: () => makeTable(), close: async () => {} }) },
  tools: { register: (def) => { regsE.push(def) } },
  effect: (fn) => { fxE.push(fn) },
  on: () => {},
  get: () => undefined,
  reflect: { provide: () => {} },
}, { sleepIntervalMinutes: 1 })
assert.equal(regsE.length, 4)
assert.equal(fxE.length, 1, '域关闭与定时器统一清理')
await fxE[0]()() // 卸载后不得再启动异步调度
const fxF = []
apply({
  storageDomain: { open: async () => ({ table: () => makeTable(), close: async () => {} }) },
  tools: { register: () => {} },
  effect: (fn) => { fxF.push(fn) },
  on: () => {},
  get: () => undefined,
  reflect: { provide: () => {} },
}, { sleepIntervalMinutes: 0 })
assert.equal(fxF.length, 1, '定时关闭时不挂 interval')

// 21. memory_sleep 呈现与 schema 形状
assert.deepEqual(sleep.presentCall({}), { card: 'generic', title: '睡眠整理', kind: 'other' })
assert.deepEqual(sleep.presentCall({ dryRun: true }), { card: 'generic', title: '睡眠整理 · 预演', kind: 'other' })
assert.ok(sleep.parameters.properties.dryRun, '参数声明 dryRun')
assert.ok(sleep.output.schema.oneOf, '输出为报告/错误二选一 schema')

// ---- M3 扩散激活召回 -------------------------------------------------------

// 22. 沿 dream-associate 边带出关联记忆：带 via、排在直接命中之后、不被强化
const M = makeInstance({})
const T3 = Date.now()
await M.table.put('smm_m1', fixture('smm_m1', {
  content: '猩红女巫的起源故事值得细读。', strength: 0.9,
  edges: [{ target: 'smm_m2', relation: 'dream-associate', weight: 0.8 }],
}))
await M.table.put('smm_m2', fixture('smm_m2', {
  content: '冰岛旅行预算清单要提前列好。', strength: 0.8,
  edges: [{ target: 'smm_m1', relation: 'dream-associate', weight: 0.8 }],
}))
const spreadR = await M.recall.execute({ query: '猩红女巫的起源' })
const m1Hit = spreadR.hits.find((hit) => hit.id === 'smm_m1')
const m2Hit = spreadR.hits.find((hit) => hit.id === 'smm_m2')
assert.ok(m1Hit && m2Hit, '直接命中 + 关联命中都应出现')
assert.equal(spreadR.hits.indexOf(m1Hit) < spreadR.hits.indexOf(m2Hit), true, '关联命中排在直接命中之后')
assert.equal(m1Hit.via, undefined, '直接命中不带 via')
assert.equal(m2Hit.via.from, 'smm_m1')
assert.equal(m2Hit.via.relation, 'dream-associate')
assert.equal(m2Hit.via.hops, 1)
assert.ok(m2Hit.score > 0, '关联命中带激活分数')
// 关联记忆不入强化：accessCount/strength 分毫不动
assert.equal(M.table.get('smm_m2').accessCount, 0, '关联命中不增加 accessCount')
assert.equal(M.table.get('smm_m2').strength, 0.8, '关联命中不增加 strength')
assert.equal(M.table.get('smm_m1').accessCount, 1, '直接命中照常强化')

// 23. 排除规则：superseded 邻居不扩散、已直接命中的邻居不重复带 via
const N = makeInstance({})
await N.table.put('smm_b1', fixture('smm_b1', {
  content: '番茄炒蛋要先炒蛋再放番茄。',
  edges: [
    { target: 'smm_b2', relation: 'dream-associate', weight: 0.8 },
    { target: 'smm_b3', relation: 'dream-associate', weight: 0.8 },
  ],
}))
await N.table.put('smm_b2', fixture('smm_b2', {
  content: '无关的锚点记录一。', supersededBy: 'smm_b2x',
}))
await N.table.put('smm_b3', fixture('smm_b3', { content: '番茄品种选择影响口感。' }))
const excludeR = await N.recall.execute({ query: '番茄' })
const b3Hits = excludeR.hits.filter((hit) => hit.id === 'smm_b3')
assert.equal(b3Hits.length, 1, '直接命中的邻居只出现一次')
assert.equal(b3Hits[0].via, undefined, '直接命中优先，不带 via')
assert.ok(!excludeR.hits.some((hit) => hit.id === 'smm_b2'), 'superseded 邻居不扩散')

// 24. spreadDepth: 0 关闭扩散
const O = makeInstance({ spreadDepth: 0 })
await O.table.put('smm_o1', fixture('smm_o1', {
  content: '猩红女巫的起源故事值得细读。',
  edges: [{ target: 'smm_o2', relation: 'dream-associate', weight: 0.8 }],
}))
await O.table.put('smm_o2', fixture('smm_o2', { content: '冰岛旅行预算清单要提前列好。' }))
const offR = await O.recall.execute({ query: '猩红女巫的起源' })
assert.ok(offR.hits.some((hit) => hit.id === 'smm_o1'), '直接命中不受影响')
assert.ok(!offR.hits.some((hit) => hit.id === 'smm_o2'), 'spreadDepth 0 关闭扩散')

// 25. spreadMaxNeighbors 截断关联命中数量
const P = makeInstance({ spreadMaxNeighbors: 2 })
await P.table.put('smm_p1', fixture('smm_p1', {
  content: '猩红女巫的起源故事值得细读。',
  edges: ['smm_p2', 'smm_p3', 'smm_p4'].map((target) => ({ target, relation: 'dream-associate', weight: 0.8 })),
}))
for (const id of ['smm_p2', 'smm_p3', 'smm_p4']) {
  await P.table.put(id, fixture(id, { content: `冰岛旅行备忘 ${id}。`, strength: 0.8 }))
}
const capR = await P.recall.execute({ query: '猩红女巫的起源' })
assert.equal(capR.hits.filter((hit) => hit.via !== undefined).length, 2, '关联命中数受 spreadMaxNeighbors 截断')

// 26. 两跳扩散：d3 经 d2 到达，via.hops=2 且 from 为上一跳（低阈值避免小分数被截）
// 注意：q2/q3 内容必须与查询无共享 token（如「的」），否则会被 BM25 直接命中并
// 被 directIds 排除出扩散，测不到第二跳。
const Q = makeInstance({ spreadDepth: 2, spreadMinActivation: 0.01 })
await Q.table.put('smm_q1', fixture('smm_q1', {
  content: '猩红女巫的起源故事值得细读。', strength: 0.9,
  edges: [{ target: 'smm_q2', relation: 'dream-associate', weight: 1 }],
}))
await Q.table.put('smm_q2', fixture('smm_q2', {
  content: '深呼吸练习能缓解焦虑。', strength: 0.9,
  edges: [{ target: 'smm_q3', relation: 'dream-associate', weight: 1 }],
}))
await Q.table.put('smm_q3', fixture('smm_q3', { content: '定期整理桌面提高效率。', strength: 0.9 }))
const twoHopR = await Q.recall.execute({ query: '猩红女巫的起源' })
const q2Hit = twoHopR.hits.find((hit) => hit.id === 'smm_q2')
const q3Hit = twoHopR.hits.find((hit) => hit.id === 'smm_q3')
assert.ok(q2Hit?.via && q3Hit?.via, '两跳链应全部激活')
assert.equal(q2Hit.via.hops, 1)
assert.equal(q3Hit.via.hops, 2, '第二跳标记 hops=2')
assert.equal(q3Hit.via.from, 'smm_q2', 'via.from 指向上一跳')
assert.ok(twoHopR.hits.indexOf(q2Hit) < twoHopR.hits.indexOf(q3Hit), '激活分数随跳数衰减排序')

// 27. 反向边扩散 + layerFilter 过滤邻居
const R = makeInstance({ spreadDepth: 2, spreadMinActivation: 0.01 })
await R.table.put('smm_r1', fixture('smm_r1', { content: '猩红女巫的起源故事值得细读。', strength: 0.9 }))
await R.table.put('smm_r2', fixture('smm_r2', {
  content: '反向邻居记录。', strength: 0.9,
  edges: [{ target: 'smm_r1', relation: 'dream-associate', weight: 0.9 }],
}))
await R.table.put('smm_r3', fixture('smm_r3', {
  layer: 'salient', content: 'salient 邻居记录。', strength: 0.9,
  edges: [{ target: 'smm_r1', relation: 'dream-associate', weight: 0.9 }],
}))
const backR = await R.recall.execute({ query: '猩红女巫的起源' })
assert.ok(backR.hits.some((hit) => hit.id === 'smm_r2' && hit.via?.hops === 1), '入边应反向传播激活')
assert.ok(backR.hits.some((hit) => hit.id === 'smm_r3'), '无过滤时 salient 邻居可出现')
const filteredR = await R.recall.execute({ query: '猩红女巫的起源', layers: ['surface'] })
assert.ok(!filteredR.hits.some((hit) => hit.id === 'smm_r3'), 'layerFilter 同样约束扩散邻居')
assert.ok(filteredR.hits.some((hit) => hit.id === 'smm_r2'), '过滤不影响符合条件的邻居')

// 28. spread 配置越界 fail loud
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { spreadDepth: 4 }), /spreadDepth/, '扩散深度越界应抛出')
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { spreadDecay: 0.05 }), /spreadDecay/, '扩散衰减越界应抛出')
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { spreadMaxNeighbors: 30 }), /spreadMaxNeighbors/, '扩散上限越界应抛出')
assert.throws(() => apply({ storageDomain: ctx.storageDomain, tools: ctx.tools, effect: () => {} }, { spreadMinActivation: 2 }), /spreadMinActivation/, '激活阈值越界应抛出')

// ---- M4 双分支：自动注入 + 显著情绪评分 -------------------------------------

/** 模拟一条用户消息（鸭子形状，对齐 UserMessage 的插件可见子集）。 */
function userMessage(id, text, source) {
  return source === undefined
    ? { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    : { id, role: 'user', content: [{ type: 'text', text }], source }
}

/** 触发捕获的 pre-step handler：next() 返回给定 decision，返回 handler 的返回值。 */
function firePreStep(handlersMap, payload, decision) {
  const handler = handlersMap.get('agent/pre-step')
  assert.ok(handler, 'pre-step handler 应已注册')
  return handler(payload, async () => decision)
}

/** 等待 fire-and-forget 的异步评分全部落定（微任务链在宏任务 tick 内清空）。 */
const flushAsync = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** 构造返回固定 JSON 评分的 mock llm，每次调用记入 calls。仿真实适配器：content 只接受 block 数组。 */
function affectLlm(scoreJson, calls) {
  return {
    prepareCall: async () => ({
      config: {},
      stream: async function* (request) {
        // 仿 pi-ai 适配器 content.some 调用：字符串 content 在此抛 TypeError，暴露消息构造错误
        for (const message of request.messages) {
          message.content.some(() => true)
          if (message.role === 'system') {
            for (const block of message.content) {
              if (block.type !== 'text') throw new TypeError('system 消息只允许 text block')
            }
          }
        }
        calls.push(scoreJson)
        yield { type: 'text-delta', text: scoreJson }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

/** 构造返回固定扩展词文本的 mock llm（M8 语义扩展召回）。mode 控制流行为：'text' 正常输出；'hang' 挂起直到 signal 中止；'length' 以非 stop 提前结束。lastSignal 记录最近一次 prepareCall 收到的中止信号。 */
function expansionLlm(termsText, calls, mode = 'text') {
  /** @type {{lastSignal: AbortSignal|undefined}} */
  const state = { lastSignal: undefined }
  return {
    get lastSignal() { return state.lastSignal },
    /** @param {AbortSignal|undefined} signal */
    prepareCall: async (_route, signal) => {
      state.lastSignal = signal
      return {
        config: {},
        stream: async function* (request) {
          // 仿 pi-ai 适配器 content.some 调用：字符串 content 在此抛 TypeError，暴露消息构造错误
          for (const message of request.messages) {
            message.content.some(() => true)
            if (message.role === 'system') {
              for (const block of message.content) {
                if (block.type !== 'text') throw new TypeError('system 消息只允许 text block')
              }
            }
          }
          calls.push(request.messages[1].content[0].text)
          if (mode === 'hang') {
            // 模拟只认中止信号的适配器。实现的超时定时器 unref，带不动顶层 await 下的空事件循环，
            // 需要 ref 保活句柄把循环带到 abort（或兜底失败）时刻。
            await new Promise((_, reject) => {
              const keepAlive = setTimeout(() => reject(new Error('smoke: 扩展流未被中止')), 5_000)
              request.signal?.addEventListener('abort', () => {
                clearTimeout(keepAlive)
                reject(new Error('smoke: 扩展流被中止'))
              })
            })
          }
          if (mode === 'length') {
            yield { type: 'finish', reason: { kind: 'length' } }
            return
          }
          yield { type: 'text-delta', text: termsText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

// 30. 注入：消息插在最后一条 claimed 消息之后，source.kind 标记，原 decision 不被改动
const IN = makeInstance({})
assert.equal(IN.handlers.has('agent/pre-step'), true, '默认配置应注册 pre-step 监听')
await IN.table.put('smm_inj1', fixture('smm_inj1', { content: '用户偏好深色主题，讨厌动画闪烁。', strength: 0.9 }))
const user1 = userMessage('u1', '用户喜欢什么主题？')
const decision1 = { kind: 'enter', messages: [userMessage('sys', 'system 开场'), user1] }
const result1 = await firePreStep(IN.handlers, { messages: [user1], step: 1, signal: { aborted: false }, modelSelection: { provider: 'p', model: 'm' } }, decision1)
assert.notEqual(result1, decision1, '注入后应返回新 decision')
assert.equal(decision1.messages.length, 2, '原 decision 的 messages 不被原地修改')
assert.equal(result1.messages.length, 3, '注入后多一条消息')
const injected1 = result1.messages[2]
assert.equal(injected1.source?.kind, 'sleep-memory', '注入消息带 sleep-memory source 标记')
assert.equal(injected1.role, 'user', '注入消息以 user 角色出现')
assert.ok(injected1.content[0].text.includes('记忆库自动唤起'), '注入文本带自动唤起标头')
assert.ok(injected1.content[0].text.includes('深色主题'), '注入文本含命中的记忆内容')
assert.ok(injected1.source.recalled.includes('smm_inj1'), 'recalled 列出注入的记忆 id')

// 30b. salient 注入双分支：激励行带 ✦[显著·激励]，警示行带 ⚠️[显著·警示]，标头带图例
const ISJ = makeInstance({})
await ISJ.table.put('smm_sj1', fixture('smm_sj1', {
  layer: 'salient', content: '选对深色主题让用户非常满意，是值得重复的选择。', strength: 0.9, valence: 0.8, arousal: 0.8,
}))
await ISJ.table.put('smm_sj2', fixture('smm_sj2', {
  layer: 'salient', content: '动画闪烁主题方案曾让用户愤怒并流失。', strength: 0.9, valence: -0.9, arousal: 0.7,
}))
const userJ = userMessage('uj', '主题选择')
const resultJ = await firePreStep(ISJ.handlers, { messages: [userJ], step: 1, signal: { aborted: false }, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [userJ] })
const textJ = resultJ.messages[1].content[0].text
assert.ok(textJ.includes('✦[显著·激励]'), '激励记忆带 ✦[显著·激励] 标签')
assert.ok(textJ.includes('⚠️[显著·警示]'), '警示记忆带 ⚠️[显著·警示] 标签')
assert.ok(textJ.includes('激励线索') && textJ.includes('警示线索'), '注入标头带图例说明')

// 31. 注入走扩散管线：直接命中被强化，关联命中带「由联想边带出」且不强化
const IM = makeInstance({})
await IM.table.put('smm_im1', fixture('smm_im1', {
  content: '猩红女巫的起源故事值得细读。', strength: 0.9,
  edges: [{ target: 'smm_im2', relation: 'dream-associate', weight: 0.8 }],
}))
await IM.table.put('smm_im2', fixture('smm_im2', { content: '冰岛旅行预算清单要提前列好。', strength: 0.8 }))
const user2 = userMessage('u2', '猩红女巫的起源')
const result2 = await firePreStep(IM.handlers, { messages: [user2], step: 1 }, { kind: 'enter', messages: [user2] })
const text2 = result2.messages[1].content[0].text
assert.ok(text2.includes('猩红女巫'), '直接命中入注入文本')
assert.ok(text2.includes('由联想边带出'), '关联命中带出处置标')
assert.ok(result2.messages[1].source.recalled.includes('smm_im2'), '关联 id 入 recalled')
assert.equal(IM.table.get('smm_im1').accessCount, 1, '注入召回的直接命中照常强化')
assert.equal(IM.table.get('smm_im2').accessCount, 0, '关联命中不被强化')

// 32. 守卫：reject / step!==1 / 空 messages / null decision 原样透传
const IO = makeInstance({})
const rejectDecision = { kind: 'reject' }
assert.equal(await firePreStep(IO.handlers, { messages: [userMessage('x1', '主题')], step: 1 }, rejectDecision), rejectDecision, 'reject 原样透传')
const msgX = userMessage('x2', '用户喜欢什么主题？')
const lateDecision = { kind: 'enter', messages: [msgX] }
assert.equal(await firePreStep(IO.handlers, { messages: [msgX], step: 2 }, lateDecision), lateDecision, 'step!==1 不注入')
const emptyDecision = { kind: 'enter', messages: [] }
assert.equal(await firePreStep(IO.handlers, { messages: [msgX], step: 1 }, emptyDecision), emptyDecision, '空 messages 不注入')
assert.equal(await firePreStep(IO.handlers, { messages: [msgX], step: 1 }, null), null, 'null decision 透传')

// 33. 幂等：已带 sleep-memory source 的 enter 不二次注入
const II = makeInstance({})
await II.table.put('smm_ii1', fixture('smm_ii1', { content: '用户偏好深色主题，讨厌动画闪烁。', strength: 0.9 }))
const msgI = userMessage('i1', '用户喜欢什么主题？')
const alreadyInjected = userMessage('inj', '[sleep-memory 记忆库自动唤起]', { kind: 'sleep-memory', recalled: [] })
const decisionI = { kind: 'enter', messages: [msgI, alreadyInjected] }
assert.equal(await firePreStep(II.handlers, { messages: [msgI], step: 1 }, decisionI), decisionI, '已有注入痕迹时原样返回')

// 34. 显著情绪评分：负向/正向显著写入 salient，弱情绪不写，同消息幂等，LLM 抛错静默，禁用不调
const isCalls = []
const IS = makeInstance({}, undefined, { llm: affectLlm('{"valence":-0.9,"arousal":0.8}', isCalls) })
const msgS1 = userMessage('s1', '我今天项目发布失败，整晚睡不着，懊悔极了')
await firePreStep(IS.handlers, { messages: [msgS1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgS1] })
await flushAsync()
const salientRows = [...IS.table.entries()].map(([, rec]) => rec).filter((rec) => rec.layer === 'salient')
assert.equal(salientRows.length, 1, '高唤醒负情绪应自动写入一条 salient')
assert.ok(salientRows[0].tags.includes('auto-salient'), '自动记忆带 auto-salient 标签')
assert.ok(Math.abs(salientRows[0].valence + 0.9) < 1e-9, '效价落库')
assert.ok(salientRows[0].content.includes('懊悔'), '内容引用用户消息')
assert.ok(salientRows[0].content.includes('警示线索'), '负效价前缀带警示线索极性词')
await firePreStep(IS.handlers, { messages: [msgS1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgS1] })
await flushAsync()
assert.equal([...IS.table.entries()].map(([, rec]) => rec).filter((rec) => rec.layer === 'salient').length, 1, '同一消息不重复写入')
const ispCalls = []
const ISP = makeInstance({}, undefined, { llm: affectLlm('{"valence":0.9,"arousal":0.7}', ispCalls) })
const msgSP = userMessage('sp1', '我拿到梦寐以求的 offer，高兴得跳了起来！')
await firePreStep(ISP.handlers, { messages: [msgSP], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgSP] })
await flushAsync()
const positiveRows = [...ISP.table.entries()].map(([, rec]) => rec).filter((rec) => rec.layer === 'salient')
assert.equal(positiveRows.length, 1, '积极显著情绪同样写入（approach 分支）')
assert.ok(positiveRows[0].valence > 0, '正效价落库')
assert.ok(positiveRows[0].content.includes('激励线索'), '正效价前缀带激励线索极性词')
const iswCalls = []
const ISW = makeInstance({}, undefined, { llm: affectLlm('{"valence":-0.1,"arousal":0.2}', iswCalls) })
const msgSW = userMessage('sw1', '随便聊聊今天的天气')
await firePreStep(ISW.handlers, { messages: [msgSW], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgSW] })
await flushAsync()
assert.equal([...ISW.table.entries()].map(([, rec]) => rec).filter((rec) => rec.layer === 'salient').length, 0, '弱情绪不写入')
const ISE = makeInstance({}, undefined, { llm: { prepareCall: async () => { throw new Error('provider down') } } })
const realError = console.error
console.error = () => {} // 静默预期的失败日志，保持 smoke 输出干净
try {
  const msgSE = userMessage('se1', '又是一条情绪强烈的消息')
  const resultE = await firePreStep(ISE.handlers, { messages: [msgSE], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgSE] })
  assert.ok(Array.isArray(resultE.messages), '评分失败不影响会话进行')
  await flushAsync()
  assert.equal(ISE.table.size, 0, 'LLM 抛错不写记录')
} finally {
  console.error = realError
}
const isdCalls = []
const ISD = makeInstance({ salientScoringEnabled: false }, undefined, { llm: affectLlm('{"valence":-0.9,"arousal":0.8}', isdCalls) })
const msgSD = userMessage('sd1', '这条消息情绪再强烈也不该评分')
await firePreStep(ISD.handlers, { messages: [msgSD], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgSD] })
await flushAsync()
assert.equal(isdCalls.length, 0, '禁用后 llm 不被调用')

// 35. llm 服务缺失/不完整/route 非法：静默跳过评分，不抛错不写记录
const I5 = makeInstance({})
const msg5 = userMessage('n1', '没有任何 llm 服务的环境')
const result5 = await firePreStep(I5.handlers, { messages: [msg5], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msg5] })
assert.ok(Array.isArray(result5.messages), '缺 llm 服务不抛错')
await flushAsync()
assert.equal(I5.table.size, 0, '缺 llm 服务不写记录')
const I5B = makeInstance({}, undefined, { llm: {} })
const msg5B = userMessage('n2', 'llm 服务缺少 prepareCall')
await firePreStep(I5B.handlers, { messages: [msg5B], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msg5B] })
await flushAsync()
assert.equal(I5B.table.size, 0, '不完整 llm 服务不写记录')
const i5cCalls = []
const I5C = makeInstance({}, undefined, { llm: affectLlm('{"valence":-0.9,"arousal":0.8}', i5cCalls) })
const msg5C = userMessage('n3', 'modelSelection 缺少字段')
await firePreStep(I5C.handlers, { messages: [msg5C], step: 1, modelSelection: { provider: 'p' } }, { kind: 'enter', messages: [msg5C] })
await flushAsync()
assert.equal(i5cCalls.length, 0, 'route 非法时不调用 llm')

// 36. injectMinScore 纯阈值：无达阈直接命中就不注入（没有 top-hit 兜底）
const I6 = makeInstance({ injectMinScore: 100 }) // 任何 BM25 分数都到不了 100
await I6.table.put('smm_i61', fixture('smm_i61', { content: '用户偏好深色主题，讨厌动画闪烁。', strength: 0.9 }))
const msg6 = userMessage('m6', '用户喜欢什么主题？')
const decision6 = { kind: 'enter', messages: [msg6] }
assert.equal(await firePreStep(I6.handlers, { messages: [msg6], step: 1 }, decision6), decision6, '无达阈命中时不注入')

// ---- M5 Web 卡片 -----------------------------------------------------------

// 37. memory_write 卡片：output.presentationMeta 产出持久 meta，presentResult 仅按 meta 派生视图
const cardW = { content: '卡片场景：偏好深色主题', kind: 'fact' }
const wOk = await write.execute(cardW)
const wMeta = write.output.presentationMeta(cardW, wOk)
assert.deepEqual(wMeta, { v: 1, tool: 'memory_write', ok: true, id: wOk.id, layer: 'surface', kind: 'fact' })
assert.deepEqual(
  write.presentResult(cardW, { content: [{ type: 'text', text: JSON.stringify(wOk) }], isError: false, meta: wMeta }),
  {
    card: 'generic',
    title: '记忆写入 · 表层',
    content: [{ type: 'text', text: `✅ 已写入表层记忆（fact）\nid: ${wOk.id}` }],
  },
  'write 成功卡按持久 meta 渲染',
)
// 调用卡带 rawInput 预览（60 字符截断）
assert.equal(write.presentCall({ content: '长'.repeat(80) }).rawInput, `${'长'.repeat(60)}……`, 'rawInput 按 60 字符截断')
// 错误路径：execute 的 ERROR 值经 meta 派生拒绝卡
const wErrMeta = write.output.presentationMeta(cardW, weak)
assert.equal(wErrMeta.tool, 'memory_write')
assert.equal(wErrMeta.ok, false)
assert.equal(wErrMeta.code, 'not_salient')
assert.deepEqual(
  write.presentResult(cardW, { isError: true, meta: wErrMeta }),
  {
    card: 'generic',
    title: '记忆写入被拒绝',
    content: [{ type: 'text', text: `❌ ${wErrMeta.message}（not_salient）` }],
  },
  'write 拒绝卡按 meta 渲染',
)

// 38. memory_recall 卡片：命中/联想/零命中三种投影，全部只读持久 meta
const rArgs = { query: '用户喜欢什么主题' }
const rOk = await recall.execute(rArgs)
const rIdx = rOk.hits.findIndex((h) => h.id === fact.id)
assert.ok(rIdx >= 0, '卡片场景应命中偏好记忆')
const rMeta = recall.output.presentationMeta(rArgs, rOk)
assert.equal(rMeta.tool, 'memory_recall')
assert.equal(rMeta.ok, true)
assert.equal(rMeta.query, '用户喜欢什么主题')
assert.equal(rMeta.fidelity, 'recall')
assert.equal(rMeta.count, rOk.count)
assert.equal(rMeta.hits[rIdx].layer, rOk.hits[rIdx].layer)
assert.equal(rMeta.hits[rIdx].drift, rOk.hits[rIdx].drift.applied, 'surface 命中 drift=false')
assert.equal(rMeta.hits[rIdx].score, Math.round(rOk.hits[rIdx].score * 100) / 100, '分数保留两位')
assert.equal(rMeta.hits[rIdx].preview, rOk.hits[rIdx].content, '短内容预览即原文')
const rView = recall.presentResult(rArgs, { isError: false, meta: rMeta })
assert.equal(rView.card, 'generic')
assert.equal(rView.title, `记忆检索 · ${rOk.count} 条命中`)
assert.equal(
  rView.content[0].text.split('\n')[0],
  `「用户喜欢什么主题」→ ${rOk.count} 条命中 / 候选 ${rMeta.totalCandidates}（fidelity: recall）`,
  '首行是查询摘要',
)
// 关联命中：via 标注 + 页脚统计
const viaArgs = { query: '猩红女巫的起源' }
const viaR = await M.recall.execute(viaArgs)
const viaMeta = M.recall.output.presentationMeta(viaArgs, viaR)
assert.ok(viaMeta.hits.some((h) => h.via === true), 'meta 保留 via 标记')
const viaLines = M.recall.presentResult(viaArgs, { isError: false, meta: viaMeta }).content[0].text.split('\n')
assert.ok(viaLines.some((line) => line.includes('（联想带出）')), '命中行带联想标注')
assert.equal(viaLines.at(-1), `其中 ${viaMeta.hits.filter((h) => h.via === true).length} 条由扩散激活联想带出`, '页脚统计联想条数')
// 零命中：空库 + 行动提示
const zI = makeInstance({})
const zArgs = { query: '完全不相关的虚空查询词汇' }
const zR = await zI.recall.execute(zArgs)
assert.equal(zR.count, 0, '空库零命中场景前置')
const zView = zI.recall.presentResult(zArgs, { isError: false, meta: zI.recall.output.presentationMeta(zArgs, zR) })
assert.equal(zView.title, '记忆检索 · 0 条命中')
assert.ok(zView.content[0].text.endsWith('没有找到相关记忆；可换一种说法，或放宽 layers 过滤后重试'), '零命中给行动提示')

// 39. memory_sleep 卡片：预演报告投影 + busy 错误形
const sArgs = { dryRun: true }
const sOk = await sleep.execute(sArgs)
const sMeta = sleep.output.presentationMeta(sArgs, sOk)
assert.equal(sMeta.tool, 'memory_sleep')
assert.equal(sMeta.ok, true)
assert.equal(sMeta.dryRun, true)
assert.equal(sMeta.recordsBefore, sOk.recordsBefore)
assert.deepEqual(
  sleep.presentResult(sArgs, { isError: false, meta: sMeta }),
  {
    card: 'generic',
    title: '睡眠整理 · 预演完成',
    content: [{
      type: 'text',
      text: [
        `记录 ${sOk.recordsBefore} → ${sOk.recordsAfter}`,
        `NREM 巩固 ${sMeta.consolidatedCount} · 归档 ${sMeta.archivedCount} · 衰减 ${sMeta.decayedCount} · 遗忘 ${sMeta.deletedCount} · REM 联想边 +${sMeta.edgesAdded}`,
        `容量上限${sMeta.capacityLimited ? '已触发' : '未触发'} · 预演未写入任何数据`,
      ].join('\n'),
    }],
  },
  'sleep 预演卡按 meta 渲染',
)
// busy：单例运行中 execute 返回 {code:'busy'}，这里以同形值驱动纯投影
const busyMeta = sleep.output.presentationMeta(sArgs, { code: 'busy' })
assert.deepEqual(busyMeta, { v: 1, tool: 'memory_sleep', ok: false, code: 'busy', message: '未知错误' })
const busyView = sleep.presentResult(sArgs, { isError: true, meta: busyMeta })
assert.equal(busyView.title, '睡眠整理失败')
assert.deepEqual(busyView.content, [{ type: 'text', text: '❌ 未知错误（busy）' }])

// 40. 非 meta / 畸形 meta 一律回退裸 generic 卡（标题回落到调用卡）
const foreign = { v: 1, tool: 'workflow' }
assert.deepEqual(write.presentResult({}, { isError: false, meta: foreign }), { card: 'generic' })
assert.deepEqual(recall.presentResult({}, { isError: false, meta: foreign }), { card: 'generic' })
assert.deepEqual(sleep.presentResult({}, { isError: false, meta: foreign }), { card: 'generic' })
assert.deepEqual(recall.presentResult({}, { isError: false, meta: { tool: 'memory_recall', v: 99 } }), { card: 'generic' }, '版本不匹配同样回退')

// ---- M6 记忆管理 -----------------------------------------------------------

const T6 = Date.now()

// 41. stats：空表全零（无 oldest/newest），三条 fixture 后分层计数/级联计数/边数/最旧最新
const m6a = makeInstance({})
assert.deepEqual(await m6a.manage.execute({ action: 'stats' }), {
  action: 'stats', total: 0, maxRecords: 20000,
  byLayer: { surface: 0, deep: 0, archive: 0, salient: 0 },
  supersededCount: 0, edgeCount: 0,
})
await m6a.table.put('smm_m61', fixture('smm_m61', { createdAt: T6 - 3000, supersededBy: 'smm_m62' }))
await m6a.table.put('smm_m62', fixture('smm_m62', { createdAt: T6 - 2000, tags: ['睡眠'] }))
await m6a.table.put('smm_m63', fixture('smm_m63', { layer: 'salient', createdAt: T6 - 1000, edges: [{ target: 'smm_m61', relation: 'dream-associate', weight: 1 }] }))
assert.deepEqual(await m6a.manage.execute({ action: 'stats' }), {
  action: 'stats', total: 3, maxRecords: 20000,
  byLayer: { surface: 2, deep: 0, archive: 0, salient: 1 },
  supersededCount: 1, edgeCount: 1,
  oldest: { id: 'smm_m61', createdAt: T6 - 3000 },
  newest: { id: 'smm_m63', createdAt: T6 - 1000 },
})

// 42. list：createdAt 倒序、字段投影、layer/tag 过滤、limit/offset 分页与钳制、预览截断
const m6list = await m6a.manage.execute({ action: 'list' })
assert.equal(m6list.total, 3, 'total 为过滤后的全量条数')
assert.deepEqual(m6list.offset, 0)
assert.deepEqual(m6list.limit, 50, '默认 limit 取 manageListMaxItems')
assert.deepEqual(m6list.items.map((item) => item.id), ['smm_m63', 'smm_m62', 'smm_m61'], '按 createdAt 倒序')
assert.deepEqual(m6list.items[0], { id: 'smm_m63', layer: 'salient', kind: 'fact', createdAt: T6 - 1000, importance: 0.3, strength: 0.6, content: 'smm_m63' }, '无情绪则不带 valence/arousal')
assert.equal(m6list.items[2].supersededBy, 'smm_m62', '仅被 superseded 的条目带 supersededBy')
assert.deepEqual((await m6a.manage.execute({ action: 'list', layer: 'salient' })).items.map((item) => item.id), ['smm_m63'])
assert.deepEqual((await m6a.manage.execute({ action: 'list', tag: '睡眠' })).items.map((item) => item.id), ['smm_m62'])
assert.deepEqual(await m6a.manage.execute({ action: 'list', tag: '不存在' }), { action: 'list', total: 0, offset: 0, limit: 50, items: [] })
assert.deepEqual((await m6a.manage.execute({ action: 'list', limit: 2 })).items.map((item) => item.id), ['smm_m63', 'smm_m62'])
assert.deepEqual((await m6a.manage.execute({ action: 'list', offset: 1, limit: 2 })).items.map((item) => item.id), ['smm_m62', 'smm_m61'])
assert.deepEqual((await m6a.manage.execute({ action: 'list', offset: 99 })).items, [], 'offset 越界返回空页')
assert.equal((await m6a.manage.execute({ action: 'list', limit: 500 })).limit, 50, 'limit 钳到 manageListMaxItems')
await m6a.table.put('smm_m64', fixture('smm_m64', { content: '长'.repeat(200), createdAt: T6 }))
const m6long = await m6a.manage.execute({ action: 'list' })
assert.equal(m6long.total, 4, '新增长内容后 total 为 4')
assert.equal(m6long.items[0].id, 'smm_m64', '最新记录排最前')
assert.equal(m6long.items[0].content, `${'长'.repeat(120)}……`, '内容截到 manageListPreviewChars 并加省略号')

// 43. forget：级联删除被 superseded 链、剥离幸存记录的入边、cascade:false 仅删本条
const m6b = makeInstance({})
await m6b.table.put('smm_f1', fixture('smm_f1', { createdAt: T6 - 4000 }))
await m6b.table.put('smm_f2', fixture('smm_f2', { createdAt: T6 - 3000, supersededBy: 'smm_f1' }))
await m6b.table.put('smm_f3', fixture('smm_f3', { createdAt: T6 - 2000, updatedAt: T6 - 2000, edges: [{ target: 'smm_f1', relation: 'dream-associate', weight: 1 }, { target: 'smm_f2', relation: 'dream-associate', weight: 1 }] }))
await m6b.table.put('smm_f4', fixture('smm_f4', { createdAt: T6 - 1000, updatedAt: T6 - 2000, edges: [{ target: 'smm_f3', relation: 'dream-associate', weight: 1 }] }))
const f3Before = await m6b.table.get('smm_f3')
const forgotten = await m6b.manage.execute({ action: 'forget', id: 'smm_f1' })
assert.deepEqual(forgotten, { action: 'forget', id: 'smm_f1', layer: 'surface', cascadedCount: 1, edgesRemoved: 2, forgotten: ['smm_f1', 'smm_f2'] })
assert.equal(await m6b.table.get('smm_f1'), undefined, '目标已删除')
assert.equal(await m6b.table.get('smm_f2'), undefined, '被 superseded 者级联删除')
const f3After = await m6b.table.get('smm_f3')
assert.deepEqual(f3After.edges, [], '指向被删记录的入边已剥离')
assert.ok(f3After.updatedAt > f3Before.updatedAt, '剥离入边时刷新 updatedAt')
const f4After = await m6b.table.get('smm_f4')
assert.deepEqual(f4After.edges, [{ target: 'smm_f3', relation: 'dream-associate', weight: 1 }], '无关入边不动')
assert.equal(f4After.updatedAt, f3Before.updatedAt, '未受影响的记录不刷新')
await m6b.table.put('smm_g1', fixture('smm_g1', { createdAt: T6 - 500 }))
await m6b.table.put('smm_g2', fixture('smm_g2', { createdAt: T6 - 400, supersededBy: 'smm_g1' }))
const noCascade = await m6b.manage.execute({ action: 'forget', id: 'smm_g1', cascade: false })
assert.deepEqual(noCascade, { action: 'forget', id: 'smm_g1', layer: 'surface', cascadedCount: 0, edgesRemoved: 0, forgotten: ['smm_g1'] })
assert.equal((await m6b.table.get('smm_g2')).id, 'smm_g2', 'cascade:false 时被 superseded 者幸存')

// 44. 错误路径：未知 id → not_found；未知 action/未知参数/非法 layer → invalid_args
const m6missing = await m6b.manage.execute({ action: 'forget', id: 'smm_missing' })
assert.deepEqual(m6missing, { code: 'not_found', message: '未找到 id 为 smm_missing 的记忆。' })
for (const badArgs of [{ action: 'bogus' }, { action: 'list', nope: 1 }, { action: 'list', layer: 'nope' }]) {
  const bad = await m6b.manage.execute(badArgs)
  assert.equal(bad.code, 'invalid_args', `非法参数 ${JSON.stringify(badArgs)} 应被拒绝`)
  assert.match(bad.message, /^memory_manage 参数被拒绝：/)
}

// 45. list 卡：meta 投影（截 48 字符）、结果卡整页/半页/空表文案
const m6c = makeInstance({})
await m6c.table.put('smm_c1', fixture('smm_c1', { createdAt: T6 - 3000, supersededBy: 'smm_c3' }))
await m6c.table.put('smm_c2', fixture('smm_c2', { layer: 'salient', createdAt: T6 - 2000, edges: [{ target: 'smm_c1', relation: 'dream-associate', weight: 1 }] }))
await m6c.table.put('smm_c3', fixture('smm_c3', { createdAt: T6 - 1000 }))
const cList = await m6c.manage.execute({ action: 'list' })
const cMeta = m6c.manage.output.presentationMeta({ action: 'list' }, cList)
assert.deepEqual(cMeta, {
  v: 1, tool: 'memory_manage', ok: true, action: 'list',
  total: 3, offset: 0, limit: 50,
  items: [
    { id: 'smm_c3', layer: 'surface', importance: 0.3, content: 'smm_c3' },
    { id: 'smm_c2', layer: 'salient', importance: 0.3, content: 'smm_c2' },
    { id: 'smm_c1', layer: 'surface', importance: 0.3, content: 'smm_c1' },
  ],
}, 'list meta 只保留 id/layer/importance/content')
assert.deepEqual(m6c.manage.presentResult({ action: 'list' }, { isError: false, meta: cMeta }), {
  card: 'generic', kind: 'read', title: '记忆管理 · 列表',
  content: [{
    type: 'text',
    text: '[表层] smm_c3 · 重要度 +0.30\nsmm_c3\n[显著] smm_c2 · 重要度 +0.30\nsmm_c2\n[表层] smm_c1 · 重要度 +0.30\nsmm_c1\n共 3 条',
  }],
})
const cPartialMeta = m6c.manage.output.presentationMeta({ action: 'list' }, {
  action: 'list', total: 5, offset: 0, limit: 2,
  items: [
    { id: 'smm_c3', layer: 'surface', importance: 0.3, content: 'smm_c3' },
    { id: 'smm_c2', layer: 'salient', importance: 0.3, content: 'smm_c2' },
  ],
})
assert.ok(
  m6c.manage.presentResult({ action: 'list' }, { isError: false, meta: cPartialMeta }).content[0].text.endsWith('… 共 5 条，仅显示前 2 条'),
  '半页时提示剩余条数',
)
const cEmptyMeta = m6c.manage.output.presentationMeta({ action: 'list' }, { action: 'list', total: 0, offset: 0, limit: 50, items: [] })
assert.ok(
  m6c.manage.presentResult({ action: 'list' }, { isError: false, meta: cEmptyMeta }).content[0].text.endsWith('共 0 条'),
  '空列表显示 共 0 条',
)

// 46. forget 卡：meta 的 forgottenCount = cascadedCount + 1，文案列出全部删除 id；错误卡走失败标题
const gMeta = m6b.manage.output.presentationMeta({ action: 'forget', id: 'smm_g1' }, {
  action: 'forget', id: 'smm_g1', layer: 'surface', cascadedCount: 1, edgesRemoved: 0, forgotten: ['smm_g1', 'smm_g2'],
})
assert.deepEqual(gMeta, {
  v: 1, tool: 'memory_manage', ok: true, action: 'forget',
  id: 'smm_g1', layer: 'surface', forgottenCount: 2, forgotten: ['smm_g1', 'smm_g2'],
})
assert.deepEqual(m6b.manage.presentResult({ action: 'forget', id: 'smm_g1' }, { isError: false, meta: gMeta }), {
  card: 'generic', kind: 'other', title: '记忆管理 · 遗忘',
  content: [{ type: 'text', text: '已删除 2 条（含级联）：smm_g1、smm_g2' }],
})
const gErrMeta = m6b.manage.output.presentationMeta({ action: 'forget', id: 'smm_missing' }, m6missing)
assert.deepEqual(m6b.manage.presentResult({ action: 'forget', id: 'smm_missing' }, { isError: true, meta: gErrMeta }), {
  card: 'generic', title: '记忆管理失败',
  content: [{ type: 'text', text: '❌ 未找到 id 为 smm_missing 的记忆。（not_found）' }],
})

// 47. stats 卡：meta 的 byLayer 只留非零层，概况文案含总量/上限/superseded/边数与分层行；presentCall 标题
const cStats = await m6c.manage.execute({ action: 'stats' })
const cStatsMeta = m6c.manage.output.presentationMeta({ action: 'stats' }, cStats)
assert.deepEqual(cStatsMeta, {
  v: 1, tool: 'memory_manage', ok: true, action: 'stats',
  total: 3, maxRecords: 20000,
  byLayer: { surface: 2, salient: 1 },
  supersededCount: 1, edgeCount: 1,
}, 'stats meta 略去零计数层与 oldest/newest')
assert.deepEqual(m6c.manage.presentResult({ action: 'stats' }, { isError: false, meta: cStatsMeta }), {
  card: 'generic', kind: 'read', title: '记忆管理 · 概况',
  content: [{ type: 'text', text: '总记录 3/20000 · 被 superseded 1 · 关联边 1\n表层: 2\n显著: 1' }],
})
assert.deepEqual(m6c.manage.presentCall({ action: 'list' }), { card: 'generic', title: '记忆管理 · 列表', kind: 'read' })
assert.deepEqual(m6c.manage.presentCall({ action: 'forget', id: 'smm_c1' }), { card: 'generic', title: '记忆管理 · 遗忘', kind: 'other' })
assert.deepEqual(m6c.manage.presentCall({ action: 'stats' }), { card: 'generic', title: '记忆管理 · 概况', kind: 'read' })
assert.deepEqual(m6c.manage.presentCall({ action: 'nope' }), { card: 'generic', title: '记忆管理', kind: 'read' }, '未知 action 回落无后缀标题')

// 48. 非 meta / 畸形 meta 同样对 memory_manage 回退裸 generic 卡
assert.deepEqual(m6c.manage.presentResult({}, { isError: false, meta: foreign }), { card: 'generic' })
assert.deepEqual(m6c.manage.presentResult({}, { isError: false, meta: { tool: 'memory_manage', v: 99 } }), { card: 'generic' }, '版本不匹配同样回退')

// ---- M8 语义扩展召回 --------------------------------------------------------

// 49. 启用语义扩展：扩展词专属记忆被混合召回进注入文本；关闭时同一组数据不出现它
const siaCalls = []
const SIA = makeInstance({ semanticRecallEnabled: true, salientScoringEnabled: false }, undefined, { llm: expansionLlm('海神', siaCalls) })
await SIA.table.put('smm_sia1', fixture('smm_sia1', { content: '波塞冬号邮轮的航线覆盖地中海。', strength: 0.9 }))
await SIA.table.put('smm_sia2', fixture('smm_sia2', { content: '海神的三叉戟是标志性道具。', strength: 0.9 }))
const msgA1 = userMessage('ma1', '波塞冬号的航线')
const resultA1 = await firePreStep(SIA.handlers, { messages: [msgA1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgA1] })
assert.equal(siaCalls.length, 1, '启用后每轮注入恰好发起一次扩展调用')
assert.ok(siaCalls[0].includes('波塞冬号'), '扩展调用携带用户查询')
const recalledA1 = resultA1.messages.at(-1).source.recalled
assert.ok(recalledA1.includes('smm_sia1'), '原词直接命中照常召回')
assert.ok(recalledA1.includes('smm_sia2'), '扩展词专属记忆被混合召回')
assert.ok(resultA1.messages.at(-1).content[0].text.includes('三叉戟'), '扩展命中的内容进入注入文本')
const SIAOFF = makeInstance({ salientScoringEnabled: false })
await SIAOFF.table.put('smm_sia1', fixture('smm_sia1', { content: '波塞冬号邮轮的航线覆盖地中海。', strength: 0.9 }))
await SIAOFF.table.put('smm_sia2', fixture('smm_sia2', { content: '海神的三叉戟是标志性道具。', strength: 0.9 }))
const msgA2 = userMessage('ma2', '波塞冬号的航线')
const resultA2 = await firePreStep(SIAOFF.handlers, { messages: [msgA2], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgA2] })
assert.ok(resultA2.messages.at(-1).source.recalled.includes('smm_sia1'), '关闭时原词命中不受影响')
assert.ok(!resultA2.messages.at(-1).source.recalled.includes('smm_sia2'), '关闭时扩展词专属记忆不出现')

// 50. 扩展超时：挂起的流在 semanticRecallTimeoutMs 后被中止，静默退化为纯 BM25，注入照常发生
const sibCalls = []
const sibLlm = expansionLlm('海神', sibCalls, 'hang')
const SIB = makeInstance({ semanticRecallEnabled: true, semanticRecallTimeoutMs: 500, salientScoringEnabled: false }, undefined, { llm: sibLlm })
await SIB.table.put('smm_sib1', fixture('smm_sib1', { content: '波塞冬号邮轮的航线覆盖地中海。', strength: 0.9 }))
await SIB.table.put('smm_sib2', fixture('smm_sib2', { content: '海神的三叉戟是标志性道具。', strength: 0.9 }))
const realErrorB = console.error
console.error = () => {} // 静默预期的超时失败日志，保持 smoke 输出干净
try {
  const msgB1 = userMessage('mb1', '波塞冬号的航线')
  const resultB1 = await firePreStep(SIB.handlers, { messages: [msgB1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgB1] })
  assert.equal(sibCalls.length, 1, '超时前扩展调用已发起')
  assert.equal(sibLlm.lastSignal?.aborted, true, '超时路径确实中止了扩展调用')
  const recalledB1 = resultB1.messages.at(-1).source.recalled
  assert.ok(recalledB1.includes('smm_sib1'), '超时后退化为纯 BM25，直接命中照常注入')
  assert.ok(!recalledB1.includes('smm_sib2'), '超时后扩展词专属记忆不出现')
} finally {
  console.error = realErrorB
}

// 51. 扩展非正常结束：finish reason 非 stop 时丢弃输出，退化为纯 BM25
const sicCalls = []
const SIC = makeInstance({ semanticRecallEnabled: true, salientScoringEnabled: false }, undefined, { llm: expansionLlm('海神', sicCalls, 'length') })
await SIC.table.put('smm_sic1', fixture('smm_sic1', { content: '波塞冬号邮轮的航线覆盖地中海。', strength: 0.9 }))
await SIC.table.put('smm_sic2', fixture('smm_sic2', { content: '海神的三叉戟是标志性道具。', strength: 0.9 }))
const msgC1 = userMessage('mc1', '波塞冬号的航线')
const resultC1 = await firePreStep(SIC.handlers, { messages: [msgC1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgC1] })
assert.equal(sicCalls.length, 1, '非 stop 结束仍发起过扩展调用')
const recalledC1 = resultC1.messages.at(-1).source.recalled
assert.ok(recalledC1.includes('smm_sic1'), '非 stop 时退化为纯 BM25，直接命中照常注入')
assert.ok(!recalledC1.includes('smm_sic2'), '非 stop 的扩展词不参与召回')

// 52. 默认关闭不调用 llm；启用但 route 非法（缺 modelSelection）同样静默跳过扩展
const sidCalls = []
const SID = makeInstance({ salientScoringEnabled: false }, undefined, { llm: expansionLlm('海神', sidCalls) })
await SID.table.put('smm_sid1', fixture('smm_sid1', { content: '波塞冬号邮轮的航线覆盖地中海。', strength: 0.9 }))
await SID.table.put('smm_sid2', fixture('smm_sid2', { content: '海神的三叉戟是标志性道具。', strength: 0.9 }))
const msgD1 = userMessage('md1', '波塞冬号的航线')
const resultD1 = await firePreStep(SID.handlers, { messages: [msgD1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgD1] })
assert.equal(sidCalls.length, 0, '默认关闭时扩展调用不发起')
assert.ok(resultD1.messages.at(-1).source.recalled.includes('smm_sid1'), '关闭时行为与纯 BM25 一致')
assert.ok(!resultD1.messages.at(-1).source.recalled.includes('smm_sid2'), '关闭时扩展词专属记忆不出现')
const sieCalls = []
const SIE = makeInstance({ semanticRecallEnabled: true, salientScoringEnabled: false }, undefined, { llm: expansionLlm('海神', sieCalls) })
await SIE.table.put('smm_sie1', fixture('smm_sie1', { content: '波塞冬号邮轮的航线覆盖地中海。', strength: 0.9 }))
const msgE1 = userMessage('me1', '波塞冬号的航线')
const resultE1 = await firePreStep(SIE.handlers, { messages: [msgE1], step: 1 }, { kind: 'enter', messages: [msgE1] })
assert.equal(sieCalls.length, 0, 'route 非法时不发起调用')
assert.ok(resultE1.messages.at(-1).source.recalled.includes('smm_sie1'), 'route 非法时退化为纯 BM25')

// 53. 扩展词解析：编号/项目符号剥离、去重，semanticMaxTerms 封顶（多余词不参与召回）
const sifCalls = []
const SIF = makeInstance({ semanticRecallEnabled: true, semanticMaxTerms: 3, salientScoringEnabled: false }, undefined, { llm: expansionLlm('1. 海神\n- 三叉戟\n* 海神\n4) 灯塔\n5. 椰林\n6.锚链', sifCalls) })
await SIF.table.put('smm_sif1', fixture('smm_sif1', { content: '海神传说流传千年。', strength: 0.9 }))
await SIF.table.put('smm_sif2', fixture('smm_sif2', { content: '三叉戟是他的武器。', strength: 0.9 }))
await SIF.table.put('smm_sif3', fixture('smm_sif3', { content: '灯塔照亮夜航的船。', strength: 0.9 }))
await SIF.table.put('smm_sif4', fixture('smm_sif4', { content: '椰林深处有吊床。', strength: 0.9 }))
await SIF.table.put('smm_sif5', fixture('smm_sif5', { content: '锚链锈迹斑斑。', strength: 0.9 }))
const msgF1 = userMessage('mf1', '波塞冬号')
const resultF1 = await firePreStep(SIF.handlers, { messages: [msgF1], step: 1, modelSelection: { provider: 'p', model: 'm' } }, { kind: 'enter', messages: [msgF1] })
const recalledF1 = resultF1.messages.at(-1).source.recalled
assert.ok(recalledF1.includes('smm_sif1') && recalledF1.includes('smm_sif2') && recalledF1.includes('smm_sif3'), '前三条扩展词命中的记忆全部召回')
assert.ok(!recalledF1.includes('smm_sif4') && !recalledF1.includes('smm_sif5'), '超出 semanticMaxTerms 的扩展词不参与召回')
assert.equal(recalledF1.length, 3, 'recalled 恰好三条（无原词命中，无关联带出）')

// 54. M8 配置 fail loud：四个新字段越界与未知键都在加载期抛出
assert.throws(() => makeInstance({ semanticRecallEnabled: 'yes' }), /semanticRecallEnabled/, '语义扩展开关必须布尔')
assert.throws(() => makeInstance({ semanticRecallWeight: 2 }), /semanticRecallWeight/, '加权系数越上界拒绝')
assert.throws(() => makeInstance({ semanticRecallWeight: -0.5 }), /semanticRecallWeight/, '加权系数越下界拒绝')
assert.throws(() => makeInstance({ semanticRecallTimeoutMs: 100 }), /semanticRecallTimeoutMs/, '扩展超时低于下界拒绝')
assert.throws(() => makeInstance({ semanticRecallTimeoutMs: 60_000 }), /semanticRecallTimeoutMs/, '扩展超时高于上界拒绝')
assert.throws(() => makeInstance({ semanticMaxTerms: 0 }), /semanticMaxTerms/, '扩展词上限低于下界拒绝')
assert.throws(() => makeInstance({ semanticMaxTerms: 99 }), /semanticMaxTerms/, '扩展词上限高于上界拒绝')
assert.throws(() => makeInstance({ semanticRecallFoo: 1 }), /unknown config keys/, '未知键拒绝')

// ---- M9 GUI Remote 服务 ------------------------------------------------------

// 55. sleepMemoryApi 服务注册：typertRemote 绑定与原型 Remote 方法标记形状正确
const G1 = makeInstance({})
const api1 = G1.provided.get('sleepMemoryApi')
assert.ok(api1, 'GUI 服务应注册进 reflect')
assert.deepEqual(api1.typertRemote, { service: api1, serviceKey: 'sleepMemoryApi', namespace: 'sleepMemoryApi' }, 'typertRemote 绑定形状')
const gDescriptor = Object.getPrototypeOf(api1)['@deepseek-ai/dsh-typert-protocol/remote-methods']
assert.equal(gDescriptor.version, 1, 'Remote 方法标记 version 1')
assert.deepEqual(gDescriptor.methods.map((m) => m.method), ['stats', 'list', 'edges', 'runSleep', 'getConfig', 'setConfig', 'status', 'getRecord', 'manage', 'scope'], '十个 Remote 方法')
assert.ok(gDescriptor.methods.every((m) => m.invocation.kind === 'direct'), '全部 direct invocation')

// 56. stats：只计活记录、分层计数、superseded/边数、最早最晚时间
const G2 = makeInstance({})
const api2 = G2.provided.get('sleepMemoryApi')
const nowG = Date.now()
await G2.table.put('smm_g1', fixture('smm_g1', { content: '表层记忆甲', strength: 0.9, createdAt: nowG - 4000, lastAccessAt: nowG }))
await G2.table.put('smm_g2', fixture('smm_g2', { layer: 'deep', content: '深层梗概乙', strength: 0.8, createdAt: nowG - 3000, lastAccessAt: nowG }))
await G2.table.put('smm_g3', fixture('smm_g3', { layer: 'archive', content: '归档印象丙', strength: 0.2, createdAt: nowG - 2000, lastAccessAt: nowG }))
await G2.table.put('smm_g4', fixture('smm_g4', { layer: 'salient', content: '显著情绪丁', strength: 0.9, valence: 0.8, arousal: 0.8, createdAt: nowG - 1000, lastAccessAt: nowG }))
await G2.table.put('smm_g5', fixture('smm_g5', { content: '被合并的旧记录', supersededBy: 'smm_g1', createdAt: nowG }))
const gStats = await api2.stats()
assert.equal(gStats.total, 4, 'stats 只计活记录')
assert.equal(gStats.supersededCount, 1, 'superseded 计数')
assert.equal(gStats.edgeCount, 0, '无边时 edgeCount 为 0')
assert.deepEqual(gStats.byLayer, { surface: 1, deep: 1, archive: 1, salient: 1 }, '分层计数')
assert.equal(gStats.oldest, nowG - 4000, '最早创建时间')
assert.equal(gStats.newest, nowG - 1000, '最晚创建时间（superseded 不参与）')

// 57. list：层过滤、子串查询、分页与参数 fail loud
const gSalient = await api2.list({ layer: 'salient' })
assert.equal(gSalient.total, 1, '层过滤总数')
assert.equal(gSalient.items[0].id, 'smm_g4', '层过滤命中 salient 记录')
assert.equal(gSalient.items[0].valence, 0.8, '线上 item 带 valence')
const gPage1 = await api2.list({ limit: 2, offset: 0 })
assert.deepEqual(gPage1.items.map((i) => i.id), ['smm_g4', 'smm_g3'], '按 lastAccessAt/createdAt 倒序分页第一页')
assert.equal(gPage1.total, 4, '分页仍报总数')
const gPage2 = await api2.list({ limit: 2, offset: 2 })
assert.deepEqual(gPage2.items.map((i) => i.id), ['smm_g2', 'smm_g1'], '分页第二页')
const gSearch = await api2.list({ query: '深层' })
assert.deepEqual(gSearch.items.map((i) => i.id), ['smm_g2'], '子串查询命中正文')
await assert.rejects(api2.list({ layer: 'nope' }), /bad-layer/, '非法层拒绝')
await assert.rejects(api2.list({ limit: 500 }), /bad-limit/, '越界 limit 拒绝')
await assert.rejects(api2.list({ offset: -1 }), /bad-offset/, '负 offset 拒绝')

// 58. edges：关联边全量展开，字段完整
const G4 = makeInstance({})
const api4 = G4.provided.get('sleepMemoryApi')
await G4.table.put('smm_g10', fixture('smm_g10', {
  content: '边来源记录',
  edges: [
    { target: 'smm_g11', relation: 'dream-associate', weight: 0.8 },
    { target: 'smm_g12', relation: 'consolidates', weight: 1 },
  ],
}))
await G4.table.put('smm_g11', fixture('smm_g11', { content: '边目标记录' }))
const gEdges = await api4.edges()
assert.equal(gEdges.edges.length, 2, '边全部展开')
assert.deepEqual(
  gEdges.edges.find((edge) => edge.relation === 'dream-associate'),
  { from: 'smm_g10', to: 'smm_g11', relation: 'dream-associate', weight: 0.8, fromLayer: 'surface' },
  'dream-associate 边字段完整',
)

// 59. runSleep：dryRun 只预演不落库；默认真实睡眠产出沉淀与完整报告；坏参数 fail loud
const G5 = makeInstance({})
const api5 = G5.provided.get('sleepMemoryApi')
await G5.table.put('smm_g20', fixture('smm_g20', { content: '相似记忆片段之一，关于巴黎旧书店的记忆。', strength: 0.4 }))
await G5.table.put('smm_g21', fixture('smm_g21', { content: '相似记忆片段之二，关于巴黎旧书店的记忆。', strength: 0.4 }))
const gReport = await api5.runSleep({ dryRun: true })
assert.equal(gReport.dryRun, true, '报告标记 dryRun')
assert.equal(gReport.consolidatedCount, 1, '两条相似表层记忆应聚类为一条 deep 梗概')
assert.equal(G5.table.size, 2, 'dryRun 不落库')
const gReal = await api5.runSleep({})
assert.equal(gReal.dryRun, false, '默认真实睡眠')
assert.ok(
  G5.table.get('smm_g21').supersededBy !== null
    || [...G5.table.entries()].map(([, rec]) => rec).some((rec) => rec.layer === 'deep'),
  '真实睡眠产生沉淀',
)
assert.ok(typeof gReal.edgesAdded === 'number' && typeof gReal.recordsAfter === 'number', '报告字段完整')
await assert.rejects(api5.runSleep('oops'), /bad-request/, '非对象参数拒绝')

// ---- M10 时间窗召回（since/until，按 createdAt 硬过滤） ---------------------

// 60. 时间窗硬过滤候选：窗外记忆不出现，totalCandidates 随之缩小；单边/全宽窗口各形态
const TW = makeInstance({})
const T7 = Date.now()
await TW.table.put('smm_tw_old', fixture('smm_tw_old', {
  content: '猩红女巫的起源故事值得细读。', strength: 0.9,
  createdAt: T7 - 10 * DAY,
}))
await TW.table.put('smm_tw_new', fixture('smm_tw_new', {
  content: '猩红女巫的起源另有说法。', strength: 0.9,
  createdAt: T7 - 1 * DAY,
}))
const noWindowR = await TW.recall.execute({ query: '猩红女巫的起源' })
assert.ok(noWindowR.hits.some((hit) => hit.id === 'smm_tw_old'), '无窗口时旧记忆命中')
assert.ok(noWindowR.hits.some((hit) => hit.id === 'smm_tw_new'), '无窗口时新记忆命中')
assert.equal(noWindowR.totalCandidates, 2, '无窗口候选为全量')
const bothWindowR = await TW.recall.execute({ query: '猩红女巫的起源', since: T7 - 30 * DAY, until: T7 - 5 * DAY })
assert.ok(bothWindowR.hits.some((hit) => hit.id === 'smm_tw_old'), '窗口内的旧记忆命中')
assert.ok(!bothWindowR.hits.some((hit) => hit.id === 'smm_tw_new'), '窗外的新记忆被硬过滤')
assert.equal(bothWindowR.totalCandidates, 1, '窗口先于打分裁掉候选')
const untilOnlyR = await TW.recall.execute({ query: '猩红女巫的起源', until: T7 - 5 * DAY })
assert.ok(untilOnlyR.hits.some((hit) => hit.id === 'smm_tw_old'), '只传 until 同样生效')
assert.ok(!untilOnlyR.hits.some((hit) => hit.id === 'smm_tw_new'), '晚于 until 的记忆被排除')
const sinceOnlyR = await TW.recall.execute({ query: '猩红女巫的起源', since: T7 - 5 * DAY })
assert.ok(sinceOnlyR.hits.some((hit) => hit.id === 'smm_tw_new'), '只传 since 圈定其后记忆')
assert.ok(!sinceOnlyR.hits.some((hit) => hit.id === 'smm_tw_old'), '早于 since 的记忆被排除')
const wideWindowR = await TW.recall.execute({ query: '猩红女巫的起源', since: T7 - 365 * DAY, until: T7 + 365 * DAY })
assert.deepEqual(wideWindowR.hits.map((hit) => hit.id).sort(), noWindowR.hits.map((hit) => hit.id).sort(), '全宽窗口等价于无窗口')
assert.equal(wideWindowR.totalCandidates, noWindowR.totalCandidates, '全宽窗口候选数一致')

// 61. 时间窗参数校验：非法值一律 resolved invalid_args，不打库不抛异常
const badFraction = await TW.recall.execute({ query: '猩红女巫的起源', since: 1.5 })
assert.equal(badFraction.code, 'invalid_args')
assert.ok(badFraction.message.includes('since must be'), '非整数 since 报因')
const badNegative = await TW.recall.execute({ query: '猩红女巫的起源', until: -1 })
assert.equal(badNegative.code, 'invalid_args')
assert.ok(badNegative.message.includes('until must be'), '负数 until 报因')
const badOrder = await TW.recall.execute({ query: '猩红女巫的起源', since: T7, until: T7 - DAY })
assert.equal(badOrder.code, 'invalid_args')
assert.ok(badOrder.message.includes('since must be <= until'), '倒置窗口报因')
const badUnknown = await TW.recall.execute({ query: '猩红女巫的起源', bogus: true })
assert.equal(badUnknown.code, 'invalid_args', '未知参数仍被拒绝')

// 62. 时间窗同样约束扩散激活：窗外 ancient 邻居不再被带出（对照无窗口）
// B 内容与查询零 token 重叠：若有直接命中，合并会保留直接通道并丢弃 via 标注
const TS = makeInstance({})
const T8 = Date.now()
await TS.table.put('smm_ts_a', fixture('smm_ts_a', {
  content: '猩红女巫的起源设定：万磁王的女儿。', strength: 0.9,
  edges: [{ target: 'smm_ts_b', relation: 'dream-associate', weight: 0.8 }],
  createdAt: T8 - 1 * DAY,
}))
await TS.table.put('smm_ts_b', fixture('smm_ts_b', {
  content: '旺达幻视剧集在流媒体平台首播。', strength: 0.8,
  createdAt: T8 - 400 * DAY,
}))
const spreadNoWindow = await TS.recall.execute({ query: '猩红女巫的起源' })
assert.ok(
  spreadNoWindow.hits.some((hit) => hit.id === 'smm_ts_b' && hit.via?.from === 'smm_ts_a' && hit.via.hops === 1),
  '无窗口时 B 经扩散带出',
)
const spreadWindowed = await TS.recall.execute({ query: '猩红女巫的起源', since: T8 - 30 * DAY })
assert.ok(spreadWindowed.hits.some((hit) => hit.id === 'smm_ts_a'), '窗口内的直接命中保留')
assert.ok(!spreadWindowed.hits.some((hit) => hit.id === 'smm_ts_b'), '时间窗把扩散邻居也挡在窗外')

// 63. 窗口边界含端点：createdAt 恰等于 since/until 的记忆保留，差一毫秒即出局
const TB = makeInstance({})
const T9 = Date.now()
await TB.table.put('smm_tb_lo', fixture('smm_tb_lo', {
  content: '猩红女巫的起源一说是变种人血统。', strength: 0.9,
  createdAt: T9,
}))
await TB.table.put('smm_tb_hi', fixture('smm_tb_hi', {
  content: '猩红女巫的起源也牵扯混沌魔法。', strength: 0.9,
  createdAt: T9 + 5 * DAY,
}))
await TB.table.put('smm_tb_out', fixture('smm_tb_out', {
  content: '猩红女巫的起源还被写成实验品。', strength: 0.9,
  createdAt: T9 - 1,
}))
const edgeR = await TB.recall.execute({ query: '猩红女巫的起源', since: T9, until: T9 + 5 * DAY })
assert.ok(edgeR.hits.some((hit) => hit.id === 'smm_tb_lo'), 'createdAt == since 含端点')
assert.ok(edgeR.hits.some((hit) => hit.id === 'smm_tb_hi'), 'createdAt == until 含端点')
assert.ok(!edgeR.hits.some((hit) => hit.id === 'smm_tb_out'), '早于 since 一毫秒即被排除')

// ---- M10-C 插件详情页内嵌配置（plugins.bundle.config + configEditor 持久化） ---

// 65. GUI 配置读写：getConfig 按 override/inherited/defaults 取值，setConfig 合并落盘，no-op 跳过 edit，null 重置既有 override 键
let editCalls = 0
const cfgEntry = { options: { id: 'sleep-memory' } }
const cfgInherited = { recallBudget: 5, injectBudget: 2, injectEnabled: false }
let cfgOverride = { recallBudget: 9, injectBudget: 2 }
const cfgEditor = {
  entries: () => [cfgEntry],
  configuration: () => [{ entry: cfgEntry, inherited: cfgInherited, override: cfgOverride }],
  edit: async (row, change) => {
    editCalls += 1
    cfgOverride = change(cfgOverride, cfgInherited)
  },
}
const GC = makeInstance({}, null, { get: () => cfgEditor })
const apiC = GC.provided.get('sleepMemoryApi')
const cfg1 = await apiC.getConfig()
assert.equal(cfg1.fields.recallBudget.value, 9, 'override 值优先')
assert.equal(cfg1.fields.recallBudget.default, 5, 'default 来自全默认解析')
assert.equal(cfg1.fields.recallBudget.overridden, true, 'override 键标记 overridden')
assert.equal(cfg1.fields.recallBudget.type, 'integer', 'integer 字段带类型标记')
assert.equal(cfg1.fields.recallBudget.min, 1, 'integer 字段带下界')
assert.equal(cfg1.fields.recallBudget.max, 50, 'integer 字段带上界')
assert.equal(cfg1.fields.injectBudget.value, 2, 'override 与 inherited 同值时按 override 读')
assert.equal(cfg1.fields.injectBudget.overridden, true, 'override 键与 inherited 同值仍算 overridden')
assert.equal(cfg1.fields.sleepIntervalMinutes.value, 360, '两层都缺省回落 defaults')
assert.equal(cfg1.fields.sleepIntervalMinutes.overridden, false, '未覆盖键 overridden false')
assert.equal(cfg1.fields.injectEnabled.value, false, 'inherited 布尔值透出')
await apiC.setConfig({ changes: { recallBudget: 12, injectEnabled: true } })
assert.equal(editCalls, 1, '有效修改触发一次 edit')
assert.deepEqual(cfgOverride, { recallBudget: 12, injectBudget: 2, injectEnabled: true }, 'override 按键合并且保留未触及键')
assert.equal((await apiC.getConfig()).fields.recallBudget.value, 12, 'getConfig 反映新 override')
await apiC.setConfig({ changes: { recallBudget: 12 } })
assert.equal(editCalls, 1, '与当前 override 全等的 no-op 不触发 edit')
await apiC.setConfig({ changes: { recallBudget: null } })
assert.equal(editCalls, 2, '删除既有 override 键是一次真实修改')
assert.deepEqual(cfgOverride, { injectBudget: 2, injectEnabled: true }, 'null 删除 override 键')
const cfg3 = await apiC.getConfig()
assert.equal(cfg3.fields.recallBudget.value, 5, '重置后回落 inherited 值')
assert.equal(cfg3.fields.recallBudget.overridden, false, '重置后 overridden false')

// 66. GUI 配置参数校验先于 configEditor 访问：坏输入 fail loud，合法输入才暴露服务缺失
const GD = makeInstance({})
const apiD = GD.provided.get('sleepMemoryApi')
await assert.rejects(apiD.setConfig({ changes: { nope: 1 } }), /bad-field/, '未知键 bad-field')
await assert.rejects(apiD.setConfig({ changes: { recallBudget: 0 } }), /bad-recallBudget/, 'recallBudget 下界')
await assert.rejects(apiD.setConfig({ changes: { recallBudget: 51 } }), /bad-recallBudget/, 'recallBudget 上界')
await assert.rejects(apiD.setConfig({ changes: { recallBudget: 1.5 } }), /bad-recallBudget/, '非整数 recallBudget')
await assert.rejects(apiD.setConfig({ changes: { injectEnabled: 'yes' } }), /bad-injectEnabled/, '布尔字段类型错误')
await assert.rejects(apiD.setConfig({ changes: {} }), /bad-request/, '空 changes bad-request')
await assert.rejects(apiD.setConfig('oops'), /bad-request/, '非对象输入 bad-request')
await assert.rejects(apiD.getConfig(), /config-editor-unavailable/, '无 configEditor 时 getConfig fail loud')
await assert.rejects(apiD.setConfig({ changes: { recallBudget: 7 } }), /config-editor-unavailable/, '合法输入在服务缺失时 fail loud')

// 67. configEditor 存在但条目缺失：entry-not-found fail loud
const GE = makeInstance({}, null, { get: () => ({ entries: () => [], configuration: () => [], edit: async () => {} }) })
await assert.rejects(GE.provided.get('sleepMemoryApi').getConfig(), /entry-not-found/, '找不到 sleep-memory 行即 fail loud')

// 68. KvTable mock 对齐宿主：缺失记录不能 update，返回值和快照迭代器符合接口约定。
const contractTable = makeTable()
assert.equal(contractTable.deleteMany, undefined, '默认镜像 rc.5，不提供 deleteMany')
await assert.rejects(contractTable.update('smm_absent', () => fixture('smm_absent')), /记忆记录不存在/)
await contractTable.put('smm_contract', fixture('smm_contract'))
const entrySnapshot = contractTable.entries()
const keySnapshot = contractTable.keys()
await contractTable.put('smm_later', fixture('smm_later'))
assert.deepEqual([...entrySnapshot].map(([id]) => id), ['smm_contract'], 'entries 为调用时快照')
assert.deepEqual([...keySnapshot], ['smm_contract'], 'keys 为调用时快照')
assert.equal((await contractTable.update('smm_contract', (rec) => ({ ...rec, importance: 0.8 }))).importance, 0.8)
assert.equal(await contractTable.delete('smm_contract'), true, '删除已有记录返回 true')
assert.equal(await contractTable.delete('smm_contract'), false, '删除缺失记录返回 false')
const batchContract = makeTable({ batchDelete: true })
await batchContract.put('smm_batch', fixture('smm_batch'))
assert.equal(await batchContract.deleteMany(['smm_batch', 'smm_batch', 'smm_absent']), 1, '批量删除按实际存在的唯一记录计数')

// 69. 新版宿主的 forget 保留批量接口，级联只提交一次，不降级到逐条删除。
const batchForgetTable = makeTable({ batchDelete: true })
const batchForgetCalls = []
const batchForgetDelete = batchForgetTable.deleteMany
batchForgetTable.deleteMany = async (ids) => {
  batchForgetCalls.push([...ids])
  return batchForgetDelete(ids)
}
batchForgetTable.delete = async () => { throw new Error('新版宿主不应调用单条删除') }
const batchForget = makeInstance({}, batchForgetTable)
await batchForgetTable.put('smm_batch_parent', fixture('smm_batch_parent'))
await batchForgetTable.put('smm_batch_child', fixture('smm_batch_child', { supersededBy: 'smm_batch_parent' }))
await batchForgetTable.put('smm_batch_keep', fixture('smm_batch_keep'))
const batchForgotten = await batchForget.manage.execute({ action: 'forget', id: 'smm_batch_parent' })
assert.deepEqual(batchForgetCalls, [['smm_batch_parent', 'smm_batch_child']])
assert.deepEqual(batchForgotten.forgotten, ['smm_batch_parent', 'smm_batch_child'])
assert.deepEqual([...batchForgetTable.keys()], ['smm_batch_keep'], '无关记录保留')

// 70. 新版宿主的睡眠遗忘也走批量接口；预演不调用任何删除方法。
const batchSleepTable = makeTable({ batchDelete: true })
const batchSleepCalls = []
const batchSleepDelete = batchSleepTable.deleteMany
batchSleepTable.deleteMany = async (ids) => {
  batchSleepCalls.push([...ids])
  return batchSleepDelete(ids)
}
batchSleepTable.delete = async () => { throw new Error('新版宿主不应调用单条删除') }
const batchSleep = makeInstance({ dreamMaxCandidates: 0 }, batchSleepTable)
for (const id of ['smm_batch_old1', 'smm_batch_old2']) {
  await batchSleepTable.put(id, fixture(id, { layer: 'archive', strength: 0.05, lastAccessAt: Date.now() - 200 * DAY }))
}
const batchSleepPreview = await batchSleep.sleep.execute({ dryRun: true })
assert.equal(batchSleepPreview.deletedCount, 2)
assert.deepEqual(batchSleepCalls, [], '预演不落盘删除')
assert.equal(batchSleepTable.size, 2)
const batchSleepResult = await batchSleep.sleep.execute({})
assert.deepEqual(batchSleepCalls, [['smm_batch_old1', 'smm_batch_old2']])
assert.equal(batchSleepResult.deletedCount, 2)
assert.equal(batchSleepTable.size, 0)

// 71. 批量存储失败原样抛出，两个入口均不能降级重试，以免掩盖故障或扩大不确定状态。
for (const action of ['forget', 'sleep']) {
  const failingTable = makeTable({ batchDelete: true })
  const storageError = new Error('模拟批量持久化失败')
  let batchFailures = 0
  let fallbackCalls = 0
  failingTable.deleteMany = async () => { batchFailures += 1; throw storageError }
  failingTable.delete = async () => { fallbackCalls += 1; return false }
  const failingMemory = makeInstance({ dreamMaxCandidates: 0 }, failingTable)
  await failingTable.put('smm_batch_fail', fixture('smm_batch_fail', {
    layer: 'archive', strength: 0.05, lastAccessAt: Date.now() - 200 * DAY,
  }))
  const result = action === 'forget'
    ? failingMemory.manage.execute({ action, id: 'smm_batch_fail' })
    : failingMemory.sleep.execute({})
  await assert.rejects(result, (err) => err === storageError, '存储异常必须保留')
  assert.equal(batchFailures, 1)
  assert.equal(fallbackCalls, 0, '批量接口存在但失败时不调用单条删除')
  assert.ok(failingTable.get('smm_batch_fail'), '失败不得报告记忆已遗忘')
  if (action === 'sleep') {
    assert.equal((await failingMemory.sleep.execute({ dryRun: true })).dryRun, true, '失败后释放睡眠锁')
  }
}

// 72. rc.5 级联按顺序等待持久删除完成，未落盘前不返回成功，也不并发提交后续记录。
const legacyTable = makeTable()
const legacyDelete = legacyTable.delete
const legacyCalls = []
let releaseLegacyDelete
const legacyGate = new Promise((resolve) => { releaseLegacyDelete = resolve })
legacyTable.delete = async (id) => {
  legacyCalls.push(id)
  if (id === 'smm_legacy_parent') await legacyGate
  return legacyDelete(id)
}
const legacyMemory = makeInstance({}, legacyTable)
await legacyTable.put('smm_legacy_parent', fixture('smm_legacy_parent'))
await legacyTable.put('smm_legacy_child', fixture('smm_legacy_child', { supersededBy: 'smm_legacy_parent' }))
let legacyFinished = false
const legacyPending = legacyMemory.manage.execute({ action: 'forget', id: 'smm_legacy_parent' })
legacyPending.then(() => { legacyFinished = true })
await flushAsync()
assert.deepEqual(legacyCalls, ['smm_legacy_parent'], '前一条完成后才删除下一条')
assert.equal(legacyFinished, false, '必须等待持久化后才返回成功')
assert.equal(legacyTable.size, 2)
releaseLegacyDelete()
assert.deepEqual((await legacyPending).forgotten, ['smm_legacy_parent', 'smm_legacy_child'])
assert.deepEqual(legacyCalls, ['smm_legacy_parent', 'smm_legacy_child'])
assert.equal(legacyTable.size, 0)

// 73. rc.5 单条删除失败时立即中止，不能继续级联或返回成功。
const legacyFailTable = makeTable()
const legacyStorageError = new Error('模拟单条持久化失败')
const legacyFailCalls = []
legacyFailTable.delete = async (id) => { legacyFailCalls.push(id); throw legacyStorageError }
const legacyFailMemory = makeInstance({}, legacyFailTable)
await legacyFailTable.put('smm_legacy_fail', fixture('smm_legacy_fail'))
await legacyFailTable.put('smm_legacy_fail_child', fixture('smm_legacy_fail_child', { supersededBy: 'smm_legacy_fail' }))
await assert.rejects(legacyFailMemory.manage.execute({ action: 'forget', id: 'smm_legacy_fail' }), (err) => err === legacyStorageError)
assert.deepEqual(legacyFailCalls, ['smm_legacy_fail'], '首次失败后不再提交后续删除')
assert.equal(legacyFailTable.size, 2, '失败记录仍保留')

console.log('SMOKE PASS: 73/73 场景通过')
