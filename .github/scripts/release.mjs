import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'dsh-sleep-memory'
const REGISTRY_URL = 'https://registry.npmjs.org'
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseReleaseTag(tag) {
    if (!RELEASE_TAG_PATTERN.test(tag ?? '')) {
        throw new Error('发布 Tag 必须为 v主版本.次版本.修订版本，例如 v0.4.0')
    }
    return { tag, version: tag.slice(1) }
}

export async function readRegistry(fetchRegistry = fetch) {
    const response = await fetchRegistry(`${REGISTRY_URL}/${PACKAGE_NAME}`, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(30_000),
    })
    // 只有 404 表示未发布，认证失败或网络故障必须阻止后续写入。
    if (response.status === 404) return { versions: {}, 'dist-tags': {} }
    if (!response.ok) throw new Error(`查询 npm Registry 失败：HTTP ${response.status}`)
    const registry = await response.json()
    if (!registry.versions || !registry['dist-tags']) {
        throw new Error('npm Registry 返回了无效的版本元数据')
    }
    return registry
}

export function createReleaseState(tag, manifest, registry, runNumber) {
    const { version } = parseReleaseTag(tag)
    assert.equal(manifest.name, PACKAGE_NAME, '待发布源码的包名不匹配')
    assert.equal(manifest.version, version, 'Tag 与待发布源码的版本不匹配')
    if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error('缺少有效的工作流运行编号')
    const tags = registry['dist-tags']
    // 旧 Tag 补建不能让 dist 和 npm 通道回退到比 latest 更旧的内容。
    const latest = tags.latest?.match(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/)
    if (latest) {
        const requested = version.split('.').map(Number)
        const published = latest.slice(1).map(Number)
        const differing = requested.findIndex((part, index) => part !== published[index])
        if (differing >= 0 && requested[differing] < published[differing]) {
            throw new Error(`拒绝回退发布：当前 latest 为 ${tags.latest}，目标为 ${version}`)
        }
    }
    const devVersion = `${version}-dev.${runNumber}`
    return {
        published: Boolean(registry.versions[version]),
        dev_published: Boolean(registry.versions[devVersion]),
        dev_version: devVersion,
        latest_tagged: tags.latest === version,
        dev_tagged: tags.dev === devVersion,
    }
}

export async function verifyReleaseState(tag, manifest, runNumber, query = readRegistry, wait = delay) {
    const required = ['published', 'dev_published', 'latest_tagged', 'dev_tagged']
    let missing
    // Registry 的查询结果可能稍晚于发布操作可见，只对未同步状态做有限等待。
    for (let attempt = 0; attempt < 6; attempt++) {
        const state = createReleaseState(tag, manifest, await query(), runNumber)
        missing = required.filter((key) => !state[key])
        if (!missing.length) return state
        if (attempt < 5) await wait(5_000)
    }
    throw new Error(`npm 发布结果等待后仍不完整：${missing.join('、')}`)
}

function readPackageTree(root, relative = '') {
    const files = new Map()
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
            for (const [name, content] of readPackageTree(root, path)) files.set(name, content)
        } else if (entry.isFile()) {
            files.set(path, readFileSync(join(root, path)))
        } else {
            throw new Error(`发布制品包含不支持的文件类型：${path}`)
        }
    }
    return files
}

export function comparePackageTrees(source, published) {
    const expected = readPackageTree(source)
    const actual = readPackageTree(published)
    const paths = new Set([...expected.keys(), ...actual.keys()])
    const differences = [...paths].filter((path) => {
        return !expected.has(path) || !actual.has(path) || !expected.get(path).equals(actual.get(path))
    })
    // npm 版本不可覆盖，内容不同必须停止，不能把另一份代码伪装成同一个版本。
    if (differences.length) {
        throw new Error(`源码与已发布制品不一致：${differences.sort().join('、')}`)
    }
    return expected.size
}

function writeOutputs(outputs) {
    const text = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join('')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
    process.stdout.write(text)
}

async function main() {
    const command = process.argv[2]
    if (command === 'target') {
        writeOutputs(parseReleaseTag(process.env.RELEASE_TAG))
        return
    }
    if (command === 'compare') {
        const count = comparePackageTrees(process.argv[3], process.argv[4])
        console.log(`发布内容核对通过：${count} 个文件一致`)
        return
    }
    if (command === 'state' || command === 'verify') {
        const manifest = JSON.parse(readFileSync(resolve(process.env.RELEASE_SOURCE, 'package.json'), 'utf8'))
        if (command === 'verify') {
            const state = await verifyReleaseState(process.env.RELEASE_TAG, manifest, process.env.GITHUB_RUN_NUMBER)
            console.log(`npm 发布核验通过：${manifest.version} 与 ${state.dev_version}`)
        } else {
            const registry = await readRegistry()
            const state = createReleaseState(process.env.RELEASE_TAG, manifest, registry, process.env.GITHUB_RUN_NUMBER)
            writeOutputs(state)
        }
        return
    }
    throw new Error('未知发布命令，可用命令：target、state、compare、verify')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(`发布失败：${error.message}`)
        process.exitCode = 1
    })
}
