import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarness, createMessage, fixture, injectMessage } from './tests/harness.mjs'
import { estimateTokens } from './memory-metrics.js'
import { measureRetrieval, summarizeEvaluation } from './memory-evaluation.js'

// 固定场景用于监测检索契约退化，不代替真实用户问题或 LLM 效果评测。
const memory = createHarness({ injectMinScore: 0.5 })
const oldTime = Date.now() - 30 * 86400000
const records = [
    fixture('smm_db', { content: '甲项目数据库使用 DM8，迁移通过 Liquibase 执行。', projectId: '甲' }),
    fixture('smm_path', { content: '部署约定。精确目录 /srv/atlas-v2 必须保留。', projectId: '甲', strength: 0.4, occurredAt: oldTime }),
    fixture('smm_path_copy', { content: '部署约定。精确目录 /srv/atlas-v2 必须保留。', projectId: '甲', strength: 0.4, occurredAt: oldTime }),
    fixture('smm_other', { content: '乙项目数据库使用 PostgreSQL。', projectId: '乙' }),
    fixture('smm_preference', { content: '用户希望使用简体中文回复。', keywords: ['简中', 'Chinese'] }),
    fixture('smm_old', { content: '日志存储目录为 /old/logs。', projectId: '甲' }),
]
for (const record of records) await memory.table.put(record.id, record)
const corrected = await memory.call('memory_manage', { action: 'correct', projectId: '甲', id: 'smm_old', content: '日志存储目录已改为 /var/log/atlas。' })
await memory.call('memory_sleep', {})

const scenarios = [
    { name: '精确配置', args: { query: 'DM8', projectId: '甲' }, expected: ['smm_db'] },
    { name: '项目隔离', args: { query: 'PostgreSQL', projectId: '甲', includeGlobal: false }, expected: [] },
    { name: '全局查询不遍历项目', args: { query: 'DM8' }, expected: [] },
    { name: '全局偏好', args: { query: 'Chinese', projectId: '甲' }, expected: ['smm_preference'] },
    { name: '巩固后的原文细节', args: { query: 'atlas-v2', projectId: '甲', fidelity: 'raw' }, expected: ['smm_path', 'smm_path_copy'] },
    { name: '事件时间窗', args: { query: 'atlas-v2', projectId: '甲', timeField: 'occurredAt', since: oldTime - 1, until: oldTime + 1 }, expected: ['smm_path', 'smm_path_copy'] },
    { name: '纠正后的事实', args: { query: '日志存储目录', projectId: '甲' }, expected: [corrected.id], forbidden: ['smm_old'] },
    { name: '无关查询', args: { query: '火星探测器轨道椭圆率' }, expected: [] },
]
const results = []
for (const scenario of scenarios) {
    const startedAt = performance.now()
    const response = await memory.call('memory_recall', scenario.args)
    const ids = response.hits.map((hit) => hit.id)
    const passed = scenario.expected.length
        ? scenario.expected.every((id) => ids.includes(id)) && !(scenario.forbidden ?? []).some((id) => ids.includes(id))
        : ids.length === 0
    results.push({ 场景: scenario.name, 通过: passed, 返回条数: ids.length, 耗时毫秒: Number((performance.now() - startedAt).toFixed(3)) })
}
const injected = await injectMessage(memory, createMessage('火星探测器轨道椭圆率'))
results.push({ 场景: '无关问题不自动注入', 通过: injected.messages.length === 1, 返回条数: injected.messages.length - 1 })
const lifecycle = createHarness({ injectMinScore: 0 })
await lifecycle.table.put('smm_review', fixture('smm_review', { content: '灰度发布需核对备份恢复步骤。' }))
const update = { action: 'setState', id: 'smm_review', state: 'review', reason: '发布条件已变化' }
const preview = await lifecycle.call('memory_manage', update)
await lifecycle.call('memory_manage', { ...update, dryRun: false, planToken: preview.planToken })
const reviewRecall = await lifecycle.call('memory_recall', { query: '灰度发布' })
results.push({ 场景: '待复核显式召回带状态', 通过: reviewRecall.hits[0]?.lifecycle.state === 'review', 返回条数: reviewRecall.count })
const reviewInjection = await injectMessage(lifecycle, createMessage('灰度发布'))
results.push({ 场景: '待复核不自动注入', 通过: reviewInjection.messages.length === 1, 返回条数: reviewInjection.messages.length - 1 })
const invalid = { ...update, state: 'invalid' }
const invalidPlan = await lifecycle.call('memory_manage', invalid)
await lifecycle.call('memory_manage', { ...invalid, dryRun: false, planToken: invalidPlan.planToken })
const invalidRecall = await lifecycle.call('memory_recall', { query: '灰度发布', fidelity: 'raw' })
results.push({ 场景: '失效内容退出原文召回', 通过: invalidRecall.count === 0, 返回条数: invalidRecall.count })
const scoped = createHarness({}, { get: (key) => key === 'workspaceRegistry' ? {
    list: () => [{ id: '评测工作区', title: '评测项目', sessionIds: ['评测会话'] }],
} : undefined })
const context = { agent: { id: '评测会话' } }
const written = await scoped.call('memory_write', { kind: 'fact', content: '构建参数 BUILD_FLAG_42' }, context)
const scopedRecall = await scoped.call('memory_recall', { query: 'BUILD_FLAG_42' }, context)
results.push({ 场景: '宿主工作区范围召回', 通过: scopedRecall.hits[0]?.id === written.id, 返回条数: scopedRecall.count })
const relevance = createHarness()
await relevance.table.put('smm_proxy', fixture('smm_proxy', {
    content: 'GitHub 网络连接失败，代理 127.0.0.1:7897 不可用，建议使用 SSH。',
}))
for (const query of ['排查 enroll 的 del_flag，0 存在 1 删除', '0 1 127 7897', '检查当前项目的删除标识']) {
    const response = await injectMessage(relevance, createMessage(query))
    results.push({ 场景: `数字与通用词隔离：${query}`, 通过: response.messages.length === 1, 返回条数: response.messages.length - 1 })
}
await relevance.table.put('smm_rule', fixture('smm_rule', {
    content: 'enroll 的逻辑删除字段 del_flag 使用 0 表示存在、1 表示删除。',
}))
const relevant = await injectMessage(relevance, createMessage('排查 enroll 的 del_flag，0 存在 1 删除'))
results.push({
    场景: '删除标识正确召回且不强化网络记忆',
    通过: relevant.messages[1]?.source.recalled.join(',') === 'smm_rule' && relevance.table.get('smm_proxy').accessCount === 0,
    返回条数: relevant.messages[1]?.source.recalled.length ?? 0,
})
const entityScenarios = [
    {
        name: '数字角色区分：HTTP 状态码与端口',
        query: 'HTTP404 错误',
        correct: 'HTTP 状态码 404 表示资源不存在，应检查路由。',
        wrong: '开发服务监听端口 404。HTTP 500 表示服务器错误。',
    },
    {
        name: '端口精确匹配',
        query: '443端口的配置',
        correct: 'HTTPS 端口 443 由网关监听。',
        wrong: '管理服务端口 8443 由网关监听。',
    },
    {
        name: '完整版本精确匹配',
        query: 'Spring Boot 3.2.11 的配置',
        correct: 'Spring Boot 3.2.11 的项目配置已验证。',
        wrong: 'Spring Boot 3.2.12 的项目配置待验证。',
    },
    {
        name: '完整路径精确匹配',
        query: '/srv/exam/config.yml 配置',
        correct: '配置文件位于 /srv/exam/config.yml。',
        wrong: '配置文件位于 /srv/other/config.yml。',
    },
    {
        name: '同端口不同 IP 的隔离',
        query: '代理 127.0.0.1:7897',
        correct: '本机代理地址为 127.0.0.1:7897。',
        wrong: '备用代理地址为 127.0.0.2:7897。',
    },
    {
        name: '连字符设备标识精确匹配',
        query: '检查 dm-244',
        correct: 'dm-244 是开发数据库节点。',
        wrong: 'dm-245 是测试数据库节点。',
    },
    {
        name: '完整字段区分相似组件',
        query: 'del_flag',
        correct: 'del_flag 表示记录逻辑删除状态。',
        wrong: 'status_flag 表示账号启用状态。',
    },
    {
        name: '字段值绑定保留数字语义',
        query: 'del_flag=0',
        correct: 'del_flag 为 0 表示记录存在。',
        wrong: 'del_flag 为 1 表示记录已删除。',
    },
]
for (const scenario of entityScenarios) {
    const harness = createHarness()
    await harness.table.put('smm_expected', fixture('smm_expected', { content: scenario.correct }))
    await harness.table.put('smm_forbidden', fixture('smm_forbidden', { content: scenario.wrong }))
    const response = await injectMessage(harness, createMessage(scenario.query))
    const recalled = response.messages[1]?.source.recalled ?? []
    results.push({
        场景: scenario.name,
        通过: recalled.length === 1 && recalled[0] === 'smm_expected' && harness.table.get('smm_forbidden').accessCount === 0,
        返回条数: recalled.length,
    })
}
console.table(results)
const passed = results.filter((result) => result.通过).length
console.log(`确定性检索评测：${passed}/${results.length}。未调用真实 LLM，不代表同义改写的总体召回率。`)
if (passed !== results.length) process.exitCode = 1

const args = process.argv.slice(2)
const options = {}
for (let index = 0; index < args.length; index += 2) {
    if (!['--cases', '--report', '--baseline-ref', '--aliases'].includes(args[index]) || !args[index + 1]) {
        throw new Error('评测参数要求 --cases、--report、--baseline-ref 或 --aliases 后接具体值')
    }
    options[args[index].slice(2)] = args[index + 1]
}
const root = dirname(fileURLToPath(import.meta.url))
const dataset = JSON.parse(await readFile(resolve(root, options.cases ?? 'tests/fixtures/recall-cases.json'), 'utf8'))
if (dataset.version !== 1 || !Array.isArray(dataset.records) || !Array.isArray(dataset.cases)
    || dataset.cases.some((item) => typeof item.id !== 'string' || typeof item.query !== 'string'
        || !Array.isArray(item.expected) || !item.expected.every((id) => typeof id === 'string'))) {
    throw new Error('评测数据必须为 v1 格式，并为每条问题提供 ID、query 和 expected')
}
const recordIds = new Set(dataset.records.map((record) => record.id))
if (recordIds.size !== dataset.records.length || new Set(dataset.cases.map((item) => item.id)).size !== dataset.cases.length
    || dataset.cases.some((item) => [...item.expected, ...(item.explicitExpected ?? [])].some((id) => !recordIds.has(id)))) {
    throw new Error('评测 ID 不能重复，相关性标签必须引用已有记忆')
}

async function evaluateDataset(implementation, config = {}) {
    const samples = []
    for (const scenario of dataset.cases) {
        for (const mode of ['automatic', 'explicit']) {
            const harness = createHarness({
                projectId: scenario.projectId ?? '', recallBudget: 5, injectBudget: 5, injectMaxTotalChars: 32000,
                ...config,
            }, implementation ? { apply: implementation } : {})
            for (const record of dataset.records) await harness.table.put(record.id, fixture(record.id, record))
            const startedAt = performance.now()
            const response = mode === 'automatic'
                ? await injectMessage(harness, createMessage(scenario.query, scenario.id))
                : await harness.call('memory_recall', {
                    query: scenario.query, projectId: scenario.projectId ?? null, limit: 5,
                    ...(scenario.includeGlobal === false ? { includeGlobal: false } : {}),
                })
            const durationMs = Number((performance.now() - startedAt).toFixed(3))
            const ids = mode === 'automatic'
                ? response.messages.find((message) => message.source?.kind === 'sleep-memory')?.source.recalled ?? []
                : response.hits.map((hit) => hit.id)
            const outputText = mode === 'automatic'
                ? response.messages.find((message) => message.source?.kind === 'sleep-memory')?.content[0].text ?? ''
                : JSON.stringify(response, null, 2)
            const status = await harness.api.status()
            samples.push({
                id: scenario.id, mode, source: scenario.source, knownGap: scenario.knownGap ?? null,
                expectedIds: mode === 'explicit' ? scenario.explicitExpected ?? scenario.expected : scenario.expected,
                actualIds: ids, durationMs, estimatedOutputTokens: estimateTokens(outputText),
                plan: status.recallPlan?.last ?? null,
                modelCalls: Object.values(status.metrics?.models ?? {}).reduce((sum, stage) => sum + stage.calls, 0),
                requiredTextPresent: scenario.requiredText ? (mode === 'automatic' ? outputText
                    : response.hits.filter((hit) => (scenario.explicitExpected ?? scenario.expected).includes(hit.id))
                        .map((hit) => hit.content).join('\n')).includes(scenario.requiredText) : null,
                ...measureRetrieval(mode === 'explicit' ? scenario.explicitExpected ?? scenario.expected : scenario.expected, ids),
            })
            await harness.dispose()
        }
    }
    return {
        summary: Object.fromEntries(['automatic', 'explicit'].map((mode) =>
            [mode, summarizeEvaluation(samples.filter((sample) => sample.mode === mode))])),
        userCases: Object.fromEntries(['automatic', 'explicit'].map((mode) =>
            [mode, summarizeEvaluation(samples.filter((sample) => sample.mode === mode && sample.source === 'user-provided'))])),
        samples,
    }
}

const current = await evaluateDataset()
const shadow = await evaluateDataset(undefined, { recallPlanMode: 'shadow' })
const local = await evaluateDataset(undefined, { recallPlanMode: 'local' })
const aliases = options.aliases ? JSON.parse(await readFile(resolve(root, options.aliases), 'utf8')) : null
const localWithAliases = aliases ? await evaluateDataset(undefined, { recallPlanMode: 'local', recallAliases: aliases }) : null
const baseline = { ref: options['baseline-ref'] ?? null, result: null }
if (baseline.ref) {
    const revision = execFileSync('git', ['rev-parse', '--verify', `${baseline.ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
    await mkdir(resolve(root, 'tmp'), { recursive: true })
    const snapshotRoot = await mkdtemp(resolve(root, 'tmp/eval-baseline-'))
    const files = execFileSync('git', ['ls-tree', '--name-only', revision], { cwd: root, encoding: 'utf8' })
        .split('\n').filter((file) => file.endsWith('.js') || file === 'package.json')
    for (const file of files) {
        await writeFile(resolve(snapshotRoot, file), execFileSync('git', ['show', `${revision}:${file}`], { cwd: root }))
    }
    baseline.revision = revision
    baseline.result = await evaluateDataset((await import(pathToFileURL(resolve(snapshotRoot, 'index.js')).href)).apply)
}

const report = {
    version: 1, generatedAt: new Date().toISOString(),
    dataset: options.cases ?? 'tests/fixtures/recall-cases.json',
    boundary: '离线标签评测；未调用真实 LLM；Token 为字符估算；不代表线上总体准确率。',
    deterministic: { passed, total: results.length }, current, baseline, shadow, local,
    configuredAliases: aliases ? { source: options.aliases, count: aliases.length, result: localWithAliases } : null,
}
const reportPath = resolve(root, options.report ?? 'tmp/evaluation-latest.json')
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.table(Object.entries(current.summary).map(([mode, value]) => ({
    模式: mode, 问题数: value.queries, 'Precision@5': value.precisionAt5, 'Recall@5': value.recallAt5,
    误召回条数: value.falsePositives, 漏召回条数: value.falseNegatives,
    P95毫秒: value.p95Ms, 输出Token估算: value.estimatedOutputTokens,
})))
console.table(current.samples.filter((sample) => sample.falsePositives || sample.falseNegatives).map((sample) => ({
    场景: sample.id, 模式: sample.mode, 误召回: sample.falsePositives, 漏召回: sample.falseNegatives,
    已知缺口: sample.knownGap ?? '需核对',
})))
console.table([['off', current], ['shadow', shadow], ['local', local], ...(localWithAliases ? [['local+配置词表', localWithAliases]] : [])]
    .flatMap(([plan, result]) => Object.entries(result.summary).map(([mode, value]) => ({
        规划: plan, 路径: mode, 'Precision@5': value.precisionAt5, 'Recall@5': value.recallAt5,
        误召回: value.falsePositives, 漏召回: value.falseNegatives, P95毫秒: value.p95Ms,
        输出Token估算: value.estimatedOutputTokens,
        模型调用: result.samples.filter((sample) => sample.mode === mode).reduce((sum, sample) => sum + sample.modelCalls, 0),
    }))))
if (shadow.samples.some((sample, index) => JSON.stringify(sample.actualIds) !== JSON.stringify(current.samples[index].actualIds))) {
    throw new Error('影子模式改变了实际选择')
}
if (baseline.result) {
    console.table(['automatic', 'explicit'].map((mode) => ({
        模式: mode, 基线Token估算: baseline.result.summary[mode].estimatedOutputTokens,
        当前Token估算: current.summary[mode].estimatedOutputTokens,
        基线漏召回: baseline.result.summary[mode].falseNegatives, 当前漏召回: current.summary[mode].falseNegatives,
        基线误召回: baseline.result.summary[mode].falsePositives, 当前误召回: current.summary[mode].falsePositives,
        基线片段遗漏: baseline.result.samples.filter((sample) => sample.mode === mode && sample.requiredTextPresent === false).length,
        当前片段遗漏: current.samples.filter((sample) => sample.mode === mode && sample.requiredTextPresent === false).length,
    })))
}
console.log(`离线标注评测已输出：${reportPath}；${report.boundary}`)
if (baseline.result && current.samples.some((sample, index) =>
    sample.falsePositives > baseline.result.samples[index].falsePositives
    || sample.falseNegatives > baseline.result.samples[index].falseNegatives
    || (sample.requiredTextPresent === false && baseline.result.samples[index].requiredTextPresent === true))) {
    process.exitCode = 1
}
