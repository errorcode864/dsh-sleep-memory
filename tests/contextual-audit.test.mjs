import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'
import { createRecordView, exportMemoryBackup, planMemoryImport } from '../memory-contract.js'
import { matchRecallTriggers, validateRecallTriggers } from '../memory-triggers.js'
import { parseLearningResult } from '../memory-intelligence.js'

const triggers = [{ when: '准备做数据搬家时回顾兼容性教训', cues: ['数据搬家', '迁移脚本'] }]
const seedSleep = async (harness) => {
    await harness.table.put('smm_a', fixture('smm_a', { strength: 0.4 }))
    await harness.table.put('smm_b', fixture('smm_b', { strength: 0.4 }))
}

test('睡眠审计先预演再落盘且历史分页不改变记忆', async () => {
    const harness = createHarness({ sleepAuditEnabled: true })
    await seedSleep(harness)
    const before = structuredClone([...harness.data])
    const preview = await harness.call('memory_sleep', { dryRun: true })
    assert.equal(preview.forgettingPaused, true)
    assert.deepEqual([...harness.data], before)
    assert.equal((await harness.call('memory_manage', { action: 'sleepHistory' })).total, 0)
    const result = await harness.call('memory_sleep', {})
    assert.match(result.auditId, /^sleep_/)
    const writes = harness.writes.length
    const history = await harness.api.manage({ action: 'sleepHistory', limit: 1 })
    assert.equal(history.total, 1)
    assert.equal(history.items[0].state, 'applied')
    assert.equal(history.items[0].changes, undefined)
    const detail = await harness.call('memory_manage', { action: 'sleepHistory', batchId: result.auditId })
    assert.equal(detail.items[0].changes.length, 3)
    assert.equal(harness.writes.length, writes)
    assert.equal((await harness.call('memory_manage', { action: 'sleepHistory', limit: 0 })).code, 'invalid_args')
    await harness.dispose()
})

test('回滚恢复成员原文并停用新概要且重复确认幂等', async () => {
    const harness = createHarness({ sleepAuditEnabled: true })
    await seedSleep(harness)
    const before = structuredClone([...harness.data])
    const slept = await harness.call('memory_sleep', {})
    const args = { action: 'sleepRollback', batchId: slept.auditId }
    const plan = await harness.call('memory_manage', args)
    assert.equal(plan.dryRun, true)
    assert.equal(plan.restoredCount, 2)
    assert.equal(plan.invalidatedCount, 1)
    assert.equal((await harness.call('memory_manage', { ...args, dryRun: false })).code, 'confirmation_required')
    const result = await harness.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
    assert.equal(result.state, 'rolled-back')
    for (const [id, record] of before) assert.deepEqual(harness.table.get(id), record)
    const view = createRecordView([...harness.table.entries()])
    const summary = harness.table.get(slept.consolidated[0].deepId)
    assert.equal(view.isCurrent(summary), false)
    assert.equal(harness.data.size, 3, '回滚保留审计证据且不执行物理删除')
    const backup = (await harness.call('memory_manage', { action: 'export' })).backup
    const target = createHarness()
    assert.equal((await target.call('memory_manage', { action: 'import', backup })).planned, 3)
    await target.dispose()
    const writes = harness.writes.length
    assert.equal((await harness.call('memory_manage', { ...args, dryRun: false, planToken: plan.planToken })).state, 'rolled-back')
    assert.equal(harness.writes.length, writes)
    await harness.dispose()
})

test('后续强化或新增纠正会阻止旧批次覆盖', async () => {
    for (const changed of ['reinforce', 'correct']) {
        const harness = createHarness({ sleepAuditEnabled: true })
        await seedSleep(harness)
        const slept = await harness.call('memory_sleep', {})
        if (changed === 'reinforce') await harness.call('memory_recall', { query: '部署' })
        if (changed === 'correct') await harness.call('memory_manage', { action: 'correct', id: 'smm_a', content: '部署约定现在使用新参数' })
        const before = structuredClone([...harness.data])
        assert.equal((await harness.call('memory_manage', { action: 'sleepRollback', batchId: slept.auditId })).code, 'audit_conflict')
        assert.deepEqual([...harness.data], before)
        await harness.dispose()
    }
})

test('睡眠中断后重载使用原批次和固定概要 ID 恢复', async () => {
    const data = new Map()
    const domains = new Map()
    const runtimeData = new Map()
    const failure = { enabled: false, writes: 0 }
    const harness = createHarness({ sleepAuditEnabled: true }, {
        data, domains, runtimeData,
        beforePut() {
            if (failure.enabled && ++failure.writes === 2) throw new Error('模拟睡眠写入中断')
        },
    })
    await seedSleep(harness)
    failure.enabled = true
    await assert.rejects(harness.call('memory_sleep', {}), /模拟睡眠写入中断/)
    const pending = (await harness.call('memory_manage', { action: 'sleepHistory' })).items[0]
    assert.equal(pending.state, 'prepared')
    await harness.dispose()
    const restarted = createHarness({ sleepAuditEnabled: false }, { data, domains, runtimeData })
    const stats = await restarted.api.stats()
    assert.equal(stats.total, 1)
    assert.equal(data.size, 3)
    const history = await restarted.call('memory_manage', { action: 'sleepHistory' })
    assert.equal(history.items[0].id, pending.id)
    assert.equal(history.items[0].state, 'applied')
    assert.equal(history.total, 1)
    assert.equal([...data.values()].filter((record) => record.layer === 'deep').length, 1)
    await restarted.dispose()
})

test('回滚中断后可以续写且不重复停用概要', async () => {
    const failure = { enabled: false, writes: 0 }
    const harness = createHarness({ sleepAuditEnabled: true }, {
        beforePut() {
            if (failure.enabled && ++failure.writes === 2) throw new Error('模拟回滚中断')
        },
    })
    await seedSleep(harness)
    const before = structuredClone([...harness.data])
    const slept = await harness.call('memory_sleep', {})
    const args = { action: 'sleepRollback', batchId: slept.auditId }
    const plan = await harness.call('memory_manage', args)
    failure.enabled = true
    await assert.rejects(harness.call('memory_manage', { ...args, dryRun: false, planToken: plan.planToken }), /模拟回滚中断/)
    failure.enabled = false
    assert.equal((await harness.call('memory_manage', { action: 'sleepRecover' })).recovered, 1)
    for (const [id, record] of before) assert.deepEqual(harness.table.get(id), record)
    assert.equal((await harness.call('memory_manage', { action: 'sleepHistory' })).items[0].state, 'rolled-back')
    await harness.dispose()
})

test('审计落盘失败不改记忆且未知后态拒绝恢复', async () => {
    const failure = { journal: true, record: false }
    const harness = createHarness({ sleepAuditEnabled: true }, {
        beforeDomainPut(name, _id, batch) {
            if (name === 'memory_sleep_audit' && failure.journal && batch.state === 'prepared') throw new Error('审计写入失败')
        },
        beforePut() { if (failure.record) throw new Error('记忆写入失败') },
    })
    await seedSleep(harness)
    const before = structuredClone([...harness.data])
    await assert.rejects(harness.call('memory_sleep', {}), /审计写入失败/)
    assert.deepEqual([...harness.data], before)
    failure.journal = false
    failure.record = true
    await assert.rejects(harness.call('memory_sleep', {}), /记忆写入失败/)
    failure.record = false
    await harness.table.put('smm_a', { ...harness.table.get('smm_a'), content: '恢复前发生了人工纠正' })
    const changed = structuredClone([...harness.data])
    await assert.rejects(harness.call('memory_manage', { action: 'sleepRecover' }), /后续修改/)
    assert.deepEqual([...harness.data], changed)
    await assert.rejects(harness.api.stats(), /后续修改/)
    await harness.dispose()
})

test('审计模式暂停物理遗忘且默认模式保持兼容', async () => {
    const harness = createHarness({ sleepAuditEnabled: true })
    const old = Date.now() - 200 * 86_400_000
    await harness.table.put('smm_old', fixture('smm_old', { layer: 'archive', strength: 0, createdAt: old, lastAccessAt: old }))
    const result = await harness.call('memory_sleep', {})
    assert.equal(result.deletedCount, 0)
    assert.equal(result.forgettingPaused, true)
    assert.ok(harness.table.get('smm_old'))
    assert.equal((await harness.call('memory_manage', { action: 'forget', id: 'smm_old' })).code, 'audit_retention')
    await harness.dispose()
    const original = createHarness()
    assert.equal((await original.call('memory_manage', { action: 'sleepHistory' })).total, 0)
    await original.dispose()
})

test('完成标记落盘失败后恢复只补状态且不重复写入记忆', async () => {
    const failure = { enabled: true }
    const harness = createHarness({ sleepAuditEnabled: true }, {
        beforeDomainPut(name, _id, batch) {
            if (name === 'memory_sleep_audit' && failure.enabled && batch.state === 'applied') {
                throw new Error('模拟完成标记丢失')
            }
        },
    })
    await seedSleep(harness)
    await assert.rejects(harness.call('memory_sleep', {}), /模拟完成标记丢失/)
    const writes = harness.writes.length
    failure.enabled = false
    assert.equal((await harness.call('memory_manage', { action: 'sleepRecover' })).recovered, 1)
    assert.equal(harness.writes.length, writes)
    assert.equal((await harness.call('memory_manage', { action: 'sleepHistory' })).items[0].state, 'applied')
    await harness.dispose()
})

test('重启后直接回滚旧批次也先恢复较新的未完成批次', async () => {
    const data = new Map()
    const domains = new Map()
    const runtimeData = new Map()
    const failure = { enabled: false }
    const harness = createHarness({ sleepAuditEnabled: true }, {
        data, domains, runtimeData,
        beforeDomainPut(name, _id, batch) {
            if (name === 'memory_sleep_audit' && failure.enabled && batch.state === 'applied') {
                throw new Error('新批次完成标记未写入')
            }
        },
    })
    await seedSleep(harness)
    const first = await harness.call('memory_sleep', {})
    failure.enabled = true
    await assert.rejects(harness.call('memory_sleep', {}), /新批次完成标记未写入/)
    const pending = (await harness.call('memory_manage', { action: 'sleepHistory' })).items.find((batch) => batch.state === 'prepared')
    assert.ok(pending)
    await harness.dispose()
    const restarted = createHarness({ sleepAuditEnabled: false }, { data, domains, runtimeData })
    await restarted.call('memory_manage', { action: 'sleepRollback', batchId: first.auditId })
    const history = await restarted.call('memory_manage', { action: 'sleepHistory', batchId: pending.id })
    assert.equal(history.items[0].state, 'applied')
    await restarted.dispose()
})

test('读取隔离恢复期间的中间状态且失败后可以显式重试', async () => {
    const failure = { enabled: false }
    const harness = createHarness({ sleepAuditEnabled: true }, {
        beforePut() { if (failure.enabled) throw new Error('写入暂不可用') },
    })
    await seedSleep(harness)
    failure.enabled = true
    await assert.rejects(harness.call('memory_sleep', {}), /写入暂不可用/)
    await assert.rejects(harness.api.list(), /写入暂不可用/)
    await assert.rejects(harness.call('memory_write', { kind: 'fact', content: '恢复前不允许新写入' }), /写入暂不可用/)
    failure.enabled = false
    assert.equal((await harness.call('memory_manage', { action: 'sleepRecover' })).recovered, 1)
    assert.equal((await harness.api.list()).total, 1)
    await harness.dispose()
})

test('情境短语可召回无共同词语的经历且默认不启用', async () => {
    for (const enabled of [false, true]) {
        const harness = createHarness({ contextualRecallEnabled: enabled })
        const written = await harness.call('memory_write', {
            kind: 'experience', content: '旧语句执行失败。应先核对目标产品的兼容清单。', recallTriggers: triggers,
        })
        const recalled = await harness.call('memory_recall', { query: '准备做数据搬家' })
        assert.equal(recalled.hits.some((hit) => hit.id === written.id), enabled)
        if (enabled) assert.deepEqual(recalled.hits[0].retrieval.triggers[0].cues, ['数据搬家'])
        const unrelated = await injectMessage(harness, createMessage('今天调整按钮颜色', 'unrelated'))
        assert.equal(unrelated.messages.length, 1)
        if (enabled) {
            const injected = await injectMessage(harness, createMessage('准备做数据搬家', 'related'))
            assert.match(injected.messages[1].content[0].text, /情境线索/)
        }
        await harness.dispose()
    }
})

test('情境通道不能绕过项目、有效性、时间与精确实体约束', async () => {
    const harness = createHarness({ contextualRecallEnabled: true })
    const record = await harness.call('memory_write', {
        kind: 'fact', content: 'Spring Boot 3.2.11 要执行兼容检查。',
        projectId: '甲', recallTriggers: triggers,
    })
    assert.equal((await harness.call('memory_recall', { query: '数据搬家', projectId: '乙' })).count, 0)
    assert.equal((await harness.call('memory_recall', { query: '数据搬家', projectId: '甲', until: 1 })).count, 0)
    assert.equal((await harness.call('memory_recall', { query: 'Spring Boot 3.2.12 数据搬家', projectId: '甲' })).count, 0)
    const plan = await harness.call('memory_manage', { action: 'setState', id: record.id, projectId: '甲', state: 'invalid', reason: '经验不再适用' })
    await harness.call('memory_manage', {
        action: 'setState', id: record.id, projectId: '甲', state: 'invalid', reason: '经验不再适用',
        dryRun: false, planToken: plan.planToken,
    })
    assert.equal((await harness.call('memory_recall', { query: '数据搬家', projectId: '甲' })).count, 0)
    await harness.dispose()
})

test('情境候选仍须通过审核且共享注入预算', async () => {
    const harness = createHarness({ contextualRecallEnabled: true, recallReviewEnabled: true }, {
        llm: {
            prepareCall: async () => ({
                config: {},
                stream: async function* (request) {
                    const payload = JSON.parse(request.messages[1].content[0].text)
                    assert.deepEqual(payload.candidates[0].triggerConditions, triggers.map((trigger) => ({ ...trigger, cues: ['数据搬家'] })))
                    yield { type: 'text-delta', text: '{"decisions":[]}' }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    })
    await harness.call('memory_write', { kind: 'experience', content: '特殊教训需要核对', recallTriggers: triggers })
    const result = await injectMessage(harness, createMessage('数据搬家'))
    assert.equal(result.messages.length, 1)
    assert.equal((await harness.api.status()).review.rejected, 1)
    await harness.dispose()
    const bounded = createHarness({
        contextualRecallEnabled: true, injectMaxEstimatedTokens: 100, injectMaxCharsPerHit: 1000,
    })
    const written = await bounded.call('memory_write', {
        kind: 'experience', content: '兼容性检查需要逐项核对目标产品、版本和语句。'.repeat(30), recallTriggers: triggers,
    })
    assert.equal((await injectMessage(bounded, createMessage('数据搬家'))).messages.length, 1)
    assert.equal(bounded.table.get(written.id).accessCount, 0)
    assert.ok((await bounded.api.status()).injection.budgetSkipped > 0)
    await bounded.dispose()
})

test('触发条件经过边界校验且标识符组件不能误命中', () => {
    assert.equal(validateRecallTriggers([{ when: '使用标记时', cues: ['flag'] }]).length, 0)
    assert.equal(validateRecallTriggers([{ when: '', cues: ['迁移'] }]).length, 1)
    assert.equal(validateRecallTriggers([{ when: '泛词', cues: ['的'] }]).length, 1)
    assert.equal(validateRecallTriggers([{ when: '数字', cues: ['443'] }]).length, 1)
    assert.equal(validateRecallTriggers([{ when: '未知参数', cues: ['迁移'], priority: 1 }]).length, 1)
    assert.equal(matchRecallTriggers({ recallTriggers: [{ when: '操作标记', cues: ['flag'] }] }, 'status_flag').length, 0)
    assert.equal(matchRecallTriggers({ recallTriggers: [{ when: '操作标记', cues: ['flag'] }] }, '检查 FLAG。').length, 1)
})

test('触发条件在巩固、纠正与备份后保留且可以清空', async () => {
    const harness = createHarness({ contextualRecallEnabled: true })
    await seedSleep(harness)
    await harness.table.put('smm_a', { ...harness.table.get('smm_a'), recallTriggers: triggers })
    const slept = await harness.call('memory_sleep', {})
    const summary = harness.table.get(slept.consolidated[0].deepId)
    assert.deepEqual(summary.recallTriggers, triggers)
    assert.equal((await harness.call('memory_recall', { query: '数据搬家' })).hits[0].id, summary.id)
    const correction = await harness.call('memory_manage', { action: 'correct', id: 'smm_a', content: '部署修正内容', recallTriggers: [] })
    assert.deepEqual(harness.table.get(correction.id).recallTriggers, [])
    const backup = exportMemoryBackup(harness.table)
    assert.equal(planMemoryImport(harness.table, backup, (record) => record, 100).pending.length, 0)
    await harness.reloadRecords()
    await harness.dispose()
})

test('触发入口过多时保留原记忆且不丢失条件', async () => {
    const harness = createHarness({ contextualRecallEnabled: true, maxRecords: 3 })
    const entries = Array.from({ length: 6 }, (_, index) => ({
        when: `执行场景 ${index} 时`, cues: [`入口${index}`],
    }))
    await seedSleep(harness)
    await harness.table.put('smm_a', { ...harness.table.get('smm_a'), recallTriggers: entries.slice(0, 3) })
    await harness.table.put('smm_b', { ...harness.table.get('smm_b'), recallTriggers: entries.slice(3) })
    const slept = await harness.call('memory_sleep', {})
    assert.equal(slept.consolidatedCount, 0)
    assert.deepEqual(harness.table.get('smm_a').recallTriggers, entries.slice(0, 3))
    assert.deepEqual(harness.table.get('smm_b').recallTriggers, entries.slice(3))
    assert.equal((await harness.call('memory_recall', { query: '入口5' })).hits[0].id, 'smm_b')
    await harness.dispose()
})

test('自动学习接受合法条件并拒绝含密钥的条件', () => {
    const candidate = {
        content: '以后迁移前需要核对兼容性', category: 'lesson', confidence: 0.9,
        reason: '迁移时复用', relation: 'new', relatedIds: [], keywords: [],
        evidence: [{ messageId: 'user', quote: '以后迁移前需要核对兼容性' }],
        recallTriggers: [{ when: '迁移前回顾', cues: ['迁移'] }],
    }
    const messages = [{ id: 'user', role: 'user', text: '以后迁移前需要核对兼容性' }]
    assert.equal(parseLearningResult(JSON.stringify({ memories: [candidate] }), messages, [], 3).length, 1)
    assert.equal(parseLearningResult(JSON.stringify({ memories: [{ ...candidate, recallTriggers: triggers }] }), messages, [], 3).length, 0)
    assert.equal(parseLearningResult(JSON.stringify({ memories: [{
        ...candidate, recallTriggers: [{ when: '检查 api_key=secret_value', cues: ['迁移'] }],
    }] }), messages, [], 3).length, 0)
})
