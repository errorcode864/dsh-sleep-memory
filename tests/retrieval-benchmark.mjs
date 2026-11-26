import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { createCapacityBackup } from './capacity-fixtures.mjs'
import { createVariedRetrievalRecords } from './retrieval-fixtures.mjs'
import { backupChecksum, stableJson } from '../memory-contract.js'

const { values } = parseArgs({ options: {
    root: { type: 'string', default: resolve(import.meta.dirname, '..') },
    size: { type: 'string', default: '1000' },
    profile: { type: 'string', default: 'varied' },
    report: { type: 'string', default: 'tmp/retrieval-benchmark.json' },
    reference: { type: 'string' },
} })
const size = Number(values.size)
if (!Number.isInteger(size) || size < 10 || size > 20000 || !['long', 'varied'].includes(values.profile)) {
    throw new Error('检索基准仅支持 10～20000 条及 long、varied 场景')
}
const moduleRoot = resolve(values.root)
const { createLocalSearchIndex } = await import(pathToFileURL(resolve(moduleRoot, 'memory-search-index.js')))
const { analyzeRetrievalText, analyzeFields, buildIndexFromAnalyses, scoreRetrieval } = await import(pathToFileURL(resolve(moduleRoot, 'memory-retrieval.js')))
const records = values.profile === 'varied' ? createVariedRetrievalRecords(size) : createCapacityBackup(size, 'long').records
const fields = records.map((record) => [record.content, ...record.tags, ...record.keywords])
const query = values.profile === 'varied' ? `node-${size - 1}` : '定向恢复线索'
const report = {
    generatedAt: new Date().toISOString(), node: process.version, moduleRoot, size, profile: values.profile,
    fixtureChecksum: backupChecksum(records), phases: {}, scripts: {}, samples: [],
    boundary: '同一实例冷构建与三次缓存复用；阶段拆分另取前 100 条，不可相加为完整耗时；内存含数据与校验对象。',
}
if (values.profile === 'varied') assert.equal(new Set(records.map((record) => record.content)).size, size)
for (const file of ['memory-retrieval.js', 'memory-search-index.js']) {
    report.scripts[file] = createHash('sha256').update(await readFile(resolve(moduleRoot, file))).digest('hex')
}
const measure = (phase, operation) => {
    const started = performance.now()
    const result = operation()
    report.phases[phase] = Math.round((performance.now() - started) * 100) / 100
    return result
}
const cache = createLocalSearchIndex()
const index = measure('coldMs', () => cache.build(records))
const scores = measure('queryMs', () => scoreRetrieval(index, query, { automatic: true }))
assert.equal(scores[records.findIndex((record) => record.keywords.includes(query))].score, Math.max(...scores.map((score) => score.score)))
for (let repeat = 0; repeat < 3; repeat++) {
    const start = performance.now()
    const warm = cache.build(records)
    report.samples.push(Math.round((performance.now() - start) * 100) / 100)
    assert.deepEqual(warm, index)
    assert.deepEqual(scoreRetrieval(warm, query, { automatic: true }), scores)
}
report.measuredHeapMiB = Math.round(process.memoryUsage().heapUsed / 1048576)
report.measuredRssMiB = Math.round(process.memoryUsage().rss / 1048576)
// 逐条计算相同的数组摘要，避免全量校验字符串放大峰值内存。
const digest = createHash('sha256').update('[')
for (const [position, analysis] of index.analyses.entries()) {
    if (position) digest.update(',')
    digest.update(stableJson({
        tokens: [...analysis.tokens], constraints: [...analysis.constraints].map(([key, set]) => [key, [...set]]),
    }))
}
report.analysisChecksum = digest.update(']').digest('hex')
report.scoreChecksum = backupChecksum(scores)
measure('sampleSignatureMs', () => records.slice(0, 100).map((record) => backupChecksum([record.content, record.tags, record.keywords])))
measure('sampleTextMs', () => fields.slice(0, 100).map((parts) => parts.map(analyzeRetrievalText)))
const analyses = measure('sampleFieldsMs', () => fields.slice(0, 100).map(analyzeFields))
measure('sampleAssemblyMs', () => buildIndexFromAnalyses(analyses))
report.processMaxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024)
if (values.reference) {
    const reference = JSON.parse(await readFile(resolve(values.reference), 'utf8'))
    for (const key of ['node', 'size', 'profile', 'fixtureChecksum', 'analysisChecksum', 'scoreChecksum']) {
        assert.equal(report[key], reference[key], `基准对照不一致：${key}`)
    }
    report.reference = resolve(values.reference)
}
await mkdir(dirname(resolve(values.report)), { recursive: true })
await writeFile(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ profile: report.profile, size, ...report.phases, warmMs: report.samples, processMaxRssMiB: report.processMaxRssMiB }))
