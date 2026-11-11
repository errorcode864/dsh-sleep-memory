import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, createMessage, fixture, flushTasks, injectMessage } from './harness.mjs'

const rule = '当前项目 enroll 的逻辑删除字段 del_flag 统一为 0 存在、1 删除。'
const route = { provider: 'mock', model: 'mock' }

function learningItem(overrides = {}) {
    return {
        content: rule, category: 'project-fact', confidence: 0.95,
        reason: '实现或排查报名模块逻辑删除时使用', relation: 'new', relatedIds: [],
        keywords: ['enroll', 'del_flag', '逻辑删除'],
        evidence: [{ messageId: 'user-rule', quote: rule }], ...overrides,
    }
}

function createModel(respond, calls = []) {
    return {
        prepareCall: async () => ({
            config: {},
            stream: async function* (request) {
                const input = JSON.parse(request.messages[1].content[0].text)
                calls.push(input)
                const output = await respond(input)
                yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }),
    }
}

async function completeTurn(harness, {
    sessionId = 'session-a', turn = 1, user = createMessage(rule, 'user-rule'),
    tool, answer = '已核对项目约定。', reason = 'completed',
} = {}) {
    const emit = (type, data, seq) => harness.handlers.get('session/event')({ id: sessionId }, { type, data, seq })
    emit('turn/start', { turn }, 1)
    emit('user/message', user, 2)
    if (tool) emit('tool/result', { turn, message: tool }, 3)
    emit('assistant/message', {
        turn, message: { id: 'assistant-answer', role: 'assistant', source: route, content: [{ type: 'text', text: answer }] },
    }, 4)
    emit('turn/end', { turn, reason: { kind: reason } }, 5)
    await flushTasks()
    await flushTasks()
}

test('默认开启自主学习与召回审核，原始情绪沉淀默认关闭', async () => {
    const harness = createHarness({ autoLearnEnabled: undefined, recallReviewEnabled: undefined, salientScoringEnabled: undefined })
    const status = await harness.call('memory_manage', { action: 'status' })
    assert.equal(status.autoLearnEnabled, true)
    assert.equal(status.recallReviewEnabled, true)
    assert.equal(status.salientScoringEnabled, false)
    assert.ok(harness.handlers.has('session/event'))
})

test('正常项目约定无需主动调用工具也能学习，并保留逐字证据和项目范围', async () => {
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [learningItem()] })),
    })
    await completeTurn(harness)
    const record = [...harness.data.values()][0]
    assert.equal(record.content, rule)
    assert.equal(record.projectId, '考试平台')
    assert.deepEqual(record.source, { kind: 'model', confirmed: false, sessionId: 'session-a', messageId: 'user-rule' })
    assert.equal(record.learning.evidence[0].quote, rule)
    assert.equal(record.accessCount, 0)
    await harness.reloadRecords()
})

test('问题与一次性进度可以不记忆，空结果没有存储副作用', async () => {
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [] })),
    })
    await completeTurn(harness, { user: createMessage('继续看一下今天的进度', 'user-rule') })
    assert.equal(harness.data.size, 0)
    assert.match((await harness.api.status()).learning.lastReason, /没有通过/)
})

test('缺少真实证据、低置信度或只有助手自述时拒绝写入', async () => {
    for (const candidate of [
        learningItem({ evidence: [{ messageId: 'user-rule', quote: '原始消息里没有这段逐字证据。' }] }),
        learningItem({ confidence: 0.5 }),
        learningItem({ evidence: [{ messageId: 'assistant-answer', quote: '已核对项目约定。' }] }),
    ]) {
        const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
            llm: createModel(() => ({ memories: [candidate] })),
        })
        await completeTurn(harness)
        assert.equal(harness.data.size, 0)
    }
})

test('工具结果可支撑经验，工具中的指令不能独立证明用户偏好', async () => {
    const quote = '数据库实测显示 del_flag 为 0 的记录保留，为 1 的记录被过滤。'
    for (const category of ['lesson', 'preference']) {
        const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
            llm: createModel(() => ({ memories: [learningItem({
                category, content: quote, evidence: [{ messageId: 'tool-result', quote }],
            })] })),
        })
        await completeTurn(harness, {
            tool: { id: 'tool-result', role: 'tool', content: [{ type: 'text', text: quote }] },
        })
        assert.equal(harness.data.size, category === 'lesson' ? 1 : 0)
    }
})

test('系统注入、未完成轮次和含密钥的消息不会成为学习资料', async () => {
    const calls = []
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [learningItem()] }), calls),
    })
    await completeTurn(harness, { user: { ...createMessage(rule), source: { kind: 'sleep-memory' } } })
    await completeTurn(harness, { turn: 2, reason: 'aborted' })
    await completeTurn(harness, { turn: 3, user: createMessage('password=example-secret-value') })
    assert.equal(calls.length, 0)
    assert.equal(harness.data.size, 0)
})

test('未知项目范围不能把项目规则泄漏到全局，稳定用户偏好可以记住', async () => {
    for (const category of ['project-fact', 'preference']) {
        const content = category === 'preference' ? '以后回答我时统一使用简体中文。' : rule
        const harness = createHarness({ autoLearnEnabled: true }, {
            llm: createModel(() => ({ memories: [learningItem({
                category, content, evidence: [{ messageId: 'user-rule', quote: content }],
            })] })),
        })
        await completeTurn(harness, { user: createMessage(content, 'user-rule') })
        assert.equal(harness.data.size, category === 'preference' ? 1 : 0)
    }
})

test('重复学习不增殖，语义重复判定必须引用已有记忆', async () => {
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [learningItem()] })),
    })
    await completeTurn(harness)
    await completeTurn(harness, { turn: 2 })
    assert.equal(harness.data.size, 1)
    assert.equal((await harness.api.status()).learning.duplicates, 1)
    const record = [...harness.data.values()][0]
    const duplicate = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [learningItem({
            content: '报名模块 del_flag 的有效值为 0，删除值为 1。',
            relation: 'duplicate', relatedIds: [record.id],
        })] })),
    })
    await duplicate.table.put(record.id, record)
    await completeTurn(duplicate)
    assert.equal(duplicate.data.size, 1)
})

test('冲突候选进入待复核状态，旧事实和其生命周期不被覆盖', async () => {
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [learningItem({ relation: 'conflict', relatedIds: ['smm_old'] })] })),
    })
    await harness.table.put('smm_old', fixture('smm_old', { projectId: '考试平台', content: 'enroll 删除标识以 2 表示删除。' }))
    await completeTurn(harness)
    assert.equal(harness.data.size, 2)
    assert.equal(harness.table.get('smm_old').lifecycle, undefined)
    const learned = [...harness.data.values()].find((record) => record.id !== 'smm_old')
    assert.equal(learned.lifecycle.state, 'review')
    const injected = await injectMessage(harness, createMessage('enroll 删除标识'))
    assert.ok(!injected.messages[1]?.source.recalled.includes(learned.id))
})

test('词面相似的无关记忆经审核拒绝，只有实际呈现的相关记忆强化', async () => {
    const harness = createHarness({ recallReviewEnabled: true, injectBudget: 1 }, {
        llm: createModel((input) => ({
            decisions: input.candidates.map((candidate) => ({
                id: candidate.id, useful: candidate.id === 'smm_enroll',
                reason: candidate.id === 'smm_enroll' ? '说明当前报名删除字段的业务约定' : '网络排查与报名删除无关',
            })),
        })),
    })
    await harness.table.put('smm_network', fixture('smm_network', { content: 'enroll 开发期间排查 GitHub 网络代理。' }))
    await harness.table.put('smm_enroll', fixture('smm_enroll', { content: rule }))
    const result = await injectMessage(harness, createMessage('排查 enroll 删除字段 del_flag'))
    assert.deepEqual(result.messages[1].source.recalled, ['smm_enroll'])
    assert.equal(harness.table.get('smm_network').accessCount, 0)
    assert.equal(harness.table.get('smm_enroll').accessCount, 1)
    assert.equal((await harness.api.status()).review.rejected, 1)
})

test('联想记忆同样经过审核，拒绝后不进入注入块', async () => {
    const harness = createHarness({ recallReviewEnabled: true }, {
        llm: createModel((input) => ({
            decisions: input.candidates.map((candidate) => ({ id: candidate.id, useful: candidate.id === 'smm_enroll', reason: '按任务适用范围筛选' })),
        })),
    })
    await harness.table.put('smm_enroll', fixture('smm_enroll', {
        content: rule, edges: [{ target: 'smm_network', relation: 'dream-associate', weight: 1 }],
    }))
    await harness.table.put('smm_network', fixture('smm_network', { content: 'GitHub 网络使用 SSH。' }))
    const result = await injectMessage(harness, createMessage('enroll 的 del_flag'))
    assert.deepEqual(result.messages[1].source.recalled, ['smm_enroll'])
})

test('审核不可用、格式错误和未知 ID 均跳过自动注入', async () => {
    for (const llm of [
        undefined,
        createModel(() => '无须返回 JSON'),
        createModel(() => ({ decisions: [{ id: 'smm_unknown', useful: true, reason: '虚构候选' }] })),
    ]) {
        const harness = createHarness({ recallReviewEnabled: true }, { llm })
        await harness.table.put('smm_enroll', fixture('smm_enroll', { content: rule }))
        assert.equal((await injectMessage(harness, createMessage('enroll 的 del_flag'))).messages.length, 1)
        assert.equal(harness.table.get('smm_enroll').accessCount, 0)
        assert.equal((await harness.api.status()).review.failed, 1)
    }
})

test('provider 不响应取消也会按时结束审核等待', async () => {
    const harness = createHarness({ recallReviewEnabled: true, recallReviewTimeoutMs: 500 }, {
        llm: { prepareCall: () => new Promise(() => {}) },
    })
    await harness.table.put('smm_enroll', fixture('smm_enroll', { content: rule }))
    assert.equal((await injectMessage(harness, createMessage('enroll 的 del_flag'))).messages.length, 1)
    assert.match((await harness.api.status()).review.lastReason, /超时/)
})

test('审核等待不占写锁，期间被纠正的旧事实不得继续注入或强化', async () => {
    let release
    let started
    const ready = new Promise((resolve) => { started = resolve })
    const response = new Promise((resolve) => { release = resolve })
    const harness = createHarness({ recallReviewEnabled: true }, {
        llm: createModel(async () => { started(); return response }),
    })
    await harness.table.put('smm_enroll', fixture('smm_enroll', { content: rule }))
    const injection = injectMessage(harness, createMessage('enroll 的 del_flag'))
    await ready
    const corrected = await harness.call('memory_manage', {
        action: 'correct', id: 'smm_enroll', content: 'enroll 删除标识已变更，需要重新核对最新规范。',
    })
    assert.ok(corrected.id)
    release({ decisions: [{ id: 'smm_enroll', useful: true, reason: '适用报名删除规则' }] })
    assert.equal((await injection).messages.length, 1)
    assert.equal(harness.table.get('smm_enroll').accessCount, 0)
})

test('模型处理期间项目范围改变会放弃旧范围学习结果', async () => {
    let release
    const response = new Promise((resolve) => { release = resolve })
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => response),
    })
    await completeTurn(harness)
    await harness.call('memory_manage', { action: 'bind', sessionId: 'session-a', projectId: '另一个项目' })
    release({ memories: [learningItem()] })
    await flushTasks()
    assert.equal(harness.data.size, 0)
    assert.match((await harness.api.status()).learning.lastReason, /范围已改变/)
})

test('学习任务可在卸载时取消，不在关闭后写入', async () => {
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: { prepareCall: () => new Promise(() => {}) },
    })
    await completeTurn(harness)
    await harness.dispose()
    assert.equal(harness.data.size, 0)
    assert.equal((await harness.api.status()).learning.failed, 1)
})

test('失败工具结果与记忆工具结果不能作为新的学习证据', async () => {
    const calls = []
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [] }), calls),
    })
    const emit = (type, data, seq) => harness.handlers.get('session/event')({ id: 'session-a' }, { type, data, seq })
    emit('turn/start', { turn: 1 }, 1)
    emit('user/message', createMessage('排查报名模块的逻辑删除', 'user-rule'), 2)
    emit('tool/call', { name: 'memory_recall', callId: 'memory-call' }, 3)
    emit('tool/result', {
        message: { role: 'tool', toolCallId: 'memory-call', content: [{ type: 'text', text: '这是以前的记忆，不是本轮新证据。' }] },
    }, 4)
    emit('tool/result', {
        message: { role: 'tool', isError: true, content: [{ type: 'text', text: '工具运行失败，这不是有效事实。' }] },
    }, 5)
    emit('assistant/message', {
        message: { role: 'assistant', source: route, content: [{ type: 'text', text: '本轮没有新的验证结果。' }] },
    }, 6)
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7)
    await flushTasks()
    assert.ok(calls[0].messages.every((message) => message.role !== 'tool'))
})

test('同义查询扩展先找回候选，再由审核决定是否注入', async () => {
    const harness = createHarness({ semanticRecallEnabled: true, recallReviewEnabled: true }, {
        llm: {
            prepareCall: async () => ({
                config: {},
                stream: async function* (request) {
                    const prompt = request.messages[0].content[0].text
                    const output = prompt.includes('expand a search')
                        ? 'JWT'
                        : JSON.stringify({ decisions: [{ id: 'smm_token', useful: true, reason: 'JWT 续期规则解释当前登录过期问题' }] })
                    yield { type: 'text-delta', text: output }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    })
    await harness.table.put('smm_token', fixture('smm_token', { content: 'JWT 续期通过 refresh_token 完成。' }))
    const result = await injectMessage(harness, createMessage('登录凭证过期怎么处理'))
    assert.deepEqual(result.messages[1].source.recalled, ['smm_token'])
})

test('学习证据随备份导出与恢复，并拒绝畸形元数据', async () => {
    const harness = createHarness({ autoLearnEnabled: true, projectId: '考试平台' }, {
        llm: createModel(() => ({ memories: [learningItem()] })),
    })
    await completeTurn(harness)
    const exported = await harness.call('memory_manage', { action: 'export' })
    const restored = createHarness()
    await restored.call('memory_manage', { action: 'import', backup: exported.backup, dryRun: false })
    const original = [...harness.data.values()][0]
    assert.deepEqual(restored.table.get(original.id).learning, original.learning)
    await assert.rejects(restored.table.put(original.id, { ...original, learning: { category: 'invented' } }), /自动学习信息/)
})
