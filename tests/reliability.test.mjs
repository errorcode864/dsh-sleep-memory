import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupChecksum } from '../memory-contract.js'
import { createHarness, fixture, createMessage, injectMessage, flushTasks, mockAffect } from './harness.mjs'

const DAY = 86400000

test('自动情绪记忆通过真实 schema，并可重新加载', async () => {
    const h = createHarness({ salientScoringEnabled: true, injectEnabled: false, projectId: '项目甲' }, { llm: mockAffect() })
    await injectMessage(h, createMessage('成功解决了很困难的问题！'))
    await flushTasks()
    const records = await h.reloadRecords()
    assert.equal(records.length, 1)
    assert.match(records[0].id, /^smm_/)
    assert.equal(records[0].projectId, '项目甲')
    assert.equal(records[0].source.confirmed, false)
    assert.equal((await h.api.status()).scoring.stored, 1)
})

test('同一时刻重复睡眠不重复衰减，分段结算近似等于一次结算', async (t) => {
    const now = 1800000000000
    t.mock.method(Date, 'now', () => now)
    const h = createHarness()
    await h.table.put('smm_a', fixture('smm_a', { layer: 'deep', strength: 1, lastAccessAt: now - DAY }))
    await h.call('memory_sleep', {})
    const first = h.table.get('smm_a').strength
    await h.call('memory_sleep', {})
    assert.equal(h.table.get('smm_a').strength, first)
    Date.now.mock.mockImplementation(() => now + DAY)
    await h.call('memory_sleep', {})
    assert.ok(Math.abs(h.table.get('smm_a').strength - 2 ** (-2 / 14)) < 0.000002)
    assert.equal(h.table.get('smm_a').lastAccessAt, now - DAY)
})

test('巩固后 raw 仍可召回细节，按 ID 追溯无写入，事实不被截断', async () => {
    const h = createHarness()
    for (const id of ['smm_a', 'smm_b']) await h.table.put(id, fixture(id, { strength: 0.4 }))
    const report = await h.call('memory_sleep', {})
    assert.equal(report.consolidatedCount, 1)
    const hits = await h.call('memory_recall', { query: 'UNIQUE_42', fidelity: 'raw' })
    assert.equal(hits.count, 2)
    const before = h.writes.length
    const original = await h.call('memory_manage', { action: 'get', id: 'smm_a' })
    assert.match(original.record.content, /UNIQUE_42/)
    const sources = await h.call('memory_manage', { action: 'get', id: report.consolidated[0].deepId, limit: 1 })
    assert.equal(sources.totalSources, 2)
    assert.equal(sources.sources.length, 1)
    assert.equal(h.writes.length, before)
    await h.table.put('smm_archive', fixture('smm_archive', { layer: 'archive', strength: 0.1, gist: '旧概要' }))
    const facts = await h.call('memory_recall', { query: 'UNIQUE_42', layers: ['archive'] })
    assert.equal(facts.hits[0].drift.applied, false)
    assert.match(facts.hits[0].content, /UNIQUE_42/)
})

test('GUI 和工具共用睡眠锁，召回等待睡眠结束且强化不会被覆盖', async () => {
    let release
    let entered
    const gate = new Promise((resolve) => { release = resolve })
    const started = new Promise((resolve) => { entered = resolve })
    let blocked = false
    const h = createHarness({}, { beforeUpdate: async () => { if (!blocked) { blocked = true; entered(); await gate } } })
    await h.table.put('smm_a', fixture('smm_a', { layer: 'deep', lastAccessAt: Date.now() - DAY }))
    const pending = h.call('memory_sleep', {})
    await started
    assert.equal((await h.call('memory_sleep', {})).code, 'busy')
    await assert.rejects(h.api.runSleep({}), /busy/)
    let recalled = false
    const recall = h.call('memory_recall', { query: 'UNIQUE_42' }).then(() => { recalled = true })
    await flushTasks()
    assert.equal(recalled, false)
    release()
    await Promise.all([pending, recall])
    assert.equal(h.table.get('smm_a').accessCount, 1)
    assert.equal((await h.api.status()).sleeping, false)
})

test('注入阈值淘汰的候选不强化，也不产生关联注入', async () => {
    const h = createHarness({ injectMinScore: 100 })
    await h.table.put('smm_a', fixture('smm_a'))
    const before = h.table.get('smm_a')
    const result = await injectMessage(h, createMessage('部署 UNIQUE_42'))
    assert.equal(result.messages.length, 1)
    assert.deepEqual(h.table.get('smm_a'), before)
})

test('满库预演与实际执行保持相同容量和巩固结果', async () => {
    const h = createHarness({ maxRecords: 2 })
    for (const id of ['smm_a', 'smm_b']) await h.table.put(id, fixture(id, { strength: 0.4 }))
    const before = h.writes.length
    const preview = await h.call('memory_sleep', { dryRun: true })
    assert.equal(h.writes.length, before)
    const actual = await h.call('memory_sleep', {})
    for (const key of ['consolidatedCount', 'capacityLimited', 'recordsAfter', 'archivedCount']) {
        assert.deepEqual(actual[key], preview[key])
    }
    assert.equal(actual.capacityLimited, true)
})

test('项目范围同时约束直接召回、注入和联想，项目间不巩固', async () => {
    const h = createHarness({ projectId: '甲', injectMinScore: 0, dreamMaxCandidates: 10 })
    for (const [id, projectId] of [['smm_a', '甲'], ['smm_b', '乙'], ['smm_g', null]]) {
        await h.table.put(id, fixture(id, { projectId, strength: 0.4 }))
    }
    const global = await h.call('memory_recall', { query: '部署', projectId: null })
    assert.deepEqual(global.hits.map((hit) => hit.id), ['smm_g'])
    const scoped = await h.call('memory_recall', { query: '部署', projectId: '甲', includeGlobal: false })
    assert.deepEqual(scoped.hits.map((hit) => hit.id), ['smm_a'])
    const result = await injectMessage(h, createMessage('部署'))
    assert.ok(result.messages[1].source.recalled.includes('smm_a'))
    assert.ok(!result.messages[1].source.recalled.includes('smm_b'))
    const report = await h.call('memory_sleep', {})
    assert.equal(report.consolidatedCount, 0)
    assert.equal(report.edgesAdded, 0)
})

test('事实纠正只有一次写入，旧事实和过时概要退出有效召回', async () => {
    const h = createHarness()
    for (const id of ['smm_a', 'smm_b']) await h.table.put(id, fixture(id, { strength: 0.4, projectId: '甲' }))
    const report = await h.call('memory_sleep', {})
    const before = h.writes.length
    const result = await h.call('memory_manage', { action: 'correct', id: 'smm_a', projectId: '甲', content: '部署参数已改为 NEW_99' })
    assert.equal(h.writes.length - before, 1)
    assert.equal(result.replaces, 'smm_a')
    assert.match(h.table.get('smm_a').content, /UNIQUE_42/)
    const hits = await h.call('memory_recall', { query: '部署', projectId: '甲' })
    assert.ok(hits.hits.some((hit) => hit.id === result.id))
    assert.ok(hits.hits.some((hit) => hit.id === 'smm_b'))
    assert.ok(!hits.hits.some((hit) => hit.id === 'smm_a' || hit.id === report.consolidated[0].deepId))
    assert.equal((await h.call('memory_manage', { action: 'get', id: 'smm_a', projectId: '甲' })).current, false)
    assert.equal((await h.call('memory_manage', { action: 'correct', id: 'smm_a', projectId: '甲', content: '第二次纠正' })).code, 'conflict')
    assert.equal((await h.call('memory_manage', { action: 'correct', id: 'smm_b', projectId: '乙', content: '错误项目' })).code, 'not_found')
})

test('事件时间与写入时间独立，巩固保留事件范围，纯时间窗可查询', async () => {
    const h = createHarness()
    const old = Date.now() - 30 * DAY
    for (const id of ['smm_a', 'smm_b']) {
        await h.table.put(id, fixture(id, { strength: 0.4, occurredAt: old, createdAt: Date.now() - DAY }))
    }
    const report = await h.call('memory_sleep', {})
    const raw = await h.call('memory_recall', { query: 'UNIQUE_42', since: old - 1, until: old + 1, timeField: 'occurredAt' })
    assert.equal(raw.count, 2)
    const timeOnly = await h.call('memory_recall', { since: old - 1, until: old + 1, timeField: 'occurredAt' })
    assert.ok(timeOnly.hits.some((hit) => hit.id === report.consolidated[0].deepId))
    assert.equal((await h.call('memory_recall', { since: old - 1, until: old + 1 })).count, 0)
})

test('备份包含历史与来源，导入默认预演，重复导入幂等', async () => {
    const source = createHarness()
    const written = await source.call('memory_write', { kind: 'fact', content: '原始项目事实', projectId: '甲', source: { kind: 'user', confirmed: true } })
    await source.call('memory_manage', { action: 'correct', id: written.id, projectId: '甲', content: '更新后的项目事实' })
    const { backup } = await source.call('memory_manage', { action: 'export' })
    const target = createHarness()
    const preview = await target.call('memory_manage', { action: 'import', backup })
    assert.equal(preview.planned, 2)
    assert.equal(target.table.size, 0)
    assert.equal((await target.call('memory_manage', { action: 'import', backup, dryRun: false })).imported, 2)
    assert.equal((await target.call('memory_manage', { action: 'import', backup, dryRun: false })).skipped, 2)
    assert.equal((await target.reloadRecords()).length, 2)
})

test('备份校验失败、ID 冲突和跨项目边均在任何写入前拒绝', async () => {
    const h = createHarness()
    await h.table.put('smm_a', fixture('smm_a'))
    const { backup } = await h.call('memory_manage', { action: 'export' })
    const baseline = h.writes.length
    backup.records[0].content = '篡改'
    assert.equal((await h.call('memory_manage', { action: 'import', backup, dryRun: false })).code, 'invalid_args')
    backup.checksum = backupChecksum(backup.records)
    assert.equal((await h.call('memory_manage', { action: 'import', backup, dryRun: false })).code, 'invalid_args')
    const target = createHarness()
    const records = [
        fixture('smm_x', { projectId: '甲', edges: [{ target: 'smm_y', relation: 'dream-associate', weight: 1 }] }),
        fixture('smm_y', { projectId: '乙' }),
    ]
    const bad = { format: 'dsh-sleep-memory', version: 1, records, checksum: backupChecksum(records) }
    assert.equal((await target.call('memory_manage', { action: 'import', backup: bad, dryRun: false })).code, 'invalid_args')
    assert.equal(target.writes.length, 0)
    assert.equal(h.writes.length, baseline)
})

test('导入 I/O 中断透出失败，重试跳过已成功记录', async () => {
    const source = createHarness()
    for (const id of ['smm_a', 'smm_b']) await source.table.put(id, fixture(id))
    const { backup } = await source.call('memory_manage', { action: 'export' })
    let fail = true
    const target = createHarness({}, { beforePut: async (id) => { if (id === 'smm_b' && fail) throw new Error('模拟写入失败') } })
    await assert.rejects(target.call('memory_manage', { action: 'import', backup, dryRun: false }), /模拟写入失败/)
    assert.equal(target.table.size, 1)
    fail = false
    const retry = await target.call('memory_manage', { action: 'import', backup, dryRun: false })
    assert.equal(retry.skipped, 1)
    assert.equal(retry.imported, 1)
})

test('启动补跑和错误状态可观察，睡眠失败释放锁', async () => {
    const startup = createHarness({ sleepOnStart: true })
    await flushTasks()
    assert.ok((await startup.api.status()).lastSleep)
    let fail = true
    const h = createHarness({}, { beforeUpdate: async () => { if (fail) throw new Error('模拟睡眠失败') } })
    await h.table.put('smm_a', fixture('smm_a', { layer: 'deep', lastAccessAt: Date.now() - DAY }))
    await assert.rejects(h.api.runSleep({}), /模拟睡眠失败/)
    assert.match((await h.api.status()).lastSleepError.message, /模拟睡眠失败/)
    fail = false
    await h.api.runSleep({})
    assert.equal((await h.api.status()).lastSleepError, null)
})

test('新参数类型与未知字段拒绝，不污染存储', async () => {
    const h = createHarness()
    for (const args of [
        { content: '测试', kind: 'fact', projectId: ' 甲' },
        { content: '测试', kind: 'fact', source: { kind: '伪造' } },
        { content: '测试', kind: 'fact', occurredAt: -1 },
    ]) assert.equal((await h.call('memory_write', args)).code, 'invalid_args')
    assert.equal((await h.call('memory_sleep', { dryRun: 'true' })).code, 'invalid_args')
    assert.equal((await h.call('memory_recall', { query: '测试', includeGlobal: 'true' })).code, 'invalid_args')
    assert.equal((await h.call('memory_manage', { action: 'import', dryRun: 'false' })).code, 'invalid_args')
    assert.equal(h.table.size, 0)
})

test('纠正链不能因自动遗忘或逐条遗忘而复活旧事实', async () => {
    const h = createHarness()
    await h.table.put('smm_old', fixture('smm_old', { content: '旧事实 OLD_ONLY' }))
    await h.table.put('smm_new', fixture('smm_new', {
        content: '新事实 NEW_ONLY', replaces: 'smm_old', layer: 'archive',
        strength: 0.01, lastAccessAt: Date.now() - 200 * DAY,
    }))
    const preview = await h.call('memory_sleep', { dryRun: true })
    assert.equal(preview.deletedCount, 0)
    await h.call('memory_sleep', {})
    for (const id of ['smm_old', 'smm_new']) {
        assert.equal((await h.call('memory_manage', { action: 'forget', id })).code, 'conflict')
    }
    const recalled = await h.call('memory_recall', { query: 'OLD_ONLY', fidelity: 'raw' })
    assert.ok(!recalled.hits.some((hit) => hit.id === 'smm_old'))
})

test('旧自动情绪 UUID 可以读取，其他非法 ID 仍被拒绝', async () => {
    const h = createHarness()
    const legacyId = 'b8d8f2ca-1234-4567-8910-123456789abc'
    await h.table.put(legacyId, fixture(legacyId, {
        kind: 'experience', layer: 'salient', tags: ['auto-salient'], valence: 0.8, arousal: 0.8,
    }))
    assert.equal((await h.reloadRecords()).length, 1)
    await assert.rejects(h.table.put('invalid', fixture('invalid')), /ID/)
})

test('新管理动作卡片不会把成功误报为失败', async () => {
    const h = createHarness()
    const definition = h.tools.get('memory_manage')
    const result = await h.call('memory_manage', { action: 'status' })
    const meta = definition.output.presentationMeta({ action: 'status' }, result)
    assert.equal(meta.ok, true)
    assert.match(definition.presentResult({}, { meta }).title, /运行状态/)
})
