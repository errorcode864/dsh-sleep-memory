import {
    createMemoryId, createRecordView, exportMemoryBackup, getProjectId, matchesProject,
    planMemoryImport, validateMetadata, backupChecksum,
} from './memory-contract.js'

const EXTENDED_ACTIONS = ['get', 'correct', 'export', 'import', 'status', 'setState', 'scope', 'bind']

export function isExtendedAction(action) {
    return EXTENDED_ACTIONS.includes(action)
}

/** 扩展管理请求独立校验，沿用既有工具的错误返回协议。 */
export async function executeMemoryManagement(args, { table, cfg, parseRecord, status, manageScope }) {
    const allowed = {
        get: ['action', 'id', 'projectId', 'offset', 'limit'],
        correct: ['action', 'id', 'projectId', 'content', 'source', 'occurredAt'],
        export: ['action'],
        import: ['action', 'backup', 'dryRun'],
        status: ['action'],
        setState: ['action', 'id', 'projectId', 'state', 'reason', 'dryRun', 'planToken'],
        scope: ['action', 'sessionId'],
        bind: ['action', 'sessionId', 'projectId', 'release'],
    }
    const invalid = (message) => ({ code: 'invalid_args', message })
    if (Object.keys(args).some((key) => !allowed[args.action].includes(key))) return invalid('管理参数包含未知字段')
    const problems = validateMetadata(args)
    if (problems.length) return invalid(problems.join('；'))
    if (args.action === 'scope' || args.action === 'bind') return manageScope(args)
    if (args.action === 'status') return { action: 'status', ...await status() }
    if (args.action === 'export') return { action: 'export', backup: exportMemoryBackup(table) }
    if (args.action === 'import') {
        if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') return invalid('dryRun 必须为布尔值')
        let plan
        try {
            plan = planMemoryImport(table, args.backup, parseRecord, cfg.maxRecords)
        } catch (error) {
            return invalid(`备份导入被拒绝：${error.message}`)
        }
        const dryRun = args.dryRun !== false
        // 存储无多记录事务；失败必须透出，重试时已完成的相同记录会被跳过。
        let imported = 0
        if (!dryRun) {
            try {
                for (const record of plan.pending) {
                    await table.put(record.id, record)
                    imported += 1
                }
            } catch (error) {
                const failure = new Error(`备份导入中断，已完成 ${imported} 条，可用原备份重试：${error.message}`)
                failure.code = 'import_partial'
                failure.imported = imported
                throw failure
            }
        }
        return { action: 'import', dryRun, imported: dryRun ? 0 : plan.pending.length, planned: plan.pending.length, skipped: plan.skipped }
    }
    if (typeof args.id !== 'string' || !args.id) return invalid('必须提供记忆 ID')
    const record = table.get(args.id)
    if (!record || !matchesProject(record, args.projectId, args.action === 'get')) {
        return { code: 'not_found', message: '指定范围内未找到这条记忆' }
    }
    const view = createRecordView([...table.entries()])
    const root = view.rootOf(record)
    const chain = [...view.byId.values()].filter((item) => view.rootOf(item).id === root.id)
    if (args.action === 'get') {
        const offset = args.offset ?? 0
        const limit = args.limit ?? 20
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
            return invalid('来源分页要求 offset ≥ 0，limit 为 1 至 100 的整数')
        }
        const ids = record.edges.filter((edge) => edge.relation === 'consolidates').map((edge) => edge.target)
        return {
            action: 'get', record, current: view.isCurrent(record), replacedBy: view.replacedBy.get(record.id) ?? null,
            sources: ids.slice(offset, offset + limit).map((id) => table.get(id)).filter(Boolean),
            totalSources: ids.length, offset, limit,
            lifecycle: view.lifecycleOf(record), chainRoot: root.id,
            chain: chain.slice(offset, offset + limit).map((item) => ({
                id: item.id, replaces: item.replaces ?? null, current: view.isCurrent(item),
                content: item.content.slice(0, 200), projectId: getProjectId(item),
            })),
            totalChain: chain.length,
        }
    }
    if (args.action === 'setState') {
        if (!['active', 'review', 'invalid'].includes(args.state)
            || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1000
            || (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')) {
            return invalid('状态必须为 active、review 或 invalid，并提供不超过 1000 个字符的原因')
        }
        const changedRoot = {
            ...root,
            lifecycle: {
                state: args.state, reason: args.reason.trim(), at: Date.now(),
                revision: (root.lifecycle?.revision ?? 0) + 1,
            },
        }
        const preview = createRecordView([...view.byId].map(([id, value]) => [id, id === root.id ? changedRoot : value]))
        const affected = [...view.byId.values()].filter((item) =>
            view.isCurrent(item) !== preview.isCurrent(item)
            || view.isConsolidated(item) !== preview.isConsolidated(item)
            || view.lifecycleOf(item).state !== preview.lifecycleOf(item).state)
        const plan = {
            rootId: root.id, state: args.state, reason: args.reason.trim(),
            chainIds: chain.map((item) => item.id).sort(),
            affectedIds: affected.map((item) => item.id).sort(),
            revision: root.lifecycle?.revision ?? 0,
        }
        const planToken = backupChecksum(plan)
        const dryRun = args.dryRun !== false
        // 预演确认绑定整条链和派生概要；中间发生纠正或巩固必须重新预演。
        if (!dryRun && args.planToken !== planToken) {
            return { code: 'conflict', message: '状态变更计划已变化或尚未预演，请重新预演后确认' }
        }
        if (!dryRun) await table.update(root.id, () => ({ ...changedRoot, updatedAt: changedRoot.lifecycle.at }))
        return { action: 'setState', dryRun, ...plan, planToken }
    }
    if (typeof args.content !== 'string' || !args.content.trim() || args.content.length > cfg.maxContentChars) {
        return invalid(`纠正内容必须为 1 至 ${cfg.maxContentChars} 个字符`)
    }
    if (record.kind !== 'fact' || !view.isCurrent(record)) {
        return { code: 'conflict', message: '只能纠正尚未被替代的事实；经历和失效概要不能直接纠正' }
    }
    if (record.layer === 'deep') return invalid('请先展开概要，纠正具体来源事实')
    if (table.size >= cfg.maxRecords) return { code: 'capacity_full', message: '容量不足，无法保留新旧两条事实' }
    const now = Date.now()
    const { lifecycle, ...previous } = record
    const corrected = {
        ...previous, id: createMemoryId(), content: args.content.trim(), layer: 'surface',
        strength: 0.6, valence: null, arousal: null, accessCount: 0,
        createdAt: now, updatedAt: now, lastAccessAt: now, lastDecayAt: now,
        occurredAt: args.occurredAt ?? now, eventEndAt: args.occurredAt ?? now,
        supersededBy: null, gist: null, rewriteCount: 0, edges: [],
        replaces: record.id, projectId: getProjectId(record),
        source: args.source ?? { kind: 'unknown', confirmed: false },
    }
    parseRecord(corrected)
    await table.put(corrected.id, corrected)
    return { action: 'correct', id: corrected.id, replaces: record.id }
}
