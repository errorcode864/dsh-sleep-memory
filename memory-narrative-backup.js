import { backupChecksum, getProjectId, stableJson } from './memory-contract.js'
import { narrativeDomainSpec } from './memory-narrative.js'

/** 导入叙述前核对完整版本链及底稿，旧的适用版本标识原样保留。 */
export function planNarrativeImport(table, values, memories) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error('叙述备份必须为最多 1000 个版本的数组')
    const known = new Map(table.entries())
    const seen = new Set()
    const pending = []
    for (const entry of values) {
        narrativeDomainSpec.tables.records.valueSchema.parse(entry)
        if (seen.has(entry.id)) throw new Error(`叙述备份版本重复：${entry.id}`)
        seen.add(entry.id)
        const existing = known.get(entry.id)
        if (existing && stableJson(existing) !== stableJson(entry)) throw new Error(`本地叙述与备份冲突：${entry.id}`)
        if (existing) continue
        pending.push(entry)
        known.set(entry.id, entry)
    }
    if (known.size > 1000) throw new Error('导入后叙述版本超过全库容量上限')
    const counts = new Map()
    const predecessors = new Map()
    const sources = new Map()
    for (const entry of known.values()) {
        const source = memories.get(entry.memoryId)
        if (!source || getProjectId(source) !== entry.projectId || source.kind !== 'experience'
            || source.layer === 'deep' || source.learning?.category === 'preference'
            || entry.reflections.some((item) => !source.content.includes(item.quote))) {
            throw new Error(`叙述缺少同项目原始经历或逐字引文：${entry.id}`)
        }
        sources.set(source.id, source)
        counts.set(entry.memoryId, (counts.get(entry.memoryId) ?? 0) + 1)
        if (counts.get(entry.memoryId) > 50) throw new Error('导入后单条记忆的叙述版本超过 50 个')
        if (!predecessors.has(entry.memoryId)) predecessors.set(entry.memoryId, new Set())
        // 每段历史只有一个起点且不能分叉，以免导入后丢失版本先后关系。
        if (predecessors.get(entry.memoryId).has(entry.previousId)) throw new Error(`叙述版本关系存在分叉：${entry.id}`)
        predecessors.get(entry.memoryId).add(entry.previousId)
        if (entry.previousId === null) continue
        const previous = known.get(entry.previousId)
        if (!previous || previous.memoryId !== entry.memoryId || previous.projectId !== entry.projectId
            || previous.createdAt >= entry.createdAt) {
            throw new Error(`叙述前序缺失、范围不符或时间顺序错误：${entry.id}`)
        }
    }
    return {
        pending,
        context: backupChecksum({
            sources: [...sources].sort(([a], [b]) => a.localeCompare(b)),
            narratives: [...known].sort(([a], [b]) => a.localeCompare(b)),
        }),
    }
}
