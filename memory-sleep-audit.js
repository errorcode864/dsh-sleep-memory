import { randomUUID } from 'node:crypto'
import { backupChecksum, stableJson } from './memory-contract.js'

const STATES = ['prepared', 'applied', 'rolling-back', 'rolled-back']
const sameRecord = (left, right) => stableJson(left ?? null) === stableJson(right ?? null)

/** 审计独立落盘以保留睡眠修改前后的完整证据。 */
export function sleepAuditDomainSpec(parseRecord) {
    return {
        name: 'memory_sleep_audit', version: 1, layout: 'per-record',
        tables: {
            records: {
                valueSchema: {
                    parse(value) {
                        if (!value || !/^sleep_[a-f0-9-]{36}$/.test(value.id)
                            || !STATES.includes(value.state) || !Number.isSafeInteger(value.createdAt)
                            || value.createdAt < 0 || !Array.isArray(value.changes)
                            || !value.report || typeof value.report !== 'object'
                            || (['rolling-back', 'rolled-back'].includes(value.state) && !Array.isArray(value.rollbackChanges))) {
                            throw new Error('睡眠审计记录格式不合法')
                        }
                        for (const changes of [value.changes, value.rollbackChanges ?? []]) {
                            const ids = new Set()
                            for (const change of changes) {
                                if (!change || typeof change.id !== 'string' || ids.has(change.id)
                                    || !Object.hasOwn(change, 'before') || !change.after) {
                                    throw new Error('睡眠审计修改项格式不合法')
                                }
                                ids.add(change.id)
                                for (const record of [change.before, change.after]) {
                                    if (record === null) continue
                                    parseRecord(record)
                                    if (record.id !== change.id) throw new Error('睡眠审计记忆 ID 不一致')
                                }
                            }
                        }
                        return value
                    },
                },
            },
        },
    }
}

/** 修改与恢复共用串行入口以避免后台读取重复执行未完成批次。 */
export function createSleepAudit(openRecords, openAudit, maxBytes) {
    let operations = Promise.resolve()
    let needsRecovery = true
    const serialize = (operation) => {
        const result = operations.then(operation)
        operations = result.catch(() => {})
        return result
    }
    const applyChanges = async (changes) => {
        const records = await openRecords()
        // 先核对整批版本以免用恢复计划覆盖后来发生的纠正。
        const conflicts = changes.filter((change) => !sameRecord(records.get(change.id), change.before)
            && !sameRecord(records.get(change.id), change.after)).map((change) => change.id)
        if (conflicts.length) {
            const error = new Error(`睡眠恢复遇到后续修改：${conflicts.join('、')}`)
            error.code = 'audit_conflict'
            throw error
        }
        for (const change of changes) {
            if (sameRecord(records.get(change.id), change.after)) continue
            await records.put(change.id, change.after)
        }
    }
    const recoverPending = async () => {
        if (!needsRecovery) return 0
        const audit = await openAudit()
        const pending = [...audit.entries()].map(([, batch]) => batch)
            .filter((batch) => ['prepared', 'rolling-back'].includes(batch.state))
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        for (const batch of pending) {
            await applyChanges(batch.state === 'prepared' ? batch.changes : batch.rollbackChanges)
            await audit.put(batch.id, {
                ...batch, state: batch.state === 'prepared' ? 'applied' : 'rolled-back',
            })
        }
        needsRecovery = false
        return pending.length
    }
    return {
        recover: () => serialize(recoverPending),
        drain: () => operations,
        commit: (changes, report) => serialize(async () => {
            await recoverPending()
            const audit = await openAudit()
            const batch = {
                id: `sleep_${randomUUID()}`, state: 'prepared', createdAt: Date.now(),
                changes, report: structuredClone(report),
            }
            const retainedBytes = [...audit.entries()].reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
            const batchBytes = Buffer.byteLength(JSON.stringify(batch))
            if (maxBytes > 0 && retainedBytes + batchBytes > maxBytes) {
                const error = new Error('睡眠审计已达到容量上限，请导出备份并调整审计容量')
                error.code = 'audit_capacity'
                throw error
            }
            // 计划先持久化以便断电后使用相同 ID 完成写入。
            needsRecovery = true
            await audit.put(batch.id, batch)
            await applyChanges(changes)
            await audit.put(batch.id, { ...batch, state: 'applied' })
            needsRecovery = false
            return batch.id
        }),
        manage: (args) => serialize(async () => {
            const allowed = {
                sleepHistory: ['action', 'batchId', 'offset', 'limit'],
                sleepRecover: ['action'],
                sleepRollback: ['action', 'batchId', 'dryRun', 'planToken'],
                sleepStats: ['action'],
            }
            if (Object.keys(args).some((key) => !allowed[args.action].includes(key))) {
                return { code: 'invalid_args', message: '睡眠审计参数包含未知字段' }
            }
            const audit = await openAudit()
            if (args.action === 'sleepStats') {
                const batches = [...audit.entries()].map(([, batch]) => batch)
                const retainedBytes = batches.reduce((sum, batch) => sum + Buffer.byteLength(JSON.stringify(batch)), 0)
                return {
                    action: args.action, batchCount: batches.length, retainedBytes, maxBytes,
                    measurement: 'json-utf8', overLimit: maxBytes > 0 && retainedBytes >= maxBytes,
                    states: Object.fromEntries(STATES.map((state) => [state, batches.filter((batch) => batch.state === state).length])),
                    changedRecords: batches.reduce((sum, batch) => sum + batch.changes.length, 0),
                    oldestAt: batches.reduce((at, batch) => Math.min(at ?? batch.createdAt, batch.createdAt), null),
                    newestAt: batches.reduce((at, batch) => Math.max(at ?? batch.createdAt, batch.createdAt), null),
                }
            }
            if (args.action === 'sleepRecover') {
                return { action: args.action, recovered: await recoverPending() }
            }
            if (args.action === 'sleepHistory') {
                const offset = args.offset ?? 0
                const limit = args.limit ?? 20
                if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
                    || (args.batchId !== undefined && (typeof args.batchId !== 'string' || !args.batchId))) {
                    return { code: 'invalid_args', message: '睡眠历史要求合法的 batchId 或分页参数' }
                }
                const batches = [...audit.entries()].map(([, batch]) => batch)
                    .filter((batch) => args.batchId === undefined || batch.id === args.batchId)
                    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
                return {
                    action: args.action, total: batches.length, offset, limit,
                    items: (args.batchId ? batches : batches.slice(offset, offset + limit)).map((batch) => ({
                        id: batch.id, state: batch.state, createdAt: batch.createdAt,
                        changedCount: batch.changes.length, report: batch.report,
                        ...(args.batchId ? { changes: batch.changes.slice(offset, offset + limit), totalChanges: batch.changes.length } : {}),
                    })),
                }
            }
            if (typeof args.batchId !== 'string' || !args.batchId
                || (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')) {
                return { code: 'invalid_args', message: '睡眠回滚必须提供 batchId 和合法的 dryRun' }
            }
            await recoverPending()
            const batch = audit.get(args.batchId)
            if (!batch) return { code: 'not_found', message: '未找到睡眠审计批次' }
            if (batch.state === 'rolled-back') return { action: args.action, batchId: batch.id, state: batch.state }
            if (batch.state !== 'applied') return { code: 'audit_pending', message: '请先恢复未完成的睡眠批次' }
            const records = await openRecords()
            // 回滚必须保持整批后态不变以保护后续强化、纠正和状态调整。
            const changedIds = new Set(batch.changes.map((change) => change.id))
            const conflicts = [
                ...batch.changes.filter((change) => !sameRecord(records.get(change.id), change.after)).map((change) => change.id),
                ...[...records.entries()].filter(([id, record]) => !changedIds.has(id)
                    && (changedIds.has(record.replaces) || changedIds.has(record.supersededBy)))
                    .map(([id]) => id),
            ]
            if (conflicts.length) return { code: 'audit_conflict', message: '睡眠之后的记忆已改变，不能覆盖', conflicts }
            const planToken = backupChecksum([batch.id, batch.changes])
            const result = {
                action: args.action, batchId: batch.id, dryRun: args.dryRun !== false, planToken,
                restoredCount: batch.changes.filter((change) => change.before !== null).length,
                invalidatedCount: batch.changes.filter((change) => change.before === null).length,
            }
            if (result.dryRun) return result
            if (args.planToken !== planToken) return { code: 'confirmation_required', message: '请提供本次回滚预演的 planToken' }
            const now = Date.now()
            const rollbackChanges = batch.changes.map((change) => ({
                id: change.id, before: change.after,
                after: change.before ?? {
                    ...change.after, updatedAt: now,
                    lifecycle: { state: 'invalid', reason: '睡眠批次已回滚', at: now, revision: 1 },
                },
            }))
            const rolling = { ...batch, state: 'rolling-back', rollbackChanges }
            needsRecovery = true
            await audit.put(batch.id, rolling)
            await applyChanges(rollbackChanges)
            await audit.put(batch.id, { ...rolling, state: 'rolled-back' })
            needsRecovery = false
            return { ...result, state: 'rolled-back' }
        }),
    }
}
