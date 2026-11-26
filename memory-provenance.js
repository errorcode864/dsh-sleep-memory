import { getProjectId } from './memory-contract.js'
import { estimateTokens } from './memory-metrics.js'

const MAX_EXAMINED_EDGES = 1000
const CONTENT_PREVIEW_CHARS = 300

/** 追溯与递进取证共用同一来源预览契约。 */
export function sourcePreview(source, path, view) {
    return {
        id: source.id, path, depth: path.length - 1, layer: source.layer, kind: source.kind,
        content: source.content.slice(0, CONTENT_PREVIEW_CHARS), truncated: source.content.length > CONTENT_PREVIEW_CHARS,
        leaf: !source.edges.some((link) => link.relation === 'consolidates'),
        current: view.isCurrent(source), state: view.lifecycleOf(source).state,
        accessState: source.access?.state ?? 'awake', sourceKind: source.source?.kind ?? 'unknown',
    }
}

/** 沿巩固关系读取同范围证据并保留首次到达路径。 */
export function traceMemorySources(root, view, limits) {
    const result = {
        action: 'traceSources', rootId: root.id, projectId: getProjectId(root), limits,
        items: [], examinedEdges: 0, complete: false, estimatedTokens: 0,
        stopped: { cycle: 0, duplicate: 0, missing: 0, scope: 0, depth: 0, nodes: 0, tokens: 0, edges: 0 },
    }
    // 为最终计数预留空间以保证完整 JSON 仍在预算内。
    const fitsBudget = () => estimateTokens(JSON.stringify({
        ...result, examinedEdges: MAX_EXAMINED_EDGES, estimatedTokens: limits.maxEstimatedTokens,
        stopped: Object.fromEntries(Object.keys(result.stopped).map((key) => [key, MAX_EXAMINED_EDGES])),
    }, null, 2)) <= limits.maxEstimatedTokens
    if (!fitsBudget()) return { code: 'budget_too_small', message: '追溯预算不足以容纳起点和计数，请增加 maxEstimatedTokens' }
    const seen = new Set([root.id])
    const visit = (record, path) => {
        for (const edge of record.edges) {
            if (result.examinedEdges >= MAX_EXAMINED_EDGES) { result.stopped.edges += 1; return false }
            result.examinedEdges += 1
            if (edge.relation !== 'consolidates') continue
            if (path.includes(edge.target)) { result.stopped.cycle += 1; continue }
            if (seen.has(edge.target)) { result.stopped.duplicate += 1; continue }
            const source = view.byId.get(edge.target)
            if (!source) { result.stopped.missing += 1; continue }
            if (getProjectId(source) !== getProjectId(root)) { result.stopped.scope += 1; continue }
            if (path.length > limits.maxDepth) { result.stopped.depth += 1; continue }
            if (result.items.length >= limits.maxNodes) { result.stopped.nodes += 1; return false }
            const sourcePath = [...path, source.id]
            result.items.push(sourcePreview(source, sourcePath, view))
            if (!fitsBudget()) { result.items.pop(); result.stopped.tokens += 1; return false }
            seen.add(source.id)
            if (!visit(source, sourcePath)) return false
        }
        return true
    }
    visit(root, [root.id])
    result.complete = Object.entries(result.stopped).every(([reason, count]) => reason === 'duplicate' || count === 0)
    result.estimatedTokens = estimateTokens(JSON.stringify({ ...result, estimatedTokens: limits.maxEstimatedTokens }, null, 2))
    return result
}
