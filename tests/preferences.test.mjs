import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchPreferenceContext, responseLanguagePreference } from '../memory-preferences.js'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const preference = (quote = '回复请用简体中文。') => fixture('smm_language', {
    content: '用户偏好助手使用简体中文回复。', source: { kind: 'model', confirmed: false },
    learning: {
        category: 'preference', reason: '后续回答使用', relatedIds: [],
        evidence: [{ messageId: 'language-user', quote }],
    },
})

test('已有短语言偏好通过类别匹配召回不同问法且不回写旧资料', async () => {
    const host = createHarness({ contextualRecallEnabled: true, recallPlanMode: 'local', injectRepeatAfterTurns: 0 })
    await host.table.put('smm_language', preference())
    for (const query of ['回复使用哪种语言？', '我习惯你用什么语种交流？', 'What language do I prefer for your replies?']) {
        const result = await host.call('memory_recall', { query })
        assert.equal(result.hits[0]?.id, 'smm_language', query)
        assert.equal(result.hits[0].retrieval.preference.category, 'response-language')
    }
    assert.equal(host.table.get('smm_language').recallTriggers, undefined)
    await host.dispose()
})

test('临时要求、引用和工具来源不进入偏好补充通道', () => {
    for (const quote of ['这次回复请用简体中文。', '日志说“回复请用简体中文”。', '是否回复请用简体中文？', '不要用简体中文回复。']) {
        assert.equal(responseLanguagePreference(preference(quote)), false, quote)
    }
    assert.equal(responseLanguagePreference(fixture('smm_tool', {
        content: '回复请用简体中文。', source: { kind: 'tool', confirmed: true },
    })), false)
    assert.equal(responseLanguagePreference({ ...preference(), content: '当前端口为 8600。' }), false)
    assert.equal(responseLanguagePreference(preference('用中文')), true)
    for (const query of ['今天画一只蓝色小猫。', '讨论编程语言的类型系统', '这次请用英文回复', '翻译文档中的“回复使用哪种语言”']) {
        assert.equal(matchPreferenceContext(preference(), query), null, query)
    }
})

test('偏好补充仍受范围、审核拒绝和预算限制', async () => {
    const host = createHarness({ contextualRecallEnabled: true, recallPlanMode: 'local', recallReviewEnabled: true }, {
        llm: {
            prepareCall: async () => ({
                config: {},
                stream: async function* (request) {
                    const input = JSON.parse(request.messages[1].content[0].text)
                    assert.equal(input.candidates[0].preferenceContext.category, 'response-language')
                    yield { type: 'text-delta', text: '{"decisions":[]}' }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    })
    await host.table.put('smm_language', preference())
    assert.equal((await injectMessage(host, createMessage('回复使用哪种语言？'))).messages.length, 1)
    assert.equal(host.table.get('smm_language').accessCount, 0)
    await host.table.put('smm_project', { ...preference(), id: 'smm_project', projectId: '甲' })
    assert.equal((await host.call('memory_recall', { query: '回复使用哪种语言？', projectId: '乙', includeGlobal: false })).count, 0)
    await host.dispose()
    const bounded = createHarness({ contextualRecallEnabled: true, injectMaxEstimatedTokens: 100, injectMaxCharsPerHit: 1000 })
    await bounded.table.put('smm_language', { ...preference(), content: '用户偏好助手使用简体中文回复。'.repeat(80) })
    assert.equal((await injectMessage(bounded, createMessage('回复使用哪种语言？'))).messages.length, 1)
    assert.equal(bounded.table.get('smm_language').accessCount, 0)
    await bounded.dispose()
})
