import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createEvaluationModel, evaluateModelPipeline, MODEL_CASES } from './model-evaluation.mjs'

const { values } = parseArgs({ options: {
    check: { type: 'boolean', default: false },
    report: { type: 'string', default: 'tmp/live-model-evaluation.json' },
    'max-calls': { type: 'string', default: '18' },
} })
const maxCalls = Number(values['max-calls'])
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 30) throw new Error('调用次数上限必须为 1 至 30 的整数')
const reportPath = resolve(values.report)
const required = ['MEMORY_EVAL_BASE_URL', 'MEMORY_EVAL_API_KEY', 'MEMORY_EVAL_MODEL']
const missing = required.filter((key) => !process.env[key]?.trim())
await mkdir(dirname(reportPath), { recursive: true })
if (values.check || missing.length) {
    const report = {
        status: missing.length ? 'configuration-required' : 'ready', executed: false, missing,
        samples: MODEL_CASES.length, maxCalls, dataSource: 'synthetic-project',
        note: '只检查配置是否存在，不读取个人 profile、不调用模型。',
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`真实模型预检：${report.status}；报告：${reportPath}`)
    if (missing.length && !values.check) process.exitCode = 2
}
if (!values.check && !missing.length) {
    const llm = createEvaluationModel({
        baseUrl: process.env.MEMORY_EVAL_BASE_URL, apiKey: process.env.MEMORY_EVAL_API_KEY,
        model: process.env.MEMORY_EVAL_MODEL, maxCalls,
    })
    const result = await evaluateModelPipeline(llm, {
        route: { provider: 'configured-http', model: process.env.MEMORY_EVAL_MODEL },
    })
    await writeFile(reportPath, `${JSON.stringify({ status: 'completed', executed: true, ...result }, null, 2)}\n`)
    console.log(`真实模型评测完成：${result.summary.cases} 个合成场景；报告：${reportPath}`)
    if (result.summary.learningFailures || result.summary.reviewFailures || result.summary.learningTimeouts) process.exitCode = 1
}
