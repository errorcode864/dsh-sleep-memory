import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMetrics, estimateTokens } from '../memory-metrics.js'
import { summarizeMemory } from '../memory-summary.js'
import { createHarness, createMessage, fixture, flushTasks, injectMessage } from './harness.mjs'

const messages = [{ role: 'user', content: [{ type: 'text', text: '检查数据库 DM8' }] }]

test('模型实报与字符估算分开累计，缓存 Token 不会重复计入输入', () => {
    const metrics = createMemoryMetrics()
    const reported = metrics.startModel('review', messages)
    reported.observe({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, reasoningTokens: 2 } })
    reported.finish(true)
    reported.finish(true)
    const estimated = metrics.startModel('review', messages)
    for (const text of ['a', 'b', 'c', 'd']) estimated.observe({ type: 'text-delta', text })
    estimated.finish(false)
    assert.deepEqual(metrics.state.models.review.reported, {
        calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 0, reasoningTokens: 2, totalTokens: 45,
    })
    assert.equal(metrics.state.models.review.estimated.calls, 1)
    assert.equal(metrics.state.models.review.estimated.outputTokens, 1)
    assert.equal(metrics.state.models.review.failed, 1)
    assert.equal(estimateTokens(''), 0)
    assert.ok(estimateTokens('中文') > estimateTokens('ab'))
})

test('实报使用最后一份整次调用用量，取消后到达的块不能改写统计', () => {
    const metrics = createMemoryMetrics()
    const meter = metrics.startModel('learning', messages)
    meter.observe({ type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } })
    meter.observe({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 3, totalTokens: 18 } })
    meter.finish(false)
    meter.observe({ type: 'usage', usage: { inputTokens: 100, outputTokens: 500 } })
    assert.equal(metrics.state.models.learning.reported.totalTokens, 18)
    assert.equal(metrics.state.models.learning.reported.calls, 1)
})

test('摘要优先抽取命中原句，保留字段值与条件且不改写正文', () => {
    const record = fixture('smm_rule', {
        content: `${'网络检查记录仅用于排障。'.repeat(30)}只有 enroll 模块的 del_flag=0 表示存在；del_flag=1 表示删除。其他模块应核对各自规范。`,
    })
    const original = record.content
    const result = summarizeMemory(record, 'enroll del_flag=0', 110)
    assert.ok(result.content.includes('只有 enroll 模块的 del_flag=0 表示存在；del_flag=1 表示删除。'))
    assert.equal(result.truncated, true)
    assert.ok(result.content.length <= 110)
    assert.equal(record.content, original)
    assert.deepEqual(summarizeMemory(fixture('smm_short', { content: '仅本项目使用 DM8。' }), 'DM8', 100),
        { content: '仅本项目使用 DM8。', truncated: false })
})

test('默认显式检索只给摘要，按 ID 获取完整原文与证据且不强化', async () => {
    const harness = createHarness()
    const content = `${'历史部署检查记录。'.repeat(70)}部署使用 BUILD_FLAG_42。`
    await harness.table.put('smm_long', fixture('smm_long', {
        content,
        learning: {
            category: 'procedure', reason: '部署参数核对', relatedIds: [],
            evidence: [{ messageId: 'source-message', quote: '部署使用 BUILD_FLAG_42。' }],
        },
    }))
    const recalled = await harness.call('memory_recall', { query: 'BUILD_FLAG_42' })
    assert.equal(recalled.fidelity, 'summary')
    assert.equal(recalled.hits[0].truncated, true)
    assert.match(recalled.hits[0].content, /BUILD_FLAG_42/)
    assert.ok(recalled.hits[0].content.length < content.length)
    const writes = harness.writes.length
    const detail = await harness.call('memory_manage', { action: 'get', id: recalled.hits[0].id })
    assert.equal(detail.record.content, content)
    assert.equal(detail.record.learning.evidence[0].messageId, 'source-message')
    assert.equal(harness.writes.length, writes)
    assert.equal((await harness.api.status()).metrics.evidence.reads, 1)
    assert.equal((await harness.call('memory_recall', { query: 'BUILD_FLAG_42', fidelity: 'raw' })).hits[0].content, content)
    const status = await harness.api.status()
    assert.equal(status.metrics.retrieval.queries, 2)
    assert.equal(status.metrics.retrieval.returned, 2)
    assert.ok(status.metrics.retrieval.estimatedTokens > 0)
})

test('Token 预算覆盖整个注入块，被预算排除的记忆不强化', async () => {
    for (const budget of [100, 900]) {
        const harness = createHarness({ injectMaxEstimatedTokens: budget })
        await harness.table.put('smm_rule', fixture('smm_rule', { content: 'enroll 的 del_flag=0 表示存在，del_flag=1 表示删除。' }))
        const result = await injectMessage(harness, createMessage('检查 enroll 的 del_flag'))
        assert.equal(result.messages.length, budget === 100 ? 1 : 2)
        assert.equal(harness.table.get('smm_rule').accessCount, budget === 100 ? 0 : 1)
        const status = await harness.api.status()
        assert.ok(status.metrics.injection.estimatedTokens <= budget)
        assert.equal(status.metrics.recentRecalls[0].returnedIds.length, budget === 100 ? 0 : 1)
        assert.ok(!JSON.stringify(status.metrics).includes('检查 enroll'))
    }
})

test('审核使用摘要并记录模型实报 usage', async () => {
    const inputs = []
    const harness = createHarness({ recallReviewEnabled: true }, {
        llm: { prepareCall: async () => ({
            config: {},
            stream: async function* (request) {
                const input = JSON.parse(request.messages[1].content[0].text)
                inputs.push(input)
                yield { type: 'text-delta', text: JSON.stringify({
                    decisions: input.candidates.map((candidate) => ({ id: candidate.id, useful: true, reason: '原句说明删除规则' })),
                }) }
                yield { type: 'usage', usage: { inputTokens: 70, outputTokens: 12, cacheReadTokens: 100 } }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }) },
    })
    await harness.table.put('smm_rule', fixture('smm_rule', {
        content: `${'历史排障过程已结束。'.repeat(90)}enroll 的 del_flag=0 表示存在。`,
    }))
    const result = await injectMessage(harness, createMessage('enroll 的 del_flag=0'))
    assert.equal(result.messages.length, 2)
    assert.ok(inputs[0].candidates[0].content.length <= 400)
    assert.equal(inputs[0].candidates[0].truncated, true)
    assert.match(inputs[0].candidates[0].content, /del_flag=0/)
    assert.match(result.messages[1].content[0].text, /memory_manage get/)
    const status = await harness.api.status()
    assert.equal(status.metrics.models.review.reported.totalTokens, 182)
    assert.equal(status.metrics.models.review.estimated.calls, 0)
})

test('未分句长记录可以抽取末尾实体，纯空白旧记录仍能生成受限片段', () => {
    const text = `${'部署背景过程 '.repeat(150)}仅正式环境启用 RELEASE_FLAG_42`
    const summary = summarizeMemory(fixture('smm_long', { content: text }), '部署 RELEASE_FLAG_42', 100)
    assert.match(summary.content, /RELEASE_FLAG_42/)
    assert.ok(summary.content.length <= 100)
    assert.ok(summarizeMemory(fixture('smm_blank', { content: ' '.repeat(500) }), 'DM8', 100).content.length <= 100)
})

test('学习、扩展和情绪评分分别记录消耗，学习旧记忆也使用摘要', async () => {
    const inputs = []
    const harness = createHarness({
        autoLearnEnabled: true, semanticRecallEnabled: true, salientScoringEnabled: true, projectId: 'exam',
    }, {
        llm: { prepareCall: async () => ({
            config: {},
            stream: async function* (request) {
                const system = request.messages[0].content[0].text
                const learning = system.includes('提取可长期复用')
                if (learning) inputs.push(JSON.parse(request.messages[1].content[0].text))
                yield { type: 'text-delta', text: learning ? '{"memories":[]}'
                    : system.includes('expand a search') ? 'JWT' : '{"valence":0,"arousal":0.1}' }
                yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }) },
    })
    await harness.table.put('smm_token', fixture('smm_token', {
        projectId: 'exam', content: `${'历史检查已经完成。'.repeat(60)}JWT 续期通过 refresh_token 完成。`,
    }))
    await injectMessage(harness, createMessage('登录过期如何延长会话'))
    const emit = (type, data) => harness.handlers.get('session/event')({ id: 'session' }, { type, data })
    emit('turn/start', { turn: 1 })
    emit('user/message', createMessage('核对 JWT 续期的项目约定'))
    emit('assistant/message', { message: {
        role: 'assistant', source: { provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: '已核对项目约定。' }],
    } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await flushTasks()
    await flushTasks()
    const status = await harness.api.status()
    for (const stage of ['learning', 'expansion', 'scoring']) {
        assert.equal(status.metrics.models[stage].reported.totalTokens, 12)
        assert.equal(status.metrics.models[stage].reported.calls, 1)
    }
    assert.ok(inputs[0].existing[0].content.length <= 400)
    assert.equal(inputs[0].existing[0].truncated, true)
    await harness.dispose()
})

test('失败审核也记录已消耗 Token，诊断轨迹最多保留 20 次', async () => {
    const harness = createHarness({ recallReviewEnabled: true }, {
        llm: { prepareCall: async () => ({
            config: {},
            stream: async function* () {
                yield { type: 'text-delta', text: '无效 JSON' }
                yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }) },
    })
    await harness.table.put('smm_rule', fixture('smm_rule'))
    for (let index = 0; index < 23; index += 1) {
        await injectMessage(harness, createMessage('部署 UNIQUE_42', `query-${index}`))
    }
    const status = await harness.api.status()
    assert.equal(status.review.failed, 23)
    assert.equal(status.metrics.models.review.reported.totalTokens, 23 * 12)
    assert.equal(status.metrics.recentRecalls.length, 20)
    assert.equal(harness.table.get('smm_rule').accessCount, 0)
    await harness.dispose()
    await flushTasks()
})
