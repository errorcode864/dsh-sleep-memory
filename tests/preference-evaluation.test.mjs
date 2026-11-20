import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluatePreferences } from './preference-evaluation.mjs'
import { REGRESSION_PREFERENCES, HOLDOUT_PREFERENCES } from './fixtures/preference-cases.mjs'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'
import { deriveResponsePreference } from '../memory-preferences.js'

const fact = (id, content, overrides = {}) => fixture(id, {
    content, source: { kind: 'user', confirmed: true }, ...overrides,
})
const recalled = (result) => result.messages.find((message) => message.source?.kind === 'sleep-memory')?.source.recalled ?? []

test('第三人称描述不能成为当前用户的长期表达偏好', () => {
    assert.equal(deriveResponsePreference(fact('smm_other', '小李回复使用英文。')), null)
    assert.equal(deriveResponsePreference(fact('smm_other', '项目文档回答保持简短。')), null)
})

test('偏好回归样本冻结并验证候选适用标签', async () => {
    assert.equal(REGRESSION_PREFERENCES.length, 36)
    assert.equal(HOLDOUT_PREFERENCES.length, 24)
    assert.equal(new Set([...REGRESSION_PREFERENCES, ...HOLDOUT_PREFERENCES].map((item) => item.id)).size, 60)
    const result = await evaluatePreferences(REGRESSION_PREFERENCES, { config: { preferenceRecallEnabled: true } })
    assert.deepEqual(result.results.filter((item) => item.injected !== item.expected).map((item) => item.id), [])
    assert.equal(result.summary.modelCalls, 0)
})

test('模型完成但审核响应不合法仍计入评测失败', async () => {
    const result = await evaluatePreferences([REGRESSION_PREFERENCES[0]], {
        config: { preferenceRecallEnabled: true },
        llm: { prepareCall: async () => ({
            config: {},
            stream: async function* () {
                yield { type: 'text-delta', text: '{"decisions":[{"id":"错误的候选","useful":true,"reason":"模拟解析失败"}]}' }
                yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }) },
    })
    assert.equal(result.summary.reviewFailures, 1)
    assert.equal(result.summary.reportedTokens, 12)
    assert.equal(result.results[0].modelUsage.failed, 0)
    assert.equal(result.results[0].trace.diagnostics.outcome, 'failed')
})

test('临时语言覆盖不会改写长期偏好且后续恢复应用', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, contextualRecallEnabled: true })
    await host.table.put('smm_language', fact('smm_language', '以后用中文回复。'))
    for (const [index, [query, expected]] of [['解释缓存机制', 1], ['这次用英文回复并解释缓存机制', 0], ['解释缓存机制', 1]].entries()) {
        assert.equal(recalled(await injectMessage(host, createMessage(query, `轮次-${index}`), { agent: { id: '连续任务' } })).length, expected)
    }
    assert.equal(host.table.get('smm_language').content, '以后用中文回复。')
    assert.equal(host.table.get('smm_language').accessCount, 2)
    await host.dispose()
})

test('项目偏好优先且去重后不能让同类别全局偏好顶替', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, projectId: '甲' })
    await host.table.put('smm_global', fact('smm_global', '以后用中文回复。'))
    await host.table.put('smm_project', fact('smm_project', '以后用英文回复。', { projectId: '甲' }))
    assert.deepEqual(recalled(await injectMessage(host, createMessage('介绍缓存', '一'), { agent: { id: '同会话' } })), ['smm_project'])
    assert.deepEqual(recalled(await injectMessage(host, createMessage('介绍缓存', '二'), { agent: { id: '同会话' } })), [])
    assert.equal(host.table.get('smm_global').accessCount, 0)
    await host.dispose()
})

test('冲突待裁决且明确纠正和撤回沿用事实版本流程', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, contextualRecallEnabled: true, injectRepeatAfterTurns: 0 })
    await host.table.put('smm_old', fact('smm_old', '以后用中文回复。'))
    await host.table.put('smm_conflict', fact('smm_conflict', '以后用英文回复。'))
    assert.deepEqual(recalled(await injectMessage(host, createMessage('请回复并介绍缓存'))), [])
    const input = { action: 'setState', id: 'smm_conflict', state: 'invalid', reason: '撤回冲突偏好' }
    const plan = await host.api.manage(input)
    await host.api.manage({ ...input, dryRun: false, planToken: plan.planToken })
    const changed = await host.call('memory_manage', {
        action: 'correct', id: 'smm_old', content: '以后用日语回复。', source: { kind: 'user', confirmed: true },
    })
    assert.deepEqual(recalled(await injectMessage(host, createMessage('介绍缓存'))), [changed.id])
    const withdraw = { action: 'setState', id: changed.id, state: 'invalid', reason: '撤回长期语言偏好' }
    const preview = await host.api.manage(withdraw)
    await host.api.manage({ ...withdraw, dryRun: false, planToken: preview.planToken })
    assert.deepEqual(recalled(await injectMessage(host, createMessage('介绍缓存'))), [])
    await host.dispose()
})

test('偏好应用仍受审核和预算限制且不会新增审核请求', async () => {
    for (const reject of [false, true]) {
        let calls = 0
        const host = createHarness({
            preferenceRecallEnabled: true, recallReviewEnabled: true, injectMaxEstimatedTokens: reject ? 900 : 100,
            injectMaxCharsPerHit: 1000,
        }, {
            llm: { prepareCall: async () => ({
                config: {},
                stream: async function* (request) {
                    calls += 1
                    const input = JSON.parse(request.messages[1].content[0].text)
                    assert.equal(input.candidates[0].preferenceContext.category, 'response-detail')
                    yield { type: 'text-delta', text: JSON.stringify({
                        decisions: input.candidates.map((item) => ({ id: item.id, useful: !reject, reason: '核对偏好是否适用' })),
                    }) }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }) },
        })
        await host.table.put('smm_style', fact('smm_style', '以后回答请详细展开。'.repeat(80)))
        assert.deepEqual(recalled(await injectMessage(host, createMessage('解释缓存'))), [])
        assert.equal(calls, 1)
        assert.equal(host.table.get('smm_style').accessCount, 0)
        await host.dispose()
    }
})

test('偏好覆盖不能被联想路径绕过且关闭开关保持原候选', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, contextualRecallEnabled: true })
    await host.table.put('smm_language', fact('smm_language', '以后用中文回复。'))
    await host.table.put('smm_seed', fixture('smm_seed', {
        content: '缓存刷新需要核对失效时间。', edges: [{ target: 'smm_language', relation: 'dream-associate', weight: 1 }],
    }))
    assert.deepEqual(recalled(await injectMessage(host, createMessage('本次用英文回复缓存刷新策略'))), ['smm_seed'])
    await host.dispose()
    const disabled = createHarness({ contextualRecallEnabled: true, preferenceRecallEnabled: false })
    await disabled.table.put('smm_language', fact('smm_language', '以后用中文回复。'))
    assert.deepEqual(recalled(await injectMessage(disabled, createMessage('解释缓存'))), [])
    await disabled.dispose()
})

test('学习证据变化使在途审核失效且纠正记录不借用旧证据', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, recallReviewEnabled: true }, {
        llm: { prepareCall: async () => ({
            config: {},
            stream: async function* () {
                const before = host.table.get('smm_learned')
                await host.table.put('smm_learned', {
                    ...before, learning: { ...before.learning, evidence: [{ messageId: '用户证据', quote: '今天回复用中文。' }] },
                })
                yield { type: 'text-delta', text: '{"decisions":[{"id":"smm_learned","useful":true,"reason":"回复语言偏好"}]}' }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }) },
    })
    await host.table.put('smm_learned', fixture('smm_learned', {
        content: '以后回复用中文。', source: { kind: 'model', confirmed: false },
        learning: { category: 'preference', reason: '回复语言', relatedIds: [],
            evidence: [{ messageId: '用户证据', quote: '以后回复用中文。' }] },
    }))
    assert.deepEqual(recalled(await injectMessage(host, createMessage('解释缓存'))), [])
    assert.equal((await host.api.status()).metrics.recentRecalls.at(-1).diagnostics.reasons['version-changed'], 1)
    await host.dispose()
    const corrected = createHarness({ preferenceRecallEnabled: true, contextualRecallEnabled: true })
    await corrected.table.put('smm_old', fixture('smm_old', {
        content: '以后回复用中文。', source: { kind: 'model', confirmed: false },
        learning: { category: 'preference', reason: '回复语言', relatedIds: [],
            evidence: [{ messageId: '用户证据', quote: '以后回复用中文。' }] },
    }))
    await corrected.call('memory_manage', { action: 'correct', id: 'smm_old', content: '以后回复用英文。' })
    assert.deepEqual(recalled(await injectMessage(corrected, createMessage('解释缓存'))), [])
    await corrected.dispose()
})

test('普通任务不能仅凭偏好类型唤醒归档记录', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, contextualRecallEnabled: true, dormancyEnabled: true, sleepAuditEnabled: true })
    await host.table.put('smm_language', fact('smm_language', '以后回复用中文。', {
        layer: 'archive', access: { state: 'dormant', at: 1, reason: '长期未使用' },
    }))
    assert.deepEqual(recalled(await injectMessage(host, createMessage('解释缓存'))), [])
    assert.equal(host.table.get('smm_language').access.state, 'dormant')
    assert.deepEqual(recalled(await injectMessage(host, createMessage('回复用什么语言？'))), ['smm_language'])
    assert.equal(host.table.get('smm_language').access.state, 'awake')
    await host.dispose()
})

test('审核期间新增相反偏好不能沿用旧的全局选择', async () => {
    const host = createHarness({ preferenceRecallEnabled: true, recallReviewEnabled: true, projectId: '甲' }, {
        llm: { prepareCall: async () => ({
            config: {},
            stream: async function* () {
                await host.table.put('smm_project', fact('smm_project', '以后回复用英文。', { projectId: '甲' }))
                yield { type: 'text-delta', text: '{"decisions":[{"id":"smm_global","useful":true,"reason":"语言偏好适用"}]}' }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }) },
    })
    await host.table.put('smm_global', fact('smm_global', '以后回复用中文。'))
    assert.deepEqual(recalled(await injectMessage(host, createMessage('解释缓存'))), [])
    assert.equal((await host.api.status()).metrics.recentRecalls.at(-1).diagnostics.reasons['preference-overridden'], 1)
    await host.dispose()
})
