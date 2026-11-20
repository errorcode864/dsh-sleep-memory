import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRecordView } from '../memory-contract.js'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const DAY = 86_400_000
const config = {
    dormancyEnabled: true, sleepAuditEnabled: true, contextualRecallEnabled: true,
    dormantAfterDays: 10, dormantStrengthLine: 0.2,
}
const dormant = (overrides = {}) => fixture('smm_deep', {
    layer: 'deep', content: '核对目标产品的兼容清单。', strength: 0.1,
    access: { state: 'dormant', at: Date.now() - DAY, reason: '长期未使用' },
    recallTriggers: [{ when: '迁移前回顾教训', cues: ['数据搬家'] }], ...overrides,
})
const review = (useful) => ({
    prepareCall: async () => ({
        config: {},
        stream: async function* (request) {
            const input = JSON.parse(request.messages[1].content[0].text)
            yield { type: 'text-delta', text: JSON.stringify({
                decisions: input.candidates.map((item) => ({ id: item.id, useful, reason: useful ? '适用当前任务' : '与任务无关' })),
            }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
        },
    }),
})

test('分层半衰期默认兼容且增量衰减不会重复扣减', async () => {
    const host = createHarness({ deepDecayHalfLifeDays: 28, archiveDecayHalfLifeDays: 56, consolidateStrengthLine: 0.05 })
    const now = Date.now()
    for (const layer of ['surface', 'deep', 'archive']) {
        await host.table.put(`smm_${layer}`, fixture(`smm_${layer}`, {
            layer, strength: 1, createdAt: now - 14 * DAY, lastAccessAt: now - 14 * DAY, lastDecayAt: now - 14 * DAY,
        }))
    }
    await host.call('memory_sleep', {})
    assert.ok(Math.abs(host.table.get('smm_surface').strength - 0.5) < 0.00001)
    assert.ok(Math.abs(host.table.get('smm_deep').strength - Math.sqrt(0.5)) < 0.00001)
    assert.ok(Math.abs(host.table.get('smm_archive').strength - 0.5 ** 0.25) < 0.00001)
    const strength = host.table.get('smm_deep').strength
    await host.call('memory_sleep', {})
    assert.ok(Math.abs(host.table.get('smm_deep').strength - strength) < 0.00001)
    await host.dispose()
    const original = createHarness()
    await original.table.put('smm_default', fixture('smm_default', {
        layer: 'deep', strength: 1, lastAccessAt: now - 14 * DAY, lastDecayAt: now - 14 * DAY,
    }))
    await original.call('memory_sleep', {})
    assert.ok(Math.abs(original.table.get('smm_default').strength - 0.5) < 0.00001)
    await original.dispose()
})

test('休眠预演无副作用且概要休眠不释放巩固成员', async () => {
    const host = createHarness(config)
    const now = Date.now()
    await host.table.put('smm_member', fixture('smm_member', { content: '只有原成员包含的细节', supersededBy: 'smm_deep' }))
    await host.table.put('smm_deep', fixture('smm_deep', {
        layer: 'deep', content: '巩固概要', strength: 0.1, lastAccessAt: now - 20 * DAY,
        edges: [{ target: 'smm_member', relation: 'consolidates', weight: 1 }],
    }))
    const preview = await host.call('memory_sleep', { dryRun: true })
    assert.equal(preview.dormantCount, 1)
    assert.equal(host.table.get('smm_deep').access, undefined)
    const slept = await host.call('memory_sleep', {})
    assert.equal(host.table.get('smm_deep').access.state, 'dormant')
    const view = createRecordView([...host.table.entries()])
    assert.equal(view.isCurrent(host.table.get('smm_deep')), true)
    assert.equal(view.isConsolidated(host.table.get('smm_member')), true)
    assert.equal((await host.call('memory_recall', { query: '只有原成员包含的细节' })).count, 0)
    const plan = await host.api.manage({ action: 'sleepRollback', batchId: slept.auditId })
    await host.api.manage({ action: 'sleepRollback', batchId: slept.auditId, dryRun: false, planToken: plan.planToken })
    assert.equal(host.table.get('smm_deep').access, undefined)
    await host.dispose()
})

test('休眠须有明确情境才直接唤醒且整批可回滚', async () => {
    const host = createHarness(config)
    await host.table.put('smm_deep', dormant())
    assert.equal((await host.call('memory_recall', { query: '兼容清单' })).count, 0)
    assert.equal((await host.call('memory_recall', { layers: ['deep'] })).count, 0)
    await host.api.getRecord({ id: 'smm_deep' })
    assert.equal(host.table.get('smm_deep').access.state, 'dormant')
    const before = host.table.get('smm_deep')
    const result = await host.call('memory_recall', { query: '准备数据搬家' })
    assert.equal(result.hits[0].wake.via, 'context')
    assert.equal(host.table.get('smm_deep').access.state, 'awake')
    assert.equal(host.table.get('smm_deep').accessCount, 1)
    const batch = (await host.api.manage({ action: 'sleepHistory' })).items[0]
    assert.equal(batch.report.operation, 'wake')
    const plan = await host.api.manage({ action: 'sleepRollback', batchId: batch.id })
    await host.api.manage({ action: 'sleepRollback', batchId: batch.id, dryRun: false, planToken: plan.planToken })
    assert.deepEqual(host.table.get('smm_deep'), before)
    await host.dispose()
})

test('审核拒绝与预算不足不唤醒且不新增审计', async () => {
    for (const mode of ['review', 'budget']) {
        const host = createHarness({
            ...config, recallReviewEnabled: mode === 'review', injectMaxEstimatedTokens: mode === 'budget' ? 100 : 900,
            injectMaxCharsPerHit: 1000,
        }, { llm: review(false) })
        await host.table.put('smm_deep', dormant({ content: '兼容清单中的精确条件需要逐项核对。'.repeat(60) }))
        const result = await injectMessage(host, createMessage('数据搬家'))
        assert.equal(result.messages.length, 1)
        assert.equal(host.table.get('smm_deep').access.state, 'dormant')
        assert.equal((await host.api.manage({ action: 'sleepHistory' })).total, 0)
        await host.dispose()
    }
})

test('唤醒不能绕过项目、时间、精确实体和有效性约束', async () => {
    const host = createHarness(config)
    await host.table.put('smm_deep', dormant({ projectId: '甲', content: 'Spring Boot 3.2.11 迁移限制。' }))
    for (const args of [
        { query: '数据搬家', projectId: '乙' },
        { query: '数据搬家', projectId: '甲', until: 1 },
        { query: 'Spring Boot 3.2.12 数据搬家', projectId: '甲' },
    ]) assert.equal((await host.call('memory_recall', args)).count, 0)
    const input = { action: 'setState', id: 'smm_deep', projectId: '甲', state: 'invalid', reason: '已不适用' }
    const plan = await host.api.manage(input)
    await host.api.manage({ ...input, dryRun: false, planToken: plan.planToken })
    assert.equal((await host.call('memory_recall', { query: '数据搬家', projectId: '甲' })).count, 0)
    assert.equal(host.table.get('smm_deep').access.state, 'dormant')
    await host.dispose()
})

test('关联路径只唤醒实际呈现的休眠节点并保留路径和使用时间', async () => {
    const host = createHarness({ ...config, spreadMinActivation: 0.001 })
    await host.table.put('smm_seed', fixture('smm_seed', {
        content: '发布备份检查', edges: [{ target: 'smm_deep', relation: 'dream-associate', weight: 1 }],
    }))
    await host.table.put('smm_deep', dormant({ recallTriggers: [] }))
    const result = await injectMessage(host, createMessage('发布备份检查'))
    assert.equal(result.messages.length, 2)
    const restored = host.table.get('smm_deep')
    assert.equal(restored.access.state, 'awake')
    assert.equal(restored.access.lastWake.fromId, 'smm_seed')
    assert.equal(restored.access.lastWake.hops, 1)
    assert.equal(restored.accessCount, 0, '关联唤醒不冒充直接使用次数')
    assert.ok(restored.lastAccessAt >= restored.access.at)
    await host.dispose()
})

test('中间节点审核拒绝后不能跨过它唤醒下游', async () => {
    const host = createHarness({
        ...config, recallReviewEnabled: true, spreadDepth: 2, spreadMinActivation: 0.00001,
    }, {
        llm: {
            prepareCall: async () => ({
                config: {},
                stream: async function* (request) {
                    const input = JSON.parse(request.messages[1].content[0].text)
                    assert.ok(input.candidates.some((item) => item.id === 'smm_leaf'))
                    yield { type: 'text-delta', text: JSON.stringify({
                        decisions: input.candidates.map((item) => ({
                            id: item.id, useful: item.id !== 'smm_deep', reason: '按任务核对关联节点',
                        })),
                    }) }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    })
    await host.table.put('smm_seed', fixture('smm_seed', {
        content: '发布备份检查', edges: [{ target: 'smm_deep', relation: 'dream-associate', weight: 1 }],
    }))
    await host.table.put('smm_deep', dormant({
        recallTriggers: [], edges: [{ target: 'smm_leaf', relation: 'dream-associate', weight: 1 }],
    }))
    await host.table.put('smm_leaf', dormant({ id: 'smm_leaf', content: '历史恢复教训', recallTriggers: [] }))
    const result = await injectMessage(host, createMessage('发布备份检查'))
    assert.equal(result.messages.length, 2)
    assert.deepEqual(result.messages.find((message) => message.source?.kind === 'sleep-memory').source.recalled, ['smm_seed'])
    assert.equal(host.table.get('smm_deep').access.state, 'dormant')
    assert.equal(host.table.get('smm_leaf').access.state, 'dormant')
    assert.equal((await host.api.manage({ action: 'sleepHistory' })).total, 0)
    await host.dispose()
})

test('审计容量不足时唤醒不修改记忆', async () => {
    const host = createHarness({ ...config, sleepAuditMaxBytes: 1 })
    await host.table.put('smm_deep', dormant())
    const before = structuredClone([...host.data])
    await assert.rejects(host.call('memory_recall', { query: '数据搬家' }), /容量上限/)
    assert.deepEqual([...host.data], before)
    assert.equal((await host.api.manage({ action: 'sleepHistory' })).total, 0)
    await host.dispose()
})

test('休眠后新增巩固引用仍阻止回滚', async () => {
    const host = createHarness(config)
    await host.table.put('smm_deep', fixture('smm_deep', {
        layer: 'deep', strength: 0.1, lastAccessAt: Date.now() - 20 * DAY,
    }))
    const slept = await host.call('memory_sleep', {})
    await host.table.put('smm_new_member', fixture('smm_new_member', { supersededBy: 'smm_deep' }))
    const plan = await host.call('memory_manage', { action: 'sleepRollback', batchId: slept.auditId })
    assert.equal(plan.code, 'audit_conflict')
    assert.ok(plan.conflicts.includes('smm_new_member'))
    assert.equal(host.table.get('smm_deep').access.state, 'dormant')
    await host.dispose()
})

test('唤醒写入中断后重载恢复且备份保留可访问状态', async () => {
    const failure = { enabled: false }
    const data = new Map()
    const domains = new Map()
    const host = createHarness(config, {
        data, domains, beforeDomainPut(name, _id, batch) {
            if (failure.enabled && name === 'memory_sleep_audit' && batch.state === 'applied') throw new Error('唤醒完成标记失败')
        },
    })
    await host.table.put('smm_deep', dormant())
    failure.enabled = true
    await assert.rejects(host.call('memory_recall', { query: '数据搬家' }), /唤醒完成标记失败/)
    await host.dispose()
    const restarted = createHarness(config, { data, domains })
    await restarted.api.stats()
    assert.equal(restarted.table.get('smm_deep').access.state, 'awake')
    const backup = (await restarted.api.manage({ action: 'export', includeAudit: true })).backup
    const target = createHarness(config)
    const plan = await target.api.manage({ action: 'import', backup })
    await target.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken })
    assert.deepEqual(target.table.get('smm_deep').access, restarted.table.get('smm_deep').access)
    await target.dispose()
    await restarted.dispose()
})

test('休眠关闭时保留元数据并恢复旧检索且非法 access 在边界拒绝', async () => {
    assert.throws(() => createHarness({ dormancyEnabled: true }), /sleepAuditEnabled/)
    const host = createHarness()
    await host.table.put('smm_deep', dormant())
    assert.equal((await host.call('memory_recall', { query: '兼容清单' })).hits[0].id, 'smm_deep')
    assert.equal(host.table.get('smm_deep').access.state, 'dormant')
    await assert.rejects(host.table.put('smm_bad', fixture('smm_bad', { access: dormant().access })), /access/)
    await assert.rejects(host.table.put('smm_bad_wake', dormant({
        id: 'smm_bad_wake', access: { ...dormant().access, lastWake: { at: 1, via: 'context', fromId: 'smm_seed' } },
    })), /access.lastWake/)
    await host.dispose()
})
