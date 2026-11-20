import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { evaluatePreferences } from './preference-evaluation.mjs'
import { REGRESSION_PREFERENCES, HOLDOUT_PREFERENCES } from './fixtures/preference-cases.mjs'
import { createEvaluationModel } from './model-evaluation.mjs'

const { values } = parseArgs({ options: {
    live: { type: 'boolean', default: false },
    enabled: { type: 'boolean', default: false },
    split: { type: 'string', default: 'regression' },
    ids: { type: 'string' },
    'max-calls': { type: 'string', default: '12' },
    'review-timeout-ms': { type: 'string', default: '15000' },
    'cache-seconds': { type: 'string', default: '0' },
    repeats: { type: 'string', default: '1' },
    report: { type: 'string', default: 'tmp/preference-evaluation.json' },
} })
if (!['regression', 'holdout', 'all'].includes(values.split)) throw new Error('样本集必须为 regression、holdout 或 all')
const maxCalls = Number(values['max-calls'])
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 60) throw new Error('调用上限必须为 1 至 60 的整数')
const reviewTimeoutMs = Number(values['review-timeout-ms'])
if (!Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs < 500 || reviewTimeoutMs > 30000) throw new Error('审核时限必须为 500 至 30000 毫秒的整数')
const cacheSeconds = Number(values['cache-seconds'])
const repeats = Number(values.repeats)
if (!Number.isInteger(cacheSeconds) || cacheSeconds < 0 || cacheSeconds > 300) throw new Error('审核缓存必须为 0 至 300 秒的整数')
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('同问题重复次数必须为 1 至 3 的整数')
const selected = values.split === 'all' ? [...REGRESSION_PREFERENCES, ...HOLDOUT_PREFERENCES]
    : values.split === 'holdout' ? HOLDOUT_PREFERENCES : REGRESSION_PREFERENCES
const ids = values.ids?.split(',')
if (ids?.some((id) => !selected.some((item) => item.id === id))) throw new Error('指定样本 ID 不在当前样本集中')
const cases = ids ? selected.filter((item) => ids.includes(item.id)) : selected
if (values.live && ['MEMORY_EVAL_BASE_URL', 'MEMORY_EVAL_API_KEY', 'MEMORY_EVAL_MODEL'].some((key) => !process.env[key]?.trim())) {
    throw new Error('真实评测需要配置模型地址、模型名称和 API Key')
}
const report = await evaluatePreferences(cases, {
    config: { preferenceRecallEnabled: values.enabled, recallReviewTimeoutMs: reviewTimeoutMs, recallReviewCacheSeconds: cacheSeconds },
    repeats,
    ...(values.live ? {
        model: process.env.MEMORY_EVAL_MODEL,
        llm: createEvaluationModel({
            baseUrl: process.env.MEMORY_EVAL_BASE_URL, apiKey: process.env.MEMORY_EVAL_API_KEY,
            model: process.env.MEMORY_EVAL_MODEL, maxCalls,
        }),
    } : {}),
})
await mkdir(dirname(resolve(values.report)), { recursive: true })
await writeFile(resolve(values.report), `${JSON.stringify({
    split: values.split, enabled: values.enabled, reviewTimeoutMs, cacheSeconds, source: 'synthetic-preference', ...report,
}, null, 2)}\n`)
console.log(JSON.stringify(report.summary))
if (report.summary.reviewFailures) process.exitCode = 1
