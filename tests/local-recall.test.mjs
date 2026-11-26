import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createLocalSearchIndex } from '../memory-search-index.js'
import { buildRetrievalIndex } from '../memory-retrieval.js'
import { selectRecallAliases } from '../memory-query-plan.js'
import { createHarness, fixture, injectMessage, createMessage } from './harness.mjs'

test('分词缓存复用强化后的记录并按内容更新，同时只统计当前范围', () => {
    const cache = createLocalSearchIndex()
    const first = fixture('smm_cache_1', { content: 'JWT 使用 refresh_token 续期', projectId: 'a' })
    const other = fixture('smm_cache_2', { content: 'GitHub 代理 IP 设置', projectId: 'b' })
    cache.build([first, other])
    assert.deepEqual(cache.build([{ ...first, accessCount: 2, strength: 0.9 }]),
        buildRetrievalIndex([[first.content, ...first.tags, ...first.keywords]]))
    assert.equal(cache.state.rebuilt, 2)
    assert.equal(cache.state.reused, 1)
    cache.build([{ ...first, content: 'JWT 禁止自动续期' }])
    assert.equal(cache.state.rebuilt, 3)
    cache.retain([first.id])
    assert.equal(cache.state.cached, 1)
})

test('标签和关键词原地变更会重建分词，保留集合变化不复用旧 ID', () => {
    const record = fixture('smm_mutable', { content: '恢复演练', tags: ['发布'], keywords: ['node-a'] })
    const cache = createLocalSearchIndex()
    const first = cache.build([record])
    record.tags[0] = '归档'
    record.keywords[0] = 'node-b'
    const updated = cache.build([record])
    assert.equal(first.analyses[0].tokens.has('identifier:node-a'), true)
    assert.equal(updated.analyses[0].tokens.has('identifier:node-a'), false)
    assert.equal(updated.analyses[0].tokens.has('identifier:node-b'), true)
    assert.equal(cache.state.rebuilt, 2)
    cache.retain([])
    assert.equal(cache.state.cached, 0)
    assert.deepEqual(cache.build([record]), updated)
    assert.equal(cache.state.rebuilt, 3)
})

test('术语别名限定项目和完整标识符边界', () => {
    const aliases = [
        { projectId: 'a', phrase: 'JWT', target: 'refresh_token' },
        { projectId: null, phrase: 'JWT', target: 'global_token' },
    ]
    assert.equal(selectRecallAliases('jwt 续期', 'a', aliases).length, 1)
    assert.equal(selectRecallAliases('other_jwt 续期', 'a', aliases).length, 0)
    assert.equal(selectRecallAliases('jwt-service 续期', 'a', aliases).length, 0)
    assert.equal(selectRecallAliases('other.jwt 续期', 'a', aliases).length, 0)
    assert.equal(selectRecallAliases('jwt 续期', 'b', aliases).length, 0)
    assert.equal(selectRecallAliases('jwt 续期', null, aliases)[0].target, 'global_token')
})

test('local 使用配置术语召回并保留原问题精确实体冲突', async () => {
    const harness = createHarness({
        projectId: 'a', recallPlanMode: 'local', spreadDepth: 0,
        recallAliases: [{ projectId: 'a', phrase: '登录过期', target: 'refresh_token' }],
    })
    await harness.table.put('smm_local_1', fixture('smm_local_1', {
        projectId: 'a', content: 'JWT 使用 refresh_token 续期，部署端口 8080。',
    }))
    assert.equal((await harness.call('memory_recall', { query: '登录过期' })).count, 1)
    assert.equal((await harness.call('memory_recall', { query: '登录过期，端口 9090' })).count, 0)
    assert.equal((await harness.call('memory_recall', { query: '登录过期', projectId: 'b' })).count, 0)
    assert.equal((await harness.api.status()).searchIndex.rebuilt, 1)
})

test('shadow 只记录候选差异，额外候选不注入也不强化', async () => {
    const harness = createHarness({
        projectId: 'a', recallPlanMode: 'shadow', spreadDepth: 0,
        recallAliases: [{ projectId: 'a', phrase: '登录过期', target: 'refresh_token' }],
    })
    await harness.table.put('smm_shadow', fixture('smm_shadow', { projectId: 'a', content: 'JWT refresh_token' }))
    const decision = await injectMessage(harness, createMessage('登录过期'))
    assert.equal(decision.messages.length, 1)
    assert.equal(harness.table.get('smm_shadow').accessCount, 0)
    const status = await harness.api.status()
    assert.deepEqual(status.recallPlan.last.originalIds, [])
    assert.deepEqual(status.recallPlan.last.plannedIds, ['smm_shadow'])
})

test('local 的单字弱匹配允许零条，显式空查询仍可浏览', async () => {
    const harness = createHarness({ recallPlanMode: 'local', spreadDepth: 0 })
    await harness.table.put('smm_char', fixture('smm_char', { content: '保存完整的培训记录' }))
    assert.equal((await harness.call('memory_recall', { query: '培' })).count, 0)
    assert.equal((await harness.call('memory_recall', { layers: ['surface'] })).count, 1)
})

test('local 拒绝排查拆出的单字和低主题覆盖，单独中文术语仍可查', async () => {
    const harness = createHarness({ recallPlanMode: 'local', spreadDepth: 0 })
    await harness.table.put('smm_proxy_fragment', fixture('smm_proxy_fragment', { content: 'GitHub 网络代理 SSH 排障。' }))
    await harness.table.put('smm_water', fixture('smm_water', { content: '水 是实验中的溶剂。' }))
    assert.equal((await harness.call('memory_recall', { query: '排查 enroll 的 del_flag' })).count, 0)
    assert.equal((await harness.call('memory_recall', { query: '水' })).hits[0].id, 'smm_water')
    assert.equal((await harness.call('memory_recall', { query: '水 的 溶剂' })).hits[0].id, 'smm_water')
    assert.equal((await harness.call('memory_recall', { query: '水的溶剂' })).hits[0].id, 'smm_water')
})

test('配置拒绝未知模式、越界词表和未开启记录的反馈排序', () => {
    for (const config of [
        { recallPlanMode: 'vector' }, { recallPlanMode: null }, { learningPolicyMode: 'anything' },
        { recallAliases: null },
        { recallAliases: [{ phrase: 'a', target: 'b' }] },
        { recallAliases: [{ projectId: null, phrase: '', target: 'b' }] },
        { feedbackRankingEnabled: true },
    ]) assert.throws(() => createHarness(config), /config rejected/)
})

test('独立主题回归覆盖范围、路径大小写、完整版本和困难负例', async () => {
    const dataset = JSON.parse(await readFile(new URL('./fixtures/recall-holdout.json', import.meta.url), 'utf8'))
    for (const scenario of dataset.cases) {
        const harness = createHarness({ projectId: scenario.projectId ?? '', recallPlanMode: 'local', spreadDepth: 0 })
        for (const record of dataset.records) await harness.table.put(record.id, fixture(record.id, record))
        const explicit = await harness.call('memory_recall', { query: scenario.query })
        const automatic = await injectMessage(harness, createMessage(scenario.query))
        const ids = automatic.messages.find((message) => message.source?.kind === 'sleep-memory')?.source.recalled ?? []
        assert.deepEqual(explicit.hits.map((hit) => hit.id).sort(), [...scenario.expected].sort(), `${scenario.id} 的显式召回`)
        assert.deepEqual([...ids].sort(), [...scenario.expected].sort(), `${scenario.id} 的自动召回`)
        await harness.dispose()
    }
})
