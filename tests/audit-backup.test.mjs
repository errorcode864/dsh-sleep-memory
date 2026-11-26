import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupChecksum } from '../memory-contract.js'
import { createHarness, fixture } from './harness.mjs'

async function createSource() {
    const host = createHarness({ sleepAuditEnabled: true })
    await host.table.put('smm_backup_a', fixture('smm_backup_a', { strength: 0.4 }))
    await host.table.put('smm_backup_b', fixture('smm_backup_b', { strength: 0.4 }))
    const slept = await host.call('memory_sleep', {})
    const backup = (await host.api.manage({ action: 'export', includeAudit: true })).backup
    return { host, slept, backup }
}

test('记忆与审计备份导入后保留回滚能力且默认导出仍为 v1', async () => {
    const { host, slept, backup } = await createSource()
    const target = createHarness()
    try {
        assert.equal((await host.api.manage({ action: 'export' })).backup.version, 1)
        assert.equal(backup.version, 2)
        assert.equal(backup.audits.length, 1)
        const args = { action: 'import', backup }
        const plan = await target.api.manage(args)
        assert.equal(plan.planned, 3)
        assert.equal(plan.plannedAudits, 1)
        assert.equal(target.data.size, 0)
        assert.equal((await target.call('memory_manage', { ...args, dryRun: false })).code, 'confirmation_required')
        const result = await target.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        assert.equal(result.importedAudits, 1)
        const repeated = await target.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        assert.equal(repeated.imported, 0)
        assert.equal(repeated.importedAudits, 0)
        const rollback = await target.api.manage({ action: 'sleepRollback', batchId: slept.auditId })
        await target.api.manage({
            action: 'sleepRollback', batchId: slept.auditId, dryRun: false, planToken: rollback.planToken,
        })
        assert.equal(target.table.get('smm_backup_a').supersededBy, null)
        const state = target.domains.get('memory_backup_state').get('restore')
        assert.equal(state.state, 'complete')
        assert.equal(state.records, undefined, '完成后恢复计划不保留内容副本')
    } finally {
        await host.dispose()
        await target.dispose()
    }
})

test('审计备份校验、冲突与待执行批次均在写入前拒绝', async () => {
    const { host, backup } = await createSource()
    for (const mode of ['checksum', 'record', 'audit', 'pending', 'duplicate']) {
        const target = createHarness()
        const input = structuredClone(backup)
        if (mode === 'checksum') input.records[0].content = '被修改的正文'
        if (mode === 'record') await target.table.put(input.records[0].id, { ...input.records[0], content: '本地已有新事实' })
        if (mode === 'audit') target.domains.get('memory_sleep_audit').set(input.audits[0].id, {
            ...input.audits[0], report: { changed: true },
        })
        if (mode === 'pending') input.audits[0].state = 'prepared'
        if (mode === 'duplicate') input.audits.push(input.audits[0])
        if (mode !== 'checksum') input.checksum = backupChecksum({ records: input.records, audits: input.audits })
        const before = structuredClone([...target.data])
        const result = await target.call('memory_manage', { action: 'import', backup: input })
        assert.equal(result.code, 'invalid_args', mode)
        assert.deepEqual([...target.data], before)
        await target.dispose()
    }
    await host.dispose()
})

test('跨域导入中断后重载先完成原计划且相同备份不会重复写入', async () => {
    const { host, backup } = await createSource()
    const data = new Map()
    const domains = new Map()
    const runtimeData = new Map()
    const failure = { enabled: false }
    const target = createHarness({}, {
        data, domains, runtimeData,
        beforeDomainPut(name) {
            if (name === 'memory_sleep_audit' && failure.enabled) throw new Error('审计导入写入中断')
        },
    })
    const args = { action: 'import', backup }
    const plan = await target.api.manage(args)
    failure.enabled = true
    await assert.rejects(target.api.manage({ ...args, dryRun: false, planToken: plan.planToken }), /导入写入中断/)
    assert.equal(data.size, 3)
    await assert.rejects(target.api.stats(), /导入写入中断/)
    await target.dispose()
    const restarted = createHarness({}, { data, domains, runtimeData })
    try {
        await restarted.api.stats()
        const repeated = await restarted.api.manage(args)
        assert.equal(repeated.planned, 0)
        assert.equal(repeated.plannedAudits, 0)
        assert.equal((await restarted.api.manage({ action: 'sleepHistory' })).total, 1)
        assert.equal(domains.get('memory_backup_state').get('restore').state, 'complete')
    } finally {
        await restarted.dispose()
        await host.dispose()
    }
})

test('恢复计划写入失败不修改记忆且后续本地冲突会阻止恢复', async () => {
    const { host, backup } = await createSource()
    const failure = { prepare: true, record: false }
    const target = createHarness({}, {
        beforeDomainPut(name, _id, value) {
            if (name === 'memory_backup_state' && failure.prepare && value.state === 'prepared') throw new Error('恢复计划保存失败')
        },
        beforePut() { if (failure.record) throw new Error('导入记忆写入失败') },
    })
    const args = { action: 'import', backup }
    const plan = await target.api.manage(args)
    await assert.rejects(target.api.manage({ ...args, dryRun: false, planToken: plan.planToken }), /计划保存失败/)
    assert.equal(target.data.size, 0)
    failure.prepare = false
    failure.record = true
    await assert.rejects(target.api.manage({ ...args, dryRun: false, planToken: plan.planToken }), /记忆写入失败/)
    failure.record = false
    await target.table.put(backup.records[0].id, { ...backup.records[0], content: '恢复前人工修改' })
    await assert.rejects(target.api.stats(), /本地冲突/)
    await target.dispose()
    await host.dispose()
})

test('容量统计使用 UTF-8 内容字节且超限前拒绝整批睡眠', async () => {
    const host = createHarness({ sleepAuditEnabled: true, sleepAuditMaxBytes: 1 })
    await host.table.put('smm_capacity', fixture('smm_capacity'))
    const before = structuredClone([...host.data])
    await assert.rejects(host.call('memory_sleep', {}), /容量上限/)
    assert.deepEqual([...host.data], before)
    assert.equal((await host.api.manage({ action: 'sleepStats' })).batchCount, 0)
    await host.dispose()
    const source = await createSource()
    const stats = await source.host.api.manage({ action: 'sleepStats' })
    assert.equal(stats.batchCount, 1)
    assert.equal(stats.states.applied, 1)
    assert.equal(stats.retainedBytes, Buffer.byteLength(JSON.stringify(source.backup.audits[0])))
    assert.equal(stats.measurement, 'json-utf8')
    await source.host.dispose()
})

test('完成标记写入失败后只补标记且重复确认不重写记忆', async () => {
    const { host, backup } = await createSource()
    const failure = { enabled: true }
    const target = createHarness({}, {
        beforeDomainPut(name, _id, value) {
            if (name === 'memory_backup_state' && value.state === 'complete' && failure.enabled) {
                throw new Error('备份完成标记写入失败')
            }
        },
    })
    try {
        const args = { action: 'import', backup }
        const plan = await target.api.manage(args)
        await assert.rejects(target.api.manage({ ...args, dryRun: false, planToken: plan.planToken }), /完成标记/)
        const writes = target.writes.length
        failure.enabled = false
        const repeated = await target.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        assert.equal(repeated.imported, 0)
        assert.equal(repeated.importedAudits, 0)
        assert.equal(target.writes.length, writes)
        assert.equal(target.domains.get('memory_backup_state').get('restore').state, 'complete')
    } finally {
        await target.dispose()
        await host.dispose()
    }
})
