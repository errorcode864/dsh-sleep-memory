import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { apply } from '../index.js'
import { exportMemoryBackup } from '../memory-contract.js'
import { fixture } from './harness.mjs'

// 在 Electron 的 Node 模式下读取已安装宿主组件；只写入本仓库 tmp 隔离目录。
const appPackage = process.env.DSH_APP_PACKAGE
if (!appPackage) throw new Error('请通过 DSH_APP_PACKAGE 指定已安装宿主的 dsh/package.json')
const requireHost = createRequire(appPackage)
const { DomainFacility } = requireHost('@deepseek-ai/dsh-storage-domain')
const { JsonStorageBackend } = requireHost('@deepseek-ai/dsh-storage-json')
const testRoot = resolve(import.meta.dirname, '../tmp')
await mkdir(testRoot, { recursive: true })
const root = await mkdtemp(resolve(testRoot, 'host-integration-'))

function startInstance(config = {}, failure = {}, storageRoot = root, llm) {
    const backend = new JsonStorageBackend(storageRoot)
    const facility = new DomainFacility({
        storage: { backend: { get: () => backend } },
        emit: () => {},
        logger: console,
    }, { backend: 'json', routes: {} })
    const tools = new Map()
    const cleanups = []
    const handlers = new Map()
    let api
    apply({
        storageDomain: {
            async open(spec) {
                const domain = await facility.open(spec)
                const table = domain.table('records')
                const put = table.put.bind(table)
                table.put = async (id, record) => {
                    if (spec.name === 'memory_bank' && failure.enabled && ++failure.writes === 2) {
                        throw new Error('真实存储验收模拟睡眠中断')
                    }
                    if (spec.name === 'memory_sleep_audit' && failure.audit) throw new Error('真实审计备份导入中断')
                    await put(id, record)
                }
                // 宿主实例测试绝不进入物理遗忘，避免测试清理误触文件删除。
                table.delete = async () => { throw new Error('集成验收禁止物理删除') }
                table.deleteMany = table.delete
                return domain
            },
        },
        tools: { register: (definition) => tools.set(definition.name, definition) },
        reflect: { provide: (_name, service) => { api = service } },
        effect: (effect) => { cleanups.push(effect()) },
        on: (name, handler) => handlers.set(name, handler),
        get: () => undefined,
        llm: llm ?? {
            prepareCall: async () => ({
                config: {},
                stream: async function* () {
                    yield { type: 'text-delta', text: JSON.stringify({
                        memories: [{
                            content: '集成验收项目的构建固定使用 Java 21。', category: 'project-fact', confidence: 0.95,
                            reason: '后续执行构建时核对 JDK 版本', relation: 'new', relatedIds: [],
                            keywords: ['Java', 'JDK'], evidence: [{
                                messageId: 'integration-user', quote: '集成验收项目的构建固定使用 Java 21。',
                            }],
                        }],
                    }) }
                    yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 10 } }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    }, {
        sleepIntervalMinutes: 60, sleepOnStart: false, salientScoringEnabled: false, dreamMaxCandidates: 0,
        learningPolicyMode: 'evidence', feedbackEnabled: true, recallPlanMode: 'local',
        sleepAuditEnabled: true, contextualRecallEnabled: true, ...config,
    })
    return {
        api, handlers,
        call: (name, args, execution) => tools.get(name).execute(args, execution),
        async close() {
            for (const cleanup of cleanups) if (typeof cleanup === 'function') await cleanup()
            await facility.closeAll()
            await backend.close()
        },
    }
}

const sessionId = '会话/包含路径字符:测试'
const execution = { agent: { id: sessionId, session: { id: sessionId } } }
const first = startInstance()
let id
let correctedId
let successfulSleepAt
let learnedId
let exposureId
let auditId
try {
    await first.api.manage({ action: 'bind', sessionId, projectId: '测试项目' })
    const write = await first.call('memory_write', { content: '部署端口 8600', kind: 'fact' }, execution)
    id = write.id
    const corrected = await first.call('memory_manage', { action: 'correct', id, content: '部署端口 8601' }, execution)
    correctedId = corrected.id
    const request = { action: 'setState', id, projectId: '测试项目', state: 'invalid', reason: '集成验证失效恢复' }
    const plan = await first.api.manage(request)
    await first.api.manage({ ...request, dryRun: false, planToken: plan.planToken })
    assert.equal((await first.call('memory_recall', { query: '部署' }, execution)).count, 0)
    auditId = (await first.call('memory_sleep', {})).auditId
    successfulSleepAt = (await first.api.status()).schedule.lastSuccessAt
    assert.ok(successfulSleepAt)
    const emit = (type, data) => first.handlers.get('session/event')({ id: sessionId }, { type, data })
    emit('turn/start', { turn: 1 })
    emit('user/message', {
        id: 'integration-user', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '集成验收项目的构建固定使用 Java 21。' }],
    })
    emit('assistant/message', { message: {
        role: 'assistant', source: { provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '已确认项目构建约定。' }],
    } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // 磁盘写入通过状态计数确认；只轮询隔离实例，不触碰个人 profile。
    for (let attempt = 0; attempt < 100 && (await first.api.status()).learning.stored === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await first.api.status()).learning.stored, 1)
    assert.equal((await first.api.status()).metrics.models.learning.reported.totalTokens, 110)
    const learned = await first.call('memory_recall', { query: 'Java', projectId: '测试项目' })
    learnedId = learned.hits[0].id
    assert.equal(learned.fidelity, 'summary')
    exposureId = learned.hits[0].exposureId
    await first.api.manage({ action: 'feedback', eventId: 'host-feedback', exposureId, signal: 'helpful' })
    assert.equal((await first.api.status()).metrics.retrieval.queries, 2)
} finally {
    await first.close()
}

const second = startInstance()
try {
    assert.equal((await second.api.scope({ sessionId })).scope.projectId, '测试项目')
    assert.equal((await second.api.getRecord({ id: correctedId })).lifecycle.state, 'invalid')
    assert.equal((await second.api.status()).schedule.lastSuccessAt, successfulSleepAt)
    assert.equal((await second.api.status()).lastSleep, null)
    assert.equal((await second.api.status()).metrics.models.learning.calls, 0)
    const learned = await second.api.getRecord({ id: learnedId })
    assert.equal(learned.record.source.kind, 'model')
    assert.equal(learned.record.learning.evidence[0].messageId, 'integration-user')
    assert.equal(learned.exposures[0].feedback.signal, 'helpful')
    assert.equal((await second.api.manage({
        action: 'feedback', eventId: 'host-feedback', exposureId, signal: 'helpful',
    })).duplicate, true)
    const emit = (type, data) => second.handlers.get('session/event')({ id: sessionId }, { type, data })
    emit('turn/start', { turn: 1 })
    emit('user/message', {
        id: 'integration-user', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '集成验收项目的构建固定使用 Java 21。' }],
    })
    emit('assistant/message', { message: {
        role: 'assistant', source: { provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '重放相同来源。' }],
    } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (let attempt = 0; attempt < 100 && (await second.api.status()).learning.duplicates === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await second.api.status()).learning.duplicates, 1)
    assert.equal((await second.api.status()).metrics.models.learning.calls, 0)
    const learnedBackup = await second.api.manage({ action: 'export' })
    assert.ok(JSON.stringify(learnedBackup).includes('集成验收项目的构建固定使用 Java 21。'))
    const request = { action: 'setState', id, projectId: '测试项目', state: 'active', reason: '集成验证恢复最新事实' }
    const plan = await second.api.manage(request)
    await second.api.manage({ ...request, dryRun: false, planToken: plan.planToken })
    const recall = await second.call('memory_recall', { query: '部署' }, execution)
    assert.deepEqual(recall.hits.map((hit) => hit.id), [correctedId])
    const exported = await second.api.manage({ action: 'export' })
    const imported = await second.api.manage({ action: 'import', backup: exported.backup })
    assert.equal(imported.planned, 0)
    assert.equal(imported.skipped, 3)
    const files = await readdir(resolve(root, 'memory_runtime'))
    assert.ok(files.length > 0)
    assert.ok((await readdir(resolve(root, 'memory_feedback'))).length > 0)
    assert.ok((await readdir(resolve(root, 'memory_learning_jobs'))).length > 0)
    assert.equal((await second.api.manage({ action: 'sleepHistory', batchId: auditId })).items[0].state, 'applied')
    const contextual = await second.call('memory_write', {
        kind: 'experience', content: '旧语法造成兼容问题，需要先核对目标产品。',
        recallTriggers: [{ when: '准备迁移数据时', cues: ['数据搬家'] }],
    }, execution)
    assert.equal((await second.call('memory_recall', { query: '数据搬家' }, execution)).hits[0].id, contextual.id)
    assert.ok((await readdir(resolve(root, 'memory_sleep_audit'))).length > 0)
    console.log('宿主真实存储集成通过：本地规划、学习持久去重、反馈重载、摘要、计量、范围、纠正链与备份预演。')
    console.log('新增验收通过：睡眠审计跨实例重载和情境触发召回。')
    console.log(`隔离数据保留：${root}`)
} finally {
    await second.close()
}

const failure = { enabled: false, writes: 0 }
const interrupted = startInstance({}, failure)
const beforeInterrupted = (await interrupted.api.manage({ action: 'export' })).backup.records
let interruptedId
try {
    failure.enabled = true
    await assert.rejects(interrupted.call('memory_sleep', {}), /模拟睡眠中断/)
    interruptedId = (await interrupted.api.manage({ action: 'sleepHistory' })).items.find((batch) => batch.state === 'prepared').id
} finally {
    await interrupted.close()
}
const recovered = startInstance({ sleepAuditEnabled: false })
try {
    await recovered.api.stats()
    assert.equal((await recovered.api.manage({ action: 'sleepHistory', batchId: interruptedId })).items[0].state, 'applied')
    const request = { action: 'sleepRollback', batchId: interruptedId }
    const plan = await recovered.api.manage(request)
    assert.equal(plan.dryRun, true)
    await recovered.api.manage({ ...request, dryRun: false, planToken: plan.planToken })
} finally {
    await recovered.close()
}
const restored = startInstance()
let auditBackup
try {
    assert.deepEqual((await restored.api.manage({ action: 'export' })).backup.records, beforeInterrupted)
    assert.equal((await restored.api.manage({ action: 'sleepHistory', batchId: interruptedId })).items[0].state, 'rolled-back')
    console.log('新增故障验收通过：真实磁盘中断、关闭开关后恢复、回滚落盘与再次重载。')
    auditBackup = (await restored.api.manage({ action: 'export', includeAudit: true })).backup
} finally {
    await restored.close()
}

const backupRoot = await mkdtemp(resolve(testRoot, 'host-backup-'))
const backupFailure = { audit: true }
const importing = startInstance({ autoLearnEnabled: false }, backupFailure, backupRoot)
try {
    const args = { action: 'import', backup: auditBackup }
    const plan = await importing.api.manage(args)
    await assert.rejects(importing.api.manage({ ...args, dryRun: false, planToken: plan.planToken }), /审计备份导入中断/)
} finally { await importing.close() }
const imported = startInstance({ autoLearnEnabled: false }, {}, backupRoot)
try {
    await imported.api.stats()
    const exported = (await imported.api.manage({ action: 'export', includeAudit: true })).backup
    assert.deepEqual(exported.records, auditBackup.records)
    assert.deepEqual(exported.audits, auditBackup.audits)
    assert.equal((await imported.api.manage({ action: 'sleepStats' })).batchCount, auditBackup.audits.length)
    console.log('审计备份真实存储验收通过：新目录导入中断后重载续写，记忆和审计逐项一致。')
} finally { await imported.close() }

const dormantRoot = await mkdtemp(resolve(testRoot, 'host-dormancy-'))
const dormantConfig = {
    autoLearnEnabled: false, recallReviewEnabled: false, dormancyEnabled: true,
    sleepIntervalMinutes: 0, dormantAfterDays: 10, dormantStrengthLine: 0.2,
}
const dormantHost = startInstance(dormantConfig, {}, dormantRoot)
let dormancyBatchId
try {
    const record = fixture('smm_host_dormant', {
        layer: 'deep', content: '兼容清单需要先核对', strength: 0.1, lastAccessAt: Date.now() - 20 * 86_400_000,
        recallTriggers: [{ when: '准备迁移时', cues: ['数据搬家'] }],
    })
    await dormantHost.api.manage({
        action: 'import', dryRun: false, backup: exportMemoryBackup(new Map([[record.id, record]])),
    })
    dormancyBatchId = (await dormantHost.call('memory_sleep', {})).auditId
    assert.equal((await dormantHost.api.getRecord({ id: record.id })).record.access.state, 'dormant')
} finally { await dormantHost.close() }
const wakeHost = startInstance(dormantConfig, {}, dormantRoot)
let wakeBatchId
try {
    const recalled = await wakeHost.call('memory_recall', { query: '数据搬家' })
    assert.equal(recalled.hits[0].wake.via, 'context')
    wakeBatchId = (await wakeHost.api.manage({ action: 'sleepHistory' })).items.find((batch) => batch.report.operation === 'wake').id
    assert.ok(wakeBatchId !== dormancyBatchId)
} finally { await wakeHost.close() }
const wakeReloaded = startInstance(dormantConfig, {}, dormantRoot)
try {
    assert.equal((await wakeReloaded.api.getRecord({ id: 'smm_host_dormant' })).record.access.state, 'awake')
    const plan = await wakeReloaded.api.manage({ action: 'sleepRollback', batchId: wakeBatchId })
    await wakeReloaded.api.manage({ action: 'sleepRollback', batchId: wakeBatchId, dryRun: false, planToken: plan.planToken })
    assert.equal((await wakeReloaded.api.getRecord({ id: 'smm_host_dormant' })).record.access.state, 'dormant')
    console.log('休眠真实存储验收通过：睡眠落盘、重载唤醒、再次重载与回滚休眠。')
} finally { await wakeReloaded.close() }

const preferenceRoot = await mkdtemp(resolve(testRoot, 'host-preferences-'))
const preferenceConfig = { preferenceRecallEnabled: true, autoLearnEnabled: false, recallReviewEnabled: false, sleepIntervalMinutes: 0 }
const preferenceHost = startInstance(preferenceConfig, {}, preferenceRoot)
try {
    await preferenceHost.api.manage({ action: 'import', dryRun: false, backup: exportMemoryBackup(new Map([
        ['smm_language', fixture('smm_language', { content: '以后回复使用中文。', source: { kind: 'user', confirmed: true } })],
    ])) })
} finally { await preferenceHost.close() }
const preferenceReloaded = startInstance(preferenceConfig, {}, preferenceRoot)
try {
    for (const [index, [text, expected]] of [['解释缓存', 1], ['这次用英文回复', 0], ['解释缓存', 1]].entries()) {
        const message = { id: `偏好轮次-${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
        const response = await preferenceReloaded.handlers.get('agent/pre-step')({
            step: 1, messages: [message], agent: { id: '偏好会话' },
        }, async () => ({ kind: 'enter', messages: [message] }))
        assert.equal(response.messages.filter((item) => item.source?.kind === 'sleep-memory').length, expected)
    }
    const traces = (await preferenceReloaded.api.status()).metrics.recentRecalls
    assert.equal(traces[1].diagnostics.reasons['preference-overridden'], 1)
    assert.equal(traces[2].returnedIds[0], 'smm_language')
    assert.equal((await preferenceReloaded.api.getRecord({ id: 'smm_language' })).record.content, '以后回复使用中文。')
    console.log('偏好真实存储验收通过：重载应用、临时覆盖、后续恢复及诊断一致。')
} finally { await preferenceReloaded.close() }

const sourceRoot = await mkdtemp(resolve(testRoot, 'host-sources-'))
const sourceHost = startInstance({ autoLearnEnabled: false, sleepIntervalMinutes: 0 }, {}, sourceRoot)
try {
    const sources = [
        fixture('smm_origin', { projectId: '证据项目', content: '最初的字符集检查证据', supersededBy: 'smm_summary' }),
        fixture('smm_summary', { projectId: '证据项目', layer: 'deep', supersededBy: 'smm_root',
            edges: [{ target: 'smm_origin', relation: 'consolidates', weight: 1 }] }),
        fixture('smm_root', { projectId: '证据项目', layer: 'deep',
            edges: [{ target: 'smm_summary', relation: 'consolidates', weight: 1 }] }),
        fixture('smm_recollection_host', { projectId: '证据项目', kind: 'experience', occurredAt: 1,
            content: '迁移前必须备份，未验证恢复时不得继续。\n'.repeat(80) }),
    ]
    await sourceHost.api.manage({ action: 'import', dryRun: false, backup: exportMemoryBackup(new Map(sources.map((record) => [record.id, record]))) })
} finally { await sourceHost.close() }
const sourceReloaded = startInstance({ autoLearnEnabled: false, sleepIntervalMinutes: 0 }, {}, sourceRoot)
try {
    const before = (await sourceReloaded.api.manage({ action: 'export' })).backup.records
    const trace = await sourceReloaded.api.manage({ action: 'traceSources', id: 'smm_root', projectId: '证据项目' })
    assert.deepEqual(trace.items[1].path, ['smm_root', 'smm_summary', 'smm_origin'])
    assert.equal(trace.complete, true)
    assert.equal((await sourceReloaded.api.manage({ action: 'get', id: 'smm_origin', projectId: '证据项目' })).record.content, '最初的字符集检查证据')
    const original = await sourceReloaded.api.getRecord({ id: 'smm_recollection_host' })
    const recollection = { action: 'recollect', id: original.record.id, projectId: '证据项目', expectedVersion: original.recollectionVersion }
    const brief = await sourceReloaded.api.manage(recollection)
    assert.ok(brief.truncated && brief.omittedChars > 0)
    assert.ok(brief.fragments.every((fragment) => fragment.text === original.record.content.slice(fragment.start, fragment.end)))
    assert.equal((await sourceReloaded.api.manage({ ...recollection, detail: 'original' })).content, original.record.content)
    assert.deepEqual((await sourceReloaded.api.manage({ action: 'export' })).backup.records, before)
    console.log('多层来源真实存储验收通过：重载后路径、原文和只读状态一致。')
    console.log('回忆视图真实存储验收通过：重载后版本绑定、原句对照和只读展开一致。')
} finally { await sourceReloaded.close() }

const cacheRoot = await mkdtemp(resolve(testRoot, 'host-review-cache-'))
const cacheConfig = {
    autoLearnEnabled: false, recallReviewEnabled: true, recallReviewCacheSeconds: 60,
    injectRepeatAfterTurns: 0, sleepIntervalMinutes: 0,
}
const cacheCalls = { count: 0 }
const cacheModel = {
    prepareCall: async () => ({
        config: {},
        stream: async function* () {
            cacheCalls.count += 1
            yield { type: 'text-delta', text: '{"decisions":[{"id":"smm_cache","useful":true,"reason":"部署约定适用"}]}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
        },
    }),
}
for (const round of [0, 1]) {
    const cacheHost = startInstance(cacheConfig, {}, cacheRoot, cacheModel)
    try {
        if (round === 0) await cacheHost.api.manage({
            action: 'import', dryRun: false, backup: exportMemoryBackup(new Map([
                ['smm_cache', fixture('smm_cache')],
            ])),
        })
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const message = { id: `缓存轮次-${round}-${attempt}`, role: 'user', source: { kind: 'user' },
                content: [{ type: 'text', text: '部署约定 UNIQUE_42' }] }
            const response = await cacheHost.handlers.get('agent/pre-step')({
                step: 1, messages: [message], agent: { id: '审核缓存会话' }, modelSelection: { provider: 'mock', model: 'mock' },
            }, async () => ({ kind: 'enter', messages: [message] }))
            assert.equal(response.messages.length, 2)
        }
        const status = await cacheHost.api.status()
        assert.equal(status.recallReviewTimeoutMs, 15000)
        assert.equal(status.review.cache.hits, 1)
        assert.equal(status.metrics.models.review.calls, 1)
    } finally { await cacheHost.close() }
}
assert.equal(cacheCalls.count, 2)
console.log('审核缓存真实存储验收通过：同实例复用且重载重新审核。')

const revisionRoot = await mkdtemp(resolve(testRoot, 'host-reconsolidation-'))
const revisionConfig = { autoLearnEnabled: false, sleepIntervalMinutes: 0, reconsolidationEnabled: true }
const revisionHost = startInstance(revisionConfig, {}, revisionRoot)
let previousSummaryId
let revisionBatchId
let revisedSummaryId
try {
    const sources = ['smm_original_a', 'smm_original_b'].map((id) => fixture(id, { strength: 0.4 }))
    await revisionHost.api.manage({
        action: 'import', dryRun: false, backup: exportMemoryBackup(new Map(sources.map((record) => [record.id, record]))),
    })
    previousSummaryId = (await revisionHost.call('memory_sleep', {})).consolidated[0].deepId
    await revisionHost.api.manage({
        action: 'import', dryRun: false, backup: exportMemoryBackup(new Map([
            ['smm_new_evidence', fixture('smm_new_evidence', { strength: 0.4 })],
        ])),
    })
    const result = await revisionHost.call('memory_sleep', {})
    revisionBatchId = result.auditId
    revisedSummaryId = result.reconsolidated[0].deepId
} finally { await revisionHost.close() }
const revisionReloaded = startInstance(revisionConfig, {}, revisionRoot)
try {
    assert.equal((await revisionReloaded.api.getRecord({ id: previousSummaryId })).summaryVersion.nextId, revisedSummaryId)
    const current = await revisionReloaded.api.getRecord({ id: revisedSummaryId })
    assert.equal(current.summaryVersion.previousId, previousSummaryId)
    assert.equal(current.current, true)
    const trace = await revisionReloaded.api.manage({ action: 'traceSources', id: revisedSummaryId })
    assert.deepEqual(new Set(trace.items.map((item) => item.id)), new Set(['smm_original_a', 'smm_original_b', 'smm_new_evidence']))
    const plan = await revisionReloaded.api.manage({ action: 'sleepRollback', batchId: revisionBatchId })
    await revisionReloaded.api.manage({ action: 'sleepRollback', batchId: revisionBatchId, dryRun: false, planToken: plan.planToken })
} finally { await revisionReloaded.close() }
const revisionRestored = startInstance(revisionConfig, {}, revisionRoot)
try {
    assert.equal((await revisionRestored.api.getRecord({ id: previousSummaryId })).current, true)
    assert.equal((await revisionRestored.api.getRecord({ id: revisedSummaryId })).current, false)
    assert.equal((await revisionRestored.api.getRecord({ id: 'smm_new_evidence' })).record.supersededBy, null)
    console.log('深层再巩固真实存储验收通过：版本与原文重载、批次回滚及再次重载一致。')
} finally { await revisionRestored.close() }

const evidenceRoot = await mkdtemp(resolve(testRoot, 'host-recall-evidence-'))
const evidenceConfig = { autoLearnEnabled: false, recallReviewEnabled: false, sleepIntervalMinutes: 0,
    progressiveRecallEnabled: true, injectMaxEstimatedTokens: 2000 }
const evidenceHost = startInstance(evidenceConfig, {}, evidenceRoot)
const evidenceContext = { agent: { id: '宿主逐层取证会话' } }
let evidenceId
try {
    const sources = [
        fixture('smm_detail', { content: '验收端口固定为 8611。', supersededBy: 'smm_middle' }),
        fixture('smm_middle', { content: '验收需核对端口原文。', layer: 'deep', supersededBy: 'smm_summary',
            edges: [{ target: 'smm_detail', relation: 'consolidates', weight: 1 }] }),
        fixture('smm_summary', { content: '验收需要查看部署记录。', layer: 'deep',
            edges: [{ target: 'smm_middle', relation: 'consolidates', weight: 1 }] }),
    ]
    await evidenceHost.api.manage({
        action: 'import', dryRun: false, backup: exportMemoryBackup(new Map(sources.map((record) => [record.id, record]))),
    })
    const message = { id: '宿主取证轮次', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '验收' }] }
    const injected = await evidenceHost.handlers.get('agent/pre-step')({
        step: 1, messages: [message], ...evidenceContext,
    }, async () => ({ kind: 'enter', messages: [message] }))
    evidenceId = injected.messages.find((item) => item.source?.kind === 'sleep-memory').content[0].text.match(/evidence_[a-f0-9-]{36}/)[0]
    const before = (await evidenceHost.api.manage({ action: 'export' })).backup.records
    const first = await evidenceHost.call('memory_manage', { action: 'expandRecall', id: 'smm_summary', recallId: evidenceId }, evidenceContext)
    assert.equal(first.items[0].id, 'smm_middle')
    const second = await evidenceHost.call('memory_manage', { action: 'expandRecall', id: 'smm_middle', recallId: evidenceId }, evidenceContext)
    assert.equal(second.items[0].content, '验收端口固定为 8611。')
    assert.deepEqual((await evidenceHost.api.manage({ action: 'export' })).backup.records, before)
} finally { await evidenceHost.close() }
const evidenceReloaded = startInstance(evidenceConfig, {}, evidenceRoot)
try {
    assert.equal((await evidenceReloaded.call('memory_manage', {
        action: 'expandRecall', id: 'smm_summary', recallId: evidenceId,
    }, evidenceContext)).code, 'evidence_expired')
    const recalled = await evidenceReloaded.call('memory_recall', { query: '验收' }, evidenceContext)
    const expanded = await evidenceReloaded.call('memory_manage', {
        action: 'expandRecall', id: 'smm_summary', recallId: recalled.evidence.recallId,
    }, evidenceContext)
    assert.equal(expanded.items[0].id, 'smm_middle')
    console.log('逐层取证真实存储验收通过：自动入口、逐层读取、只读与重载重新召回一致。')
} finally { await evidenceReloaded.close() }

const outcomeRoot = await mkdtemp(resolve(testRoot, 'host-outcomes-'))
const outcomeConfig = { autoLearnEnabled: false, recallReviewEnabled: false, sleepIntervalMinutes: 0, outcomeRecallEnabled: true }
const outcomeHost = startInstance(outcomeConfig, {}, outcomeRoot)
let outcomeBackup
try {
    const records = [
        fixture('smm_practice', { content: '发布前先核验恢复能力。' }),
        fixture('smm_result', { content: '恢复演练确认成功。' }),
    ]
    await outcomeHost.api.manage({ action: 'import', dryRun: false,
        backup: exportMemoryBackup(new Map(records.map((record) => [record.id, record]))) })
    const recalled = await outcomeHost.call('memory_recall', { query: '发布前先核验恢复能力', limit: 1 })
    const proof = await outcomeHost.api.getRecord({ id: 'smm_result' })
    await outcomeHost.api.manage({
        action: 'feedback', eventId: '宿主成功结果', exposureId: recalled.hits[0].exposureId, signal: 'success',
        outcome: {
            trigger: { when: '准备迁移', cues: ['数据搬家'] }, action: '先验证恢复能力', result: '恢复演练成功',
            evidence: { memoryId: 'smm_result', quote: proof.record.content, version: proof.outcomeEvidenceVersion },
        },
    })
    outcomeBackup = (await outcomeHost.api.manage({ action: 'export', includeAudit: true, includeFeedback: true })).backup
} finally { await outcomeHost.close() }
const outcomeReloaded = startInstance(outcomeConfig, {}, outcomeRoot)
try {
    const recalled = await outcomeReloaded.call('memory_recall', { query: '数据搬家' })
    assert.equal(recalled.hits[0].retrieval.outcome.direction, 'encouragement')
} finally { await outcomeReloaded.close() }
const outcomeRestoreRoot = await mkdtemp(resolve(testRoot, 'host-outcome-restore-'))
const outcomeRestored = startInstance(outcomeConfig, {}, outcomeRestoreRoot)
try {
    const plan = await outcomeRestored.api.manage({ action: 'import', backup: outcomeBackup })
    await outcomeRestored.api.manage({ action: 'import', backup: outcomeBackup, dryRun: false, planToken: plan.planToken })
    const recalled = await outcomeRestored.call('memory_recall', { query: '数据搬家' })
    assert.equal(recalled.hits[0].retrieval.outcome.evidence[0].memoryId, 'smm_result')
    const detail = await outcomeRestored.api.getRecord({ id: 'smm_practice' })
    const event = detail.exposures.flatMap((item) => item.outcomes)[0]
    await outcomeRestored.api.manage({
        action: 'feedback', eventId: '宿主撤回结果', exposureId: event.exposureId, signal: 'retract', retracts: event.eventId,
    })
    assert.equal((await outcomeRestored.call('memory_recall', { query: '数据搬家' })).count, 0)
    console.log('结果反馈真实存储验收通过：重载后情境激励、v3 跨目录恢复及结果撤回一致。')
} finally { await outcomeRestored.close() }

const narrativeRoot = await mkdtemp(resolve(testRoot, 'host-narrative-'))
const narrativeModel = { prepareCall: async () => ({ config: {}, stream: async function* (request) {
    const input = JSON.parse(request.messages[1].content[0].text)
    yield { type: 'text-delta', text: JSON.stringify(input.reflections
        ? { accepted: true, reason: '未改变失败结果。' }
        : { reflections: [{ quote: input.source, text: '或许应在下一次演练前再次核对恢复条件。' }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
} }) }
const narrativeHost = startInstance({ narrativeEnabled: true, autoLearnEnabled: false, sleepIntervalMinutes: 0 }, {}, narrativeRoot, narrativeModel)
let narrativeId
try {
    const record = fixture('smm_host_narrative', { kind: 'experience', content: '演练失败，未获上线许可。', projectId: '甲' })
    await narrativeHost.api.manage({ action: 'import', dryRun: false, backup: exportMemoryBackup(new Map([[record.id, record]])) })
    const original = await narrativeHost.api.getRecord({ id: record.id })
    const draft = await narrativeHost.api.manage({
        action: 'narrativeDraft', id: record.id, projectId: '甲', expectedVersion: original.recollectionVersion,
        requestId: '宿主草稿', style: 'gentle', provider: 'mock', model: 'mock',
    })
    narrativeId = draft.entry.id
    await narrativeHost.api.manage({ action: 'narrativeConfirm', id: record.id, projectId: '甲', draftId: narrativeId })
} finally { await narrativeHost.close() }
const narrativeReloaded = startInstance({ autoLearnEnabled: false, sleepIntervalMinutes: 0 }, {}, narrativeRoot)
try {
    const history = await narrativeReloaded.api.manage({ action: 'narrativeHistory', id: 'smm_host_narrative', projectId: '甲' })
    assert.equal(history.items[0].id, narrativeId)
    assert.equal(history.items[0].applicable, true)
    assert.equal((await narrativeReloaded.api.getRecord({ id: 'smm_host_narrative' })).record.content, '演练失败，未获上线许可。')
    await narrativeReloaded.api.manage({ action: 'narrativeRetract', id: 'smm_host_narrative', projectId: '甲', versionId: narrativeId })
} finally { await narrativeReloaded.close() }
const narrativeRetracted = startInstance({ autoLearnEnabled: false, sleepIntervalMinutes: 0 }, {}, narrativeRoot)
try {
    assert.equal((await narrativeRetracted.api.manage({ action: 'narrativeHistory', id: 'smm_host_narrative', projectId: '甲' })).items[0].state, 'retracted')
    console.log('叙述真实存储验收通过：确认落盘、关闭开关后重载读取及撤回再次重载一致。')
} finally { await narrativeRetracted.close() }
