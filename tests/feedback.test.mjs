import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, fixture, createMessage, injectMessage } from './harness.mjs'

async function setup(config = {}, services = {}) {
    const harness = createHarness({ projectId: 'a', feedbackEnabled: true, spreadDepth: 0, ...config }, services)
    await harness.table.put('smm_feedback', fixture('smm_feedback', { projectId: 'a', content: 'JWT 使用 refresh_token 续期' }))
    return harness
}

test('反馈仅绑定实际呈现，不为零注入或影子额外候选生成记录', async () => {
    const harness = await setup({
        recallPlanMode: 'shadow', recallAliases: [{ projectId: 'a', phrase: '登录过期', target: 'refresh_token' }],
    })
    await injectMessage(harness, createMessage('登录过期'))
    assert.equal((await harness.api.status()).feedback.exposures, 0)
    const decision = await injectMessage(harness, createMessage('JWT 续期'))
    assert.equal(decision.messages[1].source.exposures.length, 1)
    const detail = await harness.api.getRecord({ id: 'smm_feedback' })
    assert.equal(detail.exposures.length, 1)
    assert.equal(detail.exposures[0].mode, 'automatic')
    const batch = [...harness.domains.get('memory_feedback').values()][0]
    assert.ok(!JSON.stringify(batch).includes('JWT'))
})

test('GUI 反馈幂等追加并可撤回，模型工具无法伪造用户反馈', async () => {
    const harness = await setup()
    const recalled = await harness.call('memory_recall', { query: 'JWT' })
    const args = { action: 'feedback', eventId: 'user-feedback', exposureId: recalled.hits[0].exposureId, signal: 'irrelevant' }
    assert.equal((await harness.call('memory_manage', args)).code, 'forbidden')
    assert.equal((await harness.api.manage(args)).duplicate, false)
    assert.equal((await harness.api.manage(args)).duplicate, true)
    await assert.rejects(harness.api.manage({ ...args, signal: 'helpful' }), /内容不一致/)
    assert.equal((await harness.api.getRecord({ id: 'smm_feedback' })).exposures[0].feedback.signal, 'irrelevant')
    await harness.api.manage({ ...args, eventId: 'undo-feedback', signal: 'retract', retracts: args.eventId })
    assert.equal((await harness.api.getRecord({ id: 'smm_feedback' })).exposures[0].feedback, null)
    assert.equal(harness.table.get('smm_feedback').lifecycle, undefined)
})

test('负反馈有限调整同问题排名，撤回恢复且纠正后的事实不受旧反馈影响', async () => {
    const harness = await setup({ feedbackRankingEnabled: true })
    const original = await harness.call('memory_recall', { query: 'JWT' })
    const args = { action: 'feedback', eventId: 'rank-negative', exposureId: original.hits[0].exposureId, signal: 'incorrect' }
    await harness.api.manage(args)
    const negative = await harness.call('memory_recall', { query: 'JWT' })
    assert.ok(negative.hits[0].score < original.hits[0].score)
    await harness.api.manage({ ...args, eventId: 'rank-undo', signal: 'retract', retracts: args.eventId })
    assert.equal((await harness.call('memory_recall', { query: 'JWT' })).hits[0].score, original.hits[0].score)
    await harness.api.manage({ ...args, eventId: 'rank-old', signal: 'outdated' })
    const corrected = await harness.api.manage({ action: 'correct', id: 'smm_feedback', projectId: 'a', content: 'JWT 使用 refresh_token 续期并轮换密钥' })
    const result = await harness.call('memory_recall', { query: 'JWT' })
    assert.equal(result.hits[0].id, corrected.id)
})

test('呈现与反馈重载后可读，重复事件不再次写入', async () => {
    const first = await setup()
    const recalled = await first.call('memory_recall', { query: 'JWT' })
    const args = { action: 'feedback', eventId: 'persistent', exposureId: recalled.hits[0].exposureId, signal: 'helpful' }
    await first.api.manage(args)
    const second = createHarness({ projectId: 'a', feedbackEnabled: true }, { data: first.data, domains: first.domains })
    assert.equal((await second.api.getRecord({ id: 'smm_feedback' })).exposures[0].feedback.signal, 'helpful')
    assert.equal((await second.api.manage(args)).duplicate, true)
    await assert.rejects(second.api.manage({ ...args, eventId: 'unknown', exposureId: 'missing' }), /实际呈现/)
})

test('反馈写入失败不返回成功且可以原 ID 重试', async () => {
    let fail = true
    const harness = await setup({}, {
        beforeDomainPut: (name, id, value) => {
            if (name === 'memory_feedback' && value.kind === 'feedback' && fail) throw new Error('模拟存储故障')
        },
    })
    const recalled = await harness.call('memory_recall', { query: 'JWT' })
    const args = { action: 'feedback', eventId: 'retry', exposureId: recalled.hits[0].exposureId, signal: 'helpful' }
    await assert.rejects(harness.api.manage(args), /模拟存储故障/)
    fail = false
    assert.equal((await harness.api.manage(args)).duplicate, false)
    assert.equal((await harness.api.status()).feedback.events, 1)
})

test('呈现日志落盘失败仍返回实际召回并报告诊断，不产生幽灵呈现', async () => {
    const harness = await setup({}, {
        beforeDomainPut: (name, id, value) => {
            if (name === 'memory_feedback' && value.kind === 'exposure') throw new Error('模拟呈现日志失败')
        },
    })
    const recalled = await harness.call('memory_recall', { query: 'JWT' })
    assert.equal(recalled.count, 1)
    assert.equal(recalled.hits[0].exposureId, undefined)
    const automatic = await injectMessage(harness, createMessage('JWT 续期'))
    assert.equal(automatic.messages[1].source.recalled[0], 'smm_feedback')
    assert.equal(harness.table.get('smm_feedback').accessCount, 2)
    const status = await harness.api.status()
    assert.equal(status.feedback.exposures, 0)
    assert.equal(status.feedback.failed, 2)
    assert.match(status.feedback.lastError, /呈现记录保存失败/)
})

test('Linux 路径大小写不同的查询不能共享反馈分数', async () => {
    const harness = await setup({ feedbackRankingEnabled: true })
    const before = await harness.call('memory_recall', { query: 'JWT /srv/App' })
    await harness.api.manage({
        action: 'feedback', eventId: 'case-feedback', exposureId: before.hits[0].exposureId, signal: 'irrelevant',
    })
    const after = await harness.call('memory_recall', { query: 'JWT /srv/App' })
    const different = await harness.call('memory_recall', { query: 'JWT /srv/app' })
    assert.ok(after.hits[0].score < before.hits[0].score)
    assert.equal(different.hits[0].score, before.hits[0].score)
})

test('全局记忆在不同项目呈现时反馈范围独立，版本改变也不继承分数', async () => {
    const harness = createHarness({ feedbackEnabled: true, feedbackRankingEnabled: true, spreadDepth: 0 })
    await harness.table.put('smm_global_feedback', fixture('smm_global_feedback', { content: 'JWT 使用 refresh_token 续期' }))
    const first = await harness.call('memory_recall', { query: 'JWT', projectId: 'a' })
    await harness.api.manage({
        action: 'feedback', eventId: 'scope-feedback', exposureId: first.hits[0].exposureId, signal: 'irrelevant',
    })
    const same = await harness.call('memory_recall', { query: 'JWT', projectId: 'a' })
    const other = await harness.call('memory_recall', { query: 'JWT', projectId: 'b' })
    assert.ok(same.hits[0].score < first.hits[0].score)
    assert.equal(other.hits[0].score, first.hits[0].score)
    await harness.table.update('smm_global_feedback', (record) => ({ ...record, source: { kind: 'user', confirmed: true } }))
    assert.equal((await harness.call('memory_recall', { query: 'JWT', projectId: 'a' })).hits[0].score, first.hits[0].score)
})
