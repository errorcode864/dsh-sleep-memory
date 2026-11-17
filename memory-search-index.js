import { analyzeFields, buildIndexFromAnalyses } from './memory-retrieval.js'
import { backupChecksum } from './memory-contract.js'

/** 分词投影只随可检索字段更新，访问强化不触发重新分词。 */
export function createLocalSearchIndex() {
    const cache = new Map()
    const state = { queries: 0, reused: 0, rebuilt: 0, cached: 0, lastCandidates: 0 }
    return {
        state,
        build(records) {
            state.queries += 1
            state.lastCandidates = records.length
            const analyses = records.map((record) => {
                const signature = backupChecksum([record.content, record.tags, record.keywords])
                const previous = cache.get(record.id)
                if (previous?.signature === signature) {
                    state.reused += 1
                    return previous.analysis
                }
                const analysis = analyzeFields([record.content, ...record.tags, ...record.keywords])
                cache.set(record.id, { signature, analysis })
                state.rebuilt += 1
                return analysis
            })
            state.cached = cache.size
            return buildIndexFromAnalyses(analyses)
        },
        retain(ids) {
            const current = new Set(ids)
            for (const id of cache.keys()) if (!current.has(id)) cache.delete(id)
            state.cached = cache.size
        },
    }
}
