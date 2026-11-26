import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRecordView } from '../memory-contract.js'
import { createRecallEvidence } from '../memory-recall-evidence.js'
import { estimateTokens } from '../memory-metrics.js'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const config = { progressiveRecallEnabled: true, recallEvidenceMaxEstimatedTokens: 8000 }
const execution = { agent: { id: '取证会话' } }
const edges = (...ids) => ids.map((target) => ({ target, relation: 'consolidates', weight: 1 }))

async function seed(host, overrides = {}) {
    for (const record of [
        fixture('smm_leaf', { content: '迁移验收端口固定为 8611。', supersededBy: 'smm_mid', ...overrides }),
        fixture('smm_mid', { content: '迁移验收需要核对具体端口。', layer: 'deep',
            edges: edges('smm_leaf'), supersededBy: 'smm_root', ...overrides }),
        fixture('smm_root', { content: '迁移验收需核对部署记录。', layer: 'deep', edges: edges('smm_mid'), ...overrides }),
    ]) await host.table.put(record.id, record)
}

async function recall(host, args = {}, context = execution) {
    return host.call('memory_recall', { query: '迁移验收', layers: ['deep'], limit: 1, ...args }, context)
}

const expand = (host, recallId, id = 'smm_root', args = {}, context = execution) =>
    host.call('memory_manage', { action: 'expandRecall', recallId, id, ...args }, context)

test('逐层取证默认关闭且参数只在工具边界校验', async () => {
    for (const invalid of [{ recallEvidenceMaxDepth: 0 }, { recallEvidenceMaxNodes: 101 }, { recallEvidenceMaxEstimatedTokens: 299 }]) {
        assert.throws(() => createHarness(invalid), /config rejected/)
    }
    const disabled = createHarness()
    await seed(disabled)
    assert.equal((await recall(disabled)).evidence, undefined)
    assert.equal((await disabled.api.status()).progressiveRecallEnabled, false)
    assert.equal((await expand(disabled, 'evidence_00000000-0000-0000-0000-000000000000')).code, 'disabled')
    await disabled.dispose()
    const host = createHarness(config)
    await seed(host)
    const { evidence } = await recall(host)
    for (const args of [{ maxNodes: 99 }, { recallId: null }, { id: '' }, { reason: '强制展开' }]) {
        assert.equal((await expand(host, evidence.recallId, 'smm_root', args)).code, 'invalid_args')
    }
    await host.dispose()
})

test('已呈现概要每次展开一层并保持原文、强化、休眠和审计不变', async () => {
    const host = createHarness(config)
    await seed(host)
    await host.table.update('smm_leaf', (record) => ({
        ...record, layer: 'archive', access: { state: 'dormant', at: Date.now(), reason: '只读验收' },
    }))
    const { evidence } = await recall(host)
    const before = structuredClone([...host.data])
    const auditCount = (await host.api.manage({ action: 'sleepHistory' })).total
    assert.deepEqual(evidence.rootIds, ['smm_root'])
    const first = await expand(host, evidence.recallId)
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0].id, 'smm_mid')
    assert.equal(first.items[0].expandable, true)
    first.items[0].path.push('调用方修改响应')
    evidence.limits.maxNodes = 0
    const second = await expand(host, evidence.recallId, 'smm_mid')
    assert.deepEqual(second.items[0].path, ['smm_root', 'smm_mid', 'smm_leaf'])
    assert.equal(second.items[0].content, '迁移验收端口固定为 8611。')
    assert.equal(second.items[0].accessState, 'dormant')
    assert.equal(second.items[0].expandable, false)
    assert.equal((await expand(host, evidence.recallId, 'smm_mid')).code, 'evidence_complete')
    assert.deepEqual([...host.data], before)
    assert.equal((await host.api.manage({ action: 'sleepHistory' })).total, auditCount)
    assert.ok(estimateTokens(JSON.stringify(second, null, 2)) <= second.estimatedTokens)
    assert.equal(first.estimatedTokens + second.estimatedTokens + second.remaining.estimatedTokens, 8000)
    const status = await host.api.status()
    assert.equal(status.recallEvidence.returned, 2)
    assert.equal(status.metrics.evidence.reads, 2)
    assert.equal(JSON.stringify(status.recallEvidence).includes('8611'), false)
    await host.dispose()
})

test('必须使用当前会话已发现的 ID 且不能跨层猜测来源', async () => {
    const host = createHarness(config)
    await seed(host)
    const { evidence } = await recall(host)
    assert.equal((await expand(host, evidence.recallId, 'smm_leaf')).code, 'evidence_not_offered')
    assert.equal((await expand(host, evidence.recallId, 'smm_root', {}, { agent: { id: '另一会话' } })).code, 'evidence_expired')
    assert.equal((await expand(host, evidence.recallId, 'smm_root', {}, {})).code, 'evidence_expired')
    assert.equal((await recall(host, {}, {})).evidence, undefined)
    assert.equal((await expand(host, evidence.recallId, 'smm_root', {}, {
        ...execution, signal: AbortSignal.abort(),
    })).code, 'cancelled')
    await host.dispose()
})

test('同轮多次召回不会重置页游标或预算而新用户轮次会使旧请求失效', async () => {
    const host = createHarness({ ...config, injectEnabled: false })
    await seed(host)
    await injectMessage(host, createMessage('迁移验收', '用户轮次一'), execution)
    const first = (await recall(host)).evidence
    const page = await expand(host, first.recallId)
    const second = (await recall(host)).evidence
    assert.equal(first.recallId, second.recallId)
    assert.equal((await expand(host, second.recallId)).code, 'evidence_complete')
    assert.equal((await expand(host, second.recallId, 'smm_mid')).remaining.estimatedTokens < page.remaining.estimatedTokens, true)
    await injectMessage(host, createMessage('迁移验收', '用户轮次二'), execution)
    assert.equal((await expand(host, first.recallId)).code, 'evidence_expired')
    assert.notEqual((await recall(host)).evidence.recallId, first.recallId)
    await host.dispose()
})

test('自动注入附带可执行取证标识且提示也纳入首次注入预算', async () => {
    const host = createHarness({ ...config, injectRepeatAfterTurns: 0, injectMaxEstimatedTokens: 2000 })
    await seed(host)
    const result = await injectMessage(host, createMessage('迁移验收', '自动轮次'), execution)
    const injected = result.messages.find((message) => message.source?.kind === 'sleep-memory')
    const text = injected.content[0].text
    assert.ok(text.includes('每次一层'))
    assert.ok(estimateTokens(text) <= 2000)
    const recallId = text.match(/evidence_[a-f0-9-]{36}/)[0]
    assert.equal((await expand(host, recallId)).items[0].id, 'smm_mid')
    const limited = createHarness({ ...config, injectMaxEstimatedTokens: 100 })
    await seed(limited)
    const skipped = await injectMessage(limited, createMessage('迁移验收', '预算不足'), execution)
    assert.equal(skipped.messages.length, 1)
    assert.equal(limited.table.get('smm_root').accessCount, 0)
    assert.equal((await limited.api.status()).recallEvidence.returned, 0)
    await limited.dispose()
    await host.dispose()
})

test('项目绑定和显式范围变化会停止旧取证且项目来源不能借全局越界', async () => {
    const host = createHarness(config)
    await seed(host, { projectId: '甲' })
    await host.api.manage({ action: 'bind', sessionId: execution.agent.id, projectId: '甲' })
    const { evidence } = await recall(host)
    assert.equal((await expand(host, evidence.recallId, 'smm_root', { projectId: '乙' })).code, 'evidence_scope_changed')
    await host.api.manage({ action: 'bind', sessionId: execution.agent.id, projectId: '乙' })
    assert.equal((await expand(host, evidence.recallId, 'smm_root', { projectId: '甲' })).code, 'evidence_scope_changed')
    await host.dispose()
    const mixed = createHarness(config)
    await seed(mixed)
    await mixed.table.update('smm_leaf', (record) => ({ ...record, projectId: '机密项目' }))
    const global = (await recall(mixed, { projectId: '甲' })).evidence
    await expand(mixed, global.recallId, 'smm_root', { projectId: '甲' })
    const result = await expand(mixed, global.recallId, 'smm_mid', { projectId: '甲' })
    assert.equal(result.stopped.scope, 1)
    assert.equal(JSON.stringify(result).includes('8611'), false)
    assert.equal(JSON.stringify(result).includes('smm_leaf'), false)
    await mixed.dispose()
})

test('来源纠正、概要再巩固与状态变化使已发现路径失效', async () => {
    for (const mode of ['correct', 'state', 'version']) {
        const host = createHarness(config)
        await seed(host)
        const { evidence } = await recall(host)
        await expand(host, evidence.recallId)
        if (mode === 'correct') await host.call('memory_manage', { action: 'correct', id: 'smm_leaf', content: '迁移验收改为 8612' })
        if (mode === 'state') {
            const args = { action: 'setState', id: 'smm_mid', state: 'review', reason: '重新核验' }
            const plan = await host.api.manage(args)
            await host.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        }
        if (mode === 'version') await host.table.update('smm_root', (record) => ({ ...record, content: '新版概要' }))
        assert.equal((await expand(host, evidence.recallId, 'smm_mid')).code, 'evidence_changed', mode)
        await host.dispose()
    }
})

test('深度、条数和 Token 预算由同轮多个概要共享', async () => {
    for (const [setting, code] of [
        [{ recallEvidenceMaxDepth: 1 }, 'evidence_depth_limit'],
        [{ recallEvidenceMaxNodes: 1 }, 'evidence_budget_exhausted'],
        [{ recallEvidenceMaxEstimatedTokens: 300 }, 'evidence_budget_exhausted'],
    ]) {
        const host = createHarness({ ...config, ...setting })
        await seed(host)
        const { evidence } = await recall(host)
        const first = await expand(host, evidence.recallId)
        if (setting.recallEvidenceMaxEstimatedTokens) {
            assert.ok(first.estimatedTokens <= setting.recallEvidenceMaxEstimatedTokens)
            assert.equal((await expand(host, evidence.recallId, 'smm_mid')).code, code)
        }
        if (!setting.recallEvidenceMaxEstimatedTokens) assert.equal((await expand(host, evidence.recallId, 'smm_mid')).code, code)
        await host.dispose()
    }
    const host = createHarness({ ...config, recallEvidenceMaxNodes: 2 })
    await seed(host)
    await host.table.put('smm_second', fixture('smm_second', { layer: 'deep', content: '迁移验收另一个概要', edges: edges('smm_leaf') }))
    const { evidence } = await recall(host, { limit: 5 })
    await expand(host, evidence.recallId)
    await expand(host, evidence.recallId, 'smm_mid')
    assert.equal((await expand(host, evidence.recallId, 'smm_second')).code, 'evidence_budget_exhausted')
    await host.dispose()
})

test('宽来源分批展开且共享来源、循环及截断都有明确结果', async () => {
    const host = createHarness({ ...config, recallEvidenceMaxEstimatedTokens: 16000 })
    for (let index = 0; index < 7; index += 1) {
        await host.table.put(`smm_${index}`, fixture(`smm_${index}`, { content: '原始证据。'.repeat(100), supersededBy: 'smm_root' }))
    }
    await host.table.put('smm_root', fixture('smm_root', {
        layer: 'deep', content: '迁移验收', edges: edges(...Array.from({ length: 7 }, (_, index) => `smm_${index}`), 'smm_0', 'smm_root'),
    }))
    const { evidence } = await recall(host)
    const first = await expand(host, evidence.recallId)
    assert.equal(first.items.length, 5)
    assert.equal(first.hasMore, true)
    assert.ok(first.items.every((item) => item.truncated && item.content.length === 300))
    const second = await expand(host, evidence.recallId)
    assert.equal(second.items.length, 2)
    assert.equal(second.stopped.duplicate, 1)
    assert.equal(second.stopped.cycle, 1)
    assert.equal(second.hasMore, false)
    assert.equal((await expand(host, evidence.recallId)).code, 'evidence_complete')
    await host.dispose()
})

test('会话缓存有容量与有效期且实例重载不保留取证凭据', async (context) => {
    const store = createRecallEvidence({ ...config, recallEvidenceMaxDepth: 3, recallEvidenceMaxNodes: 20 })
    const first = store.begin('最初会话', '轮次一')
    assert.equal(store.current(first), true)
    context.mock.method(performance, 'now', () => first.expiresAt)
    assert.equal(store.current(first), false)
    const refreshed = store.begin('最初会话', '轮次一')
    assert.notEqual(first.recallId, refreshed.recallId)
    context.mock.restoreAll()
    for (let index = 0; index < 200; index += 1) store.begin(`会话${index}`, '轮次')
    assert.equal(store.current(refreshed), false)
    const host = createHarness(config)
    await seed(host)
    const { evidence } = await recall(host)
    await host.dispose()
    const reload = createHarness(config, { data: host.data })
    assert.equal((await expand(reload, evidence.recallId)).code, 'evidence_expired')
    await reload.dispose()
})

test('边遍历累计有上限且预算响应不超出完整 JSON 估算', () => {
    const store = createRecallEvidence({ ...config, recallEvidenceMaxDepth: 3, recallEvidenceMaxNodes: 20 })
    const root = fixture('smm_root', { layer: 'deep',
        edges: [...Array.from({ length: 1001 }, () => ({ target: 'smm_root', relation: 'dream-associate', weight: 1 })), ...edges('smm_leaf')] })
    const leaf = fixture('smm_leaf')
    const view = createRecordView([[root.id, root], [leaf.id, leaf]])
    const session = store.begin('会话', '轮次')
    store.offer(session, [root], null, null, view)
    const args = { action: 'expandRecall', id: root.id, recallId: session.recallId, projectId: null }
    const result = store.expand(args, '会话', null, view)
    assert.equal(result.stopped.edges, 1)
    assert.equal(result.items.length, 0)
    assert.ok(estimateTokens(JSON.stringify(result, null, 2)) <= result.estimatedTokens)
    assert.equal(store.expand(args, '会话', null, view).code, 'evidence_budget_exhausted')
})

test('审核拒绝不开放来源且较早轮次的迟到审核不能覆盖新轮次', async () => {
    const ready = Promise.withResolvers()
    const waiting = Promise.withResolvers()
    let calls = 0
    const host = createHarness({ ...config, recallReviewEnabled: true, injectMaxEstimatedTokens: 2000 }, { llm: {
        prepareCall: async () => ({
            config: {},
            stream: async function* () {
                calls += 1
                const first = calls === 1
                if (first) { ready.resolve(); await waiting.promise }
                yield { type: 'text-delta', text: JSON.stringify({
                    decisions: [{ id: 'smm_root', useful: first, reason: '验证不同轮次审核' }],
                }) }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }),
    } })
    await seed(host)
    const first = injectMessage(host, createMessage('迁移验收', '旧轮次'), execution)
    await ready.promise
    const second = await injectMessage(host, createMessage('迁移验收', '新轮次'), execution)
    assert.equal(second.messages.length, 1)
    waiting.resolve()
    assert.equal((await first).messages.length, 1)
    const status = await host.api.status()
    assert.ok(status.metrics.recentRecalls.some((trace) => trace.diagnostics.reasons['turn-changed'] === 1))
    assert.equal(host.table.get('smm_root').accessCount, 0)
    assert.equal(status.recallEvidence.returned, 0)
    await host.dispose()
})
