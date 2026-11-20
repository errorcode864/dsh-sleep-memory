import { backupChecksum, getProjectId } from './memory-contract.js'
import { matchRecallTriggers, validateRecallTriggers } from './memory-triggers.js'
import { buildRetrievalIndex, scoreRetrieval } from './memory-retrieval.js'

export const OUTCOME_SIGNALS = ['success', 'failure']

/** 结果只绑定内容与来源版本以避免访问强化使用户确认失效。 */
export function outcomeMemoryVersion(record, lifecycle) {
    return backupChecksum({
        id: record.id, content: record.content, kind: record.kind, projectId: getProjectId(record),
        source: record.source, learning: record.learning, replaces: record.replaces, lifecycle,
        recallTriggers: record.recallTriggers,
        edges: record.edges.filter((edge) => ['consolidates', 'revises'].includes(edge.relation)),
    })
}

/** 表单与持久记录在各自入口校验结果结构。 */
export function validateOutcome(value, stored = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !['trigger', 'action', 'result', 'evidence', ...(stored ? ['targetVersion'] : [])].includes(key))
        || !value.trigger || validateRecallTriggers([value.trigger]).length
        || ['action', 'result'].some((key) => typeof value[key] !== 'string' || !value[key].trim()
            || value[key].length > (key === 'action' ? 200 : 300))
        || !value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)
        || Object.keys(value.evidence).some((key) => !['memoryId', 'quote', 'version'].includes(key))
        || typeof value.evidence.memoryId !== 'string' || !value.evidence.memoryId.startsWith('smm_')
        || typeof value.evidence.quote !== 'string' || value.evidence.quote.trim().length < 2 || value.evidence.quote.length > 500
        || !/^[a-f0-9]{64}$/.test(value.evidence.version)
        || (stored && !/^[a-f0-9]{64}$/.test(value.targetVersion))) {
        return '结果反馈必须包含情境、做法、结果及原文证据'
    }
    return null
}

/** 来源失效或版本改变后停止采用结果且不改写历史反馈。 */
export function outcomeApplies(event, record, view) {
    const evidence = view.byId.get(event.outcome.evidence.memoryId)
    return view.isCurrent(record) && event.outcome.targetVersion === outcomeMemoryVersion(record, view.lifecycleOf(record))
        && evidence && evidence.layer !== 'deep' && getProjectId(evidence) === getProjectId(record)
        && view.isCurrent(evidence)
        && event.outcome.evidence.version === outcomeMemoryVersion(evidence, view.lifecycleOf(evidence))
}

/** 每份原始证据只计一次且正反结果共同决定当前提示。 */
export function planOutcome(events, record, query, view) {
    const groups = new Map()
    for (const event of events.sort((left, right) => right.sequence - left.sequence)) {
        if (!outcomeApplies(event, record, view)
            || !matchRecallTriggers({ recallTriggers: [event.outcome.trigger] }, query).length) continue
        if (scoreRetrieval(buildRetrievalIndex([[event.outcome.action, event.outcome.result, event.outcome.evidence.quote]]),
            query)[0].conflicts.length) continue
        const key = backupChecksum([
            event.outcome.trigger.when.normalize('NFKC').trim(),
            event.outcome.trigger.cues.map((cue) => cue.normalize('NFKC').toLowerCase()).sort(),
            event.outcome.action.normalize('NFKC').trim(),
        ])
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(event)
    }
    const group = groups.values().next().value
    if (!group) return null
    const evidence = new Map()
    for (const event of group) {
        if (!evidence.has(event.outcome.evidence.memoryId)) evidence.set(event.outcome.evidence.memoryId, event)
    }
    const eventsByEvidence = [...evidence.values()]
    const success = eventsByEvidence.filter((event) => event.signal === 'success').length
    const failure = eventsByEvidence.length - success
    const balance = Math.abs(success - failure) / eventsByEvidence.length
    return {
        direction: success === failure ? 'mixed' : success > failure ? 'encouragement' : 'warning',
        when: group[0].outcome.trigger.when, action: group[0].outcome.action,
        success, failure, multiplier: Math.round((1 + 0.15 * balance) * 1000) / 1000,
        evidence: OUTCOME_SIGNALS.map((signal) => eventsByEvidence.find((event) => event.signal === signal)).filter(Boolean).map((event) => ({
            eventId: event.eventId, signal: event.signal, memoryId: event.outcome.evidence.memoryId,
            result: event.outcome.result, quote: event.outcome.evidence.quote.slice(0, 200),
            truncated: event.outcome.evidence.quote.length > 200,
        })),
    }
}

/** 提示明确区分用户确认结果与情绪推断。 */
export function outcomeNote(outcome) {
    return `（用户确认·${{ encouragement: '激励', warning: '警示', mixed: '正反并存需复核' }[outcome.direction]}：情境 ${outcome.when}；做法 ${outcome.action}；成功 ${outcome.success}、失败 ${outcome.failure}；${outcome.evidence.map((item) =>
        `${item.signal === 'success' ? '成功' : '失败'}结果 ${item.result}，证据 ${item.memoryId}：「${item.quote}」${item.truncated ? '（片段）' : ''}`).join('；')}；结果不证明因果，执行前核对条件）`
}
