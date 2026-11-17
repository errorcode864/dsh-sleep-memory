import { scoreRetrieval } from './memory-retrieval.js'

/** 配置别名按完整短语匹配，技术名称不允许从更长标识符内部命中。 */
export function selectRecallAliases(query, projectId, aliases) {
    const normalized = query.normalize('NFKC').toLowerCase()
    return aliases.filter((alias) => alias.projectId === projectId).filter((alias) => {
        const phrase = alias.phrase.normalize('NFKC').toLowerCase()
        const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`${/^[a-z0-9_$]/.test(phrase) ? '(?<![a-z0-9_$.-])' : ''}${pattern}${/[a-z0-9_$]$/.test(phrase) ? '(?![a-z0-9_$.-])' : ''}`, 'u').test(normalized)
    })
}

/** 本地规划只增加显式项目词表通道，所有候选仍受原问题实体冲突限制。 */
export function planLocalRecall(index, query, projectId, aliases, minCoverage) {
    const matched = selectRecallAliases(query, projectId, aliases)
    const scores = scoreRetrieval(index, query, { automatic: query.trim() !== '', local: true, minCoverage: query.trim() ? minCoverage : 0 })
    const aliasChannels = matched.map((alias) => ({
        phrase: alias.phrase,
        scores: scoreRetrieval(index, alias.target, { automatic: true, local: true, minCoverage }),
    }))
    return {
        scores,
        aliases: scores.map((direct, position) => {
            const hits = aliasChannels.filter((channel) => channel.scores[position].score > 0)
            return {
                score: direct.conflicts.length ? 0 : Math.max(0, ...hits.map((channel) => channel.scores[position].score)),
                phrases: hits.map((channel) => channel.phrase),
            }
        }),
        aliasCount: matched.length,
    }
}
