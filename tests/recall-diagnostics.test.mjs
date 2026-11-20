import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const latest = async (host) => (await host.api.status()).metrics.recentRecalls.at(-1)
const reviewer = (before = () => {}, useful = true) => ({
    prepareCall: async () => ({
        config: {},
        stream: async function* (request) {
            const input = JSON.parse(request.messages[1].content[0].text)
            await before(input)
            yield { type: 'text-delta', text: JSON.stringify({
                decisions: input.candidates.map((candidate) => ({ id: candidate.id, useful, reason: '按测试任务审核' })),
            }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
        },
    }),
})

test('诊断区分空库、候选未命中和范围过滤且不保存正文', async () => {
    const host = createHarness()
    await injectMessage(host, createMessage('特殊任务正文'))
    assert.equal((await latest(host)).diagnostics.reasons['empty-store'], 1)
    await host.table.put('smm_rule', fixture('smm_rule', { projectId: '甲' }))
    await injectMessage(host, createMessage('特殊任务正文'))
    assert.equal((await latest(host)).diagnostics.reasons.scope, 1)
    await host.table.put('smm_global', fixture('smm_global'))
    await injectMessage(host, createMessage('特殊任务正文'))
    assert.equal((await latest(host)).diagnostics.reasons['no-match'], 1)
    assert.ok(!JSON.stringify((await host.api.status()).metrics.recentRecalls).includes('特殊任务正文'))
    await host.dispose()
})

test('审核拒绝、错误响应和超时分别记录且不误报为最终返回', async () => {
    for (const mode of ['rejected', 'failed', 'timeout']) {
        const host = createHarness({ recallReviewEnabled: true, recallReviewTimeoutMs: 500 }, {
            llm: mode === 'rejected' ? reviewer(undefined, false) : {
                prepareCall: async () => {
                    if (mode === 'failed') throw new Error('测试模型服务失败')
                    return new Promise(() => {})
                },
            },
        })
        await host.table.put('smm_rule', fixture('smm_rule'))
        await injectMessage(host, createMessage('部署约定 UNIQUE_42'))
        const trace = await latest(host)
        assert.equal(trace.diagnostics.reasons[`review-${mode}`], 1)
        assert.deepEqual(trace.returnedIds, [])
        assert.equal(host.table.get('smm_rule').accessCount, 0)
        await host.dispose()
    }
})

test('诊断区分审核期间取消、范围变化和内容版本变化', async () => {
    for (const mode of ['cancelled', 'scope-changed', 'version-changed']) {
        const controller = new AbortController()
        const host = createHarness({ recallReviewEnabled: true }, {
            llm: reviewer(async () => {
                if (mode === 'cancelled') controller.abort()
                if (mode === 'version-changed') await host.table.put('smm_rule', fixture('smm_rule', { content: '更新后的事实' }))
                if (mode === 'scope-changed') await host.api.manage({ action: 'bind', sessionId: '诊断会话', projectId: '乙' })
            }),
        })
        await host.table.put('smm_rule', fixture('smm_rule'))
        await injectMessage(host, createMessage('部署约定 UNIQUE_42'), { agent: { id: '诊断会话' }, signal: controller.signal })
        const trace = await latest(host)
        assert.equal(trace.diagnostics.reasons[mode], 1, `${mode}: ${JSON.stringify(trace)}`)
        assert.deepEqual(trace.returnedIds, [])
        await host.dispose()
    }
})

test('预算和去重有明确原因且诊断开关不改变召回和强化', async () => {
    for (const enabled of [false, true]) {
        const host = createHarness({ recallDiagnosticsEnabled: enabled })
        await host.table.put('smm_rule', fixture('smm_rule'))
        const first = await injectMessage(host, createMessage('部署约定 UNIQUE_42', '第一轮'), { agent: { id: '同会话' } })
        assert.equal(first.messages.length, 2)
        await injectMessage(host, createMessage('部署约定 UNIQUE_42', '第二轮'), { agent: { id: '同会话' } })
        const trace = await latest(host)
        assert.equal(host.table.get('smm_rule').accessCount, 1)
        assert.equal(trace.diagnostics?.reasons.duplicate, enabled ? 1 : undefined)
        assert.deepEqual(trace.returnedIds, [])
        await host.dispose()
    }
    const host = createHarness({ injectMaxEstimatedTokens: 100, injectMaxCharsPerHit: 1000 })
    await host.table.put('smm_long', fixture('smm_long', { content: '部署约定 UNIQUE_42 具体参数需要核对。'.repeat(70) }))
    await injectMessage(host, createMessage('部署约定 UNIQUE_42'))
    assert.equal((await latest(host)).diagnostics.reasons['token-budget'], 1)
    await host.dispose()
})

test('唤醒容量不足和写入失败只记录筛选数量而不宣称已返回', async () => {
    for (const mode of ['audit-capacity', 'write-failed']) {
        const host = createHarness({
            dormancyEnabled: true, sleepAuditEnabled: true, contextualRecallEnabled: true,
            sleepAuditMaxBytes: mode === 'audit-capacity' ? 1 : 0,
        }, {
            beforeDomainPut(name, _id, batch) {
                if (mode === 'write-failed' && name === 'memory_sleep_audit' && batch.state === 'applied') throw new Error('模拟存储写入中断')
            },
        })
        await host.table.put('smm_deep', fixture('smm_deep', {
            layer: 'deep', access: { state: 'dormant', at: 1, reason: '长期未使用' },
            recallTriggers: [{ when: '迁移时核对', cues: ['数据搬家'] }],
        }))
        await injectMessage(host, createMessage('数据搬家'))
        const trace = await latest(host)
        assert.equal(trace.diagnostics.reasons[mode], 1)
        assert.equal(trace.diagnostics.selectedCount, 1)
        assert.equal(trace.diagnostics.wakeCount, 1)
        assert.equal(trace.diagnostics.outcome, 'failed')
        assert.deepEqual(trace.returnedIds, [])
        await host.dispose()
    }
})

test('显式召回失败也进入诊断且沿用原错误', async () => {
    const host = createHarness({}, { beforeUpdate: () => { throw new Error('显式强化失败') } })
    await host.table.put('smm_rule', fixture('smm_rule'))
    await assert.rejects(host.call('memory_recall', { query: '部署约定' }), /显式强化失败/)
    assert.equal((await latest(host)).diagnostics.reasons['write-failed'], 1)
    await host.dispose()
})

test('数量、字符和关联路径不足以及重入均有阶段原因', async () => {
    const limited = createHarness({ recallReviewEnabled: true, injectBudget: 1 }, { llm: reviewer() })
    for (const id of ['smm_a', 'smm_b']) await limited.table.put(id, fixture(id))
    const response = await injectMessage(limited, createMessage('部署约定 UNIQUE_42'))
    assert.equal((await latest(limited)).diagnostics.reasons['count-budget'], 1)
    await limited.handlers.get('agent/pre-step')({
        step: 1, messages: [createMessage('部署约定 UNIQUE_42')],
    }, async () => response)
    assert.equal((await latest(limited)).diagnostics.reasons.reentry, 1)
    await limited.dispose()
    const chars = createHarness({ injectMaxTotalChars: 300, injectMaxEstimatedTokens: 16000, injectMaxCharsPerHit: 1000 })
    await chars.table.put('smm_a', fixture('smm_a', { content: '部署约定 UNIQUE_42 核对具体限制'.repeat(80) }))
    await injectMessage(chars, createMessage('部署约定 UNIQUE_42'))
    assert.equal((await latest(chars)).diagnostics.reasons['char-budget'], 1)
    await chars.dispose()
    const paths = createHarness({ recallReviewEnabled: true }, { llm: reviewer(undefined, false) })
    await paths.table.put('smm_seed', fixture('smm_seed', {
        edges: [{ target: 'smm_neighbor', relation: 'dream-associate', weight: 1 }],
    }))
    await paths.table.put('smm_neighbor', fixture('smm_neighbor', { content: '毫不相似的故事' }))
    await injectMessage(paths, createMessage('部署约定 UNIQUE_42'))
    assert.equal((await latest(paths)).diagnostics.reasons['path-rejected'], 1)
    await paths.dispose()
})
