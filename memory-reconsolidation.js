import { getProjectId } from './memory-contract.js'

const MAX_SOURCES = 100
const MAX_NODES = 200
const MAX_EDGES = 1000
const MAX_DEPTH = 8
const MAX_COMPARISONS = 10000

/** 新概要只使用有效原始来源并将版本关系留给审计批次写入。 */
export function planReconsolidation(view, candidates, cfg, similarity) {
    const plans = []
    const claimed = new Set()
    const skipped = []
    let comparisons = 0
    const roots = [...view.byId.values()].filter((record) => record.layer === 'deep'
        && record.edges.some((edge) => edge.relation === 'consolidates')
        && view.lifecycleOf(record).state === 'active' && !view.summaryReplacedBy.has(record.id)
        && !view.isConsolidated(record) && record.access?.state !== 'dormant')
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    for (const previous of roots) {
        const nodes = new Set()
        const sources = new Map()
        const originalIds = new Set()
        const stopped = new Set()
        let examined = 0
        const visit = (record, path) => {
            if (path.includes(record.id)) { stopped.add('cycle'); return }
            if (nodes.has(record.id)) return
            if (path.length > MAX_DEPTH || nodes.size >= MAX_NODES) { stopped.add('limit'); return }
            if (getProjectId(record) !== getProjectId(previous) || record.kind !== previous.kind) {
                stopped.add('scope-or-kind')
                return
            }
            nodes.add(record.id)
            if (record.layer === 'deep') {
                if (view.summaryReplacedBy.has(record.id)) { stopped.add('retired-summary'); return }
                if (view.lifecycleOf(record).state !== 'active') { stopped.add('inactive-summary'); return }
                if (!record.edges.some((edge) => edge.relation === 'consolidates')) { stopped.add('missing-source'); return }
                for (const edge of record.edges) {
                    if (++examined > MAX_EDGES) { stopped.add('limit'); return }
                    if (edge.relation !== 'consolidates') continue
                    const source = view.byId.get(edge.target)
                    if (!source) { stopped.add('missing-source'); return }
                    visit(source, [...path, record.id])
                }
                return
            }
            originalIds.add(record.id)
            const chain = new Set()
            let current = record
            while (view.replacedBy.has(current.id)) {
                if (chain.has(current.id)) { stopped.add('cycle'); return }
                if (++examined > MAX_EDGES) { stopped.add('limit'); return }
                chain.add(current.id)
                current = view.byId.get(view.replacedBy.get(current.id))
            }
            if (getProjectId(current) !== getProjectId(previous) || current.kind !== previous.kind) {
                stopped.add('scope-or-kind')
                return
            }
            if (view.isCurrent(current)) sources.set(current.id, current)
        }
        visit(previous, [])
        if (stopped.size) { skipped.push({ id: previous.id, reasons: [...stopped] }); continue }
        // 已由别的有效概要承接的证据不能被本轮再次占用。
        if ([...sources.values()].some((record) => claimed.has(record.id)
            || (view.isConsolidated(record) && !nodes.has(record.supersededBy)))) {
            skipped.push({ id: previous.id, reasons: ['source-owned'] })
            continue
        }
        const added = []
        for (const [, candidate] of candidates) {
            if (sources.has(candidate.id) || claimed.has(candidate.id)
                || getProjectId(candidate) !== getProjectId(previous) || candidate.kind !== previous.kind) continue
            if (sources.size + added.length >= MAX_SOURCES) { stopped.add('limit'); break }
            let match = null
            for (const source of sources.values()) {
                if (comparisons >= MAX_COMPARISONS) { stopped.add('comparison-limit'); break }
                comparisons += 1
                const score = similarity(source, candidate)
                if (score >= cfg.consolidateMinSimilarity && (!match || score > match.similarity)) {
                    match = { id: candidate.id, sourceId: source.id, similarity: Math.round(score * 1000) / 1000 }
                }
            }
            if (stopped.size) break
            if (match) added.push({ record: candidate, match })
        }
        if (sources.size > MAX_SOURCES || stopped.size) {
            skipped.push({ id: previous.id, reasons: stopped.size ? [...stopped] : ['limit'] })
            continue
        }
        const changed = [...sources.keys()].some((id) => !originalIds.has(id))
            || [...originalIds].some((id) => !sources.has(id))
        if (!changed && !added.length) continue
        const members = [...added.map((item) => item.record), ...[...sources.values()]
            .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))]
        if (members.length < 2) { skipped.push({ id: previous.id, reasons: ['insufficient-sources'] }); continue }
        const recallTriggers = [...new Map([previous, ...members].flatMap((record) => record.recallTriggers ?? [])
            .map((trigger) => [JSON.stringify(trigger), trigger])).values()]
        if (recallTriggers.length > 4) { skipped.push({ id: previous.id, reasons: ['trigger-limit'] }); continue }
        for (const member of members) claimed.add(member.id)
        plans.push({
            previous, members, recallTriggers, matches: added.map((item) => item.match),
            reason: changed ? '原始来源已纠正或失效，依据当前有效证据重新整理' : '同主题新增证据达到相似度阈值，重新整理原始来源',
        })
    }
    return { plans, claimed, skipped, comparisons }
}
