/** 字符估算只用于比较和预算判断，不冒充模型的实际分词计费。 */
export function estimateTokens(text) {
    const asciiChars = text.match(/[\x00-\x7f]/g)?.length ?? 0
    return Math.ceil(asciiChars / 4 + ([...text].length - asciiChars) * 1.5)
}

/** 统计只保留计数和记忆 ID，不保留用户问题与记忆正文。 */
export function createMemoryMetrics() {
    const state = {
        models: Object.fromEntries(['learning', 'review', 'expansion', 'scoring'].map((stage) => [stage, {
            calls: 0, failed: 0, durationMs: 0,
            reported: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
            estimated: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        }])),
        retrieval: { queries: 0, empty: 0, returned: 0, durationMs: 0, estimatedTokens: 0 },
        evidence: { reads: 0, estimatedTokens: 0 },
        injection: { turns: 0, estimatedTokens: 0, sourceEstimatedTokens: 0 },
        recentRecalls: [],
    }
    return {
        state,
        /** 每次召回独立记录阶段结果且不保留正文。 */
        startRecall(mode, detailed) {
            const startedAt = performance.now()
            const data = { mode, candidateCount: 0, approvedCount: 0, returnedIds: [], estimatedTokens: 0 }
            const diagnostics = { stage: 'candidate', review: 'not-run', selectedCount: 0, wakeCount: 0, reasons: {} }
            return {
                data, diagnostics,
                skip(reason, count = 1) {
                    if (count > 0) diagnostics.reasons[reason] = (diagnostics.reasons[reason] ?? 0) + count
                },
                fail(error) {
                    const reason = error.code === 'audit_capacity' ? 'audit-capacity'
                        : diagnostics.stage === 'write' ? 'write-failed' : 'pipeline-failed'
                    diagnostics.reasons[reason] = 1
                    diagnostics.failed = true
                },
                finish() {
                    state.recentRecalls.push({
                        at: Date.now(), ...data, durationMs: Math.round(performance.now() - startedAt),
                        ...(detailed ? { diagnostics: {
                            ...diagnostics, outcome: diagnostics.failed ? 'failed' : data.returnedIds.length ? 'returned' : 'empty',
                        } } : {}),
                    })
                    if (state.recentRecalls.length > 20) state.recentRecalls.shift()
                },
            }
        },
        startModel(stage, messages) {
            const startedAt = performance.now()
            const counters = state.models[stage]
            const inputTokens = messages.reduce((sum, message) =>
                sum + 4 + estimateTokens(message.content.map((part) => part.text).join('\n')), 2)
            let outputAsciiChars = 0
            let outputOtherChars = 0
            let usage
            let finished = false
            counters.calls += 1
            return {
                observe(chunk) {
                    if (finished) return
                    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
                        const asciiChars = chunk.text.match(/[\x00-\x7f]/g)?.length ?? 0
                        outputAsciiChars += asciiChars
                        outputOtherChars += [...chunk.text].length - asciiChars
                    }
                    if (chunk.type === 'usage') usage = chunk.usage
                },
                finish(succeeded) {
                    if (finished) return
                    finished = true
                    counters.durationMs += Math.round(performance.now() - startedAt)
                    if (!succeeded) counters.failed += 1
                    if (usage) {
                        counters.reported.calls += 1
                        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
                            counters.reported[key] += usage[key] ?? 0
                        }
                        counters.reported.totalTokens += usage.totalTokens
                            ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
                        return
                    }
                    counters.estimated.calls += 1
                    counters.estimated.inputTokens += inputTokens
                    const outputTokens = Math.ceil(outputAsciiChars / 4 + outputOtherChars * 1.5)
                    counters.estimated.outputTokens += outputTokens
                    counters.estimated.totalTokens += inputTokens + outputTokens
                },
            }
        },
        recordRecall(trace) {
            state.recentRecalls.push({ at: Date.now(), ...trace })
            if (state.recentRecalls.length > 20) state.recentRecalls.shift()
        },
    }
}
