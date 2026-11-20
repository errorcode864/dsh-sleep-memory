import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupChecksum, createRecordView } from '../memory-contract.js'
import { recollectionVersion } from '../memory-recollection.js'
import { planNarrativeImport } from '../memory-narrative-backup.js'
import { backupStateDomainSpec } from '../memory-backup.js'
import { createHarness, fixture } from './harness.mjs'

const EXPORT = { action: 'export', includeAudit: true, includeFeedback: true, includeNarratives: true }
const history = (host) => host.api.manage({ action: 'narrativeHistory', id: 'smm_narrative_backup', projectId: '甲' })
const recalculate = (backup) => {
    backup.checksum = backupChecksum({ records: backup.records, audits: backup.audits, feedback: backup.feedback, narratives: backup.narratives })
    return backup
}

async function createSource() {
    const host = createHarness({ narrativeEnabled: true, sleepAuditEnabled: true, feedbackEnabled: true }, { llm: {
        prepareCall: async () => ({ config: {}, stream: async function* (request) {
            const input = JSON.parse(request.messages[1].content[0].text)
            yield { type: 'text-delta', text: JSON.stringify(input.reflections
                ? { accepted: true, reason: '保留失败与上线限制。' }
                : { reflections: [{ quote: input.source, text: '或许应在下一次演练前再次核对恢复条件。' }] }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
        } }),
    } })
    await host.table.put('smm_narrative_backup', fixture('smm_narrative_backup', {
        projectId: '甲', kind: 'experience', content: '演练失败，未获上线许可。', strength: 0.7,
    }))
    await host.call('memory_recall', { query: '演练失败', projectId: '甲' })
    await host.call('memory_sleep', {})
    const expectedVersion = (await host.api.getRecord({ id: 'smm_narrative_backup' })).recollectionVersion
    for (const requestId of ['初版', '次版']) {
        const draft = await host.api.manage({ action: 'narrativeDraft', id: 'smm_narrative_backup', projectId: '甲',
            expectedVersion, requestId, style: 'gentle', provider: 'mock', model: 'mock' })
        await host.api.manage({ action: 'narrativeConfirm', id: 'smm_narrative_backup', projectId: '甲', draftId: draft.entry.id })
    }
    const newest = (await history(host)).items[0]
    await host.api.manage({ action: 'narrativeRetract', id: 'smm_narrative_backup', projectId: '甲', versionId: newest.id })
    return { host, backup: (await host.api.manage(EXPORT)).backup }
}

test('v4 预演及恢复四个域并保留撤回与版本关系，旧格式与关闭开关兼容', async () => {
    const { host, backup } = await createSource()
    const target = createHarness()
    try {
        assert.equal(backup.version, 4)
        assert.equal(backup.scope, 'memory-audit-feedback-and-narratives')
        assert.equal(backup.narratives.length, 2)
        assert.ok(backup.audits.length && backup.feedback.length)
        for (const [options, version] of [[{}, 1], [{ includeAudit: true }, 2], [{ includeAudit: true, includeFeedback: true }, 3]]) {
            const old = (await host.api.manage({ action: 'export', ...options })).backup
            assert.equal(old.version, version)
            assert.equal(Object.hasOwn(old, 'narratives'), false)
        }
        const args = { action: 'import', backup }
        const plan = await target.api.manage(args)
        assert.equal(plan.plannedNarratives, 2)
        assert.equal(target.data.size, 0)
        assert.equal((await target.call('memory_manage', args)).code, 'forbidden')
        await assert.rejects(target.api.manage({ ...args, dryRun: false }), /planToken/)
        const result = await target.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        assert.equal(result.importedNarratives, 2)
        const restored = (await target.api.manage(EXPORT)).backup
        for (const key of ['records', 'audits', 'feedback', 'narratives']) assert.deepEqual(restored[key], backup[key])
        assert.equal(restored.checksum, backup.checksum)
        const versions = await history(target)
        assert.equal(versions.enabled, false)
        assert.equal(versions.items[0].state, 'retracted')
        assert.equal(versions.items[0].previousId, versions.items[1].id)
        assert.equal(versions.items[1].applicable, true)
        const repeated = await target.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        assert.equal(repeated.importedNarratives, 0)
        assert.equal(repeated.skippedNarratives, 2)
        assert.equal(target.domains.get('memory_backup_state').get('restore').narratives, undefined)
        assert.equal((await target.call('memory_manage', { action: 'forget', id: 'smm_narrative_backup', projectId: '甲' })).code, 'conflict')
    } finally { await host.dispose(); await target.dispose() }
})

test('v4 拒绝摘要篡改、缺失来源、跨项目、伪造引文及非法版本链且不写入', async () => {
    const { host, backup } = await createSource()
    const changes = {
        checksum: (value) => { value.narratives[0].reviewReason = '篡改复核'; return false },
        missing: (value) => { value.narratives[0].memoryId = 'smm_missing' },
        scope: (value) => { value.narratives[0].projectId = '乙' },
        quote: (value) => { value.narratives[0].reflections[0].quote = '演练已经成功。' },
        fact: (value) => { value.records[0].kind = 'fact' },
        duplicate: (value) => { value.narratives.push(structuredClone(value.narratives[0])) },
        parent: (value) => { value.narratives.find((entry) => entry.previousId).previousId = `narrative_${'f'.repeat(64)}` },
        cycle: (value) => { const root = value.narratives.find((entry) => !entry.previousId); root.previousId = root.id },
        order: (value) => { value.narratives[0].createdAt = value.narratives[1].createdAt },
        fork: (value) => { value.narratives.find((entry) => entry.previousId).previousId = null },
        pending: (value) => { value.narratives[0].state = 'draft' },
        retracted: (value) => { value.narratives.find((entry) => entry.state === 'retracted').retractedAt = 0 },
        schema: (value) => { value.narratives[0].unexpected = true },
        envelope: (value) => { value.unexpected = true },
        absent: (value) => { value.narratives = null },
    }
    for (const [name, change] of Object.entries(changes)) {
        const target = createHarness()
        const input = structuredClone(backup)
        if (change(input) !== false) recalculate(input)
        await assert.rejects(target.api.manage({ action: 'import', backup: input }), undefined, name)
        assert.equal(target.data.size, 0, name)
        assert.equal(target.domains.get('memory_narratives').size, 0, name)
        assert.equal(target.domains.get('memory_backup_state').size, 0, name)
        await target.dispose()
    }
    await host.dispose()
})

test('过期叙述按历史恢复且不因导入重新确认适用性', async () => {
    const { host } = await createSource()
    const plan = await host.api.manage({ action: 'setState', id: 'smm_narrative_backup', projectId: '甲', state: 'review', reason: '结果待核对' })
    await host.api.manage({ action: 'setState', id: 'smm_narrative_backup', projectId: '甲', state: 'review', reason: '结果待核对', dryRun: false, planToken: plan.planToken })
    const backup = (await host.api.manage(EXPORT)).backup
    const target = createHarness()
    const restore = await target.api.manage({ action: 'import', backup })
    await target.api.manage({ action: 'import', backup, dryRun: false, planToken: restore.planToken })
    assert.ok((await history(target)).items.every((entry) => !entry.applicable))
    assert.deepEqual((await target.api.manage(EXPORT)).backup.narratives, backup.narratives)
    await target.dispose()
    await host.dispose()
})

test('各域与完成标记中断后重载续写且未完成恢复阻止历史读取', async () => {
    const { host, backup } = await createSource()
    for (const stage of ['prepare', 'records', 'audit', 'feedback', 'narratives', 'complete']) {
        let failing = true
        const target = createHarness({}, {
            beforePut: () => { if (failing && stage === 'records') throw new Error('模拟记忆中断') },
            beforeDomainPut: (name, _id, value) => {
                if (!failing) return
                if ((stage === 'prepare' && name === 'memory_backup_state' && value.state === 'prepared')
                    || (stage === 'audit' && name === 'memory_sleep_audit')
                    || (stage === 'feedback' && name === 'memory_feedback')
                    || (stage === 'narratives' && name === 'memory_narratives')
                    || (stage === 'complete' && name === 'memory_backup_state' && value.state === 'complete')) {
                    throw new Error(`模拟 ${stage} 中断`)
                }
            },
        })
        const plan = await target.api.manage({ action: 'import', backup })
        await assert.rejects(target.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken }), /中断/)
        if (stage === 'prepare') assert.equal(target.data.size, 0)
        if (stage !== 'prepare') await assert.rejects(history(target), /中断/)
        await target.dispose()
        failing = false
        const reloaded = createHarness({}, { data: target.data, domains: target.domains })
        const retry = await reloaded.api.manage({ action: 'import', backup })
        await reloaded.api.manage({ action: 'import', backup, dryRun: false, planToken: retry.planToken })
        assert.deepEqual((await reloaded.api.manage(EXPORT)).backup.narratives, backup.narratives, stage)
        assert.equal(reloaded.domains.get('memory_backup_state').get('restore').state, 'complete', stage)
        await reloaded.dispose()
    }
    await host.dispose()
})

test('同 ID 撤回状态冲突拒绝覆盖且预演后本地前序变化须重新确认', async () => {
    const { host, backup } = await createSource()
    const target = createHarness()
    const root = backup.narratives.find((entry) => !entry.previousId)
    const next = backup.narratives.find((entry) => entry.previousId)
    const initial = recalculate({ ...structuredClone(backup), narratives: [root] })
    const first = await target.api.manage({ action: 'import', backup: initial })
    await target.api.manage({ action: 'import', backup: initial, dryRun: false, planToken: first.planToken })
    const incremental = recalculate({ ...structuredClone(backup), narratives: [next] })
    const plan = await target.api.manage({ action: 'import', backup: incremental })
    await target.api.manage({ action: 'narrativeRetract', id: root.memoryId, projectId: root.projectId, versionId: root.id })
    await assert.rejects(target.api.manage({ action: 'import', backup: incremental, dryRun: false, planToken: plan.planToken }), /planToken/)
    await assert.rejects(target.api.manage({ action: 'import', backup }), /本地叙述与备份冲突/)
    const refreshed = await target.api.manage({ action: 'import', backup: incremental })
    assert.notEqual(refreshed.planToken, plan.planToken)
    await target.api.manage({ action: 'import', backup: incremental, dryRun: false, planToken: refreshed.planToken })
    assert.equal((await history(target)).total, 2)
    await target.dispose()
    await host.dispose()
})

test('恢复前已有底稿或前序版本发生变化会阻止跨域续写', async () => {
    const { host, backup } = await createSource()
    const root = backup.narratives.find((entry) => !entry.previousId)
    const next = backup.narratives.find((entry) => entry.previousId)
    for (const mode of ['source', 'parent']) {
        let failing = false
        const target = createHarness({}, { beforeDomainPut(name) {
            if (name === 'memory_narratives' && failing) throw new Error('模拟叙述中断')
        } })
        const initial = recalculate({ ...structuredClone(backup), narratives: [root] })
        const first = await target.api.manage({ action: 'import', backup: initial })
        await target.api.manage({ action: 'import', backup: initial, dryRun: false, planToken: first.planToken })
        const incremental = recalculate({ ...structuredClone(backup), records: [], audits: [], feedback: [], narratives: [next] })
        const plan = await target.api.manage({ action: 'import', backup: incremental })
        failing = true
        await assert.rejects(target.api.manage({ action: 'import', backup: incremental, dryRun: false, planToken: plan.planToken }), /中断/)
        failing = false
        if (mode === 'source') await target.table.update(root.memoryId, (record) => ({ ...record, strength: 0.2 }))
        if (mode === 'parent') target.domains.get('memory_narratives').set(root.id, { ...root, state: 'retracted', retractedAt: Date.now() })
        await assert.rejects(history(target), /叙述底稿或历史已变化/)
        assert.equal(target.domains.get('memory_narratives').size, 1)
        await target.dispose()
    }
    await host.dispose()
})

test('恢复刷新已有反馈索引且不保留半成品叙述缓存', async () => {
    const { host, backup } = await createSource()
    const target = createHarness({ feedbackEnabled: true }, { beforeDomainPut(name) {
        if (name === 'memory_narratives') throw new Error('模拟最终域中断')
    } })
    const plan = await target.api.manage({ action: 'import', backup })
    await assert.rejects(target.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken }), /中断/)
    await target.dispose()
    const reloaded = createHarness({ feedbackEnabled: true }, { data: target.data, domains: target.domains })
    await reloaded.api.manage({ action: 'sleepRecover' })
    const record = await reloaded.api.getRecord({ id: 'smm_narrative_backup' })
    assert.equal(record.exposures.length, 1)
    assert.equal((await history(reloaded)).total, 2)
    await reloaded.dispose()
    await host.dispose()
})

test('叙述全库与单记忆容量限制在合并本地记录后计算', () => {
    const source = fixture('smm_capacity', { kind: 'experience', content: '原始经历，仅供核对。' })
    const entry = {
        memoryId: source.id, projectId: null, sourceVersion: recollectionVersion(source, createRecordView([[source.id, source]])),
        style: 'gentle', reflections: [{ quote: source.content, text: '或许可在下次核对条件。' }], reviewReason: '原文一致',
        provider: 'mock', model: 'mock', state: 'confirmed', retractedAt: null, policy: 1, requestHash: 'a'.repeat(64),
    }
    const chain = Array.from({ length: 51 }, (_, index) => ({
        ...entry, id: `narrative_${index.toString(16).padStart(64, '0')}`, createdAt: index,
        previousId: index ? `narrative_${(index - 1).toString(16).padStart(64, '0')}` : null,
    }))
    assert.throws(() => planNarrativeImport(new Map(chain.slice(0, 50).map((item) => [item.id, item])), chain.slice(50), new Map([[source.id, source]])), /50/)
    assert.throws(() => planNarrativeImport(new Map(), Array(1001).fill(chain[0]), new Map()), /1000/)
})

test('v4 导出选项组合严格校验且空库可往返', async () => {
    const host = createHarness()
    for (const options of [{ includeNarratives: true }, { includeAudit: true, includeNarratives: true },
        { includeAudit: true, includeFeedback: false, includeNarratives: true },
        { ...EXPORT, includeNarratives: 1 }, { ...EXPORT, extra: true }]) {
        await assert.rejects(host.api.manage({ action: 'export', ...options }), /导出选项/)
    }
    const backup = (await host.call('memory_manage', EXPORT)).backup
    assert.equal(backup.version, 4)
    assert.equal((await host.api.manage({ action: 'import', backup })).plannedNarratives, 0)
    await host.dispose()
})

test('叙述域内部部分写入可恢复，完成标记失败不重写已落盘版本', async () => {
    const { host, backup } = await createSource()
    const counts = new Map()
    let failVersion = true
    let failComplete = true
    const target = createHarness({}, { beforeDomainPut(name, id, value) {
        if (name === 'memory_narratives') {
            if (counts.size === 1 && failVersion) throw new Error('第二条叙述写入中断')
            counts.set(id, (counts.get(id) ?? 0) + 1)
        }
        if (name === 'memory_backup_state' && value.state === 'complete' && failComplete) throw new Error('完成标记中断')
    } })
    const plan = await target.api.manage({ action: 'import', backup })
    await assert.rejects(target.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken }), /第二条叙述/)
    assert.equal(target.domains.get('memory_narratives').size, 1)
    failVersion = false
    await assert.rejects(history(target), /完成标记中断/)
    assert.equal(target.domains.get('memory_narratives').size, 2)
    failComplete = false
    assert.equal((await history(target)).total, 2)
    assert.deepEqual([...counts.values()], [1, 1])
    await target.dispose()
    await host.dispose()
})

test('持久恢复计划校验新增叙述域和上下文摘要且保留旧计划兼容', async () => {
    const { host, backup } = await createSource()
    const parse = backupStateDomainSpec((value) => value, (value) => value).tables.records.valueSchema.parse
    const data = { records: [], audits: [], feedback: [], narratives: backup.narratives, narrativeContext: 'a'.repeat(64) }
    const prepared = { id: 'restore', state: 'prepared', at: 1, ...data, checksum: backupChecksum(data) }
    assert.equal(parse(prepared).narratives.length, 2)
    assert.throws(() => parse({ ...prepared, narrativeContext: 'b'.repeat(64) }), /校验失败/)
    for (const extra of [{ narratives: null }, { narrativeContext: true }, { feedback: undefined }]) {
        const payload = { ...data, ...extra }
        assert.throws(() => parse({ ...prepared, ...payload, checksum: backupChecksum(payload) }), /校验失败/)
    }
    const invalid = { ...data, narratives: [{ ...backup.narratives[0], state: 'draft' }] }
    assert.throws(() => parse({ ...prepared, ...invalid, checksum: backupChecksum(invalid) }), /叙述版本记录/)
    for (const payload of [{ records: [], audits: [] }, { records: [], audits: [], feedback: [] }]) {
        assert.equal(parse({ id: 'restore', state: 'prepared', at: 1, ...payload, checksum: backupChecksum(payload) }).state, 'prepared')
    }
    await host.dispose()
})
