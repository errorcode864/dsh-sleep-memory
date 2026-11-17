import { analyzeRetrievalText } from './memory-retrieval.js'

/** 摘要直接抽取原句，截断时必须提示模型按 ID 核对完整条件。 */
export function summarizeMemory(record, query, maxChars) {
    if (record.content.length <= maxChars) return { content: record.content, truncated: false }
    const terms = [...analyzeRetrievalText(query).tokens.values()].filter((token) => token.anchor)
    const sentences = record.content.match(/[^\n。！？]+(?:[。！？]+|\n|$)/gu) ?? [record.content]
    const ranked = sentences.map((text, index) => ({
        text: text.trim(), index,
        score: terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term.value) ? term.weight : 0), 0),
    })).sort((a, b) => b.score - a.score || a.index - b.index)
    if (ranked[0].text.length >= maxChars) {
        const matchAt = terms.filter((term) => ranked[0].text.toLowerCase().includes(term.value))
            .sort((a, b) => b.weight - a.weight || b.value.length - a.value.length)[0]
        const position = matchAt ? ranked[0].text.toLowerCase().indexOf(matchAt.value) : 0
        const start = Math.max(0, Math.min(position - 40, ranked[0].text.length - maxChars + 2))
        return { content: `…${ranked[0].text.slice(start, start + maxChars - 2)}…`, truncated: true }
    }
    const selected = [ranked[0]]
    for (const sentence of ranked.slice(1)) {
        if (selected.length >= 3) break
        if (ranked[0].score > 0 && sentence.score === 0) continue
        if (selected.some((item) => item.text === sentence.text)) continue
        if (selected.reduce((sum, item) => sum + item.text.length + 3, 0) + sentence.text.length > maxChars - 1) continue
        selected.push(sentence)
    }
    const content = selected.sort((a, b) => a.index - b.index).map((sentence) => sentence.text).join(' … ')
    return { content: `${content}…`, truncated: true }
}
