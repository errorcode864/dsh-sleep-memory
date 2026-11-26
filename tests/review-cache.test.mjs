import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReviewCache } from '../memory-review-cache.js'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const config = { recallReviewEnabled: true, recallReviewCacheSeconds: 60, injectRepeatAfterTurns: 0 }
const scope = { agent: { id: '缓存会话' } }
const send = (host, query = '部署约定 UNIQUE_42', context = scope) => injectMessage(host, createMessage(query), context)
const model = (before = () => {}, useful = true) => ({
    prepareCall: async () => ({
        config: {},
        stream: async function* (request) {
            const input = JSON.parse(request.messages[1].content[0].text)
            await before(input)
            yield { type: 'text-delta', text: JSON.stringify({
                decisions: input.candidates.map((item) => ({ id: item.id, useful, reason: '核对当前任务' })),
            }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
        },
    }),
})

test('审核默认等待 15 秒且显式时限和缓存配置保持独立', async () => {
    const host = createHarness()
    assert.equal((await host.api.status()).recallReviewTimeoutMs, 15000)
    assert.equal((await host.api.status()).recallReviewCacheSeconds, 0)
    await host.dispose()
    const explicit = createHarness({ recallReviewTimeoutMs: 3000 })
    assert.equal((await explicit.api.status()).recallReviewTimeoutMs, 3000)
    await explicit.dispose()
    for (const value of [-1, 301, 1.5, null]) assert.throws(() => createHarness({ recallReviewCacheSeconds: value }), /recallReviewCacheSeconds/)
})

test('同会话问题和候选版本命中缓存且拒绝结果也可复用', async () => {
    for (const useful of [true, false]) {
        let calls = 0
        const host = createHarness(config, { llm: model(() => { calls += 1 }, useful) })
        await host.table.put('smm_rule', fixture('smm_rule'))
        for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await send(host)).messages.length, useful ? 2 : 1)
        const status = await host.api.status()
        assert.equal(calls, 1)
        assert.equal(status.metrics.models.review.calls, 1)
        assert.equal(status.review.attempted, 2)
        assert.equal(status.review.cache.hits, 1)
        assert.equal(status.metrics.recentRecalls.at(-1).diagnostics.reviewCache, 'hit')
        assert.equal(host.table.get('smm_rule').accessCount, useful ? 2 : 0)
        await host.dispose()
    }
})

test('完整问题、模型选项、项目和会话变化均不共享审核结果', async () => {
    let calls = 0
    const host = createHarness(config, { llm: model(() => { calls += 1 }) })
    await host.table.put('smm_rule', fixture('smm_rule'))
    await send(host)
    await send(host, '部署约定 UNIQUE_42 请再次核对')
    await send(host, undefined, { agent: { id: '另一个会话' } })
    await send(host, undefined, { ...scope, modelSelection: { provider: 'mock', model: 'changed', temperature: 0 } })
    await send(host, undefined, { ...scope, modelSelection: { provider: 'mock', model: 'changed', temperature: 1 } })
    await host.api.manage({ action: 'bind', sessionId: '缓存会话', projectId: '甲' })
    await send(host)
    const prefix = `部署约定 UNIQUE_42 ${'重复文字'.repeat(1600)}`
    await send(host, `${prefix}本次禁止发布`)
    await send(host, `${prefix}本次允许发布`)
    assert.equal(calls, 8, '被审核输入截断的后缀仍参与缓存键')
    await host.dispose()
})

test('候选正文、证据、有效性、触发条件和候选集合变化会重审', async () => {
    let calls = 0
    const host = createHarness(config, { llm: model(() => { calls += 1 }) })
    await host.table.put('smm_rule', fixture('smm_rule'))
    await send(host)
    for (const update of [
        { content: '部署约定 UNIQUE_42 的细节已更新。' },
        { learning: { category: 'procedure', reason: '明确证据', relatedIds: [], evidence: [{ messageId: '原始消息', quote: '部署约定 UNIQUE_42' }] } },
        { lifecycle: { state: 'active', at: 1, revision: 1, reason: '重新确认' } },
        { recallTriggers: [{ when: '部署时核对', cues: ['部署约定'] }] },
    ]) {
        await host.table.put('smm_rule', { ...host.table.get('smm_rule'), ...update })
        await send(host)
    }
    await host.table.put('smm_added', fixture('smm_added'))
    await send(host)
    assert.equal(calls, 6)
    await host.dispose()
})

test('缓存到期、淘汰和返回集合修改不影响已保存结果', (t) => {
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const cache = createReviewCache(1)
    cache.write('first', new Set(['smm_first']))
    cache.read('first').clear()
    assert.ok(cache.read('first').has('smm_first'))
    now = 1000
    assert.equal(cache.read('first'), null)
    for (let index = 0; index < 129; index += 1) cache.write(String(index), new Set())
    assert.equal(cache.state.entries, 128)
    assert.equal(cache.read('0'), null)
    assert.ok(cache.read('128') instanceof Set)
})

test('缓存关闭、无稳定会话和实例重载均重新审核', async () => {
    let calls = 0
    for (const mode of ['disabled', 'no-session', 'reload']) {
        const data = new Map()
        const host = createHarness({ ...config, recallReviewCacheSeconds: mode === 'disabled' ? 0 : 60 }, { data, llm: model(() => { calls += 1 }) })
        await host.table.put('smm_rule', fixture('smm_rule'))
        await send(host, undefined, mode === 'no-session' ? {} : scope)
        if (mode !== 'reload') await send(host, undefined, mode === 'no-session' ? {} : scope)
        await host.dispose()
        if (mode === 'reload') {
            const restarted = createHarness(config, { data, llm: model(() => { calls += 1 }) })
            await send(restarted)
            await restarted.dispose()
        }
    }
    assert.equal(calls, 6)
})

test('失败、超时和取消不缓存且迟到响应不会补写缓存', async () => {
    for (const mode of ['invalid', 'timeout', 'cancelled']) {
        let calls = 0
        const controller = new AbortController()
        const host = createHarness({ ...config, recallReviewTimeoutMs: 500 }, {
            llm: {
                prepareCall: async () => ({
                    config: {},
                    stream: async function* (request) {
                        calls += 1
                        const input = JSON.parse(request.messages[1].content[0].text)
                        if (calls === 1 && mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 550))
                        if (calls === 1 && mode === 'cancelled') controller.abort()
                        yield { type: 'text-delta', text: calls === 1 && mode === 'invalid' ? '不合法响应' : JSON.stringify({
                            decisions: input.candidates.map((item) => ({ id: item.id, useful: true, reason: '本次审核通过' })),
                        }) }
                        yield { type: 'finish', reason: { kind: 'stop' } }
                    },
                }),
            },
        })
        await host.table.put('smm_rule', fixture('smm_rule'))
        assert.equal((await send(host, undefined, { ...scope, signal: controller.signal })).messages.length, 1)
        if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 70))
        assert.equal((await host.api.status()).review.cache.entries, 0)
        assert.equal((await send(host)).messages.length, 2)
        assert.equal(calls, 2)
        await host.dispose()
    }
})

test('缓存命中仍执行注入预算、去重和取消约束', async () => {
    const host = createHarness({ ...config, injectMaxEstimatedTokens: 100, injectMaxCharsPerHit: 1000 }, { llm: model() })
    await host.table.put('smm_rule', fixture('smm_rule', { content: '部署约定 UNIQUE_42 条件必须完整核对'.repeat(80) }))
    for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await send(host)).messages.length, 1)
    assert.equal((await host.api.status()).review.cache.hits, 1)
    assert.equal(host.table.get('smm_rule').accessCount, 0)
    const cancelled = new AbortController()
    cancelled.abort()
    await send(host, undefined, { ...scope, signal: cancelled.signal })
    assert.equal((await host.api.status()).review.cache.hits, 1)
    await host.dispose()
    const dedup = createHarness({ ...config, injectRepeatAfterTurns: 3 }, { llm: model() })
    await dedup.table.put('smm_rule', fixture('smm_rule'))
    await send(dedup)
    assert.equal((await injectMessage(dedup, createMessage('部署约定 UNIQUE_42', '后续轮次'), scope)).messages.length, 1)
    assert.equal((await dedup.api.status()).metrics.models.review.calls, 1)
    await dedup.dispose()
})

test('审核期间事实被纠正后缓存不能使旧版本再次注入', async () => {
    let release
    let started
    let calls = 0
    const ready = new Promise((resolve) => { started = resolve })
    const response = new Promise((resolve) => { release = resolve })
    const host = createHarness(config, { llm: model(async () => {
        calls += 1
        if (calls === 1) { started(); await response }
    }) })
    await host.table.put('smm_rule', fixture('smm_rule'))
    const pending = send(host)
    await ready
    const corrected = await host.call('memory_manage', {
        action: 'correct', id: 'smm_rule', content: '部署约定 UNIQUE_42 已更新为新的检查流程。',
    })
    release()
    assert.equal((await pending).messages.length, 1)
    const result = await send(host)
    assert.deepEqual(result.messages[1].source.recalled, [corrected.id])
    assert.equal(calls, 2)
    assert.equal(host.table.get('smm_rule').accessCount, 0)
    await host.dispose()
})

test('同时发起的审核各自处理取消且未完成请求不充当缓存', async () => {
    let calls = 0
    let release
    let started
    const ready = new Promise((resolve) => { started = resolve })
    const wait = new Promise((resolve) => { release = resolve })
    const controller = new AbortController()
    const host = createHarness(config, { llm: model(async () => {
        calls += 1
        if (calls === 2) started()
        await wait
    }) })
    await host.table.put('smm_rule', fixture('smm_rule'))
    const first = send(host, undefined, { ...scope, signal: controller.signal })
    const second = send(host)
    await ready
    controller.abort()
    release()
    assert.equal((await first).messages.length, 1)
    assert.equal((await second).messages.length, 2)
    assert.equal((await send(host)).messages.length, 2)
    assert.equal(calls, 2)
    assert.equal((await host.api.status()).review.cache.hits, 1)
    await host.dispose()
})
