import { isIP } from 'node:net'

const WORD_SEGMENTER = new Intl.Segmenter('zh-Hans', { granularity: 'word' })
const BM25_K1 = 1.2
const BM25_B = 0.75
const STOP_WORDS = new Set([
    '的', '了', '着', '过', '吗', '呢', '吧', '啊', '和', '与', '及', '或', '是', '在', '把', '被',
    '我', '你', '他', '她', '它', '这', '那', '些', '个', '下', '看', '去', '来', '用', '请',
    '可以', '需要', '一下', '看看', '这个', '那个', '这些', '那些', '我们', '你们', '他们',
    '是否', '什么', '怎么', '如何', '现在', '当前', '已经', '之前', '之后', '然后',
    '进行', '使用', '用户', '请问', '帮我', '继续',
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'continue', 'do', 'for', 'from',
    'has', 'have', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'please', 'that',
    'the', 'this', 'to', 'was', 'we', 'with', 'you',
])
const GENERIC_WORDS = new Set([
    '排查', '检查', '查看', '查询', '修改', '处理', '项目', '规范', '配置', '问题',
    '相关', '内容', '信息', '记录', '系统', '功能', '方式', '方案', '测试', '选择',
])

/** 先保护完整技术实体；已识别区域不再拆成普通数字或中文碎片。 */
const TECHNICAL_PATTERN = new RegExp([
    String.raw`(?<url>https?:\/\/[^\s<>"'\x60()，。；！？]+)`,
    String.raw`(?<path>"(?:[a-z]:[\\/]|\/)[^"\r\n]+"|'(?:[a-z]:[\\/]|\/)[^'\r\n]+'|(?<![a-z0-9_$])(?:[a-z]:[\\/]|\.{1,2}[\\/]|\/)(?:[\p{L}\p{N}_.@~%+-]+[\\/])*[\p{L}\p{N}_.@~%+-]+)`,
    String.raw`(?<ipv6>\[[0-9a-f:]+\](?::\d{1,5})?)`,
    String.raw`(?<version>v\d+(?:\.\d+)+(?:[-+][a-z0-9.-]+)?)`,
    String.raw`(?<ip>\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?!\d|\.\d))`,
    String.raw`(?<endpoint>(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5})`,
    String.raw`(?<dotted>[+-]?\d+(?:\.\d+)+(?:[-+][a-z][a-z0-9.-]*)?)`,
    String.raw`(?<identifier>[a-z_$][a-z0-9_$]*(?:[-.][a-z0-9_$]+)*)`,
    String.raw`(?<number>[+-]?\d+)`,
].join('|'), 'giu')

function createAnalysis() {
    return { tokens: new Map(), constraints: new Map() }
}

/** 相同词的原词与弱别名合并，保留最可靠的边界与有限词频。 */
function addToken(analysis, type, value, weight, anchor = true, constraint) {
    if (!value) return
    const key = `${type}:${value}`
    const previous = analysis.tokens.get(key)
    analysis.tokens.set(key, {
        key, type, value, weight: Math.max(previous?.weight ?? 0, weight),
        anchor: anchor || previous?.anchor === true, count: Math.min(8, (previous?.count ?? 0) + 1),
    })
    if (constraint) {
        if (!analysis.constraints.has(constraint)) analysis.constraints.set(constraint, new Set())
        analysis.constraints.get(constraint).add(value)
    }
}

function addWord(analysis, word, weight = 1) {
    const normalized = word.toLowerCase()
    if (STOP_WORDS.has(normalized)) return
    const generic = GENERIC_WORDS.has(normalized)
    addToken(analysis, 'word', normalized, generic ? 0.15 : weight, !generic)
}

/** 中文使用词边界生成词与相邻短语；弱碎片只来自词内，不跨越词边界。 */
function addChinese(analysis, text) {
    for (const run of text.matchAll(/\p{Script=Han}+/gu)) {
        const words = [...WORD_SEGMENTER.segment(run[0])].filter((item) => item.isWordLike).map((item) => item.segment)
        for (let index = 0; index < words.length; index++) {
            const word = words[index]
            if (STOP_WORDS.has(word)) continue
            addWord(analysis, word)
            // 显式单字查询可回查词内细节，自动注入不能只靠这些碎片成立。
            for (const char of word) {
                if (!STOP_WORDS.has(char)) addToken(analysis, 'char', char, 0.08, false)
            }
            if (word.length > 2) {
                for (let offset = 0; offset < word.length - 1; offset++) {
                    addToken(analysis, 'word', word.slice(offset, offset + 2), 0.12, false)
                }
            }
            if (GENERIC_WORDS.has(word)) continue
            let phrase = word
            for (let next = index + 1; next < Math.min(words.length, index + 3); next++) {
                if (STOP_WORDS.has(words[next]) || GENERIC_WORDS.has(words[next])) break
                phrase += words[next]
                if (phrase.length > 10) break
                addToken(analysis, 'word', phrase, 1.4)
            }
        }
    }
}

/** 数字保留原值，只有明确的端口、状态码或字段赋值语境才形成独立召回依据。 */
function addNumber(analysis, value, prefix, suffix = '') {
    addToken(analysis, 'number', value, 0.12, false)
    if (/(?:端口|port|监听|listen)\s*(?:号|为|是|[:=：])?\s*$/iu.test(prefix)
        || /^\s*(?:端口|port\b)/iu.test(suffix)) {
        addToken(analysis, 'port', value, 2.5, true, 'port')
    }
    if (/(?:http(?:\s*(?:状态码|status(?:\s+code)?))?|状态码|响应码|status(?:\s+code)?)\s*(?:为|是|[:=：])?\s*$/iu.test(prefix)
        || /^\s*(?:状态码|响应码|错误)/u.test(suffix)) {
        addToken(analysis, 'status', value, 2.5, true, 'status')
    }
    const assignment = prefix.match(/([a-z_$][a-z0-9_$.-]*)\s*(?:[:=：]|为|是)\s*$/iu)
    if (assignment) {
        const field = assignment[1].toLowerCase()
        addToken(analysis, 'binding', `${field}=${value}`, 3, true, `binding:${field}`)
    }
}

function addAddress(analysis, host, port) {
    const normalizedHost = host.replace(/^\[|\]$/g, '').toLowerCase()
    const addressType = isIP(normalizedHost) ? 'ip' : 'host'
    addToken(analysis, addressType, normalizedHost, 3, true, addressType === 'ip' ? 'ip' : undefined)
    if (port) {
        addToken(analysis, 'endpoint', `${normalizedHost}:${port}`, 4, true, 'endpoint')
        addToken(analysis, 'port', port, 2.5, true, 'port')
        addToken(analysis, 'number', port, 0.12, false)
    }
}

function addIdentifier(analysis, value, weight = 3) {
    const httpStatus = value.match(/^http(\d{3})$/i)
    if (httpStatus) {
        addWord(analysis, 'HTTP')
        addToken(analysis, 'status', httpStatus[1], 2.5, true, 'status')
        return
    }
    const technical = /[_$.\d-]|[a-z][A-Z]/.test(value)
    if (!technical) {
        addWord(analysis, value)
        return
    }
    addToken(analysis, 'identifier', value.toLowerCase(), weight)
    // snake_case、camelCase、连字符组件保留为低权重别名，不能单独触发自动注入。
    const parts = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
    for (const part of parts) {
        if (part.length < 2 || /^\d+$/.test(part) || STOP_WORDS.has(part) || part === value.toLowerCase()) continue
        addToken(analysis, 'word', part, 0.15, false)
    }
}

/** 检索专用分析；不改写原文，也不改变睡眠巩固的相似度算法。 */
export function analyzeRetrievalText(text) {
    const analysis = createAnalysis()
    const input = text.normalize('NFKC')
    let previousEnd = 0
    for (const match of input.matchAll(TECHNICAL_PATTERN)) {
        addChinese(analysis, input.slice(previousEnd, match.index))
        previousEnd = match.index + match[0].length
        const groups = match.groups
        const value = match[0]
        if (groups.url) {
            try {
                const url = new URL(value.replace(/[.,;!?]+$/, ''))
                addToken(analysis, 'url', url.href, 4, true, 'url')
                addAddress(analysis, url.hostname, url.port)
                if (url.pathname !== '/') addToken(analysis, 'path', url.pathname, 3, true, 'path')
            } catch {
                // 畸形 URL 保留整体，不把其中残片当作实体证据。
                addToken(analysis, 'url', value, 0.15, false)
            }
        } else if (groups.path) {
            const path = (value.startsWith('"') || value.startsWith("'")
                ? value.slice(1, -1) : value.replace(/\.+$/, '')).replace(/\\/g, '/')
            const normalizedPath = /^[a-z]:\//i.test(path) ? path.toLowerCase() : path
            addToken(analysis, 'path', normalizedPath, 4, true, 'path')
            const basename = path.split('/').at(-1)
            if (basename && /[a-z]/i.test(basename)) addIdentifier(analysis, basename, 1)
        } else if (groups.ip || groups.ipv6 || groups.endpoint) {
            const address = groups.ipv6
                ? value.match(/^\[([^\]]+)\](?::(\d+))?$/)
                : value.match(/^([^:]+)(?::(\d+))?$/)
            const versionContext = /(?:版本|version)\s*[:=：]?\s*$/iu.test(input.slice(Math.max(0, match.index - 40), match.index))
            if (groups.ip && (!isIP(address[1]) || (!address[2] && versionContext))) {
                addToken(analysis, 'version', value, 3, true, 'version')
            } else {
                addAddress(analysis, address[1], address[2])
            }
        } else if (groups.version || groups.dotted) {
            const prefix = input.slice(Math.max(0, match.index - 40), match.index)
            if (groups.version || (value.match(/\./g)?.length ?? 0) >= 2 || /(?:版本|version)\s*[:=：]?\s*$/iu.test(prefix)) {
                addToken(analysis, 'version', value.replace(/^v/i, '').toLowerCase(), 3, true, 'version')
            } else {
                addNumber(analysis, value, prefix, input.slice(previousEnd, previousEnd + 30))
            }
        } else if (groups.identifier) {
            addIdentifier(analysis, value)
        } else {
            addNumber(analysis, value, input.slice(Math.max(0, match.index - 40), match.index), input.slice(previousEnd, previousEnd + 30))
        }
    }
    addChinese(analysis, input.slice(previousEnd))
    return analysis
}

/** 正文、标签和关键词分别分析，避免拼接字段制造不存在的短语或数字语境。 */
function analyzeFields(fields) {
    const analysis = createAnalysis()
    for (const field of fields) {
        const part = analyzeRetrievalText(field)
        for (const token of part.tokens.values()) {
            for (let count = 0; count < token.count; count++) {
                addToken(analysis, token.type, token.value, token.weight, token.anchor)
            }
        }
        for (const [group, values] of part.constraints) {
            if (!analysis.constraints.has(group)) analysis.constraints.set(group, new Set())
            for (const value of values) analysis.constraints.get(group).add(value)
        }
    }
    return analysis
}

/** 学习时挑选旧记忆也复用相同的词与实体边界。 */
export function retrievalTerms(text) {
    return [...analyzeRetrievalText(text).tokens.values()].filter((token) => token.anchor).map((token) => token.key)
}

export function buildRetrievalIndex(documents) {
    const analyses = documents.map((fields) => analyzeFields(Array.isArray(fields) ? fields : [fields]))
    const frequencies = new Map()
    const lengths = analyses.map((analysis) => {
        let length = 0
        for (const token of analysis.tokens.values()) {
            frequencies.set(token.key, (frequencies.get(token.key) ?? 0) + 1)
            length += token.count * token.weight
        }
        return Math.max(1, length)
    })
    return {
        analyses, frequencies, lengths,
        averageLength: lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length),
    }
}

/** 同类精确实体明确不一致时，普通主题词不能覆盖该冲突；查询扩展也不能绕过。 */
function conflictingEntities(query, document) {
    return [...query.constraints].filter(([group, values]) => {
        const candidates = document.constraints.get(group)
        return candidates && ![...values].some((value) => candidates.has(value))
    }).map(([group]) => group)
}

/** 分层加权 BM25：完整实体优先，覆盖度参与排序，弱碎片不能独立通过自动召回。 */
export function scoreRetrieval(index, queryText, { automatic = false } = {}) {
    const query = analyzeRetrievalText(queryText)
    const primary = [...query.tokens.values()].filter((token) => token.anchor)
    const totalWeight = primary.reduce((sum, token) => sum + token.weight, 0)
    return index.analyses.map((document, position) => {
        const conflicts = conflictingEntities(query, document)
        const matchedTerms = []
        const matchedEntities = []
        let matchedWeight = 0
        let score = 0
        let anchors = 0
        for (const token of query.tokens.values()) {
            const found = document.tokens.get(token.key)
            if (!found) continue
            const documentFrequency = index.frequencies.get(token.key)
            const idf = Math.log(1 + (index.analyses.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
            score += Math.min(token.weight, found.weight) * idf
                * found.count * (BM25_K1 + 1)
                / (found.count + BM25_K1 * (1 - BM25_B + BM25_B * index.lengths[position] / index.averageLength))
            if (token.anchor && found.anchor) {
                anchors++
                matchedWeight += token.weight
                if (token.type === 'word') matchedTerms.push(token.value)
                else matchedEntities.push(token.value)
            }
        }
        const coverage = totalWeight ? matchedWeight / totalWeight : 0
        const eligible = conflicts.length === 0 && (!automatic || anchors > 0)
        return {
            score: eligible ? score * (0.35 + 0.65 * coverage) : 0,
            eligible, conflicts,
            evidence: {
                matchedTerms: matchedTerms.slice(0, 12), matchedEntities: matchedEntities.slice(0, 12),
                coverage: Math.round(coverage * 1000) / 1000,
            },
        }
    })
}
