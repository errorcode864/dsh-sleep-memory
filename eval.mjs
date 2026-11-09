import { performance } from 'node:perf_hooks'
import { createHarness, createMessage, fixture, injectMessage } from './tests/harness.mjs'

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
console.table(results)
const passed = results.filter((result) => result.通过).length
console.log(`确定性检索评测：${passed}/${results.length}。未调用真实 LLM，不代表同义改写的总体召回率。`)
if (passed !== results.length) process.exitCode = 1
