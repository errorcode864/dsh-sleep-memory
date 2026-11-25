import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { apply } from '../index.js'
import { createHarness } from './harness.mjs'
import { createLocalSearchIndex } from '../memory-search-index.js'
import { scoreRetrieval } from '../memory-retrieval.js'
import { CAPACITY_CONFIG, CAPACITY_EXPORT, CAPACITY_PROFILES, CAPACITY_QUERY, createCapacityBackup, summarizeCapacitySamples } from './capacity-fixtures.mjs'

const options = JSON.parse(process.argv[2])
const phases = new Map()
const roots = []
const heapSamples = []
const report = { ...options, status: 'running', phases: {}, roots, boundaries: {}, counts: {}, checks: [] }
const observe = () => heapSamples.push({ heapMiB: process.memoryUsage().heapUsed / 1048576, rssMiB: process.memoryUsage().rss / 1048576 })
const measure = async (phase, operation) => {
    process.send?.({ type: 'phase', phase })
    const start = performance.now()
    const value = await operation()
    if (!phases.has(phase)) phases.set(phase, [])
    phases.get(phase).push(performance.now() - start)
    observe()
    process.send?.({ type: 'progress', report: { ...report,
        phases: Object.fromEntries([...phases].map(([name, samples]) => [name, summarizeCapacitySamples(samples)])),
        memory: { sampledHeapMaxMiB: Math.max(...heapSamples.map((sample) => sample.heapMiB)),
            sampledRssMaxMiB: Math.max(...heapSamples.map((sample) => sample.rssMiB)), processMaxRssMiB: process.resourceUsage().maxRSS / 1024 },
    } })
    return value
}
const config = { ...CAPACITY_CONFIG, maxRecords: options.size }

/** 真实宿主仅使用独立 tmp 目录，计时覆盖存储域加载完成。 */
async function openHost(storageRoot) {
    const requireHost = createRequire(process.env.DSH_APP_PACKAGE)
    const { DomainFacility } = requireHost('@deepseek-ai/dsh-storage-domain')
    const { JsonStorageBackend } = requireHost('@deepseek-ai/dsh-storage-json')
    const backend = new JsonStorageBackend(storageRoot)
    const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit: () => {}, logger: console }, { backend: 'json', routes: {} })
    const tools = new Map()
    const cleanups = []
    const provided = new Map()
    apply({
        storageDomain: { open: async (spec) => {
            const domain = await facility.open(spec)
            const table = domain.table('records')
            table.delete = async () => { throw new Error('容量验证禁止物理删除') }
            table.deleteMany = table.delete
            return domain
        } },
        tools: { register: (definition) => tools.set(definition.name, definition) },
        reflect: { provide: (key, value) => provided.set(key, value) },
        effect: (effect) => cleanups.push(effect()), on: () => {}, get: () => undefined,
    }, config)
    const host = {
        api: provided.get('sleepMemoryApi'),
        call: (name, args) => tools.get(name).execute(args),
        async dispose() {
            for (const cleanup of cleanups) if (typeof cleanup === 'function') await cleanup()
            await facility.closeAll()
            await backend.close()
        },
    }
    await host.api.stats()
    return host
}

try {
    const backup = await measure('fixture', () => createCapacityBackup(options.size, options.profile))
    const serialized = await measure('serialize', () => JSON.stringify(backup))
    report.counts = { records: backup.records.length, edges: backup.records.reduce((sum, record) => sum + record.edges.length, 0),
        audits: backup.audits.length, feedback: backup.feedback.length, narratives: backup.narratives.length,
        contentChars: backup.records[0].content.length, jsonBytes: Buffer.byteLength(serialized),
        formattedJsonBytes: Buffer.byteLength(JSON.stringify(backup, null, 2)) }
    report.fixtureChecksum = backup.checksum
    report.boundaries.guiImportAllowed = report.counts.jsonBytes <= 10 * 1024 * 1024
    report.boundaries.guiDownloadAllowed = report.counts.formattedJsonBytes <= 10 * 1024 * 1024
    const cache = createLocalSearchIndex()
    const expectedId = `smm_capacity_${options.size - 1}`
    const expected = backup.records.findIndex((record) => record.id === expectedId)
    const cold = await measure('indexCold', () => cache.build(backup.records))
    const coldScores = await measure('indexQuery', () => scoreRetrieval(cold, CAPACITY_QUERY, { automatic: true }))
    assert.equal(coldScores[expected].score, Math.max(...coldScores.map((score) => score.score)))
    for (let round = 0; round < options.repeats; round += 1) {
        const index = await measure('indexWarm', () => cache.build(backup.records))
        const scores = await measure('indexQuery', () => scoreRetrieval(index, CAPACITY_QUERY, { automatic: true }))
        assert.deepEqual(scores, coldScores)
    }
    report.search = { ...cache.state }
    report.checks.push('冷暖索引评分一致')
    // 超过 GUI 上限时仍验证内部恢复路径，并明确它不是可用的 GUI 导入渠道。
    const restore = async (host) => {
        const args = { action: 'import', backup }
        const tooLarge = report.counts.jsonBytes > 10 * 1024 * 1024
        if (tooLarge) {
            await assert.rejects(host.api.manage(args), /10 MiB/)
            report.boundaries.guiOversizeRejected = true
        }
        const run = tooLarge ? (input) => host.api.capabilities.manage(input) : (input) => host.api.manage(input)
        const plan = await measure('restorePreview', () => run(args))
        assert.equal(plan.planned, options.size)
        assert.equal(plan.plannedNarratives, backup.narratives.length)
        const result = await measure('restoreWrite', () => run({ ...args, dryRun: false, planToken: plan.planToken }))
        assert.equal(result.imported, options.size)
        assert.equal(result.importedNarratives, backup.narratives.length)
        if (tooLarge) {
            await assert.rejects(host.api.manage(CAPACITY_EXPORT), /10 MiB/)
            report.boundaries.guiOversizeExportRejected = true
        }
        const exported = await measure('exportV4', () => tooLarge
            ? host.call('memory_manage', CAPACITY_EXPORT) : host.api.manage(CAPACITY_EXPORT))
        assert.equal(exported.backup.checksum, backup.checksum)
        assert.equal((await run(args)).planned, 0)
    }
    const inspect = async (host, phase) => {
        for (let round = 0; round <= options.repeats; round += 1) {
            const result = await measure(round === 0 ? `${phase}Cold` : `${phase}Warm`, () => host.call('memory_recall', { query: CAPACITY_QUERY, projectId: 'capacity-project', limit: 1 }))
            assert.equal(result.hits[0]?.id, expectedId)
            if (CAPACITY_PROFILES[options.profile].edges) assert.ok(result.hits.some((hit) => hit.via), '密集关联应实际触发扩散')
        }
        assert.equal((await host.call('memory_recall', { query: CAPACITY_QUERY, projectId: 'other-project', limit: 1 })).count, 0)
        const history = await host.api.manage({ action: 'narrativeHistory', id: 'smm_capacity_0', projectId: 'capacity-project' })
        assert.equal(history.items[0].state, 'retracted')
        report.checks.push(`${phase}：目标命中、项目隔离与撤回状态一致`)
    }
    if (options.backend === 'memory') {
        for (let round = 0; round < options.repeats; round += 1) {
            const host = createHarness(config)
            try {
                await restore(host)
                await inspect(host, 'recallMemory')
                const snapshot = JSON.stringify({ records: [...host.data], domains: [...host.domains].map(([name, data]) => [name, [...data]]), runtime: [...host.runtimeData] })
                const reloaded = await measure('reloadSnapshot', async () => {
                    const value = JSON.parse(snapshot)
                    const instance = createHarness(config, {
                        data: new Map(value.records), domains: new Map(value.domains.map(([name, data]) => [name, new Map(data)])),
                        runtimeData: new Map(value.runtime),
                    })
                    await instance.reloadRecords()
                    await instance.api.stats()
                    return instance
                })
                try { await inspect(reloaded, 'recallReloaded') }
                finally { await reloaded.dispose() }
            } finally { await host.dispose() }
        }
    }
    if (options.backend === 'disk') {
        await mkdir(resolve(import.meta.dirname, '../tmp'), { recursive: true })
        for (let round = 0; round < options.repeats; round += 1) {
            const root = await mkdtemp(resolve(import.meta.dirname, '../tmp/capacity-host-'))
            roots.push(root)
            const host = await measure('openEmptyDisk', () => openHost(root))
            try {
                await restore(host)
                const file = resolve(root, 'capacity-backup.json')
                await measure('writeBackupFile', () => writeFile(file, serialized))
                assert.equal((await measure('readBackupFile', async () => JSON.parse(await readFile(file, 'utf8')))).checksum, backup.checksum)
                await inspect(host, 'recallDisk')
            } finally { await measure('closeDisk', () => host.dispose()) }
            const reloaded = await measure('reloadDisk', () => openHost(root))
            try { await inspect(reloaded, 'recallReloaded') }
            finally { await reloaded.dispose() }
        }
    }
    // 容量拒绝必须经过真实导入校验，不能只比较配置数字。
    const limited = createHarness({ ...config, maxRecords: options.size - 1 })
    try {
        const rejection = await limited.api.capabilities.manage({ action: 'import', backup })
        assert.equal(rejection.code, 'invalid_args')
        assert.equal(limited.data.size, 0)
        report.boundaries.recordLimitRejected = true
    } finally { await limited.dispose() }
    report.boundaries.restoreRoute = report.boundaries.guiImportAllowed ? 'gui-api' : 'internal-only'
    report.status = 'passed'
} catch (error) {
    report.status = 'failed'
    report.error = { name: error.name, message: error.message, stack: error.stack }
} finally {
    report.phases = Object.fromEntries([...phases].map(([phase, samples]) => [phase, summarizeCapacitySamples(samples)]))
    report.memory = { sampledHeapMaxMiB: Math.max(...heapSamples.map((sample) => sample.heapMiB)),
        sampledRssMaxMiB: Math.max(...heapSamples.map((sample) => sample.rssMiB)), processMaxRssMiB: process.resourceUsage().maxRSS / 1024 }
    process.send?.({ type: 'result', report })
    if (process.connected) process.disconnect()
    if (report.status !== 'passed') process.exitCode = 1
}
