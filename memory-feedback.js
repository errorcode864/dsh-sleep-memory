import { randomUUID } from 'node:crypto'
import { backupChecksum } from './memory-contract.js'
import { memoryVersion } from './memory-runtime.js'

const SIGNALS = ['helpful', 'irrelevant', 'incorrect', 'outdated', 'retract']
const queryHash = (query, projectId) => backupChecksum([projectId, query.normalize('NFKC').trim()])
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isScope = (value) => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200)

export const feedbackDomainSpec = {
    name: 'memory_feedback', version: 1, layout: 'per-record',
    tables: {
        records: {
            valueSchema: {
                parse(value) {
                    if (!value || typeof value !== 'object' || Array.isArray(value)
                        || !Number.isSafeInteger(value.at) || value.at < 0) throw new Error('反馈记录格式不合法')
                    if (value.kind === 'exposure') {
                        if (!/^exposure_[a-f0-9]{32}$/.test(value.id) || !isScope(value.projectId)
                            || !isScope(value.sessionId) || !isHash(value.queryHash)
                            || !['automatic', 'explicit'].includes(value.mode) || !Array.isArray(value.items)
                            || !value.items.length || value.items.length > 100) throw new Error('呈现记录格式不合法')
                        for (const [index, item] of value.items.entries()) {
                            if (item.id !== `${value.id}_${index}` || typeof item.memoryId !== 'string'
                                || !item.memoryId || !isHash(item.version)) throw new Error('呈现条目格式不合法')
                        }
                        return value
                    }
                    if (value.kind !== 'feedback' || typeof value.eventId !== 'string'
                        || !value.eventId.trim() || value.eventId.length > 200
                        || value.id !== `feedback_${backupChecksum(value.eventId)}`
                        || typeof value.exposureId !== 'string' || !/^exposure_[a-f0-9]{32}_\d+$/.test(value.exposureId)
                        || !SIGNALS.includes(value.signal) || value.source !== 'gui'
                        || !Number.isSafeInteger(value.sequence) || value.sequence < 1
                        || (value.signal === 'retract' ? typeof value.retracts !== 'string' : value.retracts !== null)) {
                        throw new Error('用户反馈格式不合法')
                    }
                    return value
                },
            },
        },
    },
}

/** 呈现批次原子落盘，明确反馈单独追加且不能由模型工具声明。 */
export function createFeedbackStore(openRecords) {
    const exposures = new Map()
    const exposuresByMemory = new Map()
    const events = new Map()
    const eventsByExposure = new Map()
    const state = { exposures: 0, events: 0, sequence: 0, failed: 0, lastError: null }
    const indexBatch = (batch) => {
        for (const item of batch.items) {
            const exposure = { ...batch, ...item, items: undefined }
            exposures.set(item.id, exposure)
            if (!exposuresByMemory.has(item.memoryId)) exposuresByMemory.set(item.memoryId, [])
            exposuresByMemory.get(item.memoryId).push(exposure)
        }
    }
    const indexEvent = (event) => {
        events.set(event.eventId, event)
        if (!eventsByExposure.has(event.exposureId)) eventsByExposure.set(event.exposureId, [])
        eventsByExposure.get(event.exposureId).push(event)
        state.sequence = Math.max(state.sequence, event.sequence)
    }
    const ready = openRecords().then((table) => {
        for (const [, record] of table.entries()) {
            if (record.kind === 'exposure') {
                indexBatch(record)
                continue
            }
            indexEvent(record)
        }
        state.exposures = exposures.size
        state.events = events.size
        return table
    })
    ready.catch(() => {})

    function currentFeedback(exposureId) {
        const history = eventsByExposure.get(exposureId) ?? []
        const retracted = new Set(history.filter((event) => event.signal === 'retract').map((event) => event.retracts))
        return history.filter((event) => event.signal !== 'retract' && !retracted.has(event.eventId))
            .sort((a, b) => b.sequence - a.sequence)[0] ?? null
    }

    return {
        ready, state,
        async record(hits, query, scope, sessionId, mode, view) {
            if (!hits.length) return new Map()
            const table = await ready
            const id = `exposure_${randomUUID().replaceAll('-', '')}`
            const batch = {
                id, kind: 'exposure', projectId: scope, sessionId, mode, queryHash: queryHash(query, scope), at: Date.now(),
                items: hits.map((hit, index) => ({
                    id: `${id}_${index}`, memoryId: hit.rec.id,
                    version: memoryVersion(hit.rec, view.lifecycleOf(hit.rec)),
                })),
            }
            try {
                await table.put(id, batch)
            } catch (error) {
                state.failed += 1
                state.lastError = `呈现记录保存失败：${error.message}`
                return new Map()
            }
            indexBatch(batch)
            state.exposures = exposures.size
            return new Map(batch.items.map((item) => [item.memoryId, item.id]))
        },
        async detail(record, lifecycle, current) {
            await ready
            const version = memoryVersion(record, lifecycle)
            return {
                feedbackEnabled: true,
                exposures: [...(exposuresByMemory.get(record.id) ?? [])]
                    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, 10).map((item) => ({
                        id: item.id, at: item.at, projectId: item.projectId, mode: item.mode,
                        currentVersion: current && item.version === version, feedback: currentFeedback(item.id),
                    })),
            }
        },
        async submit(args, trusted) {
            const invalid = (message) => ({ code: 'invalid_args', message })
            if (!trusted) return { code: 'forbidden', message: '反馈只接受记忆面板中的用户操作' }
            if (Object.keys(args).some((key) => !['action', 'eventId', 'exposureId', 'signal', 'retracts'].includes(key))
                || typeof args.eventId !== 'string' || !args.eventId.trim() || args.eventId.length > 200
                || typeof args.exposureId !== 'string' || !SIGNALS.includes(args.signal)
                || (args.signal === 'retract' ? typeof args.retracts !== 'string' : args.retracts !== undefined)) {
                return invalid('反馈必须包含 eventId、exposureId 与合法 signal')
            }
            const table = await ready
            const exposure = exposures.get(args.exposureId)
            if (!exposure) return { code: 'not_found', message: '找不到实际呈现记录' }
            const payload = { exposureId: args.exposureId, signal: args.signal, retracts: args.retracts ?? null }
            const previous = events.get(args.eventId)
            if (previous) {
                if (backupChecksum(payload) !== backupChecksum({
                    exposureId: previous.exposureId, signal: previous.signal, retracts: previous.retracts,
                })) return { code: 'conflict', message: '同一反馈 ID 的内容不一致' }
                return { action: 'feedback', eventId: previous.eventId, duplicate: true, signal: previous.signal }
            }
            if (args.signal === 'retract') {
                const target = events.get(args.retracts)
                if (!target || target.exposureId !== args.exposureId || target.signal === 'retract') {
                    return invalid('只能撤回同一次呈现的已有反馈')
                }
            }
            const record = {
                id: `feedback_${backupChecksum(args.eventId)}`, kind: 'feedback',
                eventId: args.eventId, ...payload, source: 'gui', at: Date.now(),
                sequence: state.sequence + 1,
            }
            await table.put(record.id, record)
            indexEvent(record)
            state.events = events.size
            return { action: 'feedback', eventId: record.eventId, duplicate: false, signal: record.signal }
        },
        ranking(record, query, projectId, lifecycle) {
            const version = memoryVersion(record, lifecycle)
            const hash = queryHash(query, projectId)
            const matching = (exposuresByMemory.get(record.id) ?? []).filter((exposure) =>
                exposure.version === version
                && exposure.projectId === projectId && exposure.queryHash === hash)
                .map((exposure) => currentFeedback(exposure.id)).filter(Boolean)
                .sort((a, b) => b.sequence - a.sequence)
            if (!matching.length) return 1
            return matching[0].signal === 'helpful' ? 1.15 : 0.7
        },
    }
}
