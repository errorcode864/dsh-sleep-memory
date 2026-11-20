import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupChecksum, createRecordView } from '../memory-contract.js'
import { createHarness, fixture } from './harness.mjs'

const config = { sleepAuditEnabled: true, reconsolidationEnabled: true }
const sourceEdges = (...ids) => ids.map((target) => ({ target, relation: 'consolidates', weight: 1 }))
const evidence = (id, text = '发布数据库迁移前需要备份。', overrides = {}) =>
    fixture(id, { content: text, strength: 0.4, ...overrides })

async function seed(host, overrides = {}) {
    await host.table.put('smm_a', evidence('smm_a', '发布数据库迁移前需要备份。仅在维护窗口执行。', overrides))
    await host.table.put('smm_b', evidence('smm_b', '发布数据库迁移前需要检查备份。完成后验证恢复。', overrides))
    return (await host.call('memory_sleep', {})).consolidated[0].deepId
}

async function changeState(host, id, state) {
    const args = { action: 'setState', id, state, reason: '验收来源有效性传播' }
    const plan = await host.api.manage(args)
    return host.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
}

test('再巩固默认关闭且必须启用睡眠审计', async () => {
    assert.throws(() => createHarness({ reconsolidationEnabled: true }), /sleepAuditEnabled/)
    const host = createHarness()
    const previousId = await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    const result = await host.call('memory_sleep', {})
    assert.equal(result.reconsolidatedCount, undefined)
    assert.equal(host.table.get(previousId).supersededBy, null)
    assert.equal((await host.api.status()).reconsolidationEnabled, false)
    await host.dispose()
})

test('跨批次从原文生成新概要且预演只读和重复睡眠幂等', async () => {
    const host = createHarness(config)
    const previousId = await seed(host)
    const oldContent = host.table.get(previousId).content
    await host.table.put('smm_c', evidence('smm_c', '发布数据库迁移前需要备份。新增证据必须核对恢复耗时。', {
        createdAt: Date.now() + 10, occurredAt: 100, eventEndAt: 200,
    }))
    const before = structuredClone([...host.data])
    const preview = await host.call('memory_sleep', { dryRun: true })
    assert.equal(preview.reconsolidatedCount, 1)
    assert.deepEqual([...host.data], before)
    const result = await host.call('memory_sleep', {})
    const revision = result.reconsolidated[0]
    const next = host.table.get(revision.deepId)
    assert.equal(revision.previousId, previousId)
    assert.equal(revision.matches[0].id, 'smm_c')
    assert.ok(revision.matches[0].similarity >= 0.45)
    assert.equal(host.table.get(previousId).content, oldContent)
    assert.equal(host.table.get(previousId).supersededBy, next.id)
    assert.deepEqual(new Set(next.edges.filter((edge) => edge.relation === 'consolidates').map((edge) => edge.target)),
        new Set(['smm_a', 'smm_b', 'smm_c']))
    assert.equal(next.content.match(/【沉淀】/g).length, 1)
    assert.equal(next.occurredAt, 100)
    for (const id of ['smm_a', 'smm_b', 'smm_c']) assert.equal(host.table.get(id).supersededBy, next.id)
    const detail = await host.api.getRecord({ id: next.id })
    assert.equal(detail.summaryVersion.previousId, previousId)
    assert.equal((await host.api.getRecord({ id: previousId })).summaryVersion.nextId, next.id)
    assert.equal((await host.api.getRecord({ id: previousId })).current, false)
    const trace = await host.api.manage({ action: 'traceSources', id: next.id })
    assert.equal(trace.complete, true)
    assert.equal(trace.items.length, 3)
    assert.ok(trace.items.every((item) => item.leaf))
    const repeated = await host.call('memory_sleep', {})
    assert.equal(repeated.reconsolidatedCount, 0)
    assert.equal(repeated.consolidatedCount, 0)
    assert.equal(repeated.recordsAfter, result.recordsAfter)
    await host.reloadRecords()
    await host.dispose()
})

test('纠正和撤回使旧概要失效且下轮重建只保留有效来源', async () => {
    const host = createHarness(config)
    const previousId = await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    const first = (await host.call('memory_sleep', {})).reconsolidated[0].deepId
    const correction = await host.call('memory_manage', {
        action: 'correct', id: 'smm_a', content: '迁移前改为仅对只读副本做快照。',
    })
    assert.equal((await host.api.getRecord({ id: first })).current, false)
    await changeState(host, 'smm_b', 'invalid')
    const second = (await host.call('memory_sleep', {})).reconsolidated[0].deepId
    const detail = await host.api.getRecord({ id: second })
    assert.deepEqual(new Set(detail.sources.map((source) => source.id)), new Set([correction.id, 'smm_c']))
    assert.equal(detail.current, true)
    assert.ok(detail.record.content.includes('只读副本'))
    assert.equal((await host.api.getRecord({ id: previousId })).current, false)
    await changeState(host, second, 'invalid')
    assert.equal((await host.api.getRecord({ id: first })).current, false, '最新版本失效不能复活旧概要')
    await host.dispose()
})

test('多层来源去重并保留旧路径和中间概要的隐藏状态', async () => {
    const host = createHarness(config)
    await host.table.put('smm_a', evidence('smm_a', undefined, { supersededBy: 'smm_mid' }))
    await host.table.put('smm_b', evidence('smm_b', undefined, { supersededBy: 'smm_old' }))
    await host.table.put('smm_mid', evidence('smm_mid', '中间压缩文字不应再次摘要', {
        layer: 'deep', supersededBy: 'smm_old', edges: sourceEdges('smm_a'),
    }))
    await host.table.put('smm_old', evidence('smm_old', '旧概要省略了原始条件', {
        layer: 'deep', edges: sourceEdges('smm_mid', 'smm_b', 'smm_a'),
    }))
    await host.table.put('smm_c', evidence('smm_c'))
    const result = await host.call('memory_sleep', {})
    const current = host.table.get(result.reconsolidated[0].deepId)
    assert.equal(current.content.includes('中间压缩文字'), false)
    assert.equal(current.edges.filter((edge) => edge.relation === 'consolidates').length, 3)
    assert.equal(createRecordView([...host.table.entries()]).isConsolidated(host.table.get('smm_mid')), true)
    const historical = await host.api.manage({ action: 'traceSources', id: 'smm_old' })
    assert.ok(historical.items.some((item) => item.path.join('/') === 'smm_old/smm_mid/smm_a'))
    await host.dispose()
})

test('已移出概要的来源重新启用后独立召回且下轮重新承接', async () => {
    const host = createHarness(config)
    await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    await host.call('memory_sleep', {})
    await changeState(host, 'smm_b', 'invalid')
    const previous = (await host.call('memory_sleep', {})).reconsolidated[0].deepId
    assert.equal((await host.api.getRecord({ id: previous })).totalSources, 2)
    await changeState(host, 'smm_b', 'active')
    assert.equal(createRecordView([...host.table.entries()]).isConsolidated(host.table.get('smm_b')), false)
    const result = await host.call('memory_sleep', {})
    assert.equal(result.reconsolidatedCount, 1)
    assert.equal((await host.api.getRecord({ id: result.reconsolidated[0].deepId })).totalSources, 3)
    const definition = host.tools.get('memory_sleep')
    const meta = definition.output.presentationMeta({}, result)
    const card = definition.presentResult({}, { meta })
    assert.ok(JSON.stringify(card).includes('深层再巩固 1'))
    await host.dispose()
})

test('项目、类型、休眠和触发入口限制不能被再巩固绕过', async () => {
    for (const variant of ['project', 'kind', 'dormant', 'triggers']) {
        const host = createHarness(config)
        const previousId = await seed(host, variant === 'project' ? { projectId: '甲' } : {})
        if (variant === 'dormant') {
            await host.table.update(previousId, (record) => ({
                ...record, access: { state: 'dormant', at: Date.now(), reason: '验收休眠' },
            }))
        }
        if (variant === 'triggers') {
            await host.table.update(previousId, (record) => ({
                ...record, recallTriggers: [1, 2, 3, 4].map((n) => ({ when: `迁移情境 ${n}`, cues: [`迁移线索 ${n}`] })),
            }))
        }
        await host.table.put('smm_c', evidence('smm_c', undefined, {
            ...(variant === 'project' ? { projectId: '乙' } : {}),
            ...(variant === 'kind' ? { kind: 'experience' } : {}),
            ...(variant === 'triggers' ? { recallTriggers: [{ when: '新维护场景', cues: ['新维护线索'] }] } : {}),
        }))
        const result = await host.call('memory_sleep', {})
        assert.equal(result.reconsolidatedCount, 0, variant)
        assert.equal(host.table.get(previousId).supersededBy, null, variant)
        if (variant === 'triggers') assert.deepEqual(result.reconsolidationSkipped[0].reasons, ['trigger-limit'])
        await host.dispose()
    }
})

test('缺失、循环、深度和来源数量超限拒绝部分再巩固', async () => {
    for (const variant of ['missing', 'cycle', 'depth', 'sources']) {
        const host = createHarness(config)
        await host.table.put('smm_a', evidence('smm_a', undefined, { supersededBy: 'smm_old' }))
        const targets = ['smm_a']
        if (variant === 'missing') targets.push('smm_missing')
        if (variant === 'cycle') targets.push('smm_old')
        if (variant === 'depth') {
            for (let index = 0; index < 9; index += 1) {
                await host.table.put(`smm_nested_${index}`, evidence(`smm_nested_${index}`, undefined, {
                    layer: 'deep', supersededBy: index === 0 ? 'smm_old' : `smm_nested_${index - 1}`,
                    edges: sourceEdges(index === 8 ? 'smm_a' : `smm_nested_${index + 1}`),
                }))
            }
            targets.push('smm_nested_0')
        }
        if (variant === 'sources') {
            for (let index = 0; index < 101; index += 1) {
                const id = `smm_source_${index}`
                await host.table.put(id, evidence(id, undefined, { supersededBy: 'smm_old' }))
                targets.push(id)
            }
        }
        await host.table.put('smm_old', evidence('smm_old', undefined, { layer: 'deep', edges: sourceEdges(...targets) }))
        await host.table.put('smm_c', evidence('smm_c'))
        const result = await host.call('memory_sleep', {})
        assert.equal(result.reconsolidatedCount, 0, variant)
        assert.ok(result.reconsolidationSkippedCount > 0, variant)
        assert.equal(host.table.get('smm_old').supersededBy, null)
        await host.dispose()
    }
})

test('审计容量和记忆容量拒绝不改写已有概要版本', async () => {
    const host = createHarness(config)
    const previousId = await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    const before = structuredClone([...host.data])
    await host.dispose()
    const full = createHarness({ ...config, maxRecords: host.data.size }, { data: host.data, domains: host.domains })
    const result = await full.call('memory_sleep', {})
    assert.equal(result.capacityLimited, true)
    assert.equal(result.reconsolidatedCount, 0)
    assert.equal(full.table.get(previousId).supersededBy, null)
    await full.dispose()
    const capped = createHarness({ ...config, sleepAuditMaxBytes: 1 }, { data: new Map(before) })
    await assert.rejects(capped.call('memory_sleep', {}), { code: 'audit_capacity' })
    assert.deepEqual([...capped.data], before)
    await capped.dispose()
})

test('再巩固部分写入可重载恢复且两轮审计按逆序回滚', async () => {
    let armed = false
    let writes = 0
    const host = createHarness(config, { beforePut: () => {
        if (armed && ++writes === 2) throw new Error('验收再巩固写入中断')
    } })
    const previousId = await seed(host)
    const firstBatch = (await host.api.manage({ action: 'sleepHistory' })).items[0].id
    await host.table.put('smm_c', evidence('smm_c'))
    const before = structuredClone([...host.data])
    armed = true
    await assert.rejects(host.call('memory_sleep', {}), /写入中断/)
    await host.dispose()
    const resumed = createHarness(config, { data: host.data, domains: host.domains })
    assert.equal((await resumed.api.manage({ action: 'sleepRecover' })).recovered, 1)
    const history = await resumed.api.manage({ action: 'sleepHistory' })
    const batch = history.items.find((item) => item.id !== firstBatch)
    assert.equal(batch.state, 'applied')
    const currentId = batch.report.reconsolidated[0].deepId
    assert.equal((await resumed.api.getRecord({ id: currentId })).current, true)
    const plan = await resumed.api.manage({ action: 'sleepRollback', batchId: batch.id })
    const rollback = await resumed.api.manage({ action: 'sleepRollback', batchId: batch.id, dryRun: false, planToken: plan.planToken })
    assert.equal(rollback.state, 'rolled-back')
    for (const [id, record] of before) assert.deepEqual(resumed.table.get(id), record)
    assert.equal((await resumed.api.getRecord({ id: previousId })).current, true)
    assert.equal((await resumed.api.getRecord({ id: currentId })).current, false)
    const earlier = await resumed.api.manage({ action: 'sleepRollback', batchId: firstBatch })
    assert.equal(earlier.code, undefined)
    await resumed.api.manage({ action: 'sleepRollback', batchId: firstBatch, dryRun: false, planToken: earlier.planToken })
    assert.equal(createRecordView([...resumed.table.entries()]).isConsolidated(resumed.table.get('smm_a')), false)
    await resumed.dispose()
})

test('后续纠正会阻止再巩固批次回滚', async () => {
    const host = createHarness(config)
    await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    const result = await host.call('memory_sleep', {})
    await host.call('memory_manage', { action: 'correct', id: 'smm_c', content: '后续明确纠正' })
    assert.equal((await host.call('memory_manage', { action: 'sleepRollback', batchId: result.auditId })).code, 'audit_conflict')
    await host.dispose()
})

test('回滚中断重载后完成同一批次且允许再次生成版本', async () => {
    let interrupt = false
    let writes = 0
    const host = createHarness(config, { beforePut: () => {
        if (interrupt && ++writes === 2) throw new Error('验收回滚中断')
    } })
    const previousId = await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    const before = structuredClone([...host.data])
    const result = await host.call('memory_sleep', {})
    const plan = await host.api.manage({ action: 'sleepRollback', batchId: result.auditId })
    interrupt = true
    await assert.rejects(host.api.manage({
        action: 'sleepRollback', batchId: result.auditId, dryRun: false, planToken: plan.planToken,
    }), /回滚中断/)
    await host.dispose()
    const resumed = createHarness(config, { data: host.data, domains: host.domains })
    await resumed.api.manage({ action: 'sleepRecover' })
    for (const [id, record] of before) assert.deepEqual(resumed.table.get(id), record)
    const regenerated = await resumed.call('memory_sleep', {})
    assert.equal(regenerated.reconsolidatedCount, 1)
    assert.notEqual(regenerated.reconsolidated[0].deepId, result.reconsolidated[0].deepId)
    assert.equal((await resumed.api.getRecord({ id: previousId })).summaryVersion.nextId, regenerated.reconsolidated[0].deepId)
    const restored = createHarness(config)
    const { backup } = await resumed.api.manage({ action: 'export' })
    assert.equal((await restored.call('memory_manage', { action: 'import', backup, dryRun: false })).code, undefined)
    await restored.dispose()
    await resumed.dispose()
})

test('备份保留版本与审计且拒绝循环或跨类型版本', async () => {
    const host = createHarness(config)
    const previousId = await seed(host)
    await host.table.put('smm_c', evidence('smm_c'))
    const result = await host.call('memory_sleep', {})
    const { backup } = await host.api.manage({ action: 'export', includeAudit: true })
    const imported = createHarness(config)
    const preview = await imported.api.manage({ action: 'import', backup })
    await imported.api.manage({ action: 'import', backup, dryRun: false, planToken: preview.planToken })
    assert.equal((await imported.api.getRecord({ id: previousId })).summaryVersion.nextId, result.reconsolidated[0].deepId)
    const plan = await imported.api.manage({ action: 'sleepRollback', batchId: result.auditId })
    assert.equal(plan.code, undefined)
    await imported.api.manage({ action: 'sleepRollback', batchId: result.auditId, dryRun: false, planToken: plan.planToken })
    assert.equal((await imported.api.getRecord({ id: previousId })).current, true)
    const plain = (await host.api.manage({ action: 'export' })).backup
    for (const mode of ['cycle', 'kind', 'reason', 'branch']) {
        const bad = structuredClone(plain)
        const previous = bad.records.find((record) => record.id === previousId)
        const current = bad.records.find((record) => record.id === result.reconsolidated[0].deepId)
        if (mode === 'cycle') previous.edges.push({ target: current.id, relation: 'revises', weight: 1, reason: '错误循环' })
        if (mode === 'kind') previous.kind = 'experience'
        if (mode === 'reason') current.edges.find((edge) => edge.relation === 'revises').reason = ''
        if (mode === 'branch') previous.supersededBy = null
        bad.checksum = backupChecksum(bad.records)
        const empty = createHarness(config)
        const failure = await empty.call('memory_manage', { action: 'import', backup: bad })
        assert.equal(failure.code, 'invalid_args', mode)
        assert.equal(empty.data.size, 0)
        await empty.dispose()
    }
    await imported.dispose()
    await host.dispose()
})
