import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, createMessage, fixture, flushTasks } from './harness.mjs'

const config = { autoLearnEnabled: true, learningPolicyMode: 'evidence', projectId: 'a' }

function model(calls, content = '用中文') {
    return {
        prepareCall: async () => ({
            config: {},
            stream: async function* (request) {
                calls.push(request)
                yield { type: 'text-delta', text: JSON.stringify({
                    memories: [{
                        content, category: 'preference', confidence: 0.95, reason: '后续回答语言',
                        relation: 'new', relatedIds: [], keywords: ['中文'],
                        evidence: [{ messageId: 'short-preference', quote: content }],
                    }],
                }) }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }),
    }
}

async function finish(harness, text = '用中文', turn = 1) {
    const emit = (type, data) => harness.handlers.get('session/event')({ id: 'session-a' }, { type, data })
    emit('turn/start', { turn })
    emit('user/message', createMessage(text, 'short-preference'))
    emit('assistant/message', { message: {
        id: 'answer', role: 'assistant', source: { provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '已按要求处理' }],
    } })
    emit('turn/end', { turn, reason: { kind: 'completed' } })
    await flushTasks()
    await flushTasks()
}

test('证据策略接受短偏好，纯继续不调用学习模型', async () => {
    const calls = []
    const harness = createHarness(config, { llm: model(calls) })
    await finish(harness, '继续')
    assert.equal(calls.length, 0)
    await finish(harness, '用中文', 2)
    assert.equal(calls.length, 1)
    assert.equal([...harness.data.values()][0].content, '用中文')
    assert.equal([...harness.domains.get('memory_learning_jobs').values()][0].state, 'complete')
    await harness.reloadRecords()
})

test('已完成来源重放和重载均不重复调用模型', async () => {
    const calls = []
    const first = createHarness(config, { llm: model(calls) })
    await finish(first)
    await finish(first)
    assert.equal(calls.length, 1)
    const second = createHarness(config, {
        llm: model(calls), data: first.data, runtimeData: first.runtimeData, domains: first.domains,
    })
    await finish(second)
    assert.equal(calls.length, 1)
    assert.equal(second.data.size, 1)
})

test('候选落盘后写事实失败，重载可用固定 ID 恢复而不重新抽取', async () => {
    const calls = []
    const first = createHarness(config, {
        llm: model(calls), beforePut: () => { throw new Error('模拟事实落盘失败') },
    })
    await finish(first)
    const job = [...first.domains.get('memory_learning_jobs').values()][0]
    assert.equal(job.state, 'ready')
    assert.equal(first.data.size, 0)
    const second = createHarness(config, { llm: model(calls), data: first.data, domains: first.domains })
    await flushTasks()
    await flushTasks()
    assert.equal(second.data.size, 1)
    assert.ok(second.table.get(job.memories[0].id))
    assert.equal(calls.length, 1)
    assert.equal(second.domains.get('memory_learning_jobs').get(job.id).state, 'complete')
})

test('写事实后任务完成标记失败，重放不会覆盖已强化的事实', async () => {
    const calls = []
    const harness = createHarness(config, {
        llm: model(calls),
        beforeDomainPut: (name, id, value) => {
            if (name === 'memory_learning_jobs' && value.state === 'complete') throw new Error('模拟任务完成落盘失败')
        },
    })
    await finish(harness)
    const id = [...harness.data.keys()][0]
    await harness.call('memory_recall', { query: '中文' })
    const second = createHarness(config, { llm: model(calls), data: harness.data, domains: harness.domains })
    await finish(second)
    assert.equal(second.data.size, 1)
    assert.equal(second.table.get(id).accessCount, 1)
    assert.equal(calls.length, 1)
})

test('恢复时会话已换项目不会把旧范围候选写入新项目', async () => {
    const first = createHarness(config, {
        llm: model([]), beforePut: () => { throw new Error('模拟中断') },
    })
    await finish(first)
    const second = createHarness({ ...config, projectId: 'b' }, { domains: first.domains })
    await flushTasks()
    await flushTasks()
    assert.equal(second.data.size, 0)
    assert.match((await second.api.status()).learning.lastReason, /范围已改变/)
})

test('准备后已由用户写入相同事实，恢复时不再生成副本', async () => {
    const calls = []
    const first = createHarness(config, { llm: model(calls), beforePut: () => { throw new Error('模拟中断') } })
    await finish(first)
    first.data.set('smm_manual', fixture('smm_manual', { content: '用中文', projectId: 'a' }))
    const second = createHarness(config, { data: first.data, domains: first.domains })
    await flushTasks()
    await flushTasks()
    assert.equal(second.data.size, 1)
    assert.equal((await second.api.status()).learning.duplicates, 1)
    assert.equal([...second.domains.get('memory_learning_jobs').values()][0].state, 'complete')
})

test('同一消息 ID 的来源内容变化必须拒绝，不能覆盖已完成学习', async () => {
    const calls = []
    const harness = createHarness(config, { llm: model(calls) })
    await finish(harness)
    await finish(harness, '用英文')
    assert.equal(calls.length, 1)
    assert.equal(harness.data.size, 1)
    assert.match((await harness.api.status()).learning.lastReason, /资料已改变/)
})

test('存储加载边界拒绝项目不一致的候选与未验证的任务状态', async () => {
    const first = createHarness(config, { llm: model([]), beforePut: () => { throw new Error('模拟中断') } })
    await finish(first)
    const job = [...first.domains.get('memory_learning_jobs').values()][0]
    for (const invalid of [
        { ...job, state: 'guess' },
        { ...job, memories: job.memories.map((record) => ({ ...record, projectId: 'other' })) },
    ]) {
        const harness = createHarness(config, {
            domains: new Map([['memory_learning_jobs', new Map([[job.id, invalid]])]]),
        })
        await flushTasks()
        await flushTasks()
        assert.equal(harness.data.size, 0)
        assert.match((await harness.api.status()).learning.lastReason, /恢复学习任务失败/)
    }
})

test('恢复时容量已满或关联事实已被纠正，不写入过时候选也不误报新增', async () => {
    const first = createHarness(config, { llm: model([]), beforePut: () => { throw new Error('模拟中断') } })
    await finish(first)
    const job = [...first.domains.get('memory_learning_jobs').values()][0]
    for (const scenario of ['capacity', 'related']) {
        const data = new Map()
        data.set('smm_existing', fixture('smm_existing', { content: '已有的项目事实', projectId: 'a' }))
        const currentJob = structuredClone(job)
        if (scenario === 'related') {
            currentJob.memories[0].learning.relatedIds = ['smm_existing']
            data.set('smm_corrected', fixture('smm_corrected', {
                projectId: 'a', content: '已纠正的项目事实', replaces: 'smm_existing',
            }))
        }
        const harness = createHarness({ ...config, ...(scenario === 'capacity' ? { maxRecords: 1 } : {}) }, {
            data, domains: new Map([['memory_learning_jobs', new Map([[job.id, currentJob]])]]),
        })
        await flushTasks()
        await flushTasks()
        assert.equal(harness.data.has(job.memories[0].id), false, scenario)
        const status = await harness.api.status()
        assert.equal(status.learning.stored, 0)
        assert.equal(status.learning.skipped, 1)
        assert.match(status.learning.lastReason, /未新增/)
        assert.equal(harness.domains.get('memory_learning_jobs').get(job.id).state, 'complete')
    }
})
