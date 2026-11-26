import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createProjectTrial, summarizeProjectTrial, validateProjectTrial } from './project-trial.mjs'

async function run() {
    const { values } = parseArgs({ options: {
        init: { type: 'boolean', default: false }, project: { type: 'string' },
        file: { type: 'string', default: 'tmp/project-trial.json' }, report: { type: 'string' },
    } })
    if (values.init && values.report) throw new Error('初始化与报告导出不能同时执行')
    if (!values.init && values.project) throw new Error('汇总项目以台账内容为准，不能通过参数覆盖')
    const file = resolve(values.file)
    if (values.init) {
        const trial = createProjectTrial(values.project)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, `${JSON.stringify(trial, null, 2)}\n`, { flag: 'wx' })
        console.log(`已初始化 30 个待采样位置：${file}；真实标注 0/30。`)
        return
    }
    const summary = summarizeProjectTrial(validateProjectTrial(JSON.parse(await readFile(file, 'utf8'))))
    if (values.report) {
        const report = resolve(values.report)
        await mkdir(dirname(report), { recursive: true })
        await writeFile(report, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
    }
    console.log(JSON.stringify(summary, null, 2))
}

run().catch((error) => {
    const message = error.code === 'EEXIST' ? '文件已存在，请指定新的输出路径'
        : error.code === 'ENOENT' ? '找不到台账文件，请先初始化或核对路径'
            : error instanceof SyntaxError ? '台账不是有效的 JSON' : error.message
    console.error(`试用台账处理失败：${message}`)
    process.exitCode = 1
})
