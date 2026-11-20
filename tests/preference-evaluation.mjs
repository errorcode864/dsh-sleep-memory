import { createHash } from 'node:crypto'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

/** 固定记忆隔离检索与审核质量以免把学习差异混入偏好对照。 */
export async function evaluatePreferences(cases, { config = {}, llm, model = 'deterministic' } = {}) {
    const results = []
    for (const scenario of cases) {
        const host = createHarness({
            contextualRecallEnabled: true, recallPlanMode: 'local', injectRepeatAfterTurns: 0,
            projectId: scenario.queryProjectId ?? '', recallReviewEnabled: Boolean(llm), recallReviewTimeoutMs: 30_000, ...config,
        }, { llm })
        try {
            await host.table.put('smm_preference', fixture('smm_preference', {
                content: scenario.preference, projectId: scenario.projectId ?? null,
                source: { kind: scenario.sourceKind ?? 'user', confirmed: true },
                ...(scenario.state ? { lifecycle: { state: scenario.state, at: 1, revision: 1, reason: '样本有效性' } } : {}),
            }))
            const response = await injectMessage(host, createMessage(scenario.query), {
                modelSelection: { provider: 'configured-http', model },
            })
            const status = await host.api.status()
            results.push({
                id: scenario.id, topic: scenario.topic, expected: scenario.expected,
                injected: response.messages.some((message) => message.source?.kind === 'sleep-memory'),
                trace: status.metrics.recentRecalls.at(-1), review: status.review, modelUsage: status.metrics.models.review,
            })
        } finally { await host.dispose() }
    }
    const times = results.map((result) => result.trace.durationMs).sort((a, b) => a - b)
    return {
        model, generatedAt: new Date().toISOString(),
        casesChecksum: createHash('sha256').update(JSON.stringify(cases)).digest('hex'), results,
        summary: {
            cases: results.length, expected: results.filter((result) => result.expected).length,
            matched: results.filter((result) => result.expected === result.injected).length,
            missedCandidates: results.filter((result) => result.expected && result.trace.candidateCount === 0).length,
            missedAfterSelection: results.filter((result) => result.expected && result.trace.candidateCount > 0 && !result.injected).length,
            unwanted: results.filter((result) => !result.expected && result.injected).length,
            reviewFailures: results.filter((result) => ['failed', 'timeout', 'cancelled'].includes(result.trace.diagnostics.review)).length,
            modelCalls: results.reduce((sum, result) => sum + result.modelUsage.calls, 0),
            reportedTokens: results.reduce((sum, result) => sum + result.modelUsage.reported.totalTokens, 0),
            p50Ms: times[Math.ceil(times.length * 0.5) - 1] ?? 0,
            p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? 0,
            note: '构造标签仅用于本样本对照；留出集并非独立第三方盲测。',
        },
    }
}
