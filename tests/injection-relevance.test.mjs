import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

test('数据库监测请求不会唤起仅有中文单字或通用词重叠的全局记忆', async () => {
    const harness = createHarness()
    const records = [
        fixture('smm_benchmark', {
            content: '记忆插件做了首次隔离评测，失分集中在写入阶段，下游表现需要改进，评测基建保留完整报告。',
        }),
        fixture('smm_dream', {
            content: '做梦阶段会在语义相似的记忆之间生成双向联想边，边权重反映相似度，之后召回时可以沿这些边把关联记忆扩散出来。',
        }),
        fixture('smm_network', {
            content: '用户本机的 GitHub 网络连接曾被阻断，可改用 SSH 通道，之前已经验证了安装方式。',
        }),
    ]
    for (const record of records) await harness.table.put(record.id, record)
    const result = await injectMessage(harness, createMessage('表建过了,你可以连dbx的mcp去dm-244看监测下'))
    assert.equal(result.messages.length, 1, '无关全局记录不应自动注入')
    for (const record of records) {
        assert.equal(harness.table.get(record.id).accessCount, 0, '被过滤的记忆不应强化')
    }
})

test('没有有效检索词时跳过自动注入，低分门槛也不会退化为浏览全库', async () => {
    const harness = createHarness({ injectMinScore: 0 })
    await harness.table.put('smm_generic', fixture('smm_generic', { content: '用户可以使用深色主题，继续沿用已有方案。' }))
    for (const text of ['可以', '继续', '的', '。。。', 'can you please', 'continue']) {
        const result = await injectMessage(harness, createMessage(text, `message-${text}`))
        assert.equal(result.messages.length, 1, `无有效检索词的消息不应注入：${text}`)
    }
    assert.equal(harness.table.get('smm_generic').accessCount, 0)
})

test('相关项目与全局记忆继续注入，其他项目和通用词命中不会挤占预算', async () => {
    const harness = createHarness({ injectBudget: 2 })
    await harness.table.put('smm_db', fixture('smm_db', {
        projectId: '考试平台', content: 'dm-244 数据库监测先核对表结构，再检查迁移记录。',
    }))
    await harness.table.put('smm_global', fixture('smm_global', {
        content: '数据库监测使用只读连接。',
    }))
    await harness.table.put('smm_noise', fixture('smm_noise', {
        content: '你可以使用主题设置，用户之前已经确认。',
    }))
    await harness.table.put('smm_other', fixture('smm_other', {
        projectId: '其他项目', content: 'dm-244 数据库监测专用规则。',
    }))
    const message = createMessage('你可以检查 dm-244 的数据库监测规则')
    const result = await injectMessage(harness, message)
    assert.deepEqual(result.messages[1].source.recalled, ['smm_global'], '未绑定项目时只注入相关全局记忆')
    const scoped = await harness.call('memory_manage', {
        action: 'bind', sessionId: '考试会话', projectId: '考试平台',
    })
    assert.equal(scoped.scope.projectId, '考试平台')
    const injected = await injectMessage(harness, message, { agent: { id: '考试会话' } })
    assert.deepEqual(new Set(injected.messages[1].source.recalled), new Set(['smm_db', 'smm_global']))
    assert.equal(harness.table.get('smm_other').accessCount, 0)
    assert.equal(harness.table.get('smm_noise').accessCount, 0)
})

test('显式召回仍支持单字查询与按层浏览，自动注入采用更严格的条件', async () => {
    const harness = createHarness({ injectMinScore: 0 })
    await harness.table.put('smm_theme', fixture('smm_theme', { content: '主题设置采用深色。' }))
    assert.equal((await injectMessage(harness, createMessage('色'))).messages.length, 1)
    const recalled = await harness.call('memory_recall', { query: '色' })
    assert.deepEqual(recalled.hits.map((hit) => hit.id), ['smm_theme'])
    const browsed = await harness.call('memory_recall', { layers: ['surface'] })
    assert.deepEqual(browsed.hits.map((hit) => hit.id), ['smm_theme'])
})
