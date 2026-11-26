import { backupChecksum, getEventRange, getProjectId } from './memory-contract.js'
import { analyzeRetrievalText } from './memory-retrieval.js'

/** 对照版本绑定原文及有效性，不随访问强化和强度衰减变化。 */
export function recollectionVersion(record, view) {
    return backupChecksum({
        id: record.id, content: record.content, kind: record.kind, layer: record.layer,
        projectId: getProjectId(record), eventRange: getEventRange(record),
        source: record.source ?? null, learning: record.learning ?? null,
        current: view.isCurrent(record), lifecycle: view.lifecycleOf(record),
        replacedBy: view.replacedBy.get(record.id) ?? view.summaryReplacedBy.get(record.id) ?? null,
        sources: record.edges.filter((edge) => ['consolidates', 'revises'].includes(edge.relation)),
    })
}

/** 仅抽取完整原句段，省略范围可按 UTF-16 下标与底稿逐字对照。 */
export function createRecollection(record, view, { detail = 'brief', query = '', now = Date.now() } = {}) {
    const ageDays = Math.max(0, Math.floor((now - getEventRange(record)[1]) / 86_400_000))
    const preserveFull = detail === 'original' || record.kind === 'fact'
        || record.layer === 'salient' || record.learning?.category === 'preference'
    const excerptBudgetChars = preserveFull ? record.content.length
        : detail === 'expanded' ? 1800 : ageDays >= 180 ? 300 : ageDays >= 30 ? 600 : 900
    const terms = [...analyzeRetrievalText(query).tokens.values()].filter((token) => token.anchor)
    const ranked = [...record.content.matchAll(/[^\n。！？]+(?:[。！？]+(?:\r?\n)?|\n|$)|[\n。！？]+/gu)].map((match) => ({
        start: match.index, end: match.index + match[0].length, text: match[0],
        score: terms.reduce((sum, term) => sum + (match[0].toLowerCase().includes(term.value) ? term.weight : 0), 0),
    })).sort((a, b) => b.score - a.score || a.start - b.start)
    const selected = []
    // 固定优先序只取可容纳的前缀以保证展开保留已呈现的句段。
    for (const fragment of ranked) {
        if (preserveFull || record.content.length <= excerptBudgetChars) break
        if (selected.length >= (detail === 'expanded' ? 48 : 24)
            || selected.reduce((sum, item) => sum + item.text.length, 0) + fragment.text.length > excerptBudgetChars) break
        selected.push(fragment)
    }
    const fragments = preserveFull || record.content.length <= excerptBudgetChars
        ? [{ start: 0, end: record.content.length, text: record.content }]
        : selected.sort((a, b) => a.start - b.start).map(({ start, end, text }) => ({ start, end, text }))
    const omitted = [...fragments, { start: record.content.length }].flatMap((fragment, index) => {
        const start = index === 0 ? 0 : fragments[index - 1].end
        return fragment.start > start ? [{ start, end: fragment.start }] : []
    })
    const includedChars = fragments.reduce((sum, fragment) => sum + fragment.text.length, 0)
    const sourceVersion = recollectionVersion(record, view)
    return {
        action: 'recollect', id: record.id, projectId: getProjectId(record),
        sourceVersion, viewVersion: backupChecksum({ sourceVersion, formatVersion: 1, detail, excerptBudgetChars, fragments }),
        formatVersion: 1, detail, ageDays, excerptBudgetChars,
        ageBasis: record.eventEndAt !== undefined ? 'eventEndAt' : record.occurredAt !== undefined ? 'occurredAt' : 'createdAt',
        current: view.isCurrent(record), lifecycle: view.lifecycleOf(record),
        replacedBy: view.replacedBy.get(record.id) ?? view.summaryReplacedBy.get(record.id) ?? null,
        source: record.source ?? { kind: 'unknown' },
        sourceCount: record.edges.filter((edge) => edge.relation === 'consolidates').length,
        content: fragments.map((fragment, index) =>
            `${fragment.start > (index === 0 ? 0 : fragments[index - 1].end) ? '…' : ''}${fragment.text}`).join('')
            + (fragments.length && fragments.at(-1).end < record.content.length ? '…' : ''),
        fragments, omitted, originalChars: record.content.length, includedChars,
        omittedChars: record.content.length - includedChars, truncated: omitted.length > 0, inferred: false,
        note: `${record.layer === 'deep' ? '底稿是深层概要，原始证据需继续追溯。' : ''}仅展示原文句段；省略处可能含条件或反例，不能据片段补全经历；年龄不代表事实可信度。`,
    }
}
