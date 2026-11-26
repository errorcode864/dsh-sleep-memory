import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import * as current from '../memory-retrieval.js'
import { createVariedRetrievalRecords } from './retrieval-fixtures.mjs'

const { values } = parseArgs({ options: {
    baseline: { type: 'string' },
    report: { type: 'string', default: 'tmp/retrieval-equivalence.json' },
} })
if (!values.baseline) throw new Error('请通过 --baseline 指定基线源码目录')
const baseline = await import(pathToFileURL(resolve(values.baseline, 'memory-retrieval.js')))
const datasets = await Promise.all(['recall-cases', 'recall-holdout'].map(async (name) =>
    JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))))
const records = [...datasets.flatMap((data) => data.records), ...createVariedRetrievalRecords(100)]
const fields = records.map((record) => [record.content, ...(record.tags ?? []), ...(record.keywords ?? [])])
fields.push(
    ['数据库迁移；库迁移；数据；库迁移；数据库迁移', 'HTTP', '404'],
    ['资源占用，异常分支，资源占用。'.repeat(30), 'HTTP404', '端口443'],
    ['恢复演练'.repeat(16384)],
    ['数据𠀀核对！', '数据𠀀核对！', 'Ｃ：／配置／Ａ.yml', '１２７.０.０.１'],
    ['http://[bad 端口8080', 'delete_flag=0', '版本3.2.11'],
)
const original = baseline.buildRetrievalIndex(fields)
const optimized = current.buildRetrievalIndex(fields)
assert.deepEqual(optimized, original)
const queries = [...new Set([...datasets.flatMap((data) => data.cases.map((entry) => entry.query)),
    '资源占用', '库迁移', '数据', 'HTTP404', '端口443', '端口 8081', 'node-99',
    'delete_flag=0', '版本3.2.11', '𠀀', '１２７.０.０.１', 'please'])]
for (const query of queries) {
    for (const options of [{}, { automatic: true }, { automatic: true, local: true, minCoverage: 0.25 }]) {
        assert.deepEqual(current.scoreRetrieval(optimized, query, options), baseline.scoreRetrieval(original, query, options), query)
    }
}
const report = { node: process.version, baseline: resolve(values.baseline),
    records: fields.length, queries: queries.length, modes: 3, scoreComparisons: fields.length * queries.length * 3 }
await mkdir(dirname(resolve(values.report)), { recursive: true })
await writeFile(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`)
console.log(report)
