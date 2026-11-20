import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, fixture, flushTasks } from './harness.mjs'
import { narrativeDomainSpec, parseNarrative, parseNarrativeReview } from '../memory-narrative.js'

const CONTENT = '2026-11-20 的迁移演练未通过。预算为 99.5 元；未经确认不能执行，承诺先核对备份。'
const REFLECTION = '这段经历或许提醒我在下一次行动前保留核对步骤，不急于确认成功。'
const makeModel = (options = {}) => ({
    prepareCall: async () => ({
        config: {},
        async *stream(request) {
            const input = JSON.parse(request.messages[1].content[0].text)
            await options.before?.(input)
            yield { type: 'text-delta', text: options.output?.(input) ?? JSON.stringify(input.reflections
                ? { accepted: options.accepted ?? true, reason: '只描述未来核对建议，未补造历史结果。' }
                : { reflections: [{ quote: input.source, text: REFLECTION }] }) }
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
        },
    }),
})
async function seed(host, overrides = {}) {
    await host.table.put('smm_narrative', fixture('smm_narrative', { kind: 'experience', content: CONTENT, ...overrides }))
    return { action: 'narrativeDraft', id: 'smm_narrative', projectId: overrides.projectId ?? null,
        expectedVersion: (await host.api.getRecord({ id: 'smm_narrative' })).recollectionVersion,
        requestId: 'request-1', style: 'gentle', provider: 'mock', model: 'mock' }
}
const readHistory = (host, projectId = null, options = {}) => host.api.manage({ action: 'narrativeHistory', id: 'smm_narrative', projectId, ...options })
const confirm = (host, draft, projectId = null) => host.api.manage({
    action: 'narrativeConfirm', id: 'smm_narrative', projectId, draftId: draft.entry.id,
})

test('叙述默认关闭且仅 GUI 可生成确认，普通原文读取不调用模型', async () => {
    let calls = 0
    const host = createHarness({}, { llm: makeModel({ before: () => { calls += 1 } }) })
    const args = await seed(host)
    await assert.rejects(host.api.manage(args), /尚未开启/)
    assert.equal((await host.call('memory_manage', args)).code, 'invalid_args')
    assert.equal((await host.api.status()).narrativeEnabled, false)
    assert.equal((await readHistory(host)).total, 0)
    assert.equal(calls, 0)
    for (const value of [0, 499, 60001, null]) assert.throws(() => createHarness({ narrativeTimeoutMs: value }), /narrativeTimeoutMs/)
    await host.dispose()
})

test('草稿经两次模型调用再确认保存，原文与数值承诺完整且重复确认幂等', async () => {
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel() })
    const args = await seed(host, { projectId: '甲' })
    const before = structuredClone([...host.data])
    const draft = await host.api.manage(args)
    assert.equal(draft.inferred, true)
    assert.equal(draft.entry.state, 'draft')
    assert.equal((await readHistory(host, '甲')).total, 0)
    assert.equal((await host.api.manage(args)).entry.id, draft.entry.id)
    const result = await confirm(host, draft, '甲')
    assert.equal(result.duplicate, false)
    assert.equal((await confirm(host, draft, '甲')).duplicate, true)
    assert.equal((await host.api.manage(args)).savedId, result.id)
    await assert.rejects(host.api.manage({ ...args, style: 'reflective' }), /同一请求标识/)
    const history = await readHistory(host, '甲')
    assert.equal(history.total, 1)
    assert.equal(history.items[0].state, 'confirmed')
    assert.equal(history.items[0].applicable, true)
    assert.equal(history.items[0].reflections[0].quote, CONTENT)
    assert.deepEqual([...host.data], before)
    assert.equal((await host.api.status()).metrics.models.narrative.calls, 2)
    assert.equal((await host.api.status()).metrics.models.narrative.reported.totalTokens, 260)
    const recalled = await host.call('memory_recall', { query: '下一次行动', projectId: '甲' })
    assert.ok(recalled.hits.every((hit) => !hit.id.startsWith('narrative_') && !hit.content.includes(REFLECTION)))
    await host.dispose()
})

test('叙述版本串联与撤回保留历史，分页和原文失效状态可见', async () => {
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel() })
    const args = await seed(host)
    const first = await host.api.manage(args)
    await confirm(host, first)
    const second = await host.api.manage({ ...args, requestId: 'request-2', style: 'reflective' })
    assert.equal(second.entry.previousId, first.entry.id)
    await confirm(host, second)
    const page = await readHistory(host, null, { offset: 1, limit: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items[0].id, first.entry.id)
    const retract = { action: 'narrativeRetract', id: args.id, versionId: second.entry.id }
    await host.api.manage(retract)
    await host.api.manage(retract)
    assert.equal((await readHistory(host)).items[0].state, 'retracted')
    assert.equal((await confirm(host, second)).state, 'retracted')
    await host.table.update(args.id, (record) => ({ ...record, source: { kind: 'tool', confirmed: false } }))
    assert.ok((await readHistory(host)).items.every((entry) => !entry.applicable))
    assert.equal((await host.api.status()).narrative.retracted, 1)
    await host.dispose()
})

test('模型输出拒绝伪造引文、新数值、错误结构及复核拒绝且不落库', async () => {
    assert.throws(() => parseNarrative('{"reflections":[{"quote":"捏造","text":"可能成功"}]}', CONTENT))
    assert.throws(() => parseNarrative(JSON.stringify({ reflections: [{ quote: CONTENT, text: '明天 12:00 完成。' }] }), CONTENT))
    assert.throws(() => parseNarrative('{"reflections":[]}', CONTENT))
    assert.throws(() => parseNarrativeReview('{"accepted":true,"reason":"同意","extra":1}'))
    assert.throws(() => parseNarrativeReview('{"accepted":false,"reason":"改写了失败结果"}'), /未通过/)
    for (const options of [
        { accepted: false },
        { output: () => '这不是合法 JSON' },
        { output: () => '{"reflections":[{"quote":"演练已成功","text":"可能值得重复"}]}' },
    ]) {
        const host = createHarness({ narrativeEnabled: true }, { llm: makeModel(options) })
        const args = await seed(host)
        await assert.rejects(host.api.manage(args))
        assert.equal((await readHistory(host)).total, 0)
        assert.equal((await host.api.status()).narrative.rejected, 1)
        await host.dispose()
    }
})

test('生成期间不占写队列，原文或有效状态变化后拒绝草稿', async () => {
    let release
    const waiting = new Promise((resolve) => { release = resolve })
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel({ before: () => waiting }) })
    const args = await seed(host)
    const generating = host.api.manage(args)
    await flushTasks()
    const plan = await host.call('memory_manage', { action: 'setState', id: args.id, state: 'review', reason: '核对事件结果' })
    await host.call('memory_manage', { action: 'setState', id: args.id, state: 'review', reason: '核对事件结果', planToken: plan.planToken, dryRun: false })
    release()
    await assert.rejects(generating, /生成期间原文/)
    assert.equal((await readHistory(host)).total, 0)
    await host.dispose()
})

test('相同请求在途拒绝且并发草稿不能覆盖已确认的新版本', async () => {
    let release
    const waiting = new Promise((resolve) => { release = resolve })
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel({ before: () => waiting }) })
    const args = await seed(host)
    const generating = host.api.manage(args)
    await flushTasks()
    await assert.rejects(host.api.manage(args), /正在生成/)
    const competing = host.api.manage({ ...args, requestId: 'request-2' })
    await flushTasks()
    await assert.rejects(host.api.manage({ ...args, requestId: 'request-3' }), /并发上限/)
    release()
    const [first, second] = await Promise.all([generating, competing])
    await confirm(host, first)
    await assert.rejects(confirm(host, second), /历史已变化/)
    assert.equal((await readHistory(host)).total, 1)
    await host.dispose()
})

test('草稿过期、存储故障及重载后不能意外确认，成功保存可跨实例读取', async () => {
    let failWrite = true
    const host = createHarness({ narrativeEnabled: true }, {
        llm: makeModel(), beforeDomainPut: (name) => { if (name === 'memory_narratives' && failWrite) throw new Error('模拟写入中断') },
    })
    const args = await seed(host)
    const draft = await host.api.manage(args)
    await assert.rejects(confirm(host, draft), /模拟写入中断/)
    assert.equal((await readHistory(host)).total, 0)
    failWrite = false
    await confirm(host, draft)
    const another = await host.api.manage({ ...args, requestId: 'request-2' })
    const originalNow = Date.now
    Date.now = () => another.expiresAt
    try { await assert.rejects(confirm(host, another), /过期/) }
    finally { Date.now = originalNow }
    await host.dispose()
    const reloaded = createHarness({ narrativeEnabled: true }, { data: host.data, domains: host.domains, llm: makeModel() })
    assert.equal((await readHistory(reloaded)).items[0].id, draft.entry.id)
    await assert.rejects(confirm(reloaded, another), /过期/)
    await reloaded.dispose()
})

test('超时与卸载中断模型等待且迟到结果不保存', async () => {
    for (const dispose of [false, true]) {
        const host = createHarness({ narrativeEnabled: true, narrativeTimeoutMs: 500 }, {
            llm: { prepareCall: () => new Promise(() => {}) },
        })
        const args = await seed(host)
        const generating = host.api.manage(args)
        const rejected = assert.rejects(generating)
        await flushTasks()
        if (dispose) await host.dispose()
        await rejected
        assert.equal(host.domains.get('memory_narratives').size, 0)
        if (!dispose) await host.dispose()
    }
})

test('范围、参数和原文资格在模型调用前校验，关闭功能仍可读历史与撤回', async () => {
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel() })
    const args = await seed(host, { projectId: '甲' })
    for (const extra of [{ projectId: '乙' }, { projectId: null }, { expectedVersion: '0'.repeat(64) },
        { style: 'beautify' }, { model: '' }, { provider: ' ' }, { requestId: '' }, { arbitrary: true }]) {
        await assert.rejects(host.api.manage({ ...args, ...extra }))
    }
    for (const extra of [{ kind: 'fact' }, { layer: 'deep' }, { content: '长'.repeat(6001) }, { content: 'api_key=synthetic-example-value' }]) {
        const record = host.table.get(args.id)
        await host.table.put(args.id, { ...record, ...extra })
        await assert.rejects(host.api.manage({ ...args, expectedVersion: (await host.api.getRecord({ id: args.id })).recollectionVersion }))
        await host.table.put(args.id, record)
    }
    assert.equal((await host.api.status()).metrics.models.narrative.calls, 0)
    const draft = await host.api.manage(args)
    await confirm(host, draft, '甲')
    await host.dispose()
    const disabled = createHarness({}, { data: host.data, domains: host.domains })
    assert.equal((await readHistory(disabled, '甲')).total, 1)
    await disabled.api.manage({ action: 'narrativeRetract', id: args.id, projectId: '甲', versionId: draft.entry.id })
    assert.equal((await readHistory(disabled, '甲')).items[0].state, 'retracted')
    await disabled.dispose()
})

test('叙述历史引用保护原始底稿，现有备份范围不会悄悄扩大', async () => {
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel() })
    const args = await seed(host, { layer: 'archive', strength: 0, createdAt: 1, updatedAt: 1, lastAccessAt: 1 })
    const draft = await host.api.manage(args)
    await confirm(host, draft)
    await host.api.manage({ action: 'narrativeRetract', id: args.id, versionId: draft.entry.id })
    assert.equal((await host.call('memory_manage', { action: 'forget', id: args.id })).code, 'conflict')
    await host.api.runSleep({ dryRun: false })
    assert.ok(host.table.get(args.id))
    const backup = await host.api.manage({ action: 'export', includeAudit: true, includeFeedback: true })
    assert.equal(backup.backup.version, 3)
    assert.equal(Object.hasOwn(backup.backup, 'narratives'), false)
    const record = (await readHistory(host)).items[0]
    const { inferred, applicable, ...stored } = record
    assert.equal(narrativeDomainSpec.tables.records.valueSchema.parse(stored).id, record.id)
    for (const extra of [{ state: 'draft' }, { retractedAt: -1 }, { policy: 2 }, { reflections: [] }, { unknown: true }]) {
        assert.throws(() => narrativeDomainSpec.tables.records.valueSchema.parse({ ...stored, ...extra }))
    }
    await host.dispose()
})

test('草稿响应不可篡改缓存，底稿变更和历史容量分别拒绝确认及新增', async () => {
    const host = createHarness({ narrativeEnabled: true }, { llm: makeModel() })
    const args = await seed(host)
    const draft = await host.api.manage(args)
    draft.entry.reflections[0].text = '篡改响应为成功结果'
    await confirm(host, draft)
    assert.equal((await readHistory(host)).items[0].reflections[0].text, REFLECTION)
    const next = await host.api.manage({ ...args, requestId: 'request-2' })
    await host.table.update(args.id, (record) => ({ ...record, content: `${record.content}补充核验限制。` }))
    await assert.rejects(confirm(host, next), /底稿或叙述历史已变化/)
    await host.table.update(args.id, (record) => ({ ...record, content: CONTENT }))
    const stored = [...host.domains.get('memory_narratives').values()][0]
    for (let index = 1; index < 50; index += 1) {
        const id = `narrative_${index.toString(16).padStart(64, '0')}`
        host.domains.get('memory_narratives').set(id, narrativeDomainSpec.tables.records.valueSchema.parse({
            ...stored, id, createdAt: stored.createdAt + index, previousId: stored.id,
        }))
    }
    await assert.rejects(host.api.manage({ ...args, requestId: 'capacity-request' }), /容量已满/)
    assert.equal((await readHistory(host)).total, 50)
    await host.dispose()
})
