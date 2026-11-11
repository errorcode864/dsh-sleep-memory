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

function startInstance() {
    const backend = new JsonStorageBackend(root)
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
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    }, { sleepIntervalMinutes: 60, sleepOnStart: false, salientScoringEnabled: false, dreamMaxCandidates: 0 })
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
    await first.call('memory_sleep', {})
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
    const learned = await first.call('memory_recall', { query: 'Java', projectId: '测试项目' })
    learnedId = learned.hits[0].id
} finally {
    await first.close()
}

const second = startInstance()
try {
    assert.equal((await second.api.scope({ sessionId })).scope.projectId, '测试项目')
    assert.equal((await second.api.getRecord({ id: correctedId })).lifecycle.state, 'invalid')
    assert.equal((await second.api.status()).schedule.lastSuccessAt, successfulSleepAt)
    assert.equal((await second.api.status()).lastSleep, null)
    const learned = await second.api.getRecord({ id: learnedId })
    assert.equal(learned.record.source.kind, 'model')
    assert.equal(learned.record.learning.evidence[0].messageId, 'integration-user')
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
    console.log('宿主真实存储集成通过：写入、自主学习、范围绑定、纠正链、失效恢复、持久调度、重载与备份预演。')
    console.log(`隔离数据保留：${root}`)
} finally {
    await second.close()
}
