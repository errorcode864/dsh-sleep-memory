import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupChecksum } from '../memory-contract.js'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const config = { feedbackEnabled: true, outcomeRecallEnabled: true, projectId: '甲', spreadDepth: 0, recallPlanMode: 'local' }
const query = '现在准备数据搬家'
const action = '先备份再检查恢复结果'

async function seed(host) {
    await host.table.put('smm_practice', fixture('smm_practice', { projectId: '甲', content: '部署前先验证备份能够恢复。' }))
    await host.table.put('smm_success', fixture('smm_success', { projectId: '甲', content: '采用备份校验流程后恢复演练成功。' }))
    await host.table.put('smm_failure', fixture('smm_failure', { projectId: '甲', content: '采用同样流程后恢复演练失败。' }))
    return (await host.call('memory_recall', { query: '部署前先验证备份能够恢复', limit: 1 })).hits[0].exposureId
}

async function confirm(host, exposureId, signal, id, eventId, overrides = {}) {
    const proof = await host.api.getRecord({ id })
    const args = {
        action: 'feedback', eventId, exposureId, signal,
        outcome: {
            trigger: { when: '迁移前检查恢复能力', cues: ['数据搬家'] }, action,
            result: signal === 'success' ? '恢复演练成功' : '恢复演练失败',
            evidence: { memoryId: id, quote: proof.record.content, version: proof.outcomeEvidenceVersion }, ...overrides,
        },
    }
    await host.api.manage(args)
    return args
}

const recall = (host, overrides = {}) => host.call('memory_recall', { query, ...overrides })

test('结果召回默认关闭且需要反馈记录，情绪和普通赞同不充当结果', async () => {
    assert.throws(() => createHarness({ outcomeRecallEnabled: true }), /feedbackEnabled/)
    const host = createHarness({ ...config, outcomeRecallEnabled: false })
    const exposure = await seed(host)
    await host.api.manage({ action: 'feedback', eventId: '有用', exposureId: exposure, signal: 'helpful' })
    assert.equal((await recall(host)).count, 0)
    await confirm(host, exposure, 'success', 'smm_success', '明确成功')
    assert.equal((await recall(host)).count, 0)
    assert.equal((await host.api.status()).outcomeRecallEnabled, false)
    await host.dispose()
})

test('同类情境召回成功经验并给出证据，无关任务和项目不受影响', async () => {
    const host = createHarness(config)
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功一')
    const result = await recall(host)
    assert.equal(result.hits[0].id, 'smm_practice')
    assert.equal(result.hits[0].retrieval.outcome.direction, 'encouragement')
    assert.equal(result.hits[0].retrieval.outcome.evidence[0].memoryId, 'smm_success')
    assert.equal(result.hits[0].retrieval.outcome.multiplier, 1.15)
    assert.equal((await host.call('memory_recall', { query: '画一只蓝色小猫' })).count, 0)
    assert.equal((await recall(host, { projectId: '乙', includeGlobal: false })).count, 0)
    const injected = await injectMessage(host, createMessage(query))
    assert.ok(injected.messages[1].content[0].text.includes('用户确认·激励'))
    assert.ok(injected.messages[1].content[0].text.includes('smm_success'))
    assert.equal(host.table.get('smm_practice').valence, null)
    await host.dispose()
})

test('正反证据共同决定提示且同一份证据重复确认不累加', async () => {
    const host = createHarness(config)
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功一')
    const again = await recall(host)
    await confirm(host, again.hits[0].exposureId, 'success', 'smm_success', '重复成功')
    assert.equal((await recall(host)).hits[0].retrieval.outcome.success, 1)
    await confirm(host, exposure, 'failure', 'smm_failure', '失败一')
    const mixed = (await recall(host)).hits[0].retrieval.outcome
    assert.equal(mixed.direction, 'mixed')
    assert.equal(mixed.multiplier, 1)
    assert.equal(mixed.evidence.length, 2)
    await host.table.put('smm_failure_two', fixture('smm_failure_two', { projectId: '甲', content: '第二次独立的恢复演练也失败。' }))
    await confirm(host, exposure, 'failure', 'smm_failure_two', '失败二')
    const warning = (await recall(host)).hits[0].retrieval.outcome
    assert.equal(warning.direction, 'warning')
    assert.equal(warning.failure, 2)
    assert.ok(warning.multiplier > 1 && warning.multiplier < 1.15)
    await host.api.manage({ action: 'feedback', eventId: '撤回二', exposureId: exposure, signal: 'retract', retracts: '失败二' })
    await host.api.manage({ action: 'feedback', eventId: '撤回一', exposureId: exposure, signal: 'retract', retracts: '失败一' })
    assert.equal((await recall(host)).hits[0].retrieval.outcome.direction, 'encouragement')
    await host.table.update('smm_success', (record) => ({
        ...record, content: `${'操作日志已确认。'.repeat(30)}依赖 Spring Boot 3.2.11 的恢复演练成功。`,
    }))
    await confirm(host, exposure, 'success', 'smm_success', '长证据', { action })
    assert.equal((await recall(host, { query: 'Spring Boot 3.2.12 数据搬家' })).count, 0)
    await host.dispose()
})

test('结果必须由 GUI 确认且目标、来源版本、项目和引文均校验', async () => {
    const host = createHarness(config)
    const exposure = await seed(host)
    const args = await confirm(host, exposure, 'success', 'smm_success', '真实确认')
    assert.equal((await host.call('memory_manage', { ...args, eventId: '模型伪造' })).code, 'forbidden')
    assert.equal((await host.api.manage(args)).duplicate, true)
    await assert.rejects(host.api.manage({ ...args, outcome: { ...args.outcome, action: '改变做法' } }), /内容不一致/)
    for (const outcome of [
        { ...args.outcome, evidence: { ...args.outcome.evidence, quote: '不在原文的证明' } },
        { ...args.outcome, evidence: { ...args.outcome.evidence, version: 'a'.repeat(64) } },
        { ...args.outcome, trigger: { when: '任何任务', cues: ['a'] } },
    ]) await assert.rejects(host.api.manage({ ...args, eventId: '无效', outcome }))
    await host.table.update('smm_success', (record) => ({ ...record, projectId: '乙' }))
    await assert.rejects(host.api.manage({ ...args, eventId: '跨范围' }), /同项目/)
    await host.table.update('smm_practice', (record) => ({ ...record, content: '做法已修改' }))
    await assert.rejects(host.api.manage({ ...args, eventId: '过时呈现' }), /版本已变化/)
    await host.dispose()
})

test('来源纠正和失效停止结果影响，恢复有效性需要重新确认新版本', async () => {
    for (const change of ['correct', 'invalidate', 'target']) {
        const host = createHarness(config)
        const exposure = await seed(host)
        await confirm(host, exposure, 'success', 'smm_success', '成功')
        if (change === 'correct') await host.api.manage({ action: 'correct', id: 'smm_success', projectId: '甲', content: '之前记录有误' })
        if (change === 'target') await host.api.manage({ action: 'correct', id: 'smm_practice', projectId: '甲', content: '部署前采用新的验证步骤' })
        if (change === 'invalidate') {
            const args = { action: 'setState', id: 'smm_success', projectId: '甲', state: 'invalid', reason: '结果不可靠' }
            const plan = await host.api.manage(args)
            await host.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
        }
        assert.equal((await recall(host)).count, 0, change)
        const detail = await host.api.getRecord({ id: 'smm_practice' })
        assert.equal(detail.exposures.find((item) => item.id === exposure).outcomes[0].applicable, false)
        if (change === 'invalidate') {
            const args = { action: 'setState', id: 'smm_success', projectId: '甲', state: 'active', reason: '已重新核验' }
            const plan = await host.api.manage(args)
            await host.api.manage({ ...args, dryRun: false, planToken: plan.planToken })
            assert.equal((await recall(host)).count, 0)
            await confirm(host, exposure, 'success', 'smm_success', '重新确认')
            assert.equal((await recall(host)).hits[0].retrieval.outcome.direction, 'encouragement')
        }
        await host.dispose()
    }
})

test('结果情境不绕过精确实体、时间和层过滤且普通反馈独立保留', async () => {
    const host = createHarness({ ...config, feedbackRankingEnabled: true })
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功', { action: '使用 Spring Boot 3.2.11 检查恢复' })
    assert.equal((await recall(host, { query: 'Spring Boot 3.2.12 数据搬家' })).count, 0)
    assert.equal((await recall(host, { until: 1 })).count, 0)
    assert.equal((await recall(host, { layers: ['salient'] })).count, 0)
    await host.api.manage({ action: 'feedback', eventId: '有用', exposureId: exposure, signal: 'helpful' })
    const detail = await host.api.getRecord({ id: 'smm_practice' })
    assert.equal(detail.exposures.find((item) => item.id === exposure).feedback.signal, 'helpful')
    assert.equal((await recall(host)).hits[0].retrieval.outcome.direction, 'encouragement')
    await host.dispose()
})

test('审核可见结果证据且审核期间撤回会丢弃旧候选', async () => {
    const ready = Promise.withResolvers()
    const wait = Promise.withResolvers()
    let input
    const host = createHarness({ ...config, recallReviewEnabled: true, recallReviewCacheSeconds: 60 }, { llm: {
        prepareCall: async () => ({ config: {}, stream: async function* (request) {
            input = JSON.parse(request.messages[1].content[0].text)
            ready.resolve()
            await wait.promise
            yield { type: 'text-delta', text: '{"decisions":[{"id":"smm_practice","useful":true,"reason":"适用"}]}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
        } }),
    } })
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功')
    const before = host.table.get('smm_practice').accessCount
    const injection = injectMessage(host, createMessage(query), { agent: { id: '审核会话' } })
    await ready.promise
    assert.equal(input.candidates[0].outcomeContext.direction, 'encouragement')
    await host.api.manage({ action: 'feedback', eventId: '撤回', exposureId: exposure, signal: 'retract', retracts: '成功' })
    wait.resolve()
    assert.equal((await injection).messages.length, 1)
    assert.equal(host.table.get('smm_practice').accessCount, before)
    assert.equal((await host.api.status()).metrics.recentRecalls.at(-1).diagnostics.reasons['outcome-changed'], 1)
    await host.dispose()
})

test('结果提示计入注入预算且休眠唤醒不消除确认', async () => {
    const host = createHarness({ ...config, sleepAuditEnabled: true, dormancyEnabled: true, injectMaxEstimatedTokens: 100 })
    const exposure = await seed(host)
    await confirm(host, exposure, 'failure', 'smm_failure', '失败')
    await host.table.update('smm_practice', (record) => ({ ...record, layer: 'archive',
        access: { state: 'dormant', at: Date.now(), reason: '等待情境' } }))
    assert.equal((await injectMessage(host, createMessage(query))).messages.length, 1)
    assert.equal(host.table.get('smm_practice').access.state, 'dormant')
    const result = await recall(host)
    assert.equal(result.hits[0].wake.via, 'context')
    assert.equal(result.hits[0].retrieval.outcome.direction, 'warning')
    assert.equal((await recall(host)).hits[0].retrieval.outcome.direction, 'warning')
    await host.dispose()
})

test('结果写入失败可用同 ID 重试且重载后保留结果与撤回', async () => {
    let fail = true
    const host = createHarness(config, { beforeDomainPut: (domain, _id, value) => {
        if (domain === 'memory_feedback' && value.outcome && fail) throw new Error('模拟结果写入失败')
    } })
    const exposure = await seed(host)
    await assert.rejects(confirm(host, exposure, 'success', 'smm_success', '失败重试'), /模拟结果写入失败/)
    assert.equal((await recall(host)).count, 0)
    fail = false
    const args = await confirm(host, exposure, 'success', 'smm_success', '失败重试')
    await host.dispose()
    const reload = createHarness(config, { data: host.data, domains: host.domains })
    assert.equal((await reload.api.manage(args)).duplicate, true)
    assert.equal((await recall(reload)).hits[0].retrieval.outcome.direction, 'encouragement')
    await reload.api.manage({ action: 'feedback', eventId: '撤回', exposureId: exposure, signal: 'retract', retracts: args.eventId })
    assert.equal((await recall(reload)).count, 0)
    await reload.dispose()
})

test('v3 备份恢复结果和撤回，预演只读且拒绝篡改或缺失引用', async () => {
    const host = createHarness(config)
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功')
    await confirm(host, exposure, 'failure', 'smm_failure', '失败')
    await host.api.manage({ action: 'feedback', eventId: '撤回', exposureId: exposure, signal: 'retract', retracts: '失败' })
    const { backup } = await host.api.manage({ action: 'export', includeAudit: true, includeFeedback: true })
    assert.equal(backup.version, 3)
    assert.ok(backup.feedback.some((item) => item.signal === 'retract'))
    const restored = createHarness(config)
    assert.equal((await restored.call('memory_manage', { action: 'import', backup })).code, 'forbidden')
    const plan = await restored.api.manage({ action: 'import', backup })
    assert.ok(plan.plannedFeedback >= 4)
    assert.equal(restored.data.size, 0)
    await assert.rejects(restored.api.manage({ action: 'import', backup, dryRun: false }), /planToken/)
    const imported = await restored.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken })
    assert.equal(imported.importedFeedback, plan.plannedFeedback)
    assert.equal((await restored.api.manage({ action: 'import', backup })).plannedFeedback, 0)
    assert.equal((await recall(restored)).hits[0].retrieval.outcome.direction, 'encouragement')
    for (const mutation of ['missing-proof', 'missing-exposure', 'bad-quote', 'sequence', 'retract']) {
        const bad = structuredClone(backup)
        if (mutation === 'missing-proof') bad.records = bad.records.filter((record) => record.id !== 'smm_success')
        if (mutation === 'missing-exposure') bad.feedback = bad.feedback.filter((record) => record.kind !== 'exposure')
        if (mutation === 'bad-quote') bad.feedback.find((item) => item.outcome).outcome.evidence.quote = '伪造原文'
        if (mutation === 'sequence') bad.feedback.find((item) => item.signal === 'failure').sequence = 1
        if (mutation === 'retract') bad.feedback.find((item) => item.signal === 'retract').retracts = '不存在'
        bad.checksum = backupChecksum({ records: bad.records, audits: bad.audits, feedback: bad.feedback })
        const empty = createHarness(config)
        await assert.rejects(empty.api.manage({ action: 'import', backup: bad }), { code: 'sleep-memory/invalid_args' }, mutation)
        assert.equal(empty.data.size, 0)
        await empty.dispose()
    }
    await restored.dispose()
    await host.dispose()
})

test('三域导入中断后重载先恢复反馈再允许召回', async () => {
    const host = createHarness(config)
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功')
    const { backup } = await host.api.manage({ action: 'export', includeAudit: true, includeFeedback: true })
    const partial = createHarness(config, { beforeDomainPut: (domain, _id, value) => {
        if (domain === 'memory_feedback' && value.outcome) throw new Error('模拟反馈恢复中断')
    } })
    const plan = await partial.api.manage({ action: 'import', backup })
    await assert.rejects(partial.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken }), /模拟反馈恢复中断/)
    await partial.dispose()
    const resumed = createHarness(config, { data: partial.data, domains: partial.domains })
    await resumed.api.manage({ action: 'sleepRecover' })
    assert.equal((await recall(resumed)).hits[0].retrieval.outcome.direction, 'encouragement')
    assert.equal(resumed.domains.get('memory_backup_state').get('restore').state, 'complete')
    await resumed.dispose()
    await host.dispose()
})

test('全局经验的结果严格限定呈现项目且反向结果使审核缓存重新审核', async () => {
    let calls = 0
    const host = createHarness({ ...config, recallReviewEnabled: true, recallReviewCacheSeconds: 60, injectRepeatAfterTurns: 0 }, { llm: {
        prepareCall: async () => ({ config: {}, stream: async function* () {
            calls += 1
            yield { type: 'text-delta', text: '{"decisions":[{"id":"smm_practice","useful":true,"reason":"情境相关"}]}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
        } }),
    } })
    await seed(host)
    for (const id of ['smm_practice', 'smm_success', 'smm_failure']) await host.table.update(id, (record) => ({ ...record, projectId: null }))
    const exposure = (await host.call('memory_recall', { query: '部署前先验证备份能够恢复', limit: 1 })).hits[0].exposureId
    await confirm(host, exposure, 'success', 'smm_success', '全局在甲成功')
    assert.equal((await recall(host, { projectId: '乙' })).count, 0)
    const context = { agent: { id: '结果缓存会话' } }
    for (const id of ['一', '二']) assert.equal((await injectMessage(host, createMessage(query, id), context)).messages.length, 2)
    assert.equal(calls, 1)
    await confirm(host, exposure, 'failure', 'smm_failure', '全局在甲失败')
    const changed = await injectMessage(host, createMessage(query, '三'), context)
    assert.ok(changed.messages[1].content[0].text.includes('正反并存需复核'))
    assert.equal(calls, 2)
    await host.dispose()
})

test('结果历史的目标和证据不进入物理遗忘且保留旧版备份契约', async () => {
    const host = createHarness({ ...config, deleteArchiveAfterDays: 7 })
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功')
    await host.table.update('smm_success', (record) => ({
        ...record, layer: 'archive', strength: 0, lastAccessAt: 1, lastDecayAt: 1,
    }))
    assert.equal((await host.call('memory_sleep', {})).deletedCount, 0)
    for (const id of ['smm_practice', 'smm_success']) {
        assert.equal((await host.call('memory_manage', { action: 'forget', id })).code, 'conflict')
    }
    assert.equal((await host.api.manage({ action: 'export' })).backup.version, 1)
    assert.equal((await host.api.manage({ action: 'export', includeAudit: true })).backup.version, 2)
    await host.dispose()
})

test('反馈备份可在关闭反馈时恢复且重新开启后采用持久结果', async () => {
    const host = createHarness(config)
    const exposure = await seed(host)
    await confirm(host, exposure, 'success', 'smm_success', '成功')
    const { backup } = await host.api.manage({ action: 'export', includeAudit: true, includeFeedback: true })
    const disabled = createHarness({ projectId: '甲' })
    const plan = await disabled.api.manage({ action: 'import', backup })
    await disabled.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken })
    assert.equal((await disabled.api.getRecord({ id: 'smm_practice' })).feedbackEnabled, undefined)
    await disabled.dispose()
    const enabled = createHarness(config, { data: disabled.data, domains: disabled.domains })
    assert.equal((await recall(enabled)).hits[0].retrieval.outcome.direction, 'encouragement')
    await enabled.dispose()
    await host.dispose()
})
