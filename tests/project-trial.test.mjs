import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createProjectTrial, summarizeProjectTrial, validateProjectTrial } from './project-trial.mjs'

function reviewedTrial() {
    const trial = createProjectTrial('试用项目')
    trial.setup = { profile: '隔离 profile', pluginRevision: '测试版本', scopeProjectId: trial.projectId, backupVerified: true, configNote: '固定试用配置' }
    trial.rounds[0] = {
        turn: 1, sessionId: '会话甲', messageId: '消息甲', at: '2026-11-26T10:00:00+08:00', observedProjectId: trial.projectId,
        case: 'preference-paraphrase', latencyMs: 150, reportedTokens: null, estimatedTokens: 10,
        review: { reviewer: '测试标注者', issues: ['missed-recall', 'review-rejected'], evidenceRefs: ['隔离测试证据'],
            note: '仅为单元测试构造数据', wakeResult: 'not-tested' },
    }
    return trial
}

test('空台账和未标注观测不计成功，未知 Token 不当作零', () => {
    const trial = createProjectTrial('试用项目')
    assert.equal(summarizeProjectTrial(validateProjectTrial(trial)).reviewedRounds, 0)
    trial.rounds[0].reportedTokens = 0
    assert.equal(summarizeProjectTrial(validateProjectTrial(trial)).usage.reportedTokens.total, null)
    const report = summarizeProjectTrial(validateProjectTrial(reviewedTrial()))
    assert.equal(report.reviewedRounds, 1)
    assert.equal(report.pendingRounds, 29)
    assert.equal(report.issues['missed-recall'], 1)
    assert.deepEqual(report.usage.reportedTokens, { measuredRounds: 0, unknownRounds: 1, total: null })
    assert.equal(report.usage.estimatedTokens.total, 10)
    assert.equal(report.latencyMs.p95, 150)
})

test('缺失人工证据、重复消息、错误项目和合成来源不得混入真实试用', () => {
    const mutations = [
        (trial) => { trial.setup.backupVerified = false },
        (trial) => { trial.rounds[0].review.evidenceRefs = [] },
        (trial) => { trial.rounds[0].review.reviewer = '' },
        (trial) => { trial.rounds[0].observedProjectId = '其他项目' },
        (trial) => { trial.dataSource = 'synthetic-project' },
        (trial) => { trial.rounds[0].review.issues = ['unknown'] },
        (trial) => { trial.rounds[0].reportedTokens = -1 },
        (trial) => { trial.rounds[0].at = '昨天' },
        (trial) => { trial.rounds[0].case = 'dormancy-wake' },
        (trial) => { trial.rounds[1] = { ...structuredClone(trial.rounds[0]), turn: 2 } },
    ]
    for (const mutate of mutations) {
        const trial = reviewedTrial()
        mutate(trial)
        assert.throws(() => validateProjectTrial(trial))
    }
})

test('达到 30 轮仍需场景覆盖和问题复核，实报与估算分别累计', () => {
    const trial = reviewedTrial()
    trial.rounds = Array.from({ length: 30 }, (_, index) => ({
        ...structuredClone(trial.rounds[0]), turn: index + 1, messageId: `消息${index}`, reportedTokens: 0,
    }))
    assert.equal(summarizeProjectTrial(validateProjectTrial(trial)).status, 'coverage-incomplete')
    trial.rounds[1].case = 'ordinary-task'
    trial.rounds[2].case = 'dormancy-wake'
    trial.rounds[2].review.wakeResult = 'failed'
    assert.equal(summarizeProjectTrial(validateProjectTrial(trial)).status, 'needs-follow-up')
    for (const round of trial.rounds) round.review.issues = []
    trial.rounds[2].review.wakeResult = 'success'
    const summary = summarizeProjectTrial(validateProjectTrial(trial))
    assert.equal(summary.status, 'ready-for-review')
    assert.equal(summary.usage.reportedTokens.total, 0)
    assert.equal(summary.usage.estimatedTokens.total, 300)
})

test('台账命令拒绝覆盖已有文件且空台账可汇总', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dsh-trial-')), 'trial.json')
    const run = (...args) => execFileSync(process.execPath, [fileURLToPath(new URL('./project-trial-cli.mjs', import.meta.url)), ...args], { encoding: 'utf8', stdio: 'pipe' })
    run('--init', '--project', '隔离项目', '--file', file)
    const original = await readFile(file, 'utf8')
    assert.throws(() => run('--init', '--project', '其他项目', '--file', file), /文件已存在/)
    assert.equal(await readFile(file, 'utf8'), original)
    assert.equal(JSON.parse(run('--file', file)).reviewedRounds, 0)
    assert.throws(() => run('--file', file, '--report', file), /文件已存在/)
    assert.equal(await readFile(file, 'utf8'), original)
})
