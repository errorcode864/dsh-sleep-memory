import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, fixture } from './harness.mjs'
import { estimateTokens } from '../memory-metrics.js'

const edges = (...ids) => ids.map((target) => ({ target, relation: 'consolidates', weight: 1 }))
const read = (host, options = {}) => host.call('memory_manage', { action: 'traceSources', id: 'smm_root', ...options })

test('多层追溯保留首次路径和历史状态且不强化或唤醒', async () => {
    const host = createHarness({ dormancyEnabled: true, sleepAuditEnabled: true })
    await host.table.put('smm_leaf', fixture('smm_leaf', { content: '原始证据内容。'.repeat(70), supersededBy: 'smm_mid' }))
    await host.table.put('smm_mid', fixture('smm_mid', {
        layer: 'deep', edges: edges('smm_leaf'), supersededBy: 'smm_root',
        access: { state: 'dormant', at: 1, reason: '长期未用' },
    }))
    await host.table.put('smm_root', fixture('smm_root', { layer: 'deep', edges: edges('smm_mid', 'smm_leaf') }))
    const before = structuredClone([...host.data])
    const result = await read(host, { maxEstimatedTokens: 3000 })
    assert.deepEqual(result.items.map((item) => item.id), ['smm_mid', 'smm_leaf'])
    assert.deepEqual(result.items[1].path, ['smm_root', 'smm_mid', 'smm_leaf'])
    assert.equal(result.items[1].leaf, true)
    assert.equal(result.items[1].truncated, true)
    assert.equal(result.items[0].accessState, 'dormant')
    assert.equal(result.stopped.duplicate, 1)
    assert.equal(result.complete, true)
    const original = await host.call('memory_manage', { action: 'get', id: 'smm_leaf' })
    assert.equal(original.record.content, host.table.get('smm_leaf').content)
    assert.deepEqual([...host.data], before)
    assert.equal((await host.api.manage({ action: 'sleepHistory' })).total, 0)
    assert.equal((await host.api.status()).metrics.evidence.reads, 2)
    await host.dispose()
})

test('追溯可查看失效旧证据但不自动跳到纠正后的事实', async () => {
    const host = createHarness()
    await host.table.put('smm_old', fixture('smm_old'))
    await host.table.put('smm_root', fixture('smm_root', { layer: 'deep', edges: edges('smm_old') }))
    const corrected = await host.call('memory_manage', { action: 'correct', id: 'smm_old', content: '已纠正的版本' })
    const result = await read(host)
    assert.equal(result.items[0].id, 'smm_old')
    assert.equal(result.items[0].current, false)
    assert.ok(!result.items.some((item) => item.id === corrected.id))
    const state = { action: 'setState', id: 'smm_old', state: 'invalid', reason: '证据已过时' }
    const preview = await host.api.manage(state)
    await host.api.manage({ ...state, dryRun: false, planToken: preview.planToken })
    assert.equal((await read(host)).items[0].state, 'invalid')
    await host.dispose()
})

test('项目范围逐边约束且循环、缺失、重复引用分别可见', async () => {
    const host = createHarness()
    await host.table.put('smm_root', fixture('smm_root', { projectId: '甲', layer: 'deep', edges: edges('smm_mid', 'smm_foreign', 'smm_missing') }))
    await host.table.put('smm_mid', fixture('smm_mid', { projectId: '甲', layer: 'deep', edges: edges('smm_root', 'smm_mid') }))
    await host.table.put('smm_foreign', fixture('smm_foreign', { projectId: '乙', content: '其他项目的独有资料' }))
    assert.equal((await read(host, { projectId: '乙' })).code, 'not_found')
    const result = await read(host, { projectId: '甲' })
    assert.equal(result.stopped.cycle, 2)
    assert.equal(result.stopped.scope, 1)
    assert.equal(result.stopped.missing, 1)
    assert.equal(result.complete, false)
    assert.ok(!JSON.stringify(result).includes('smm_foreign'))
    assert.ok(!JSON.stringify(result).includes('其他项目'))
    await host.api.manage({ action: 'bind', sessionId: '来源会话', projectId: '甲' })
    assert.equal((await host.call('memory_manage', { action: 'traceSources', id: 'smm_root' }, { agent: { id: '来源会话' } })).rootId, 'smm_root')
    await host.dispose()
})

test('深度、条数和完整响应的 Token 预算均能中止展开', async () => {
    const host = createHarness()
    await host.table.put('smm_leaf', fixture('smm_leaf', { content: '原始内容。'.repeat(120) }))
    await host.table.put('smm_mid', fixture('smm_mid', { layer: 'deep', edges: edges('smm_leaf') }))
    await host.table.put('smm_root', fixture('smm_root', { layer: 'deep', edges: edges('smm_mid') }))
    const shallow = await read(host, { maxDepth: 1 })
    assert.equal(shallow.items.length, 1)
    assert.equal(shallow.items[0].leaf, false)
    assert.equal(shallow.stopped.depth, 1)
    assert.equal(shallow.complete, false)
    assert.equal((await read(host, { maxNodes: 1 })).stopped.nodes, 1)
    for (const budget of [300, 500, 800, 1200, 2000]) {
        const result = await read(host, { maxEstimatedTokens: budget })
        assert.ok(estimateTokens(JSON.stringify(result, null, 2)) <= budget)
        assert.ok(result.estimatedTokens <= budget)
        if (result.items.length < 2) assert.equal(result.stopped.tokens, 1)
    }
    await host.dispose()
})

test('大量重复边也受遍历上限约束且只沿巩固关系展开', async () => {
    const host = createHarness()
    await host.table.put('smm_leaf', fixture('smm_leaf'))
    await host.table.put('smm_root', fixture('smm_root', {
        layer: 'deep', edges: [
            { target: 'smm_unrelated', relation: 'dream-associate', weight: 1 },
            ...Array.from({ length: 1100 }, () => edges('smm_leaf')[0]),
        ],
    }))
    const result = await read(host)
    assert.equal(result.items.length, 1)
    assert.equal(result.examinedEdges, 1000)
    assert.equal(result.stopped.edges, 1)
    assert.equal(result.stopped.missing, 0)
    assert.equal(result.complete, false)
    await host.dispose()
})

test('追溯边界拒绝非法参数且原 get 契约保持一层来源', async () => {
    const host = createHarness()
    await host.table.put('smm_mid', fixture('smm_mid', { layer: 'deep', edges: edges('smm_leaf') }))
    await host.table.put('smm_leaf', fixture('smm_leaf'))
    await host.table.put('smm_root', fixture('smm_root', { layer: 'deep', edges: edges('smm_mid') }))
    for (const options of [{ maxDepth: 0 }, { maxDepth: 9 }, { maxDepth: null }, { maxNodes: 1.5 }, { maxNodes: 101 }, { maxEstimatedTokens: 299 }, { maxEstimatedTokens: 16001 }, { offset: 1 }]) {
        assert.equal((await read(host, options)).code, 'invalid_args')
    }
    const original = await host.call('memory_manage', { action: 'get', id: 'smm_root' })
    assert.deepEqual(original.sources.map((item) => item.id), ['smm_mid'])
    const leaf = await read(host, { id: 'smm_leaf' })
    assert.equal(leaf.complete, true)
    assert.deepEqual(leaf.items, [])
    await host.dispose()
})
