import { fork, execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { CAPACITY_PROFILES } from './capacity-fixtures.mjs'

const { values } = parseArgs({ options: {
    sizes: { type: 'string', default: '1000,10000,20000' },
    profiles: { type: 'string', default: 'short,long,dense' },
    backend: { type: 'string', default: 'memory' },
    repeats: { type: 'string', default: '3' },
    'timeout-seconds': { type: 'string', default: '180' },
    'heap-mib': { type: 'string', default: '3072' },
    report: { type: 'string', default: 'tmp/capacity-benchmark.json' },
} })
const sizes = values.sizes.split(',').map(Number)
const profiles = values.profiles.split(',')
const repeats = Number(values.repeats)
const timeoutSeconds = Number(values['timeout-seconds'])
const heapMiB = Number(values['heap-mib'])
if (sizes.some((size) => !Number.isInteger(size) || size < 10 || size > 20000) || sizes.length > 5
    || profiles.some((name) => !Object.hasOwn(CAPACITY_PROFILES, name)) || profiles.length > 3
    || !['memory', 'disk'].includes(values.backend) || !Number.isInteger(repeats) || repeats < 1 || repeats > 10
    || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 900
    || !Number.isInteger(heapMiB) || heapMiB < 256 || heapMiB > 8192) throw new Error('容量测试参数超出支持范围')
if (values.backend === 'disk' && !process.env.DSH_APP_PACKAGE) throw new Error('真实磁盘模式需要 DSH_APP_PACKAGE')
const reportPath = resolve(values.report)
await mkdir(dirname(reportPath), { recursive: true })
const report = {
    generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0].model, cores: availableParallelism(), totalMemoryMiB: Math.round(totalmem() / 1048576),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: resolve(import.meta.dirname, '..') }).trim(),
    backend: values.backend, repeats, timeoutSeconds, heapMiB, samples: [],
    boundary: '固定合成数据；小样本 P95 通常为最大值；快照替身与真实宿主磁盘分别报告；不调用模型、不删除数据、不代表生产承载量。',
}
report.scripts = Object.fromEntries(await Promise.all(['capacity-benchmark.mjs', 'capacity-worker.mjs', 'capacity-fixtures.mjs'].map(async (name) =>
    [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])))
for (const size of sizes) {
    for (const profile of profiles) {
        const options = { size, profile, backend: values.backend, repeats }
        console.log(`开始 ${values.backend} ${profile} ${size} 条`)
        const startedAt = Date.now()
        const result = await new Promise((resolveResult) => {
            const child = fork(new URL('./capacity-worker.mjs', import.meta.url), [JSON.stringify(options)], {
                execArgv: [`--max-old-space-size=${heapMiB}`], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                cwd: dirname(fileURLToPath(import.meta.url)),
            })
            const output = []
            const state = { phase: 'startup', result: null, progress: null, timedOut: false }
            for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
                output.push(String(chunk))
                if (output.length > 20) output.shift()
            })
            child.on('message', (message) => {
                if (message.type === 'phase') state.phase = message.phase
                if (message.type === 'progress') state.progress = message.report
                if (message.type === 'result') state.result = message.report
            })
            const timer = setTimeout(() => { state.timedOut = true; child.kill() }, timeoutSeconds * 1000)
            child.once('error', (error) => { state.result = { ...options, status: 'failed', error: { message: error.message } } })
            child.once('close', (code, signal) => {
                clearTimeout(timer)
                resolveResult({ ...(state.result ?? state.progress ?? options), status: state.timedOut ? 'timeout' : code === 0 ? state.result?.status ?? 'failed' : 'failed',
                    exitCode: code, signal, lastPhase: state.phase, diagnostics: output.join('').slice(-8000) })
            })
        })
        report.samples.push({ ...result, wallSeconds: Math.round((Date.now() - startedAt) / 10) / 100 })
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
        console.log(`完成 ${profile} ${size}：${result.status}，最后阶段 ${result.lastPhase}`)
    }
}
console.log(`报告：${reportPath}`)
if (report.samples.some((sample) => sample.status !== 'passed')) process.exitCode = 1
