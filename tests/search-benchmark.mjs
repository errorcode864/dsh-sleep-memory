import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createLocalSearchIndex } from '../memory-search-index.js'
import { buildRetrievalIndex, scoreRetrieval } from '../memory-retrieval.js'

const samples = []
for (const size of [1000, 10000, 20000]) {
    const records = Array.from({ length: size }, (_, position) => ({
        id: `smm_benchmark_${position}`,
        content: `部署节点 node-${position} 使用独立目录 /srv/service-${position}/config.yml，服务端口 ${8000 + position}。`,
        tags: ['部署'], keywords: [`node-${position}`],
    }))
    const cache = createLocalSearchIndex()
    const query = `node-${size - 1}`
    const heapBefore = process.memoryUsage().heapUsed
    const coldStart = performance.now()
    const cold = cache.build(records)
    const coldMs = performance.now() - coldStart
    const warmStart = performance.now()
    const warm = cache.build(records)
    const warmMs = performance.now() - warmStart
    const queryStart = performance.now()
    const scores = scoreRetrieval(warm, query, { automatic: true })
    const queryMs = performance.now() - queryStart
    const legacyStart = performance.now()
    const legacy = buildRetrievalIndex(records.map((record) => [record.content, ...record.tags, ...record.keywords]))
    const legacyMs = performance.now() - legacyStart
    assert.equal(cache.state.rebuilt, size)
    assert.equal(cache.state.reused, size)
    assert.deepEqual(cold.frequencies, warm.frequencies)
    assert.deepEqual(scoreRetrieval(legacy, query, { automatic: true }), scores)
    assert.equal(scores.filter((score) => score.score > 0).length, 1)
    samples.push({
        size, coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), legacyMs: Math.round(legacyMs),
        queryMs: Math.round(queryMs), heapDeltaMiB: Number(((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(1)),
        rebuilt: cache.state.rebuilt, reused: cache.state.reused,
    })
}
await mkdir(new URL('../tmp/', import.meta.url), { recursive: true })
await writeFile(new URL('../tmp/search-benchmark.json', import.meta.url), `${JSON.stringify({
    generatedAt: new Date().toISOString(), node: process.version,
    boundary: '构造短记忆的单次进程测试；堆变化含基线索引和临时对象，不等于缓存独占内存或真实宿主延迟。',
    samples,
}, null, 2)}\n`)
console.table(samples)
