import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeRetrievalText, buildRetrievalIndex, retrievalTerms, scoreRetrieval } from '../memory-retrieval.js'
import { createHarness, createMessage, fixture, injectMessage } from './harness.mjs'

const tokensOf = (text) => [...analyzeRetrievalText(text).tokens.values()]

test('字段、设备名、版本与 IP 保留完整边界，不泄漏内部数字', () => {
    const fields = tokensOf('del_flag dm-244 127.0.0.1:7897 Spring Boot 3.2.11')
    for (const value of ['del_flag', 'dm-244', '127.0.0.1', '127.0.0.1:7897', '3.2.11']) {
        assert.ok(fields.some((token) => token.value === value && token.anchor), value)
    }
    assert.deepEqual(fields.filter((token) => token.type === 'number').map((token) => token.value), ['7897'])
    assert.equal(fields.find((token) => token.value === 'flag').anchor, false)
    assert.equal(fields.find((token) => token.value === 'del').anchor, false)
})

test('中文以词和短语为主，不生成跨词的除标碎片', () => {
    const words = tokensOf('删除标识')
    assert.ok(words.some((token) => token.value === '删除' && token.anchor))
    assert.ok(words.some((token) => token.value === '标识' && token.anchor))
    assert.ok(words.some((token) => token.value === '删除标识' && token.anchor))
    assert.ok(!words.some((token) => token.value === '除标'))
    assert.equal(words.find((token) => token.value === '除').anchor, false)
    const [result] = scoreRetrieval(buildRetrievalIndex(['删除标识']), '除标', { automatic: true })
    assert.equal(result.score, 0)
})

test('路径和 URL 保护数字，Windows 斜杠与盘符大小写等价', () => {
    const query = 'C:\\Project\\应用\\config.yml'
    const [result] = scoreRetrieval(buildRetrievalIndex(['配置文件为 c:/project/应用/config.yml。']), query, { automatic: true })
    assert.ok(result.score > 0)
    const tokens = tokensOf('https://example.com:7897/api/v1?status=404')
    assert.ok(tokens.some((token) => token.type === 'url' && token.value.includes('status=404')))
    assert.ok(!tokens.some((token) => token.type === 'number' && token.value === '404'))
    const [quoted] = scoreRetrieval(buildRetrievalIndex(['目录 "C:\\Program Files\\DSH"']), '"c:/program files/dsh"', { automatic: true })
    assert.ok(quoted.score > 0)
})

test('IPv6 与主机端点可以通过完整地址和端口查询', () => {
    const index = buildRetrievalIndex(['代理使用 [::1]:7897。', '备用代理使用 localhost:7897。'])
    assert.ok(scoreRetrieval(index, '[::1]:7897', { automatic: true })[0].score > 0)
    assert.ok(scoreRetrieval(index, 'localhost:7897', { automatic: true })[1].score > 0)
    assert.ok(scoreRetrieval(index, '端口 7897', { automatic: true }).every((result) => result.score > 0))
})

test('英文句末标点不进入实体，明确版本语境区分四段版本与 IP', () => {
    for (const [query, text] of [
        ['127.0.0.1', 'Proxy address is 127.0.0.1.'],
        ['/srv/config.yml', 'Config is /srv/config.yml.'],
        ['v1.2.3.4', '应用版本 1.2.3.4。'],
    ]) {
        const [result] = scoreRetrieval(buildRetrievalIndex([text]), query, { automatic: true })
        assert.ok(result.score > 0, query)
    }
})

test('数字有端口、状态码或字段赋值语境时可以成为完整匹配依据', () => {
    for (const [query, text, expected] of [
        ['端口 443', 'HTTPS 监听端口为 443。', '443'],
        ['443端口', 'HTTPS 监听端口为 443。', '443'],
        ['HTTP 404', 'HTTP 状态码 404 表示资源不存在。', '404'],
        ['HTTP404', 'HTTP 状态码 404 表示资源不存在。', '404'],
        ['404错误', 'HTTP 状态码 404 表示资源不存在。', '404'],
        ['del_flag=0', 'del_flag 为 0 表示记录存在。', 'del_flag=0'],
        ['retry_limit=-1', 'retry_limit 为 -1 表示不重试。', 'retry_limit=-1'],
        ['版本 3.2', 'version: 3.2', '3.2'],
    ]) {
        const [result] = scoreRetrieval(buildRetrievalIndex([text]), query, { automatic: true })
        assert.ok(result.score > 0, query)
        assert.ok(result.evidence.matchedEntities.includes(expected), query)
    }
})

test('数字和语法单字没有被一刀切，显式查询仍可找到原值', async () => {
    const harness = createHarness()
    await harness.table.put('smm_count', fixture('smm_count', { content: '本地并发限制为 42。' }))
    await harness.table.put('smm_color', fixture('smm_color', { content: '主题设置采用深色。' }))
    assert.deepEqual((await harness.call('memory_recall', { query: '42' })).hits.map((hit) => hit.id), ['smm_count'])
    assert.deepEqual((await harness.call('memory_recall', { query: '色' })).hits.map((hit) => hit.id), ['smm_color'])
    for (const text of ['42', '0/1', '0 1 127 7897']) {
        assert.deepEqual(retrievalTerms(text), [])
        assert.equal((await injectMessage(harness, createMessage(text))).messages.length, 1)
    }
})

test('独立中文单字术语可以召回，词内单字碎片不能独立触发', async () => {
    const harness = createHarness()
    await harness.table.put('smm_lock', fixture('smm_lock', { content: '锁 用于保护并发写入。' }))
    await harness.table.put('smm_color', fixture('smm_color', { content: '主题采用深色。' }))
    const result = await injectMessage(harness, createMessage('锁'))
    assert.deepEqual(result.messages[1].source.recalled, ['smm_lock'])
    assert.equal((await injectMessage(harness, createMessage('色'))).messages.length, 1)
})

test('只有标识符弱组件重叠时不自动注入，完整字段优先', async () => {
    const harness = createHarness()
    await harness.table.put('smm_wrong', fixture('smm_wrong', { content: 'status_flag 控制账号状态。' }))
    await harness.table.put('smm_right', fixture('smm_right', { content: 'del_flag 控制逻辑删除。' }))
    const result = await injectMessage(harness, createMessage('del_flag'))
    assert.deepEqual(result.messages[1].source.recalled, ['smm_right'])
    assert.equal(harness.table.get('smm_wrong').accessCount, 0)
    assert.equal((await injectMessage(harness, createMessage('flag'))).messages.length, 1)
})

test('明确的端口、状态码、版本、IP、路径和字段值冲突不能被主题词绕过', () => {
    const pairs = [
        ['服务端口 443', '服务端口 8443'],
        ['HTTP 404 错误', 'HTTP 500 错误'],
        ['Spring Boot 3.2.11', 'Spring Boot 3.2.12'],
        ['代理 127.0.0.1:7897', '代理 127.0.0.2:7897'],
        ['配置 /srv/a/config.yml', '配置 /srv/b/config.yml'],
        ['del_flag=0', 'del_flag=1'],
        ['retry_limit=-1', 'retry_limit=1'],
    ]
    for (const [query, text] of pairs) {
        const [result] = scoreRetrieval(buildRetrievalIndex([text]), query, { automatic: true })
        assert.equal(result.score, 0, query)
        assert.ok(result.conflicts.length > 0, query)
    }
})

test('完整技术实体和更完整主题覆盖优先于大量通用词或少量主题词', () => {
    const index = buildRetrievalIndex([
        'enroll 的逻辑删除字段 del_flag 使用 0 表示存在、1 表示删除。',
        'enroll 项目配置规范检查处理问题。'.repeat(20),
        'flag 配置检查。',
    ])
    const results = scoreRetrieval(index, 'enroll 的逻辑删除字段 del_flag', { automatic: true })
    assert.ok(results[0].score > results[1].score)
    assert.ok(results[0].evidence.coverage > results[1].evidence.coverage)
    assert.equal(results[2].score, 0)
})

test('正文与标签的边界不能合成不存在的数字语境或短语', () => {
    const index = buildRetrievalIndex([['HTTP', '404'], ['端口', '443']])
    assert.deepEqual(index.analyses.map((analysis) => [...analysis.constraints.keys()]), [[], []])
    const [first] = scoreRetrieval(buildRetrievalIndex([['删除', '标识']]), '除标', { automatic: true })
    assert.equal(first.score, 0)
})

test('无有效查询不会意外变成全库浏览，显式按层浏览仍可用', async () => {
    const harness = createHarness()
    await harness.table.put('smm_rule', fixture('smm_rule'))
    for (const query of ['。。。', '的', 'please']) {
        assert.equal((await harness.call('memory_recall', { query })).hits.length, 0)
    }
    assert.equal((await harness.call('memory_recall', { layers: ['surface'] })).hits.length, 1)
})

test('同义扩展不改变原查询的精确版本约束', async () => {
    const harness = createHarness({ semanticRecallEnabled: true }, {
        llm: {
            prepareCall: async () => ({
                config: {},
                stream: async function* () {
                    yield { type: 'text-delta', text: 'Spring Boot 3.2.12' }
                    yield { type: 'finish', reason: { kind: 'stop' } }
                },
            }),
        },
    })
    await harness.table.put('smm_wrong', fixture('smm_wrong', { content: 'Spring Boot 3.2.12 的配置约定。' }))
    assert.equal((await injectMessage(harness, createMessage('Spring Boot 3.2.11 的配置'))).messages.length, 1)
    assert.equal(harness.table.get('smm_wrong').accessCount, 0)
})

test('联想扩散不能绕过精确版本冲突，也不能沿冲突节点继续传播', async () => {
    const harness = createHarness({ spreadDepth: 2, spreadMaxNeighbors: 1 })
    await harness.table.put('smm_right', fixture('smm_right', {
        content: 'Spring Boot 3.2.11 的配置已经验证。',
        edges: [{ target: 'smm_wrong', relation: 'dream-associate', weight: 1 }],
    }))
    await harness.table.put('smm_wrong', fixture('smm_wrong', {
        content: 'Spring Boot 3.2.12 的配置约定。',
        edges: [{ target: 'smm_neighbor', relation: 'dream-associate', weight: 1 }],
    }))
    await harness.table.put('smm_neighbor', fixture('smm_neighbor', { content: '无关的网络代理记录。' }))
    const result = await injectMessage(harness, createMessage('Spring Boot 3.2.11 配置'))
    assert.deepEqual(result.messages[1].source.recalled, ['smm_right'])
    assert.equal(harness.table.get('smm_wrong').accessCount, 0)
})

test('显式召回给出匹配词、实体与覆盖度，方便解释排名', async () => {
    const harness = createHarness()
    await harness.table.put('smm_rule', fixture('smm_rule', { content: 'enroll 删除字段使用 del_flag。' }))
    const result = await harness.call('memory_recall', { query: 'enroll 删除字段 del_flag' })
    assert.ok(result.hits[0].retrieval.matchedTerms.includes('enroll'))
    assert.ok(result.hits[0].retrieval.matchedEntities.includes('del_flag'))
    assert.ok(result.hits[0].retrieval.coverage > 0 && result.hits[0].retrieval.coverage <= 1)
})
