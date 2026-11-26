const CASES = ['preference-paraphrase', 'ordinary-task', 'dormancy-wake', 'other']
const ISSUES = [
    'missed-storage', 'unwanted-storage', 'missed-recall', 'irrelevant-injection',
    'incorrect-memory', 'outdated-memory', 'review-rejected', 'review-failed',
]
const isText = (value) => typeof value === 'string' && value.trim().length > 0

function requireKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
        throw new Error(`${label}字段不完整或包含未支持的字段`)
    }
}

/** 空位只是待采样轮次，不能算作成功样本。 */
export function createProjectTrial(projectId) {
    if (!isText(projectId)) throw new Error('必须提供试用项目标识')
    return {
        format: 'dsh-memory-project-trial', version: 1, dataSource: 'real-project', projectId, targetRounds: 30,
        setup: { profile: null, pluginRevision: null, scopeProjectId: null, backupVerified: false, configNote: null },
        rounds: Array.from({ length: 30 }, (_, index) => ({
            turn: index + 1, sessionId: null, messageId: null, at: null, observedProjectId: null, case: null,
            latencyMs: null, reportedTokens: null, estimatedTokens: null, review: null,
        })),
    }
}

/** 人工台账在文件入口统一校验，缺失数据不得默认为正确或零成本。 */
export function validateProjectTrial(value) {
    requireKeys(value, ['format', 'version', 'dataSource', 'projectId', 'targetRounds', 'setup', 'rounds'], '台账')
    if (value.format !== 'dsh-memory-project-trial' || value.version !== 1 || value.dataSource !== 'real-project'
        || !isText(value.projectId) || value.targetRounds !== 30 || !Array.isArray(value.rounds) || value.rounds.length !== 30) {
        throw new Error('台账必须是单项目的 30 轮真实试用记录')
    }
    requireKeys(value.setup, ['profile', 'pluginRevision', 'scopeProjectId', 'backupVerified', 'configNote'], '试用配置')
    for (const key of ['profile', 'pluginRevision', 'scopeProjectId', 'configNote']) {
        if (value.setup[key] !== null && !isText(value.setup[key])) throw new Error(`试用配置 ${key} 必须为非空文字或 null`)
    }
    if (typeof value.setup.backupVerified !== 'boolean') throw new Error('备份验证标记必须为布尔值')
    if (value.setup.scopeProjectId !== null && value.setup.scopeProjectId !== value.projectId) throw new Error('试用范围与台账项目不一致')
    const configured = ['profile', 'pluginRevision', 'scopeProjectId', 'configNote'].every((key) => isText(value.setup[key]))
        && value.setup.backupVerified
    const identities = new Set()
    for (const [index, round] of value.rounds.entries()) {
        const label = `第 ${index + 1} 轮`
        requireKeys(round, ['turn', 'sessionId', 'messageId', 'at', 'observedProjectId', 'case',
            'latencyMs', 'reportedTokens', 'estimatedTokens', 'review'], label)
        if (round.turn !== index + 1) throw new Error('轮次必须按 1～30 连续排列')
        for (const key of ['sessionId', 'messageId', 'at', 'observedProjectId']) {
            if (round[key] !== null && !isText(round[key])) throw new Error(`${label}的 ${key} 必须为非空文字或 null`)
        }
        if (round.at !== null && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(round.at) || !Number.isFinite(Date.parse(round.at)))) {
            throw new Error(`${label}必须使用带时区的有效时间`)
        }
        if (round.observedProjectId !== null && round.observedProjectId !== value.projectId) throw new Error(`${label}不属于本次试用项目`)
        if (round.case !== null && !CASES.includes(round.case)) throw new Error(`${label}场景分类不合法`)
        for (const key of ['latencyMs', 'reportedTokens', 'estimatedTokens']) {
            if (round[key] !== null && (!Number.isSafeInteger(round[key]) || round[key] < 0)) throw new Error(`${label}的 ${key} 必须为非负整数或 null`)
        }
        // 同一真实消息不能重复计数，未完成的记录也参与查重。
        if (round.sessionId !== null && round.messageId !== null) {
            const identity = JSON.stringify([round.sessionId, round.messageId])
            if (identities.has(identity)) throw new Error(`${label}重复使用同一会话消息`)
            identities.add(identity)
        }
        if (round.review === null) continue
        if (!configured) throw new Error('开始标注前必须核对 profile、插件版本、实际项目范围、配置和备份恢复')
        if (['sessionId', 'messageId', 'at', 'observedProjectId', 'case'].some((key) => round[key] === null)) {
            throw new Error(`${label}标注前必须补齐实际轮次来源和场景`)
        }
        requireKeys(round.review, ['reviewer', 'issues', 'evidenceRefs', 'note', 'wakeResult'], `${label}标注`)
        if (!isText(round.review.reviewer) || !isText(round.review.note)
            || !Array.isArray(round.review.evidenceRefs) || !round.review.evidenceRefs.length || !round.review.evidenceRefs.every(isText)) {
            throw new Error(`${label}必须有人工标注者、判断说明和证据引用`)
        }
        if (!Array.isArray(round.review.issues) || round.review.issues.some((issue) => !ISSUES.includes(issue))
            || new Set(round.review.issues).size !== round.review.issues.length) throw new Error(`${label}问题标签不合法或重复`)
        if (!(round.case === 'dormancy-wake' ? ['success', 'failed'] : ['not-tested']).includes(round.review.wakeResult)) {
            throw new Error(`${label}唤醒结论必须与实际场景对应`)
        }
    }
    return value
}

/** 汇总已核对轮次，未知成本和未标注轮次单独计数。 */
export function summarizeProjectTrial(trial) {
    const reviewed = trial.rounds.filter((round) => round.review !== null)
    const coverage = Object.fromEntries(CASES.map((name) => [name, reviewed.filter((round) => round.case === name).length]))
    const missingCoverage = CASES.slice(0, 3).filter((name) => !coverage[name])
    const issues = Object.fromEntries(ISSUES.map((issue) => [issue, reviewed.filter((round) => round.review.issues.includes(issue)).length]))
    const latency = reviewed.map((round) => round.latencyMs).filter((value) => value !== null).sort((a, b) => a - b)
    const usage = Object.fromEntries(['reportedTokens', 'estimatedTokens'].map((key) => {
        const known = reviewed.map((round) => round[key]).filter((value) => value !== null)
        return [key, { measuredRounds: known.length, unknownRounds: reviewed.length - known.length,
            total: known.length ? known.reduce((sum, value) => sum + value, 0) : null }]
    }))
    return {
        projectId: trial.projectId, reviewedRounds: reviewed.length, pendingRounds: 30 - reviewed.length,
        setupReady: trial.setup.backupVerified && ['profile', 'pluginRevision', 'scopeProjectId', 'configNote'].every((key) => isText(trial.setup[key])),
        status: reviewed.length < 30 ? 'collecting' : missingCoverage.length ? 'coverage-incomplete'
            : reviewed.some((round) => round.review.issues.length || round.review.wakeResult === 'failed') ? 'needs-follow-up' : 'ready-for-review',
        coverage, missingCoverage, issues,
        wake: { success: reviewed.filter((round) => round.review.wakeResult === 'success').length,
            failed: reviewed.filter((round) => round.review.wakeResult === 'failed').length },
        latencyMs: { measuredRounds: latency.length, unknownRounds: reviewed.length - latency.length,
            p50: latency.length ? latency[Math.ceil(latency.length * 0.5) - 1] : null,
            p95: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null },
        usage,
        boundary: '人工台账仅汇总已标注的真实轮次声明；不验证外部证据真实性、不代表总体准确率，实报和估算 Token 不相加。',
    }
}
