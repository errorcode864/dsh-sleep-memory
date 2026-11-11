import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, createMessage, fixture, flushTasks, injectMessage, mockAffect } from './harness.mjs'
import { backupChecksum, exportMemoryBackup } from '../memory-contract.js'
import { initialSchedule, listWorkspaceScopes, nextSleepTime } from '../memory-runtime.js'

const DAY = 86_400_000
const execution = (id) => ({ agent: { id, session: { id } } })
const workspaceRegistry = {
    list: () => [
        { id: 'wa', title: '项目甲', sessionIds: ['sa'] },
        { id: 'wb', title: '项目乙', sessionIds: ['sb'] },
    ],
}
const services = { get: (key) => key === 'workspaceRegistry' ? workspaceRegistry : undefined }

test('工作区可选服务通过安全查询读取，避免触发宿主属性注入检查', () => {
    const context = new Proxy({ get: services.get }, {
        get(target, key) {
            if (key === 'workspaceRegistry') throw new Error('未声明注入时禁止直接读取工作区属性')
            return Reflect.get(target, key)
        },
    })
    assert.deepEqual(listWorkspaceScopes(context).map((entry) => entry.projectId), ['workspace:wa', 'workspace:wb'])
    assert.deepEqual(listWorkspaceScopes({ get: () => undefined }), [])
    assert.throws(() => listWorkspaceScopes({ get: () => ({ list() { throw new Error('工作区读取失败') } }) }), /工作区读取失败/)
})

test('全库项目目录保留真实归属，工作区提供名称且名称故障不阻断浏览', async () => {
    const harness = createHarness({}, services)
    await harness.table.put('smm_global', fixture('smm_global'))
    await harness.table.put('smm_a', fixture('smm_a', { projectId: 'workspace:wa' }))
    await harness.table.put('smm_review', fixture('smm_review', {
        projectId: '归档项目', lifecycle: { state: 'review', reason: '需复核', at: Date.now(), revision: 1 },
    }))
    const stats = await harness.api.stats()
    assert.equal(stats.total, 2)
    assert.equal(stats.projects.find((project) => project.projectId === 'workspace:wa').title, '项目甲')
    assert.equal(stats.projects.find((project) => project.projectId === null).title, '全局记忆')
    assert.equal(stats.projects.find((project) => project.projectId === '归档项目').total, 1, '仅有非活跃记录的项目也应可选')
    assert.equal(stats.projectError, null)
    assert.equal(harness.table.get('smm_global').projectId, undefined, '读取目录不迁移旧记录')

    const unavailable = createHarness({}, { get: () => ({ list() { throw new Error('工作区未就绪') } }) })
    await unavailable.table.put('smm_b', fixture('smm_b', { projectId: 'workspace:wb' }))
    const fallback = await unavailable.api.stats()
    assert.equal(fallback.total, 1)
    assert.equal(fallback.projects[0].title, 'workspace:wb')
    assert.match(fallback.projectError, /显示项目标识/)
})

test('项目分组在分页前排序，数量覆盖完整筛选结果且选择项目可显式包含全局', async () => {
    const harness = createHarness({}, services)
    const now = Date.now()
    for (let index = 0; index < 55; index++) {
        await harness.table.put(`smm_a${index}`, fixture(`smm_a${index}`, {
            projectId: 'workspace:wa', content: '部署参数', lastAccessAt: now - index * 2,
        }))
        await harness.table.put(`smm_b${index}`, fixture(`smm_b${index}`, {
            projectId: 'workspace:wb', content: '部署参数', lastAccessAt: now - index * 2 - 1,
        }))
    }
    await harness.table.put('smm_global', fixture('smm_global', { content: '部署公共约定', lastAccessAt: now + 1 }))
    const plain = await harness.api.list({ projectId: 'workspace:wa', limit: 200 })
    assert.equal(plain.total, 55, '旧参数继续保持严格项目筛选')
    const first = await harness.api.list({ groupBy: 'project', query: '部署', limit: 50 })
    const second = await harness.api.list({ groupBy: 'project', query: '部署', limit: 50, offset: 50 })
    const third = await harness.api.list({ groupBy: 'project', query: '部署', limit: 50, offset: 100 })
    assert.deepEqual(first.groups, [
        { projectId: null, total: 1 }, { projectId: 'workspace:wa', total: 55 }, { projectId: 'workspace:wb', total: 55 },
    ])
    assert.equal(first.total, 111)
    assert.ok(first.items.slice(1).every((record) => record.projectId === 'workspace:wa'))
    assert.equal(second.items[0].projectId, 'workspace:wa')
    assert.equal(new Set([...first.items, ...second.items, ...third.items].map((record) => record.id)).size, 111)
    const selected = await harness.api.list({ projectId: 'workspace:wa', includeGlobal: true, groupBy: 'project', limit: 200 })
    assert.deepEqual(selected.groups, [{ projectId: 'workspace:wa', total: 55 }, { projectId: null, total: 1 }])
    assert.equal(selected.items.at(-1).id, 'smm_global')
    assert.equal(selected.total, 56)
    assert.ok(selected.items.every((record) => record.projectId !== 'workspace:wb'))
    assert.equal((await harness.api.list({ projectId: null, includeGlobal: true })).total, 1)
    assert.deepEqual((await harness.api.list({ query: '不存在', groupBy: 'project' })).groups, [])
    await assert.rejects(harness.api.list({ includeGlobal: 'true' }), /bad-request/)
    await assert.rejects(harness.api.list({ groupBy: 'tag' }), /bad-request/)
})

async function setState(harness, id, state, reason = '用户确认适用条件发生变化') {
    const input = { action: 'setState', id, state, reason, projectId: null }
    const plan = await harness.call('memory_manage', input)
    assert.equal(plan.dryRun, true)
    const result = await harness.call('memory_manage', { ...input, dryRun: false, planToken: plan.planToken })
    assert.equal(result.dryRun, false)
    return result
}

test('工具、评分和注入共享宿主会话范围，显式全局优先且绑定可持久释放', async () => {
    const runtimeData = new Map()
    const harness = createHarness({ projectId: '配置项目', salientScoringEnabled: true, injectMinScore: 0 },
        { ...services, runtimeData, llm: mockAffect() })
    const a = await harness.call('memory_write', { kind: 'fact', content: '部署甲项目使用 DM8' }, execution('sa'))
    const b = await harness.call('memory_write', { kind: 'fact', content: '部署乙项目使用 DM8' }, execution('sb'))
    const global = await harness.call('memory_write', { kind: 'fact', content: '部署全局习惯', projectId: null }, execution('sa'))
    assert.equal(harness.table.get(a.id).projectId, 'workspace:wa')
    assert.equal(harness.table.get(a.id).source.sessionId, 'sa')
    assert.equal(harness.table.get(global.id).projectId, null)
    const recalled = await harness.call('memory_recall', { query: '部署' }, execution('sa'))
    assert.ok(recalled.hits.some((hit) => hit.id === a.id))
    assert.ok(!recalled.hits.some((hit) => hit.id === b.id))
    const injected = await injectMessage(harness, createMessage('部署项目终于成功了！'), execution('sa'))
    assert.ok(injected.messages[1].source.recalled.includes(a.id))
    assert.ok(!injected.messages[1].source.recalled.includes(b.id))
    await flushTasks()
    assert.ok([...harness.data.values()].some((record) => record.layer === 'salient'
        && record.projectId === 'workspace:wa' && record.source.sessionId === 'sa'))
    await harness.call('memory_manage', { action: 'bind', projectId: null }, execution('sa'))
    assert.equal((await harness.call('memory_manage', { action: 'scope' }, execution('sa'))).scope.source, 'session')
    const restarted = createHarness({ projectId: '配置项目' }, { ...services, runtimeData })
    assert.equal((await restarted.api.scope({ sessionId: 'sa' })).scope.projectId, null)
    await restarted.api.manage({ action: 'bind', sessionId: 'sa', release: true })
    assert.equal((await restarted.api.scope({ sessionId: 'sa' })).scope.projectId, 'workspace:wa')
    assert.equal((await restarted.api.scope({ sessionId: '未知会话' })).scope.source, 'config')
    assert.equal((await restarted.call('memory_recall', { query: '部署', projectId: 7 }, execution('sa'))).code, 'invalid_args')
    await harness.dispose()
    await restarted.dispose()
})

test('工作区读取失败明确报错，显式范围仍可用且不落入其他项目', async () => {
    const harness = createHarness({}, { get: () => ({ list: () => { throw new Error('工作区未就绪') } }) })
    await assert.rejects(harness.call('memory_write', { kind: 'fact', content: '配置测试' }, execution('sa')), /工作区未就绪/)
    assert.equal(harness.data.size, 0)
    const result = await harness.call('memory_write', { kind: 'fact', content: '配置测试', projectId: '甲' }, execution('sa'))
    assert.equal(harness.table.get(result.id).projectId, '甲')
})

test('整链失效只写一次，概要退出召回，恢复仍只返回最新事实', async () => {
    const harness = createHarness({ consolidateMinSimilarity: 0.1 })
    await harness.table.put('smm_a', fixture('smm_a', { strength: 0.4 }))
    await harness.table.put('smm_b', fixture('smm_b', { strength: 0.4 }))
    const sleep = await harness.call('memory_sleep', {})
    const corrected = await harness.call('memory_manage', { action: 'correct', id: 'smm_a', content: '部署新参数 NEW_99' })
    const before = harness.writes.length
    const plan = await setState(harness, corrected.id, 'invalid')
    assert.equal(harness.writes.length - before, 1)
    assert.deepEqual(new Set(plan.chainIds), new Set(['smm_a', corrected.id]))
    const result = await harness.call('memory_recall', { query: '部署', fidelity: 'raw' })
    assert.deepEqual(result.hits.map((hit) => hit.id), ['smm_b'])
    const detail = await harness.api.getRecord({ id: 'smm_a' })
    assert.equal(detail.totalChain, 2)
    assert.equal(detail.lifecycle.state, 'invalid')
    assert.equal(harness.data.size, 4)
    await setState(harness, 'smm_a', 'active', '已确认新事实仍适用')
    const restored = await harness.call('memory_recall', { query: '部署', fidelity: 'raw' })
    assert.ok(restored.hits.some((hit) => hit.id === corrected.id))
    assert.ok(!restored.hits.some((hit) => [sleep.consolidated[0].deepId, 'smm_a'].includes(hit.id)))
})

test('状态预演拒绝过期凭据和错误参数，原子写入失败不产生半条纠正链', async () => {
    let reject = false
    const harness = createHarness({}, { beforeUpdate: async () => { if (reject) throw new Error('模拟存储失败') } })
    await harness.table.put('smm_a', fixture('smm_a'))
    const input = { action: 'setState', id: 'smm_a', state: 'invalid', reason: '已过期' }
    const plan = await harness.call('memory_manage', input)
    assert.equal(harness.table.get('smm_a').lifecycle, undefined)
    assert.deepEqual(plan.affectedIds, ['smm_a'])
    await harness.call('memory_manage', { action: 'correct', id: 'smm_a', content: '部署参数已更新' })
    assert.equal((await harness.call('memory_manage', { ...input, dryRun: false, planToken: plan.planToken })).code, 'conflict')
    assert.equal((await harness.call('memory_manage', { ...input, reason: '' })).code, 'invalid_args')
    const fresh = await harness.call('memory_manage', input)
    reject = true
    await assert.rejects(harness.call('memory_manage', { ...input, dryRun: false, planToken: fresh.planToken }), /模拟存储失败/)
    assert.equal((await harness.api.getRecord({ id: 'smm_a' })).lifecycle.state, 'active')
})

test('概要状态预演同时列明恢复独立召回的原始成员', async () => {
    const harness = createHarness()
    for (const id of ['smm_a', 'smm_b']) await harness.table.put(id, fixture(id, { strength: 0.4 }))
    const sleep = await harness.call('memory_sleep', {})
    const deepId = sleep.consolidated[0].deepId
    const plan = await setState(harness, deepId, 'invalid', '概要不适用，但原始事实需要保留')
    assert.deepEqual(new Set(plan.affectedIds), new Set([deepId, 'smm_a', 'smm_b']))
    const recalled = await harness.call('memory_recall', { query: '部署' })
    assert.deepEqual(new Set(recalled.hits.map((hit) => hit.id)), new Set(['smm_a', 'smm_b']))
})

test('待复核经历允许显式带标记召回，但不自动注入、强化或参与睡眠巩固', async () => {
    const harness = createHarness({ injectMinScore: 0 })
    await harness.table.put('smm_a', fixture('smm_a', { kind: 'experience', strength: 0.1 }))
    await setState(harness, 'smm_a', 'review')
    const before = structuredClone(harness.table.get('smm_a'))
    const recall = await harness.call('memory_recall', { query: '部署' })
    assert.equal(recall.hits[0].lifecycle.state, 'review')
    assert.deepEqual(harness.table.get('smm_a'), before)
    assert.equal((await injectMessage(harness, createMessage('部署'))).messages.length, 1)
    assert.equal((await harness.call('memory_sleep', {})).consolidatedCount, 0)
    assert.deepEqual(harness.table.get('smm_a'), before)
    assert.equal((await harness.api.list({ state: 'review' })).total, 1)
    assert.equal((await harness.api.list({ state: 'active' })).total, 0)
})

test('显著经历自动复核和衰减默认关闭，启用后正负经历采用相同规则', async () => {
    const harness = createHarness()
    const old = Date.now() - 100 * DAY
    for (const [id, valence] of [['smm_pos', 0.9], ['smm_neg', -0.9]]) {
        await harness.table.put(id, fixture(id, { layer: 'salient', kind: 'experience', valence, arousal: 0.9,
            createdAt: old, lastAccessAt: old, lastDecayAt: old, strength: 1 }))
    }
    await harness.call('memory_sleep', {})
    assert.equal(harness.table.get('smm_pos').strength, 1)
    assert.equal(harness.table.get('smm_neg').lifecycle, undefined)
    const review = createHarness({ salientReviewAfterDays: 30 }, { data: harness.data })
    const preview = await review.call('memory_sleep', { dryRun: true })
    assert.equal(preview.reviewCount, 2)
    assert.equal(harness.table.get('smm_pos').lifecycle, undefined)
    await review.call('memory_sleep', {})
    assert.equal(harness.table.get('smm_pos').lifecycle.state, 'review')
    assert.equal(harness.table.get('smm_neg').lifecycle.state, 'review')
    await setState(review, 'smm_pos', 'active', '刚刚复核通过')
    assert.equal((await review.call('memory_sleep', {})).reviewCount, 0)
    const decay = createHarness({ salientDecayHalfLifeDays: 100 })
    await decay.table.put('smm_decay', fixture('smm_decay', { layer: 'salient', valence: 0.9, arousal: 0.9,
        lastAccessAt: old, lastDecayAt: old, strength: 1 }))
    await decay.call('memory_sleep', {})
    assert.ok(Math.abs(decay.table.get('smm_decay').strength - 0.5) < 0.001)
})

test('有效性元数据随备份恢复，错误状态在任何写入前被拒绝', async () => {
    const harness = createHarness()
    await harness.table.put('smm_a', fixture('smm_a'))
    await setState(harness, 'smm_a', 'invalid')
    const backup = exportMemoryBackup(harness.table)
    const restored = createHarness()
    const imported = await restored.call('memory_manage', { action: 'import', backup, dryRun: false })
    assert.equal(imported.imported, 1)
    assert.equal((await restored.call('memory_recall', { query: '部署' })).count, 0)
    backup.records[0].lifecycle.state = 'unknown'
    backup.checksum = backupChecksum(backup.records)
    const empty = createHarness()
    assert.equal((await empty.call('memory_manage', { action: 'import', backup, dryRun: false })).code, 'invalid_args')
    assert.equal(empty.data.size, 0)
})

test('睡眠成功时刻跨实例持久保存，未到期重载不补跑，到期补跑一次', async () => {
    const runtimeData = new Map()
    const config = { sleepOnStart: true, sleepIntervalMinutes: 60 }
    const first = createHarness(config, { runtimeData })
    await flushTasks()
    const successAt = (await first.api.status()).schedule.lastSuccessAt
    assert.ok(successAt > 0)
    await first.dispose()
    const second = createHarness(config, { runtimeData })
    await flushTasks()
    const state = await second.api.status()
    assert.equal(state.lastSleep, null)
    assert.equal(state.schedule.lastSuccessAt, successAt)
    assert.equal(state.nextSleepAt, successAt + 3_600_000)
    await second.dispose()
    runtimeData.set('schedule', { ...runtimeData.get('schedule'), lastSuccessAt: successAt - 2 * 3_600_000 })
    const third = createHarness(config, { runtimeData })
    await flushTasks()
    assert.ok((await third.api.status()).lastSleep)
    await third.dispose()
})

test('失败持久化、退避与重启恢复不会把失败当成功', async () => {
    const runtimeData = new Map()
    const data = new Map([['smm_a', fixture('smm_a', { lastAccessAt: Date.now() - DAY })]])
    const first = createHarness({ sleepIntervalMinutes: 60 }, {
        runtimeData, data, beforeUpdate: async () => { throw new Error('模拟磁盘故障') },
    })
    await assert.rejects(first.call('memory_sleep', {}), /模拟磁盘故障/)
    const failed = (await first.api.status()).schedule
    assert.equal(failed.lastSuccessAt, null)
    assert.equal(failed.failures, 1)
    assert.ok(failed.retryAt >= failed.lastAttemptAt + 60_000)
    await first.dispose()
    const restarted = createHarness({ sleepOnStart: true, sleepIntervalMinutes: 60 }, { runtimeData, data })
    await flushTasks()
    assert.equal((await restarted.api.status()).schedule.failures, 1)
    assert.equal((await restarted.api.status()).lastSleep, null)
    await restarted.call('memory_sleep', {})
    assert.equal((await restarted.api.status()).schedule.failures, 0)
    await restarted.dispose()
})

test('调度状态写入失败会阻止睡眠，卸载后不会产生异步启动写入', async () => {
    const harness = createHarness({}, { beforeRuntimePut: () => { throw new Error('调度不可持久化') } })
    await harness.table.put('smm_a', fixture('smm_a'))
    await assert.rejects(harness.call('memory_sleep', {}), /调度不可持久化/)
    assert.equal(harness.table.get('smm_a').lastDecayAt, undefined)
    assert.equal((await harness.api.status()).schedule.lastSuccessAt, null)
    const empty = createHarness({ sleepIntervalMinutes: 60 })
    await empty.dispose()
    await flushTasks()
    assert.equal(empty.runtimeData.size, 0)
    const state = { ...initialSchedule(), lastSuccessAt: 1000 }
    assert.equal(nextSleepTime(state, { sleepIntervalMinutes: 60, sleepOnStart: false }, 0, 4_000_000), 7_600_000)
})

test('注入整体预算覆盖标题与来源，未呈现的直接和关联记忆不强化', async () => {
    const harness = createHarness({ injectMinScore: 0, injectMaxTotalChars: 300, injectMaxCharsPerHit: 200 })
    await harness.table.put('smm_large', fixture('smm_large', { content: '部署'.repeat(200) }))
    assert.equal((await injectMessage(harness, createMessage('部署'))).messages.length, 1)
    assert.equal(harness.table.get('smm_large').accessCount, 0)
    assert.equal((await harness.api.status()).injection.budgetSkipped, 1)
    const roomy = createHarness({ injectMinScore: 0, injectMaxTotalChars: 500 })
    for (const id of ['smm_a', 'smm_b', 'smm_c']) await roomy.table.put(id, fixture(id))
    const result = await injectMessage(roomy, createMessage('部署'))
    assert.ok(result.messages[1].content[0].text.length <= 500)
    const shown = new Set(result.messages[1].source.recalled)
    for (const [id, record] of roomy.data) assert.equal(record.accessCount, shown.has(id) ? 1 : 0)
})

test('同会话相邻轮次去重，其他会话和纠正后版本仍可注入，显式召回不受影响', async () => {
    const harness = createHarness({ injectMinScore: 0, injectRepeatAfterTurns: 3 })
    await harness.table.put('smm_a', fixture('smm_a'))
    assert.equal((await injectMessage(harness, createMessage('部署', 'm1'), execution('sa'))).messages.length, 2)
    assert.equal((await injectMessage(harness, createMessage('部署', 'm2'), execution('sa'))).messages.length, 1)
    assert.equal((await injectMessage(harness, createMessage('部署', 'm3'), execution('sb'))).messages.length, 2)
    assert.equal((await harness.call('memory_recall', { query: '部署' }, execution('sa'))).count, 1)
    const corrected = await harness.call('memory_manage', { action: 'correct', id: 'smm_a', content: '部署新版本' })
    const result = await injectMessage(harness, createMessage('部署', 'm4'), execution('sa'))
    assert.deepEqual(result.messages[1].source.recalled, [corrected.id])
    await setState(harness, corrected.id, 'invalid')
    assert.equal((await injectMessage(harness, createMessage('部署', 'm5'), execution('sa'))).messages.length, 1)
    await setState(harness, corrected.id, 'active')
    assert.equal((await injectMessage(harness, createMessage('部署', 'm6'), execution('sa'))).messages.length, 2)
})

test('新轮次已有历史注入块时仍可注入新版本，同触发消息重入不重复', async () => {
    const harness = createHarness({ injectMinScore: 0 })
    await harness.table.put('smm_a', fixture('smm_a'))
    const message = createMessage('部署', 'first')
    const first = await injectMessage(harness, message, execution('sa'))
    const entered = first.messages
    const replay = await harness.handlers.get('agent/pre-step')(
        { step: 1, messages: [message], ...execution('sa') }, async () => ({ kind: 'enter', messages: entered }))
    assert.equal(replay.messages.length, 2)
    await harness.call('memory_manage', { action: 'correct', id: 'smm_a', content: '部署新方案' })
    const next = createMessage('部署', 'second')
    const result = await harness.handlers.get('agent/pre-step')(
        { step: 1, messages: [next], ...execution('sa') },
        async () => ({ kind: 'enter', messages: [...entered, next] }))
    assert.equal(result.messages.length, 4)
    const legacy = { ...first.messages[1], source: { kind: 'sleep-memory', recalled: ['smm_a'] } }
    const legacyResult = await harness.handlers.get('agent/pre-step')(
        { step: 1, messages: [next], ...execution('other-session') },
        async () => ({ kind: 'enter', messages: [message, legacy, next] }))
    assert.equal(legacyResult.messages.length, 4)
})
