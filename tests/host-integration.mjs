import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { apply } from '../index.js'

// 在 Electron 的 Node 模式下读取已安装宿主组件；只写入本仓库 tmp 隔离目录。
const appPackage = process.env.DSH_APP_PACKAGE
if (!appPackage) throw new Error('请通过 DSH_APP_PACKAGE 指定已安装宿主的 dsh/package.json')
const requireHost = createRequire(appPackage)
const { DomainFacility } = requireHost('@deepseek-ai/dsh-storage-domain')
const { JsonStorageBackend } = requireHost('@deepseek-ai/dsh-storage-json')
const testRoot = resolve(import.meta.dirname, '../tmp')
await mkdir(testRoot, { recursive: true })
const root = await mkdtemp(resolve(testRoot, 'host-integration-'))

function startInstance(config = {}, failure = {}, storageRoot = root) {
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
        llm: {
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
