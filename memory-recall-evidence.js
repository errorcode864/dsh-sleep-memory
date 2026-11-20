import { randomUUID } from 'node:crypto'
import { getProjectId } from './memory-contract.js'
import { memoryVersion } from './memory-runtime.js'
import { estimateTokens } from './memory-metrics.js'
import { sourcePreview } from './memory-provenance.js'

const MAX_SESSIONS = 200
const MAX_ROOTS = 50
const MAX_EDGES = 1000
const PAGE_SIZE = 5
const RETENTION_MS = 15 * 60 * 1000

/** 取证额度按用户轮次共享且只保存路径、版本和计数。 */
export function createRecallEvidence(cfg) {
    const sessions = new Map()
    const limits = {
        maxDepth: cfg.recallEvidenceMaxDepth,
        maxNodes: cfg.recallEvidenceMaxNodes,
        maxEstimatedTokens: cfg.recallEvidenceMaxEstimatedTokens,
    }
    const state = { requests: 0, returned: 0, estimatedTokens: 0, rejected: {} }
    const current = (session) => session && sessions.get(session.sessionId) === session
        && performance.now() < session.expiresAt
    return {
        state, limits, current,
        begin(sessionId, triggerId) {
            if (!cfg.progressiveRecallEnabled || !sessionId) return null
            const previous = sessions.get(sessionId)
            if (triggerId === '') { sessions.delete(sessionId); return null }
            if (current(previous) && (triggerId === undefined || previous.triggerId === triggerId)) return previous
            const session = {
                sessionId, triggerId, recallId: `evidence_${randomUUID()}`, expiresAt: performance.now() + RETENTION_MS,
                nodes: new Map(), roots: new Set(), usedNodes: 0, usedTokens: 0, examinedEdges: 0,
            }
            sessions.delete(sessionId)
            sessions.set(sessionId, session)
            if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
            return session
        },
        offer(session, records, scope, contextProjectId, view) {
            if (!current(session)) return null
            const rootIds = []
            for (const record of records) {
                if (record.layer !== 'deep' || !view.isCurrent(record)
                    || !record.edges.some((edge) => edge.relation === 'consolidates')) continue
                if (!session.nodes.has(record.id) && session.roots.size < MAX_ROOTS) {
                    session.roots.add(record.id)
                    session.nodes.set(record.id, {
                        path: [record.id], projectId: getProjectId(record), scope, contextProjectId,
                        version: memoryVersion(record, view.lifecycleOf(record), true), offset: 0,
                    })
                }
                if (session.roots.has(record.id)) rootIds.push(record.id)
            }
            return rootIds.length ? { action: 'expandRecall', recallId: session.recallId, rootIds, limits: { ...limits } } : null
        },
        expand(args, sessionId, contextProjectId, view) {
            state.requests += 1
            const reject = (code, message) => {
                state.rejected[code] = (state.rejected[code] ?? 0) + 1
                return { code, message }
            }
            if (Object.keys(args).some((key) => !['action', 'id', 'recallId', 'projectId'].includes(key))
                || typeof args.id !== 'string' || !args.id
                || typeof args.recallId !== 'string' || !/^evidence_[a-f0-9-]{36}$/.test(args.recallId)) {
                return reject('invalid_args', '递进取证必须提供合法的 id、recallId，不能覆盖本轮预算')
            }
            if (!cfg.progressiveRecallEnabled) return reject('disabled', '递进取证尚未开启')
            const session = sessions.get(sessionId)
            if (!current(session) || session.recallId !== args.recallId) {
                return reject('evidence_expired', '取证轮次已失效或不属于当前会话，请重新召回概要')
            }
            const node = session.nodes.get(args.id)
            if (!node) return reject('evidence_not_offered', '只能展开本轮已呈现的概要或已发现的来源')
            if (node.scope !== args.projectId || node.contextProjectId !== contextProjectId) {
                return reject('evidence_scope_changed', '当前项目范围已变化，请在新一轮重新召回概要')
            }
            // 每次逐层请求重新核对整条已发现路径以阻止旧概要继续取证。
            for (const [index, id] of node.path.entries()) {
                const record = view.byId.get(id)
                const known = session.nodes.get(id)
                if (!record || !view.isCurrent(record) || getProjectId(record) !== node.projectId
                    || memoryVersion(record, view.lifecycleOf(record), true) !== known.version
                    || (index > 0 && !view.byId.get(node.path[index - 1]).edges
                        .some((edge) => edge.relation === 'consolidates' && edge.target === id))) {
                    return reject('evidence_changed', '概要或来源版本已变化，本轮旧路径停止取证')
                }
            }
            if (node.path.length > limits.maxDepth) return reject('evidence_depth_limit', '已达到本轮来源展开深度')
            const record = view.byId.get(args.id)
            if (node.offset >= record.edges.length) return reject('evidence_complete', '这条记忆的直接来源已经展开')
            if (session.usedNodes >= limits.maxNodes || session.examinedEdges >= MAX_EDGES) {
                return reject('evidence_budget_exhausted', '本轮来源条数或遍历预算已用尽')
            }
            const result = {
                action: 'expandRecall', recallId: session.recallId, id: args.id, rootId: node.path[0],
                items: [], hasMore: false, estimatedTokens: 0,
                remaining: { nodes: limits.maxNodes - session.usedNodes, estimatedTokens: limits.maxEstimatedTokens - session.usedTokens },
                stopped: { cycle: 0, duplicate: 0, missing: 0, scope: 0, inactive: 0, nodes: 0, tokens: 0, edges: 0 },
            }
            const responseCost = () => estimateTokens(JSON.stringify({
                ...result, hasMore: false, estimatedTokens: limits.maxEstimatedTokens,
                remaining: { nodes: limits.maxNodes, estimatedTokens: limits.maxEstimatedTokens },
                stopped: Object.fromEntries(Object.keys(result.stopped).map((key) => [key, MAX_EDGES])),
            }, null, 2))
            if (responseCost() > result.remaining.estimatedTokens) {
                return reject('evidence_budget_exhausted', '剩余 Token 预算不足以返回来源信息')
            }
            const pending = []
            let offset = node.offset
            let examined = 0
            for (; offset < record.edges.length && result.items.length < PAGE_SIZE; offset += 1) {
                if (session.examinedEdges + examined >= MAX_EDGES) { result.stopped.edges += 1; break }
                examined += 1
                const edge = record.edges[offset]
                if (edge.relation !== 'consolidates') continue
                if (node.path.includes(edge.target)) { result.stopped.cycle += 1; continue }
                if (session.nodes.has(edge.target) || pending.some((item) => item.id === edge.target)) { result.stopped.duplicate += 1; continue }
                const source = view.byId.get(edge.target)
                if (!source) { result.stopped.missing += 1; continue }
                if (getProjectId(source) !== node.projectId) { result.stopped.scope += 1; continue }
                if (!view.isCurrent(source)) { result.stopped.inactive += 1; continue }
                if (session.usedNodes + pending.length >= limits.maxNodes) { result.stopped.nodes += 1; break }
                const path = [...node.path, source.id]
                const preview = sourcePreview(source, path, view)
                result.items.push({ ...preview, expandable: !preview.leaf && preview.depth < limits.maxDepth })
                if (responseCost() > result.remaining.estimatedTokens) { result.items.pop(); result.stopped.tokens += 1; break }
                pending.push({ id: source.id, path, version: memoryVersion(source, view.lifecycleOf(source), true) })
            }
            result.hasMore = offset < record.edges.length && !result.stopped.tokens && !result.stopped.nodes && !result.stopped.edges
            result.estimatedTokens = responseCost()
            node.offset = offset
            for (const item of pending) session.nodes.set(item.id, { ...node, ...item, path: [...item.path], offset: 0 })
            session.usedNodes += pending.length
            session.usedTokens += result.estimatedTokens
            session.examinedEdges += examined
            result.remaining = {
                nodes: limits.maxNodes - session.usedNodes, estimatedTokens: limits.maxEstimatedTokens - session.usedTokens,
            }
            state.returned += pending.length
            state.estimatedTokens += result.estimatedTokens
            return result
        },
    }
}
