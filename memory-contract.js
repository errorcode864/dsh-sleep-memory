import { createHash, randomUUID } from 'node:crypto'

/** 统一记忆 ID，消息 ID 不使用此约束。 */
export function createMemoryId() {
    return `smm_${randomUUID()}`
}

/** 旧记录没有项目字段，按全局记忆兼容读取。 */
export function getProjectId(record) {
    return record.projectId ?? null
}

/** 项目查询可包含全局；缺省查询不遍历其他项目。 */
export function matchesProject(record, projectId, includeGlobal = true) {
    const current = getProjectId(record)
    return current === (projectId ?? null) || (includeGlobal && current === null)
}

/** 摘要保留成员事件跨度，写入时间不替代事件发生时间。 */
export function getEventRange(record) {
    return [record.occurredAt ?? record.createdAt, record.eventEndAt ?? record.occurredAt ?? record.createdAt]
}

/** 扩展字段均为可选，旧格式不需要读时回写。 */
export function validateMetadata(value) {
    const problems = []
    if (value.projectId !== undefined && value.projectId !== null
        && (typeof value.projectId !== 'string' || !value.projectId.trim()
            || value.projectId !== value.projectId.trim() || value.projectId.length > 200)) {
        problems.push('projectId 必须为不超过 200 个字符的非空项目标识，或 null')
    }
    for (const key of ['occurredAt', 'eventEndAt', 'lastDecayAt']) {
        if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
            problems.push(`${key} 必须为非负毫秒时间戳整数`)
        }
    }
    if (value.eventEndAt !== undefined
        && value.eventEndAt < (value.occurredAt ?? value.createdAt ?? 0)) {
        problems.push('事件结束时间不能早于开始时间')
    }
    if (value.replaces !== undefined && (typeof value.replaces !== 'string' || !value.replaces)) {
        problems.push('replaces 必须为非空记忆 ID')
    }
    if (value.lifecycle !== undefined) {
        const state = value.lifecycle
        if (!state || typeof state !== 'object' || Array.isArray(state)
            || !['active', 'review', 'invalid'].includes(state.state)
            || typeof state.reason !== 'string' || !state.reason.trim() || state.reason.length > 1000
            || !Number.isSafeInteger(state.at) || state.at < 0
            || !Number.isSafeInteger(state.revision) || state.revision < 1
            || Object.keys(state).some((key) => !['state', 'reason', 'at', 'revision'].includes(key))) {
            problems.push('lifecycle 必须包含合法的 state、reason、at 和 revision')
        }
    }
    if (value.source !== undefined) {
        const source = value.source
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            problems.push('source 必须为来源对象')
        } else {
            if (!['user', 'tool', 'model', 'import', 'unknown'].includes(source.kind)) {
                problems.push('source.kind 必须为 user、tool、model、import 或 unknown')
            }
            for (const key of ['sessionId', 'messageId']) {
                if (source[key] !== undefined
                    && (typeof source[key] !== 'string' || !source[key] || source[key].length > 200)) {
                    problems.push(`source.${key} 必须为不超过 200 个字符的非空字符串`)
                }
            }
            if (source.confirmed !== undefined && typeof source.confirmed !== 'boolean') {
                problems.push('source.confirmed 必须为布尔值')
            }
            if (Object.keys(source).some((key) => !['kind', 'sessionId', 'messageId', 'confirmed'].includes(key))) {
                problems.push('source 含未知字段')
            }
        }
    }
    return problems
}

/** 建立事实替代视图；受纠正影响的概要失效，其余成员重新进入检索。 */
export function createRecordView(entries) {
    const byId = new Map(entries)
    const replacedBy = new Map()
    for (const [id, record] of entries) {
        if (record.replaces && byId.has(record.replaces)) replacedBy.set(record.replaces, id)
    }
    // 整条纠正链共用根记录上的状态，一次持久写入即可切换，避免半条链生效。
    const rootOf = (record) => {
        const visited = new Set()
        let root = byId.get(record.id) ?? record
        while (root.replaces && byId.has(root.replaces) && !visited.has(root.id)) {
            visited.add(root.id)
            root = byId.get(root.replaces)
        }
        return root
    }
    const lifecycleOf = (record) => rootOf(record).lifecycle
        ?? { state: 'active', reason: '', at: 0, revision: 0 }
    const invalidSummaries = new Set()
    let changed
    do {
        changed = false
        for (const [id, record] of entries) {
            if (!invalidSummaries.has(id) && record.edges.some((edge) => edge.relation === 'consolidates'
                && (!byId.has(edge.target) || replacedBy.has(edge.target)
                    || invalidSummaries.has(edge.target) || lifecycleOf(byId.get(edge.target)).state !== 'active'))) {
                invalidSummaries.add(id)
                changed = true
            }
        }
    } while (changed)
    const isRecallable = (record, automatic = false) => !replacedBy.has(record.id)
        && !invalidSummaries.has(record.id)
        && (lifecycleOf(record).state === 'active' || (!automatic && lifecycleOf(record).state === 'review'))
    const isCurrent = (record) => isRecallable(record, true)
    const isConsolidated = (record) => record.supersededBy !== null
        && (!byId.has(record.supersededBy) || isCurrent(byId.get(record.supersededBy)))
    return { byId, replacedBy, invalidSummaries, isCurrent, isConsolidated, isRecallable, rootOf, lifecycleOf }
}

/** 规范化键顺序，使备份与重复导入不受 JSON 属性顺序影响。 */
export function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

export function backupChecksum(records) {
    return createHash('sha256').update(stableJson(records)).digest('hex')
}

/** 来源完整导出，保留已巩固和已替代的历史，不调用召回强化。 */
export function exportMemoryBackup(table) {
    const records = [...table.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, record]) => record)
    return {
        format: 'dsh-sleep-memory',
        version: 1,
        exportedAt: Date.now(),
        records,
        checksum: backupChecksum(records),
    }
}

/** 导入计划全量校验后才允许写入，同 ID 异内容绝不覆盖本地历史。 */
export function planMemoryImport(table, backup, parseRecord, maxRecords) {
    if (!backup || backup.format !== 'dsh-sleep-memory' || backup.version !== 1
        || !Array.isArray(backup.records) || backup.records.length > maxRecords) {
        throw new Error('备份格式、版本或记录数量不合法')
    }
    if (backup.checksum !== backupChecksum(backup.records)) throw new Error('备份校验摘要不匹配')
    const known = new Map(table.entries())
    const seen = new Set()
    const pending = []
    let skipped = 0
    for (const record of backup.records) {
        try {
            parseRecord(record)
        } catch (error) {
            throw new Error(`备份记忆 ${record?.id ?? '未提供 ID'} 校验失败：${error.message}`)
        }
        if (seen.has(record.id)) throw new Error(`备份中重复的记忆 ID：${record.id}`)
        seen.add(record.id)
        const existing = known.get(record.id)
        if (existing !== undefined) {
            if (stableJson(existing) !== stableJson(record)) throw new Error(`本地记忆与备份冲突：${record.id}`)
            skipped += 1
        } else {
            pending.push(record)
            known.set(record.id, record)
        }
    }
    if (known.size > maxRecords) throw new Error('导入后记录数超过容量上限')
    const replacements = new Set()
    for (const record of known.values()) {
        for (const target of [record.supersededBy, record.replaces, ...record.edges.map((edge) => edge.target)]) {
            if (target && !known.has(target)) throw new Error(`备份存在缺失的关联记忆：${target}`)
            if (target && getProjectId(known.get(target)) !== getProjectId(record)) {
                throw new Error(`备份包含跨项目关联：${record.id}`)
            }
        }
        if (record.replaces) {
            if (record.kind !== 'fact' || known.get(record.replaces).kind !== 'fact'
                || replacements.has(record.replaces)) throw new Error('事实替代关系存在分叉或类型错误')
            if (record.lifecycle !== undefined) throw new Error(`纠正链有效性只能存放在链根记录：${record.id}`)
            replacements.add(record.replaces)
            const visited = new Set([record.id])
            let cursor = record.replaces
            while (cursor) {
                if (visited.has(cursor)) throw new Error('事实替代关系存在循环')
                visited.add(cursor)
                cursor = known.get(cursor)?.replaces
            }
        }
        if (record.supersededBy) {
            const parent = known.get(record.supersededBy)
            if (parent.layer !== 'deep'
                || !parent.edges.some((edge) => edge.relation === 'consolidates' && edge.target === record.id)) {
                throw new Error(`巩固来源关系不完整：${record.id}`)
            }
        }
    }
    return { pending, skipped, total: backup.records.length }
}
