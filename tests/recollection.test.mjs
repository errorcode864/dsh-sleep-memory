import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, fixture } from './harness.mjs'
import { createRecordView } from '../memory-contract.js'
import { createRecollection } from '../memory-recollection.js'

const DAY = 86_400_000
const NOW = 800 * DAY
const content = Array.from({ length: 40 }, (_, index) =>
    `第 ${index + 1} 次演练🙂，必须先核对备份和恢复条件才能操作，未确认时不能执行。`).join('\n')
const recollect = (overrides = {}, options = {}) => {
    const record = fixture('smm_recollection', { kind: 'experience', content, createdAt: 1, occurredAt: 1, eventEndAt: 1, ...overrides })
    return createRecollection(record, createRecordView([[record.id, record]]), { now: NOW, ...options })
}

test('回忆按事件年龄分档且展开保留原片段，全文逐字覆盖没有半句截断', () => {
    const views = [1, 40, 200].map((days) => recollect({ eventEndAt: NOW - days * DAY }))
    assert.deepEqual(views.map((view) => view.excerptBudgetChars), [900, 600, 300])
    assert.ok(views[0].includedChars > views[1].includedChars)
    assert.ok(views[1].includedChars > views[2].includedChars)
    const expanded = recollect({}, { detail: 'expanded' })
    assert.ok(expanded.includedChars > views[2].includedChars)
    for (const fragment of views[2].fragments) assert.ok(expanded.fragments.some((item) => item.start <= fragment.start && item.end >= fragment.end))
    for (const view of [...views, expanded]) {
        assert.equal(view.inferred, false)
        assert.ok(view.includedChars <= view.excerptBudgetChars)
        assert.equal(view.includedChars + view.omittedChars, content.length)
        const spans = [...view.fragments, ...view.omitted].sort((a, b) => a.start - b.start)
        assert.equal(spans[0].start, 0)
        assert.equal(spans.at(-1).end, content.length)
        for (const [index, span] of spans.entries()) {
            if (index) assert.equal(span.start, spans[index - 1].end)
            if ('text' in span) assert.equal(span.text, content.slice(span.start, span.end))
        }
        assert.ok(view.fragments.every((fragment) => fragment.text.endsWith('。') || fragment.text.endsWith('\n')))
    }
    assert.equal(recollect({}, { detail: 'original' }).content, content)
})

test('事实、显著经历和偏好不因年龄丢失日期数值承诺与否定条件', () => {
    for (const overrides of [{ kind: 'fact' }, { layer: 'salient' }, {
        learning: { category: 'preference', reason: '明确偏好', relatedIds: [], evidence: [{ messageId: 'm1', quote: '始终中文' }] },
    }]) {
        const result = recollect({ ...overrides, content: `2026-11-20 承诺 12:30 前完成，预算 99.5 元，不得擅自上线；始终中文。\n${content}` })
        assert.equal(result.truncated, false)
        assert.equal(result.omittedChars, 0)
        assert.ok(result.content.startsWith('2026-11-20 承诺 12:30'))
    }
    assert.equal(recollect({ eventEndAt: NOW + DAY }).ageDays, 0)
    const legacy = recollect({ createdAt: NOW - 60 * DAY, occurredAt: undefined, eventEndAt: undefined })
    assert.equal(legacy.ageDays, 60)
    assert.equal(legacy.ageBasis, 'createdAt')
    assert.equal(recollect({ eventEndAt: undefined }).ageBasis, 'occurredAt')
})

test('问题线索优先完整句段，长句放不下时明确省略且不把梗概当底稿', () => {
    const text = `${content}\n金额必须保持 99.5 元，不得省略这个限制。`
    const result = recollect({ content: text, gist: '事情已经成功。' }, { query: '金额' })
    assert.ok(result.content.includes('金额必须保持 99.5 元，不得省略这个限制。'))
    assert.ok(!result.content.includes('事情已经成功'))
    assert.ok(result.omitted[0].start >= 0)
    const long = recollect({ content: '未经确认不能执行'.repeat(400) })
    assert.equal(long.content, '')
    assert.equal(long.omittedChars, long.originalChars)
    assert.equal(recollect({ content: '未经确认不能执行'.repeat(400) }, { detail: 'original' }).omittedChars, 0)
    assert.equal(recollect({ content: '！？\n🙂' }).content, '！？\n🙂')
})

test('视图版本稳定且展示变化单独版本化，访问强度不参与事实版本', async () => {
    const host = createHarness()
    await host.table.put('smm_recollection', fixture('smm_recollection', { content, kind: 'experience', occurredAt: 1 }))
    const get = await host.call('memory_manage', { action: 'get', id: 'smm_recollection' })
    const input = { action: 'recollect', id: get.record.id, expectedVersion: get.recollectionVersion }
    const before = structuredClone([...host.data])
    const brief = await host.call('memory_manage', input)
    assert.deepEqual(brief, await host.call('memory_manage', input))
    const expanded = await host.call('memory_manage', { ...input, detail: 'expanded' })
    assert.equal(brief.sourceVersion, expanded.sourceVersion)
    assert.notEqual(brief.viewVersion, expanded.viewVersion)
    assert.deepEqual([...host.data], before)
    await host.table.update(get.record.id, (record) => ({ ...record, strength: 0.1, accessCount: 20, lastAccessAt: Date.now() }))
    assert.equal((await host.call('memory_manage', input)).sourceVersion, brief.sourceVersion)
    await host.table.update(get.record.id, (record) => ({ ...record, content: `${record.content}新的条件。` }))
    assert.equal((await host.call('memory_manage', input)).code, 'conflict')
    await host.dispose()
})

test('原文对照拒绝状态和来源变更，历史版本仍可显式只读查看', async () => {
    const host = createHarness()
    await host.table.put('smm_fact', fixture('smm_fact'))
    const previous = await host.call('memory_manage', { action: 'recollect', id: 'smm_fact' })
    const corrected = await host.call('memory_manage', { action: 'correct', id: 'smm_fact', content: '当前有效的新条件。' })
    assert.equal((await host.call('memory_manage', { action: 'recollect', id: 'smm_fact', expectedVersion: previous.sourceVersion })).code, 'conflict')
    const historical = await host.call('memory_manage', { action: 'recollect', id: 'smm_fact' })
    assert.equal(historical.current, false)
    assert.equal(historical.replacedBy, corrected.id)
    const latest = await host.call('memory_manage', { action: 'recollect', id: corrected.id })
    await host.table.update(corrected.id, (record) => ({ ...record, source: { kind: 'user', confirmed: true } }))
    assert.equal((await host.call('memory_manage', { action: 'recollect', id: corrected.id, expectedVersion: latest.sourceVersion })).code, 'conflict')
    const source = await host.call('memory_manage', { action: 'recollect', id: corrected.id })
    const plan = await host.call('memory_manage', { action: 'setState', id: corrected.id, state: 'review', reason: '核对来源' })
    await host.call('memory_manage', { action: 'setState', id: corrected.id, state: 'review', reason: '核对来源', dryRun: false, planToken: plan.planToken })
    assert.equal((await host.call('memory_manage', { action: 'recollect', id: corrected.id, expectedVersion: source.sourceVersion })).code, 'conflict')
    await host.dispose()
})

test('回忆读取遵守会话项目范围且不写回休眠、审计和反馈', async () => {
    const host = createHarness({ feedbackEnabled: true, dormancyEnabled: true, sleepAuditEnabled: true })
    await host.table.put('smm_scoped', fixture('smm_scoped', { content, kind: 'experience', layer: 'deep', projectId: '甲',
        access: { state: 'dormant', at: 1, reason: '长期未用' } }))
    await host.call('memory_manage', { action: 'bind', sessionId: 'session-recollection', projectId: '甲' })
    const before = structuredClone({ data: [...host.data], domains: [...host.domains], runtime: [...host.runtimeData] })
    assert.equal((await host.call('memory_manage', { action: 'recollect', id: 'smm_scoped', projectId: '乙' })).code, 'not_found')
    assert.equal((await host.call('memory_manage', { action: 'recollect', id: 'smm_scoped' })).code, 'not_found')
    assert.equal((await host.call('memory_manage', { action: 'recollect', id: 'smm_scoped' }, { agent: { id: 'session-recollection' } })).id, 'smm_scoped')
    assert.deepEqual({ data: [...host.data], domains: [...host.domains], runtime: [...host.runtimeData] }, before)
    assert.equal((await host.api.status()).metrics.evidence.reads, 1)
    await host.dispose()
})

test('工具和界面共享回忆输入校验，合法空线索与全局记忆兼容', async () => {
    const host = createHarness()
    await host.table.put('smm_global', fixture('smm_global', { content }))
    const input = { action: 'recollect', id: 'smm_global', projectId: '甲', query: '' }
    assert.equal((await host.api.manage(input)).content, content)
    for (const invalid of [{ detail: 'dream' }, { detail: null }, { query: 1 }, { query: '长'.repeat(501) },
        { expectedVersion: true }, { expectedVersion: 'outdated' }, { now: 1 }, { maxChars: 1 }]) {
        assert.equal((await host.call('memory_manage', { ...input, ...invalid })).code, 'invalid_args')
        await assert.rejects(host.api.manage({ ...input, ...invalid }))
    }
    await assert.rejects(host.api.manage({ ...input, expectedVersion: '0'.repeat(64) }), /原文或有效状态已变化/)
    await host.dispose()
})
