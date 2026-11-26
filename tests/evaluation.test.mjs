import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureRetrieval, summarizeEvaluation } from '../memory-evaluation.js'

test('评测同时计算误召回、漏召回与排序，重复 ID 不增加命中', () => {
    assert.deepEqual(measureRetrieval(['a', 'b'], ['noise', 'a', 'a']), {
        expected: 2, returned: 2, truePositives: 1, falsePositives: 1, falseNegatives: 1, reciprocalRank: 0.5,
    })
    assert.equal(measureRetrieval(['a'], ['n1', 'n2', 'n3', 'n4', 'n5', 'a']).truePositives, 0)
    assert.equal(measureRetrieval([], ['noise']).falsePositives, 1)
})

test('空结果不提高召回率，分母为空时不伪造满分', () => {
    const summary = summarizeEvaluation([
        { ...measureRetrieval(['a', 'b'], ['noise', 'a']), durationMs: 10, estimatedOutputTokens: 50 },
        { ...measureRetrieval(['c'], []), durationMs: 20, estimatedOutputTokens: 0 },
        { ...measureRetrieval([], ['noise']), durationMs: 30, estimatedOutputTokens: 10 },
        { ...measureRetrieval([], []), durationMs: 40, estimatedOutputTokens: 0 },
    ])
    assert.equal(summary.precisionAt5, 1 / 3)
    assert.equal(summary.recallAt5, 1 / 3)
    assert.equal(summary.missedQueryRate, 0.5)
    assert.equal(summary.falsePositiveQueryRate, 0.5)
    assert.equal(summary.p50Ms, 20)
    assert.equal(summary.p95Ms, 40)
    assert.equal(summary.estimatedOutputTokens, 60)
    assert.equal(summarizeEvaluation([]).recallAt5, null)
    assert.equal(summarizeEvaluation([]).precisionAt5, null)
})
