import { backupChecksum, exportMemoryBackup, planMemoryImport, stableJson } from './memory-contract.js'
import { feedbackDomainSpec, planFeedbackImport } from './memory-feedback.js'
import { narrativeDomainSpec } from './memory-narrative.js'
import { planNarrativeImport } from './memory-narrative-backup.js'

/** 恢复计划独立保存以阻止读者看到跨域导入的中间状态。 */
export function backupStateDomainSpec(parseRecord, parseAudit) {
    return {
        name: 'memory_backup_state', version: 1, layout: 'per-record',
        tables: { records: { valueSchema: { parse(value) {
            if (!value || value.id !== 'restore' || !['prepared', 'complete'].includes(value.state)
                || !Number.isSafeInteger(value.at) || value.at < 0
                || typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum)) {
                throw new Error('备份恢复计划格式不合法')
            }
            if (value.state === 'complete') return value
            if (!Array.isArray(value.records) || !Array.isArray(value.audits)
                || (value.feedback !== undefined && !Array.isArray(value.feedback))
                || (value.narratives !== undefined && (!Array.isArray(value.narratives) || !Array.isArray(value.feedback)
                    || typeof value.narrativeContext !== 'string' || !/^[a-f0-9]{64}$/u.test(value.narrativeContext)))
                || value.checksum !== backupChecksum({ records: value.records, audits: value.audits,
                    ...(value.feedback !== undefined ? { feedback: value.feedback } : {}),
                    ...(value.narratives !== undefined ? { narratives: value.narratives, narrativeContext: value.narrativeContext } : {}) })) {
                throw new Error('备份恢复计划校验失败')
            }
            for (const record of value.records) parseRecord(record)
            for (const batch of value.audits) parseAudit(batch)
            for (const item of value.feedback ?? []) feedbackDomainSpec.tables.records.valueSchema.parse(item)
            for (const item of value.narratives ?? []) narrativeDomainSpec.tables.records.valueSchema.parse(item)
            return value
        } } } },
    }
}

/** 记忆与审计统一导入且不覆盖同 ID 的本地异内容。 */
export function createMemoryBackup({ openRecords, openAudit, openFeedback, openNarratives, openState, parseRecord, parseAudit, maxRecords }) {
    let operations = Promise.resolve()
    let needsRecovery = true
    const serialize = (operation) => {
        const result = operations.then(operation)
        operations = result.catch(() => {})
        return result
    }
    const recoverPending = async () => {
        if (!needsRecovery) return 0
        const state = await openState()
        const job = state.get('restore')
        if (!job || job.state === 'complete') {
            needsRecovery = false
            return 0
        }
        const tables = [[await openRecords(), job.records], [await openAudit(), job.audits]]
        if (job.feedback) tables.push([await openFeedback(), job.feedback])
        if (job.narratives) {
            const narratives = await openNarratives()
            const plan = planNarrativeImport(narratives, job.narratives,
                new Map([...tables[0][0].entries(), ...job.records.map((record) => [record.id, record])]))
            // 中断后连已有前序与底稿也必须保持预演状态，不能只核对新增 ID。
            if (plan.context !== job.narrativeContext) throw new Error('备份恢复的叙述底稿或历史已变化')
            tables.push([narratives, job.narratives])
        }
        // 全部版本先核对以免恢复时覆盖期间新增的事实或审计。
        for (const [table, values] of tables) {
            for (const value of values) {
                const current = table.get(value.id)
                if (current && stableJson(current) !== stableJson(value)) {
                    throw new Error(`备份恢复遇到本地冲突：${value.id}`)
                }
            }
        }
        for (const [table, values] of tables) {
            for (const value of values) {
                if (!table.get(value.id)) await table.put(value.id, value)
            }
        }
        await state.put('restore', { id: 'restore', state: 'complete', at: job.at, checksum: job.checksum })
        needsRecovery = false
        return 1
    }
    return {
        recover: () => serialize(recoverPending),
        drain: () => operations,
        export: (includeFeedback = false, includeNarratives = false) => serialize(async () => {
            await recoverPending()
            const records = exportMemoryBackup(await openRecords()).records
            const audits = [...(await openAudit()).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, batch]) => batch)
            if (includeFeedback) {
                const feedback = [...(await openFeedback()).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item)
                if (includeNarratives) {
                    const narratives = [...(await openNarratives()).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item)
                    planNarrativeImport(new Map(), narratives, new Map(records.map((record) => [record.id, record])))
                    return {
                        format: 'dsh-sleep-memory', version: 4, scope: 'memory-audit-feedback-and-narratives', exportedAt: Date.now(),
                        records, audits, feedback, narratives, checksum: backupChecksum({ records, audits, feedback, narratives }),
                    }
                }
                return {
                    format: 'dsh-sleep-memory', version: 3, scope: 'memory-audit-and-feedback', exportedAt: Date.now(),
                    records, audits, feedback, checksum: backupChecksum({ records, audits, feedback }),
                }
            }
            return {
                format: 'dsh-sleep-memory', version: 2, scope: 'memory-and-sleep-audit',
                exportedAt: Date.now(), records, audits, checksum: backupChecksum({ records, audits }),
            }
        }),
        import: (args) => serialize(async () => {
            if (Object.keys(args).some((key) => !['action', 'backup', 'dryRun', 'planToken'].includes(key))
                || (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')) {
                return { code: 'invalid_args', message: '审计备份导入参数不合法' }
            }
            await recoverPending()
            const records = await openRecords()
            const audits = await openAudit()
            const backup = args.backup
            let recordPlan
            let narrativePlan
            const pendingAudits = []
            const pendingFeedback = []
            try {
                if (!backup || backup.format !== 'dsh-sleep-memory' || ![2, 3, 4].includes(backup.version)
                    || backup.scope !== ({ 2: 'memory-and-sleep-audit', 3: 'memory-audit-and-feedback', 4: 'memory-audit-feedback-and-narratives' }[backup.version]) || !Array.isArray(backup.audits)
                    || backup.audits.length > 100_000
                    || (backup.version === 4 && Object.keys(backup).some((key) => ![
                        'format', 'version', 'scope', 'exportedAt', 'records', 'audits', 'feedback', 'narratives', 'checksum',
                    ].includes(key)))
                    || backup.checksum !== backupChecksum({ records: backup.records, audits: backup.audits,
                        ...(backup.version >= 3 ? { feedback: backup.feedback } : {}),
                        ...(backup.version === 4 ? { narratives: backup.narratives } : {}) })) {
                    throw new Error('备份格式、范围或校验摘要不合法')
                }
                recordPlan = planMemoryImport(records, {
                    format: backup.format, version: 1, records: backup.records, checksum: backupChecksum(backup.records),
                }, parseRecord, maxRecords)
                if (backup.version >= 3) pendingFeedback.push(...planFeedbackImport(await openFeedback(), backup.feedback,
                    new Map([...records.entries(), ...recordPlan.pending.map((record) => [record.id, record])])))
                if (backup.version === 4) narrativePlan = planNarrativeImport(await openNarratives(), backup.narratives,
                    new Map([...records.entries(), ...recordPlan.pending.map((record) => [record.id, record])]))
                const seen = new Set()
                for (const batch of backup.audits) {
                    parseAudit(batch)
                    if (seen.has(batch.id)) throw new Error(`备份审计批次重复：${batch.id}`)
                    seen.add(batch.id)
                    // 备份不能携带待执行的睡眠或回滚指令。
                    if (!['applied', 'rolled-back'].includes(batch.state)) throw new Error('备份包含未完成的审计批次')
                    const existing = audits.get(batch.id)
                    if (existing && stableJson(existing) !== stableJson(batch)) throw new Error(`本地审计与备份冲突：${batch.id}`)
                    if (!existing) pendingAudits.push(batch)
                }
            } catch (error) {
                return { code: 'invalid_args', message: `审计备份导入被拒绝：${error.message}` }
            }
            const planToken = backupChecksum({
                checksum: backup.checksum, records: recordPlan.pending.map((record) => record.id),
                audits: pendingAudits.map((batch) => batch.id),
                ...(backup.version >= 3 ? { feedback: pendingFeedback.map((item) => item.id) } : {}),
                ...(narrativePlan ? { narratives: narrativePlan.pending.map((item) => item.id), narrativeContext: narrativePlan.context } : {}),
            })
            const result = {
                action: 'import', dryRun: args.dryRun !== false, planToken,
                planned: recordPlan.pending.length, skipped: recordPlan.skipped,
                plannedAudits: pendingAudits.length, skippedAudits: backup.audits.length - pendingAudits.length,
                imported: 0, importedAudits: 0,
                ...(backup.version >= 3 ? {
                    plannedFeedback: pendingFeedback.length, skippedFeedback: backup.feedback.length - pendingFeedback.length, importedFeedback: 0,
                } : {}),
                ...(narrativePlan ? {
                    plannedNarratives: narrativePlan.pending.length,
                    skippedNarratives: backup.narratives.length - narrativePlan.pending.length, importedNarratives: 0,
                } : {}),
            }
            if (result.dryRun) return result
            if (!recordPlan.pending.length && !pendingAudits.length && !pendingFeedback.length && !narrativePlan?.pending.length) return result
            if (args.planToken !== planToken) return { code: 'confirmation_required', message: '请重新预演审计备份并提供 planToken' }
            const payload = { records: recordPlan.pending, audits: pendingAudits,
                ...(backup.version >= 3 ? { feedback: pendingFeedback } : {}),
                ...(narrativePlan ? { narratives: narrativePlan.pending, narrativeContext: narrativePlan.context } : {}) }
            needsRecovery = true
            await (await openState()).put('restore', {
                id: 'restore', state: 'prepared', at: Date.now(), ...payload, checksum: backupChecksum(payload),
            })
            await recoverPending()
            return { ...result, imported: result.planned, importedAudits: result.plannedAudits,
                ...(backup.version >= 3 ? { importedFeedback: result.plannedFeedback } : {}),
                ...(narrativePlan ? { importedNarratives: result.plannedNarratives } : {}) }
        }),
    }
}
