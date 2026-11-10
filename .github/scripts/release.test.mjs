import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { comparePackageTrees, createReleaseState, parseReleaseTag, readRegistry, verifyReleaseState } from './release.mjs'

const MANIFEST = { name: 'dsh-sleep-memory', version: '0.4.0' }

function createRegistry(versions = [], tags = {}) {
    return {
        versions: Object.fromEntries(versions.map((version) => [version, { version }])),
        'dist-tags': tags,
    }
}

test('已有正式版时，缺失的 dev 版仍需要发布', () => {
    const state = createReleaseState('v0.4.0', MANIFEST, createRegistry(['0.4.0'], { latest: '0.4.0' }), 21)
    assert.equal(state.published, true)
    assert.equal(state.dev_published, false)
    assert.equal(state.dev_version, '0.4.0-dev.21')
    assert.equal(state.latest_tagged, true)
    assert.equal(state.dev_tagged, false)
})

test('重复运行同一次发布复用 dev 版本，不受运行尝试次数影响', () => {
    const registry = createRegistry(['0.4.0', '0.4.0-dev.21'], { latest: '0.4.0', dev: '0.4.0-dev.21' })
    const first = createReleaseState('v0.4.0', MANIFEST, registry, 21)
    const second = createReleaseState('v0.4.0', MANIFEST, registry, 21)
    assert.deepEqual(first, second)
    assert.equal(first.dev_published, true)
    assert.equal(first.dev_tagged, true)
})

test('版本存在但通道缺失时分别补齐，首次发版也正常规划', () => {
    const existing = createReleaseState('v0.4.0', MANIFEST, createRegistry(['0.4.0', '0.4.0-dev.21']), 21)
    assert.equal(existing.published, true)
    assert.equal(existing.dev_published, true)
    assert.equal(existing.latest_tagged, false)
    assert.equal(existing.dev_tagged, false)
    const first = createReleaseState('v0.4.0', MANIFEST, createRegistry(), 21)
    assert.equal(first.published, false)
    assert.equal(first.dev_published, false)
})

test('拒绝错误包名、版本、运行编号和可能注入命令的 Tag', () => {
    for (const tag of ['main', 'v0.4.0;echo test', 'v0.4.0\n', 'v00.4.0', 'v0.4.0-rc.1']) {
        assert.throws(() => parseReleaseTag(tag), /发布 Tag/)
    }
    assert.throws(() => createReleaseState('v0.5.0', MANIFEST, createRegistry(), 21), /版本不匹配/)
    assert.throws(() => createReleaseState('v0.4.0', { ...MANIFEST, name: 'other' }, createRegistry(), 21), /包名不匹配/)
    assert.throws(() => createReleaseState('v0.4.0', MANIFEST, createRegistry(), '21;echo test'), /运行编号/)
})

test('补建旧版本不能回退已更新的 latest 和 dist', () => {
    for (const version of ['0.4.1', '0.5.0', '1.0.0', '0.4.1-rc.1']) {
        const registry = createRegistry([version], { latest: version })
        assert.throws(() => createReleaseState('v0.4.0', MANIFEST, registry, 21), /拒绝回退发布/)
    }
    assert.doesNotThrow(() => createReleaseState('v0.4.0', MANIFEST, createRegistry(['0.3.9'], { latest: '0.3.9' }), 21))
})

test('仅 Registry 的 404 表示尚未发布，认证或服务错误直接失败', async () => {
    assert.deepEqual(await readRegistry(async () => new Response('', { status: 404 })), createRegistry())
    for (const status of [401, 403, 429, 500, 503]) {
        await assert.rejects(readRegistry(async () => new Response('', { status })), new RegExp(`HTTP ${status}`))
    }
    await assert.rejects(readRegistry(async () => { throw new Error('网络不可用') }), /网络不可用/)
    await assert.rejects(readRegistry(async () => Response.json({})), /无效的版本元数据/)
    const registry = createRegistry(['0.4.0'], { latest: '0.4.0' })
    assert.deepEqual(await readRegistry(async () => Response.json(registry)), registry)
})

test('制品核对拒绝内容差异与额外文件，保留隔离测试目录', () => {
    const root = resolve('tmp')
    mkdirSync(root, { recursive: true })
    const fixture = mkdtempSync(join(root, 'release-verification-'))
    const source = join(fixture, 'source')
    const published = join(fixture, 'published')
    for (const directory of [source, published]) {
        mkdirSync(join(directory, 'locale'), { recursive: true })
        writeFileSync(join(directory, 'package.json'), JSON.stringify(MANIFEST))
        writeFileSync(join(directory, 'locale/zh.json'), '{"name":"记忆"}\n')
    }
    assert.equal(comparePackageTrees(source, published), 2)
    writeFileSync(join(published, 'locale/zh.json'), '{"name":"另一份内容"}\n')
    assert.throws(() => comparePackageTrees(source, published), /locale\/zh.json/)
    writeFileSync(join(published, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
    assert.throws(() => comparePackageTrees(source, published), /\.npmrc/)
})

test('发布核验容许 Registry 短暂延迟，但最终必须补齐两个版本和通道', async () => {
    const delayed = createRegistry(['0.4.0'], { latest: '0.4.0' })
    const complete = createRegistry(['0.4.0', '0.4.0-dev.21'], { latest: '0.4.0', dev: '0.4.0-dev.21' })
    let queries = 0
    const waits = []
    const state = await verifyReleaseState(
        'v0.4.0', MANIFEST, 21,
        async () => ++queries < 3 ? delayed : complete,
        async (milliseconds) => { waits.push(milliseconds) },
    )
    assert.equal(state.dev_published, true)
    assert.equal(queries, 3)
    assert.deepEqual(waits, [5_000, 5_000])
})

test('持续缺失不能误报成功，Registry 异常不能被等待逻辑吞掉', async () => {
    let queries = 0
    await assert.rejects(verifyReleaseState(
        'v0.4.0', MANIFEST, 21,
        async () => { queries++; return createRegistry() },
        async () => {},
    ), /等待后仍不完整/)
    assert.equal(queries, 6)
    await assert.rejects(verifyReleaseState(
        'v0.4.0', MANIFEST, 21,
        async () => { throw new Error('HTTP 403') },
        async () => { assert.fail('认证失败不应重试') },
    ), /HTTP 403/)
})
