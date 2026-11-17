import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createHarness, createMessage, flushTasks } from './harness.mjs'

const dataset = JSON.parse(await readFile(new URL('./fixtures/learning-cases.json', import.meta.url), 'utf8'))

test('学习边界标注集区分触发、证据拒绝与可写入，不把 Mock 结果当成真实模型准确率', async () => {
    for (const scenario of dataset.cases) {
        const calls = []
        const candidate = scenario.candidate ? {
            content: scenario.candidate.content, category: scenario.candidate.category, confidence: 0.95,
            reason: '后续同类任务使用', relation: 'new', relatedIds: [], keywords: [],
            evidence: [{
                messageId: scenario.candidate.evidenceRole ?? 'user',
                quote: scenario.candidate.quote,
            }],
        } : null
        const harness = createHarness({
            autoLearnEnabled: true, learningPolicyMode: 'evidence', projectId: 'policy-test',
        }, { llm: {
            prepareCall: async () => ({
                config: {},
                stream: async function* (request) {
                    calls.push(request)
                    yield { type: 'text-delta', text: JSON.stringify({ memories: candidate ? [candidate] : [] }) }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        } })
        const emit = (type, data) => harness.handlers.get('session/event')({ id: scenario.id }, { type, data })
        emit('turn/start', { turn: 1 })
        emit('user/message', {
            ...createMessage(scenario.user, 'user'), source: { kind: scenario.source ?? 'user' },
        })
        if (scenario.tool) emit('tool/result', {
            message: { id: 'tool', role: 'tool', content: [{ type: 'text', text: scenario.tool }] },
        })
        emit('assistant/message', { message: {
            id: 'assistant', role: 'assistant', source: { provider: 'mock', model: 'mock' },
            content: [{ type: 'text', text: '项目固定使用 Java 21。' }],
        } })
        emit('turn/end', { turn: 1, reason: { kind: scenario.reason ?? 'completed' } })
        await flushTasks()
        await flushTasks()
        assert.equal(calls.length, Number(scenario.callModel), `${scenario.id} 的触发`)
        assert.equal(harness.data.size, Number(scenario.accepted), `${scenario.id} 的写入`)
        await harness.dispose()
    }
})
