/** 相关性标签来自评测集，未标注的返回项计为误召回。 */
export function measureRetrieval(expectedIds, actualIds, limit = 5) {
    const expected = new Set(expectedIds)
    const actual = [...new Set(actualIds)].slice(0, limit)
    const truePositives = actual.filter((id) => expected.has(id)).length
    return {
        expected: expected.size, returned: actual.length, truePositives,
        falsePositives: actual.length - truePositives,
        falseNegatives: expected.size - truePositives,
        reciprocalRank: actual.some((id) => expected.has(id))
            ? 1 / (actual.findIndex((id) => expected.has(id)) + 1) : 0,
    }
}

/** 汇总保留分母，空结果不能被当成满分查询。 */
export function summarizeEvaluation(samples) {
    const total = (key) => samples.reduce((sum, sample) => sum + sample[key], 0)
    const latencies = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
    const positive = samples.filter((sample) => sample.expected > 0)
    const negative = samples.filter((sample) => sample.expected === 0)
    const falsePositiveQueries = negative.filter((sample) => sample.returned > 0).length
    const missedQueries = positive.filter((sample) => sample.truePositives === 0).length
    return {
        queries: samples.length,
        precisionAt5: total('returned') > 0 ? total('truePositives') / total('returned') : null,
        recallAt5: total('expected') > 0 ? total('truePositives') / total('expected') : null,
        meanReciprocalRank: positive.length > 0
            ? positive.reduce((sum, sample) => sum + sample.reciprocalRank, 0) / positive.length : null,
        falsePositives: total('falsePositives'), falseNegatives: total('falseNegatives'),
        negativeQueries: negative.length, falsePositiveQueries,
        falsePositiveQueryRate: negative.length > 0 ? falsePositiveQueries / negative.length : null,
        positiveQueries: positive.length, missedQueries,
        missedQueryRate: positive.length > 0 ? missedQueries / positive.length : null,
        p50Ms: latencies.length > 0 ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
        p95Ms: latencies.length > 0 ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
        estimatedOutputTokens: total('estimatedOutputTokens'),
    }
}
