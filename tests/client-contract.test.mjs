import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { createHarness, fixture, flushTasks } from './harness.mjs'

/** 执行真实 client 模块和 Remote 描述符；替身只提供宿主、React 生命周期。 */
async function createClient(host) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const components = new Map()
    const cells = new Map()
    let current
    let cursor = 0
    let pendingEffects = []
    const cleanups = []
    const registrations = []
    const slotRegistrations = []
    const calls = []
    const downloads = []
    const revoked = []
    const react = {
        Fragment: 'fragment',
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState(initial) {
            const state = cells.get(current)
            const index = cursor++
            if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
            return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
        },
        useRef(initial) {
            const [value] = react.useState({ current: initial })
            return value
        },
        useMemo: (factory) => factory(),
        useCallback: (callback) => callback,
        useSyncExternalStore: (_subscribe, read) => read(),
        useEffect: (effect) => pendingEffects.push(effect),
    }
    const remote = {}
    for (const method of ['stats', 'list', 'edges', 'runSleep', 'getConfig', 'setConfig', 'status', 'getRecord', 'manage', 'scope']) {
        remote[method] = async (...args) => {
            calls.push({ method, args })
            try { return { ok: true, value: await host.api[method](...args) } }
            catch (error) { return { ok: false, error: { code: error.code ?? 'error', message: error.message } } }
        }
    }
    const context = {
        locale: { bind: () => (key) => key, subscribe: () => () => {}, register: () => () => {} },
        slots: {
            inject: (_key, callback) => callback(),
            register: (options, component) => {
                if (options.name === 'plugins.bundle.config') {
                    assert.ok([manifest.name, '@errorcode864/dsh-sleep-memory'].includes(options.key), '配置槽应匹配规范包名或已有安装别名')
                }
                slotRegistrations.push(options)
                components.set(options.name, component)
                return () => {}
            },
        },
        effect: (effect) => { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
        get: (key) => key === 'remote' ? { $mount: async (definition) => {
            assert.equal(definition.package, manifest.name, 'Remote 挂载必须使用安装包名')
            for (const descriptor of definition.descriptors) {
                assert.equal(descriptor.id, `${manifest.name}#${descriptor.namespace}/${descriptor.method}`, 'Remote 描述符必须属于安装包')
            }
            registrations.push(definition)
            return () => {}
        } }
            : key === 'remote.sleepMemoryApi' ? remote : undefined,
    }
    const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    runInNewContext(source, {
        window: { __ModuleLoader__: { load: ({ id, factory }) => {
            assert.equal(id, manifest.name, '客户端注册 ID 必须与安装包名一致')
            return factory(() => react).apply(context)
        } } },
        document: {
            getElementById: () => ({}),
            createElement: () => ({ click() { downloads.push({ href: this.href, download: this.download }) } }),
            head: { appendChild: () => {} },
        },
        Blob,
        URL: { createObjectURL: () => 'blob:隔离测试备份', revokeObjectURL: (url) => revoked.push(url) },
        setTimeout, clearTimeout, setInterval, clearInterval, console,
    })
    return {
        components, registrations, slotRegistrations, calls, downloads, revoked,
        async render(component, props = {}, effects = false) {
            current = component
            cursor = 0
            if (!cells.has(component)) cells.set(component, [])
            pendingEffects = []
            const tree = component(props)
            if (effects) for (const effect of pendingEffects) {
                const cleanup = effect()
                if (typeof cleanup === 'function') cleanups.push(cleanup)
            }
            await flushTasks()
            return tree
        },
        dispose() { for (const cleanup of cleanups) cleanup() },
    }
}

function flatten(node) {
    if (!node || typeof node !== 'object') return []
    return [node, ...node.children.flatMap(flatten)]
}

test('配置页公开项目和评分开关，字符串保存经真实服务校验', async () => {
    let override = {}
    const row = { options: { id: 'sleep-memory' } }
    const editor = {
        entries: () => [row],
        configuration: () => [{ entry: row, inherited: {}, override }],
        edit: async (_row, updater) => { override = updater() },
    }
    const host = createHarness({}, { get: (key) => key === 'configEditor' ? editor : undefined })
    const client = await createClient(host)
    try {
        const component = client.components.get('plugins.bundle.config')
        await client.render(component, { view: 'page' }, true)
        let tree = await client.render(component, { view: 'page' })
        const inputs = flatten(tree).filter((node) => node.type === 'input')
        assert.equal(inputs.filter((node) => node.props.type === 'checkbox').length, 3)
        const project = inputs.find((node) => node.props.type === 'text')
        project.props.onChange({ target: { value: '项目甲' } })
        tree = await client.render(component, { view: 'page' })
        const save = flatten(tree).find((node) => node.type === 'button' && node.children.includes('sleep-memory.config.save'))
        assert.equal(save.props.disabled, false)
        save.props.onClick()
        await flushTasks()
        assert.equal(override.projectId, '项目甲')
        assert.ok(client.registrations[0].descriptors.some((descriptor) => descriptor.method === 'status' && descriptor.parameters.length === 0))
        await assert.rejects(host.api.setConfig({ changes: { projectId: ' 甲 ' } }), /projectId/)
    } finally { client.dispose() }
})

test('界面有效性管理必须预演后确认，成功后可按状态筛选', async () => {
    const host = createHarness()
    await host.table.put('smm_state', fixture('smm_state'))
    const client = await createClient(host)
    try {
        const main = client.components.get('main')
        await client.render(main, {}, true)
        const page = await client.render(main)
        const rowNode = flatten(page).find((node) => node.type?.name === 'RecordRow')
        let row = await client.render(rowNode.type, rowNode.props)
        flatten(row).find((node) => node.children.includes('查看原文与来源')).props.onClick()
        await flushTasks()
        row = await client.render(rowNode.type, rowNode.props)
        const editorNode = flatten(row).find((node) => node.type?.name === 'RecordEditor')
        let editor = await client.render(editorNode.type, editorNode.props)
        flatten(editor).find((node) => node.props['aria-label'] === '目标状态').props.onChange({ target: { value: 'invalid' } })
        flatten(editor).find((node) => node.props['aria-label'] === '变更原因').props.onChange({ target: { value: '当前已不适用' } })
        editor = await client.render(editorNode.type, editorNode.props)
        flatten(editor).find((node) => node.children.includes('预览变更')).props.onClick()
        await flushTasks()
        assert.equal(host.table.get('smm_state').lifecycle, undefined)
        editor = await client.render(editorNode.type, editorNode.props)
        flatten(editor).find((node) => node.children.includes('确认变更')).props.onClick()
        await flushTasks()
        assert.equal(host.table.get('smm_state').lifecycle.state, 'invalid')
        flatten(page).find((node) => node.props['aria-label'] === '有效性筛选').props.onChange({ target: { value: 'invalid' } })
        await client.render(main, {}, true)
        assert.ok(client.calls.some((entry) => entry.method === 'list' && entry.args[0].state === 'invalid'))
    } finally { client.dispose() }
})

test('界面事实纠正展示原文和新正文，确认后保留替代关系', async () => {
    const host = createHarness()
    await host.table.put('smm_fact', fixture('smm_fact'))
    const client = await createClient(host)
    try {
        const main = client.components.get('main')
        await client.render(main, {}, true)
        const page = await client.render(main)
        const rowNode = flatten(page).find((node) => node.type?.name === 'RecordRow')
        let row = await client.render(rowNode.type, rowNode.props)
        flatten(row).find((node) => node.children.includes('查看原文与来源')).props.onClick()
        await flushTasks()
        row = await client.render(rowNode.type, rowNode.props)
        const editorNode = flatten(row).find((node) => node.type?.name === 'RecordEditor')
        let editor = await client.render(editorNode.type, editorNode.props)
        flatten(editor).find((node) => node.type === 'select').props.onChange({ target: { value: 'correct' } })
        editor = await client.render(editorNode.type, editorNode.props)
        flatten(editor).find((node) => node.props['aria-label'] === '完整的新事实').props.onChange({ target: { value: '部署端口改为 8700' } })
        editor = await client.render(editorNode.type, editorNode.props)
        flatten(editor).find((node) => node.children.includes('预览变更')).props.onClick()
        await flushTasks()
        assert.equal(host.data.size, 1)
        editor = await client.render(editorNode.type, editorNode.props)
        assert.ok(flatten(editor).some((node) => node.children.includes('新事实：部署端口改为 8700')))
        flatten(editor).find((node) => node.children.includes('确认变更')).props.onClick()
        await flushTasks()
        assert.ok([...host.data.values()].some((record) => record.replaces === 'smm_fact' && record.content === '部署端口改为 8700'))
    } finally { client.dispose() }
})

test('界面备份文件下载、大小限制、导入预演及确认调用真实管理服务', async () => {
    const host = createHarness()
    const source = createHarness()
    await source.table.put('smm_import', fixture('smm_import'))
    const backup = (await source.call('memory_manage', { action: 'export' })).backup
    const client = await createClient(host)
    try {
        const main = client.components.get('main')
        const page = await client.render(main)
        const node = flatten(page).find((item) => item.type?.name === 'BackupPanel')
        let panel = await client.render(node.type, node.props)
        flatten(panel).find((item) => item.children.includes('下载 JSON 备份')).props.onClick()
        await flushTasks()
        assert.equal(client.downloads.length, 1)
        assert.match(client.downloads[0].download, /^sleep-memory-.*\.json$/)
        await flatten(panel).find((item) => item.props.type === 'file').props.onChange({ target: {
            files: [{ name: 'too-large.json', size: 11 * 1024 * 1024 }],
        } })
        panel = await client.render(node.type, node.props)
        assert.equal(flatten(panel).find((item) => item.children.includes('预演导入')).props.disabled, true)
        await flatten(panel).find((item) => item.props.type === 'file').props.onChange({ target: {
            files: [{ name: 'backup.json', size: 1000, text: async () => JSON.stringify(backup) }],
        } })
        panel = await client.render(node.type, node.props)
        flatten(panel).find((item) => item.children.includes('预演导入')).props.onClick()
        await flushTasks()
        assert.equal(host.data.size, 0)
        panel = await client.render(node.type, node.props)
        flatten(panel).find((item) => item.children.includes('确认导入')).props.onClick()
        await flushTasks()
        assert.equal(host.data.size, 1)
        panel = await client.render(node.type, node.props)
        assert.ok(flatten(panel).some((item) => item.children.some((text) => typeof text === 'string' && text.includes('导入完成'))))
    } finally { client.dispose() }
})

test('界面会话绑定按选择的 ID 生效，释放后显示全局回退', async () => {
    const host = createHarness()
    const client = await createClient(host)
    try {
        const main = client.components.get('main')
        const page = await client.render(main)
        const node = flatten(page).find((item) => item.type?.name === 'ScopePanel')
        let panel = await client.render(node.type, {}, true)
        flatten(panel).find((item) => item.props['aria-label'] === '会话 ID').props.onChange({ target: { value: '会话甲' } })
        await client.render(node.type, {}, true)
        panel = await client.render(node.type)
        flatten(panel).find((item) => item.props['aria-label'] === '绑定项目标识').props.onChange({ target: { value: '项目甲' } })
        panel = await client.render(node.type)
        flatten(panel).find((item) => item.children.includes('保存会话绑定')).props.onClick()
        await flushTasks()
        assert.equal((await host.api.scope({ sessionId: '会话甲' })).scope.projectId, '项目甲')
        panel = await client.render(node.type)
        flatten(panel).find((item) => item.children.includes('释放会话绑定')).props.onClick()
        await flushTasks()
        assert.equal((await host.api.scope({ sessionId: '会话甲' })).scope.source, 'global')
    } finally { client.dispose() }
})

test('列表原文按钮调用新 Remote 方法，运行状态面板可读', async () => {
    const host = createHarness()
    await host.table.put('smm_a', fixture('smm_a', { projectId: '甲' }))
    const client = await createClient(host)
    try {
        const main = client.components.get('main')
        await client.render(main, {}, true)
        const tree = await client.render(main)
        const rowNode = flatten(tree).find((node) => node.type?.name === 'RecordRow')
        assert.ok(rowNode)
        let row = await client.render(rowNode.type, rowNode.props)
        flatten(row).find((node) => node.type === 'button' && node.children.includes('查看原文与来源')).props.onClick()
        await flushTasks()
        row = await client.render(rowNode.type, rowNode.props)
        assert.ok(flatten(row).some((node) => node.type === 'p' && node.children.includes(host.table.get('smm_a').content)))
        assert.ok(client.calls.some((call) => call.method === 'getRecord' && call.args[0].id === 'smm_a'))
        const runtime = flatten(tree).find((node) => node.type?.name === 'RuntimeStatus')
        const statusTree = await client.render(runtime.type, runtime.props)
        assert.equal(statusTree.props['aria-label'], '记忆运行状态')
        assert.ok(client.calls.some((call) => call.method === 'status'))
    } finally { client.dispose() }
})

test('运行摘要覆盖加载、定时关闭、整理中、失败和读取失败，详情默认收起零计数', async () => {
    const host = createHarness()
    const client = await createClient(host)
    try {
        const page = await client.render(client.components.get('main'))
        const summary = flatten(page).find((node) => node.type?.name === 'RuntimeSummary')
        const runtime = flatten(page).find((node) => node.type?.name === 'RuntimeStatus')
        const state = await host.api.status()
        const cases = [
            { props: { state: null }, expected: '正在读取运行状态…' },
            { props: { state: { ...state, nextSleepAt: null } }, expected: '定时整理未启用' },
            { props: { state: { ...state, nextSleepAt: Date.now() } }, expected: '下次整理' },
            { props: { state, sleeping: true }, expected: '正在整理记忆' },
            { props: { state: { ...state, lastSleepError: { message: '模型不可用' } } }, expected: '上次整理失败', error: true },
            { props: { state: { ...state, schedule: { ...state.schedule, lastError: '调度中断' } } }, expected: '上次整理失败', error: true },
            { props: { state, error: '服务不可用' }, expected: '状态读取失败', error: true },
        ]
        for (const entry of cases) {
            const tree = await client.render(summary.type, entry.props)
            assert.ok(flatten(tree).some((node) => node.children.some((text) => typeof text === 'string' && text.includes(entry.expected))))
            assert.equal(tree.props.className.includes('is-error'), entry.error ?? false)
            assert.equal(flatten(tree).some((node) => node.type === 'details'), false)
        }
        const tree = await client.render(runtime.type, { state })
        const counts = flatten(tree).find((node) => node.type === 'details')
        assert.equal(counts.props.open, undefined, '诊断计数初始应保持折叠')
        assert.ok(flatten(tree).some((node) => node.children.includes('本次加载暂无运行记录。')))
        assert.ok(flatten(tree).some((node) => node.type === 'dd' && node.children.includes('全局')))
    } finally { client.dispose() }
})

test('管理弹窗由摘要和标题打开，分类切换与关闭保持列表筛选及表单挂载', async () => {
    const client = await createClient(createHarness())
    try {
        const main = client.components.get('main')
        let page = await client.render(main)
        const dialogNode = () => flatten(page).find((node) => node.type?.name === 'MemoryDialog' && node.props.id === 'sm-manager')
        const visiblePanel = () => flatten(page).find((node) => node.props.id?.startsWith('sm-manager-') && !node.props.hidden)
        assert.equal(dialogNode().props.open, false)
        flatten(page).find((node) => node.props['aria-label'] === '项目筛选').props.onChange({ target: { value: '项目甲' } })
        flatten(page).find((node) => node.children.includes('管理')).props.onClick()
        page = await client.render(main)
        assert.equal(dialogNode().props.open, true)
        assert.equal(visiblePanel().props.id, 'sm-manager-status')
        for (const [label, id] of [['会话范围', 'scope'], ['备份恢复', 'backup']]) {
            flatten(page).find((node) => node.type === 'button' && node.children.includes(label)).props.onClick()
            page = await client.render(main)
            assert.equal(visiblePanel().props.id, `sm-manager-${id}`)
            assert.ok(flatten(page).some((node) => node.type?.name === 'ScopePanel'))
            assert.ok(flatten(page).some((node) => node.type?.name === 'BackupPanel'))
        }
        dialogNode().props.onClose()
        page = await client.render(main)
        assert.equal(dialogNode().props.open, false)
        assert.equal(flatten(page).find((node) => node.props['aria-label'] === '项目筛选').props.value, '项目甲')
        flatten(page).find((node) => node.type?.name === 'RuntimeSummary').props.onOpen()
        page = await client.render(main)
        assert.equal(visiblePanel().props.id, 'sm-manager-status')
    } finally { client.dispose() }
})

test('配置入口覆盖规范包名、旧安装别名，以及 bundle 和组件行详情', async () => {
    const client = await createClient(createHarness())
    try {
        const keys = new Set(client.slotRegistrations.map((options) => `${options.name}:${options.key}`))
        for (const name of ['dsh-sleep-memory', '@errorcode864/dsh-sleep-memory']) {
            assert.ok(keys.has(`plugins.bundle.config:${name}`))
            assert.ok(keys.has(`plugins.row.config:${name}#sleep-memory`))
        }
        assert.equal(client.slotRegistrations.filter((options) => options.name === 'main').length, 1)
    } finally { client.dispose() }
})

test('原文入口为行内按钮，详情在独立弹窗展示且关闭后保留列表摘要', async () => {
    const host = createHarness()
    await host.table.put('smm_dialog', fixture('smm_dialog', {
        source: { kind: 'user', confirmed: true, sessionId: '会话甲', messageId: '消息甲' },
    }))
    const client = await createClient(host)
    try {
        const main = client.components.get('main')
        await client.render(main, {}, true)
        const page = await client.render(main)
        const rowNode = flatten(page).find((node) => node.type?.name === 'RecordRow')
        let row = await client.render(rowNode.type, rowNode.props)
        const opener = flatten(row).find((node) => node.type === 'button' && node.children.includes('查看原文与来源'))
        assert.ok(opener.props.className.includes('sm-record-open'))
        assert.ok(row.children.some((node) => node?.props.className === 'sm-rowtop' && flatten(node).includes(opener)))
        opener.props.onClick()
        await flushTasks()
        row = await client.render(rowNode.type, rowNode.props)
        const dialog = flatten(row).find((node) => node.type?.name === 'MemoryDialog')
        assert.equal(dialog.props.open, true)
        assert.equal(dialog.props.title, '原文与来源')
        assert.ok(flatten(dialog).some((node) => node.type === 'dd' && node.children.includes('会话甲')))
        assert.ok(flatten(dialog).some((node) => node.type === 'dd' && node.children.includes('已确认')))
        dialog.props.onClose()
        row = await client.render(rowNode.type, rowNode.props)
        assert.equal(flatten(row).find((node) => node.type?.name === 'MemoryDialog').props.open, false)
        assert.ok(flatten(row).some((node) => node.props.className === 'sm-rowcontent' && node.children.includes(host.table.get('smm_dialog').content)))
    } finally { client.dispose() }
})
