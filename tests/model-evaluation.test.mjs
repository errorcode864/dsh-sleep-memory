import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvaluationModel, evaluateModelPipeline } from './model-evaluation.mjs'

test('模型评测跑通真实学习审核管线并记录实报 Token', async () => {
    const scenario = {
        id: 'pipeline-test', text: '星帆项目固定使用 Java 21 构建。',
        query: '星帆项目构建使用什么 Java 版本？', expectStored: true,
    }
    const requests = []
    const llm = createEvaluationModel({
        baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local-test', model: 'test',
        fetchImpl: async (url, request) => {
            const body = JSON.parse(request.body)
            const input = JSON.parse(body.messages[1].content)
            requests.push({ url: String(url), input })
            const output = input.messages ? { memories: [{
                content: scenario.text, category: 'project-fact', confidence: 0.95,
                reason: '后续构建核对 JDK', relation: 'new', relatedIds: [], keywords: ['Java'],
                evidence: [{ messageId: input.messages[0].id, quote: scenario.text }],
                recallTriggers: [{ when: '执行项目构建时', cues: ['构建'] }],
            }] } : { decisions: input.candidates.map((item) => ({
                id: item.id, useful: true, reason: '提供构建版本约定',
            })) }
            return { ok: true, json: async () => ({
                choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 20, completion_tokens: 10 },
            }) }
        },
    })
    const report = await evaluateModelPipeline(llm, { cases: [scenario] })
    assert.equal(report.results[0].storedCount, 1)
    assert.equal(report.results[0].relevantInjected, true)
    assert.equal(report.results[0].unrelatedInjected, false)
    assert.equal(report.results[0].metrics.models.learning.reported.totalTokens, 30)
    assert.equal(report.results[0].metrics.models.review.calls, 1)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.candidates[0].triggerConditions[0].when, '执行项目构建时')
})

test('模型 HTTP 边界拒绝不安全地址、非完整结果和过量请求', async () => {
    assert.throws(() => createEvaluationModel({ baseUrl: 'http://example.com/v1', apiKey: 'test', model: 'test' }), /HTTPS/)
    const model = createEvaluationModel({
        baseUrl: 'http://localhost/v1', apiKey: 'test', model: 'test', maxCalls: 1,
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }) }),
    })
    const call = await model.prepareCall()
    const consume = async () => {
        for await (const chunk of call.stream({ messages: [] })) assert.ok(chunk)
    }
    await assert.rejects(consume(), /完整文本/)
    await assert.rejects(consume(), /次数上限/)
})

test('负例不会被先前注入去重掩盖且截断响应仍记录实报用量', async () => {
    const text = '星帆项目固定使用 Java 21 构建。'
    const llm = createEvaluationModel({
        baseUrl: 'http://localhost/v1', apiKey: 'local-test', model: 'test',
        fetchImpl: async (_url, request) => {
            const input = JSON.parse(JSON.parse(request.body).messages[1].content)
            const result = input.messages ? { memories: [{
                content: text, category: 'project-fact', confidence: 0.95, reason: '构建时核对',
                relation: 'new', relatedIds: [], keywords: ['Java'],
                evidence: [{ messageId: input.messages[0].id, quote: text }],
                recallTriggers: [{ when: '准备构建时', cues: ['构建'] }],
            }] } : { decisions: input.candidates.map((item) => ({ id: item.id, useful: true, reason: '模拟错误地全接受' })) }
            return { ok: true, json: async () => ({
                choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
            }) }
        },
    })
    const report = await evaluateModelPipeline(llm, { cases: [{
        id: 'negative-dedupe', text, query: 'Java 构建版本',
        negativeQuery: 'Java 构建文档插图颜色', expectStored: true,
    }] })
    assert.equal(report.results[0].relevantInjected, true)
    assert.equal(report.results[0].unrelatedInjected, true)
    assert.equal(report.summary.irrelevantInjections, 1)
    assert.equal(report.results[0].metrics.models.review.calls, 2)
    const chunks = []
    const truncated = createEvaluationModel({
        baseUrl: 'http://localhost/v1', apiKey: 'local-test', model: 'test',
        fetchImpl: async () => ({ ok: true, json: async () => ({
            choices: [{ message: { content: '{}' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 40, completion_tokens: 5 },
        }) }),
    })
    await assert.rejects(async () => {
        for await (const chunk of (await truncated.prepareCall()).stream({ messages: [] })) chunks.push(chunk)
    }, /完整文本/)
    assert.deepEqual(chunks, [{ type: 'usage', usage: { inputTokens: 40, outputTokens: 5 } }])
})
