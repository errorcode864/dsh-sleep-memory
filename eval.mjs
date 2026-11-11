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
