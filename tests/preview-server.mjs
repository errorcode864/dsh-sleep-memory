import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHarness, fixture } from './harness.mjs'

// 仅供本地浏览器验收：真实插件客户端与宿主随附 React，数据来自隔离内存替身。
const assetsRoot = process.env.DSH_PREVIEW_ASSETS
if (!assetsRoot) throw new Error('需要 DSH_PREVIEW_ASSETS 指向已安装宿主的前端 assets 目录')
const hostSource = await readFile(resolve(assetsRoot, 'index-CnyQSzND.js'), 'utf8')
const bootMarker = 'const Ys=globalThis.dshDesktopBoot'
if (!hostSource.includes(bootMarker) || !hostSource.includes('function dV()')) {
    throw new Error('宿主前端版本不匹配，不能构建隔离预览')
}
const hostModules = `${hostSource.slice(0, hostSource.indexOf(bootMarker))}\nglobalThis.previewModules=dV();`
let override = {}
const row = { options: { id: 'sleep-memory' } }
const harness = createHarness({}, { get: (key) => key === 'configEditor' ? {
    entries: () => [row],
    configuration: () => [{ entry: row, inherited: {}, override }],
    edit: async (_row, updater) => { override = updater() },
} : key === 'workspaceRegistry' ? {
    list: () => [{ id: 'preview', title: '隔离验收项目', sessionIds: ['preview-session'] }],
} : undefined })
await harness.table.put('smm_preview_fact', fixture('smm_preview_fact', {
    content: '隔离验收项目使用 DM8。部署端口为 8600，数据库迁移使用 Liquibase。',
    projectId: 'workspace:preview', tags: ['部署', '数据库'], source: { kind: 'user', confirmed: true },
}))
await harness.table.put('smm_preview_emotion', fixture('smm_preview_emotion', {
    kind: 'experience', layer: 'salient', valence: -0.8, arousal: 0.9,
    content: '上次发布前遗漏备份导致回滚困难，应在同类发布前核对备份与恢复步骤。',
    tags: ['发布经验'], source: { kind: 'model', confirmed: false },
}))
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆银行隔离验收</title><style>
:root{--dsw-alias-bg-base:#f8f9fb;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#edf0f5;
--dsw-alias-label-primary:#20242e;--dsw-alias-label-secondary:#657083;--dsw-alias-border-l1:#dce1eb;
--dsw-alias-border-l2:#bbc5d5;--dsw-alias-brand-primary:#5865bf;--dsw-alias-state-error-primary:#bc4e4e;
--dsw-alias-state-success-primary:#328261;--dsw-radius-xs:3px;--dsw-radius-sm:6px;--dsw-radius-md:8px;--dsw-radius-lg:10px;
color:#20242e;background:#f8f9fb;font-family:system-ui,sans-serif}
body{margin:0}header{padding:12px 24px;background:#e9edf8}#config{max-width:1000px;margin:20px auto;padding:20px;border:1px solid #ccd2e2}
</style><header>隔离验收 · 内存测试数据 · 不连接个人 profile</header><div id="root"></div><section id="config"></section>
<script type="module">
import '/host.js';
const React=previewModules.react, roots=[], slots=new Map(), dictionaries={};
const context={
locale:{bind:()=> (key,values={})=>{let text=dictionaries[key]??key;for(const [name,value] of Object.entries(values))text=text.replaceAll('{'+name+'}',value);return text},
register:(_name,locales)=>{Object.assign(dictionaries,locales.zh);return ()=>{}},subscribe:()=>()=>{}},
slots:{inject:(_name,callback)=>callback(),register:(options,component)=>{slots.set(options.name,component);return ()=>{}}},
effect:(effect)=>effect(),
get:(key)=>key==='remote'?{$mount:async()=>()=>{}}:key==='remote.sleepMemoryApi'?new Proxy({}, {get:(_target,method)=>async(...args)=>{
const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})});return response.json();}}):undefined};
window.__ModuleLoader__={load:({factory})=>factory((name)=>previewModules[name]).apply(context)};
await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/client.js';script.onload=resolve;script.onerror=reject;document.head.append(script)});
previewModules['react-dom/client'].createRoot(document.getElementById('root')).render(React.createElement(slots.get('main')));
previewModules['react-dom/client'].createRoot(document.getElementById('config')).render(React.createElement(slots.get('plugins.bundle.config'),{view:'page'}));
</script></html>`
const methods = new Set(['stats', 'list', 'edges', 'runSleep', 'getConfig', 'setConfig', 'status', 'getRecord', 'manage', 'scope'])
const server = createServer(async (request, response) => {
    try {
        if (request.method === 'POST' && request.url === '/api') {
            if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
                response.writeHead(403).end('仅接受同源预览请求')
                return
            }
            let body = ''
            for await (const chunk of request) {
                body += chunk
                if (body.length > 11 * 1024 * 1024) throw new Error('请求过大')
            }
            const { method, args } = JSON.parse(body)
            if (!methods.has(method) || !Array.isArray(args)) throw new Error('预览调用不合法')
            response.setHeader('Content-Type', 'application/json;charset=utf-8')
            try { response.end(JSON.stringify({ ok: true, value: await harness.api[method](...args) })) }
            catch (error) { response.end(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })) }
            return
        }
        if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html;charset=utf-8')
            response.end(html)
        } else if (request.url === '/host.js') {
            response.setHeader('Content-Type', 'text/javascript')
            response.end(hostModules)
        } else if (request.url === '/client.js') {
            response.setHeader('Content-Type', 'text/javascript')
            response.end(await readFile(new URL('../client.js', import.meta.url)))
        } else if (/^\/vendor-[\w-]+\.(js|css)$/.test(request.url)) {
            response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript')
            response.end(await readFile(resolve(assetsRoot, request.url.slice(1))))
        } else response.writeHead(404).end('预览资源不存在')
    } catch (error) { response.writeHead(500).end(`隔离预览失败：${error.message}`) }
})
server.listen(0, '127.0.0.1', () => console.log(`隔离预览：http://127.0.0.1:${server.address().port}`))
