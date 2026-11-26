import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createEvaluationModel } from './model-evaluation.mjs'
import { createHarness, fixture } from './harness.mjs'

const { values } = parseArgs({ options: {
    live: { type: 'boolean', default: false },
    'max-calls': { type: 'string', default: '8' },
    report: { type: 'string', default: 'tmp/recall-evidence-model.json' },
} })
const maxCalls = Number(values['max-calls'])
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 12) throw new Error('模型调用上限必须为 1 至 12 的整数')
const missing = ['MEMORY_EVAL_BASE_URL', 'MEMORY_EVAL_API_KEY', 'MEMORY_EVAL_MODEL'].filter((key) => !process.env[key]?.trim())
const reportPath = resolve(values.report)
await mkdir(dirname(reportPath), { recursive: true })
const report = {
    executed: values.live && !missing.length, missing,
    model: process.env.MEMORY_EVAL_MODEL ?? null,
    boundary: '仅合成证据；用 JSON 决策驱动真实插件工具，不代表宿主原生模型工具调度或长期效果。',
    maxCalls, calls: 0, reportedTokens: { input: 0, output: 0 }, samples: [],
}
if (report.executed) {
    const model = createEvaluationModel({
        baseUrl: process.env.MEMORY_EVAL_BASE_URL, apiKey: process.env.MEMORY_EVAL_API_KEY,
        model: process.env.MEMORY_EVAL_MODEL, maxCalls,
    })
    for (const scenario of ['summary-enough', 'nested-evidence', 'budget-stop']) {
        const host = createHarness({
            progressiveRecallEnabled: true, recallEvidenceMaxNodes: scenario === 'budget-stop' ? 1 : 10,
            recallEvidenceMaxEstimatedTokens: 4000,
        })
        const context = { agent: { id: `模型验收-${scenario}` } }
        const sample = { scenario, calls: 0, expansions: [], answer: null, passed: false, failure: null }
        const startedAt = performance.now()
        try {
            for (const record of [
                fixture('smm_source', { content: '合成项目的部署验收端口为 8611。', supersededBy: 'smm_middle' }),
                fixture('smm_middle', { layer: 'deep', content: '部署验收的端口需核对原始记录。',
                    supersededBy: 'smm_root', edges: [{ target: 'smm_source', relation: 'consolidates', weight: 1 }] }),
                fixture('smm_root', { layer: 'deep',
                    content: scenario === 'summary-enough' ? '合成项目的部署验收端口为 8611。' : '合成项目的部署验收约定已整理，细节在来源中。',
                    edges: [{ target: 'smm_middle', relation: 'consolidates', weight: 1 }] }),
            ]) await host.table.put(record.id, record)
            const recalled = await host.call('memory_recall', { query: '部署验收端口', limit: 1 }, context)
            const before = structuredClone([...host.data])
            const messages = [
                { role: 'system', content: [{ type: 'text', text: [
                    '你在执行记忆取证验收，只能依据已给出的内容回答，缺失端口不能猜测。',
                    '只输出 JSON：若概要足够则 {"action":"answer","port":整数或null,"reason":"依据或缺口"}。',
                    '若需要证据则 {"action":"expandRecall","recallId":"召回给出的标识","id":"已呈现的概要或已发现来源的ID"}。',
                    '每次展开一层，只能使用提供的工具；hasMore 可读取同层下一页，expandable 可继续下层。',
                    '来源预算耗尽或取证报错后用 port:null 说明缺口，知道答案就停止。',
                ].join('\n') }] },
                { role: 'user', content: [{ type: 'text', text: `合成项目的部署验收端口是多少？\n召回结果：${JSON.stringify(recalled)}` }] },
            ]
            for (let step = 0; step < 4 && report.calls < maxCalls; step += 1) {
                report.calls += 1
                sample.calls += 1
                const signal = AbortSignal.timeout(20000)
                const call = await model.prepareCall({}, signal)
                let text = ''
                for await (const chunk of call.stream({ ...call.config, messages, signal })) {
                    if (chunk.type === 'text-delta') text += chunk.text
                    if (chunk.type === 'usage') {
                        report.reportedTokens.input += chunk.usage.inputTokens
                        report.reportedTokens.output += chunk.usage.outputTokens
                    }
                }
                const decision = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
                if (decision.action === 'answer') {
                    if (!(decision.port === null || Number.isInteger(decision.port)) || typeof decision.reason !== 'string') {
                        throw new Error('模型答案不符合评测协议')
                    }
                    sample.answer = decision
                    break
                }
                if (decision.action !== 'expandRecall' || Object.keys(decision).some((key) => !['action', 'id', 'recallId'].includes(key))) {
                    throw new Error('模型取证决策不符合评测协议')
                }
                const result = await host.call('memory_manage', decision, context)
                sample.expansions.push({
                    id: decision.id, code: result.code ?? null,
                    returnedIds: result.items?.map((item) => item.id) ?? [], estimatedTokens: result.estimatedTokens ?? 0,
                })
                messages.push({ role: 'assistant', content: [{ type: 'text', text }] },
                    { role: 'user', content: [{ type: 'text', text: `工具结果：${JSON.stringify(result)}` }] })
            }
            sample.readOnly = JSON.stringify([...host.data]) === JSON.stringify(before)
            sample.passed = sample.readOnly && (scenario === 'summary-enough'
                ? sample.answer?.port === 8611 && sample.expansions.length === 0
                : scenario === 'nested-evidence'
                    ? sample.answer?.port === 8611 && sample.expansions.some((item) => item.returnedIds.includes('smm_source'))
                    : sample.answer?.port === null && !sample.expansions.some((item) => item.returnedIds.includes('smm_source')))
            if (!sample.answer) sample.failure = '未在调用上限内完成回答'
        } catch (error) {
            sample.failure = error.message
        } finally {
            sample.durationMs = Math.round(performance.now() - startedAt)
            report.samples.push(sample)
            await host.dispose()
        }
        console.log(`${scenario}：${sample.passed ? '通过' : '未通过'}，模型调用 ${sample.calls} 次`)
    }
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`逐层取证评测报告：${reportPath}`)
if (values.live && (!report.executed || report.samples.some((sample) => !sample.passed))) process.exitCode = 1
