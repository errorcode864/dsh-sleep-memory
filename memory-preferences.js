const RESPONSE = /(?:回复|回答|答复|交流|沟通|输出|response|reply|respond|answer)/iu
const LANGUAGE = /(?:简体中文|繁体中文|中文|汉语|英文|英语|日语|日文|韩语|法语|德语|西班牙语|chinese|english|japanese|french|german|spanish)/iu

/** 只识别带用户来源的语言偏好且不从项目文档或工具指令推导。 */
export function responseLanguagePreference(record) {
    if (record.kind !== 'fact' || record.layer === 'deep') return false
    const evidence = record.source?.kind === 'user' && record.source.confirmed === true ? record.content
        : !record.replaces && record.learning?.category === 'preference'
            ? record.learning.evidence.map((item) => item.quote).join('\n') : ''
    if (!evidence || !LANGUAGE.test(record.content)
        || /(?:[“”「」『』"`]|日志|引用|假设|是不是|是否|能否|这次|本次|仅此|暂时|今天|不要|不必|别用|don't|only this)/iu.test(evidence)) return false
    return LANGUAGE.test(evidence) && (RESPONSE.test(evidence) || /^(?:请|以后|今后|一直|默认|尽量|\s)*(?:用|使用).{1,12}[。.!！\s]*$/u.test(evidence))
}

/** 类别匹配补足语言问法的词面差异且不扩展到编程语言讨论。 */
export function matchPreferenceContext(record, query) {
    if (!responseLanguagePreference(record)) return null
    const normalized = query.normalize('NFKC').toLowerCase()
    if (/[“”「」『』"`]|编程语言|程序语言|开发语言|programming|代码语言|语言模型|文档|翻译|translate/iu.test(normalized)) return null
    const languageQuestion = /(?:语言|语种|哪种话|哪国话|什么话|language)/iu.test(normalized)
        && (RESPONSE.test(normalized) || /(?:我|你|偏好|习惯|默认|prefer|my|you)/iu.test(normalized))
    const explicitLanguage = RESPONSE.test(normalized) && LANGUAGE.test(normalized)
    if (!languageQuestion && !explicitLanguage) return null
    // 新请求指定相反语言或否定旧偏好时不能借类别加分压过当前要求。
    if (/(?:不要|不必|别用|don't)/iu.test(normalized) || (explicitLanguage
        && normalized.match(LANGUAGE)[0].toLowerCase() !== record.content.match(LANGUAGE)?.[0].toLowerCase())) return null
    return { category: 'response-language', reason: '用户语言偏好与当前语言选择任务相关' }
}

const PREFERENCE_VALUES = [
    { category: 'response-language', value: 'zh-hans', pattern: /简体中文|简体汉语|simplified chinese/iu },
    { category: 'response-language', value: 'zh-hant', pattern: /繁体中文|繁体汉语|traditional chinese/iu },
    { category: 'response-language', value: 'zh', pattern: /中文|汉语|chinese/iu },
    { category: 'response-language', value: 'en', pattern: /英文|英语|\benglish\b/iu },
    { category: 'response-language', value: 'ja', pattern: /日文|日语|\bjapanese\b/iu },
    { category: 'response-language', value: 'ko', pattern: /韩文|韩语|\bkorean\b/iu },
    { category: 'response-language', value: 'fr', pattern: /法文|法语|\bfrench\b/iu },
    { category: 'response-language', value: 'de', pattern: /德文|德语|\bgerman\b/iu },
    { category: 'response-language', value: 'es', pattern: /西班牙语|\bspanish\b/iu },
    { category: 'response-detail', value: 'concise', pattern: /简短|简洁|精简|少说|concise|brief/iu },
    { category: 'response-detail', value: 'detailed', pattern: /详细|详尽|展开|具体步骤|detailed|in detail/iu },
    { category: 'response-format', value: 'list', pattern: /列表|分点|要点|bullet|list/iu },
    { category: 'response-format', value: 'paragraph', pattern: /连续段落|自然段|paragraph|prose/iu },
    { category: 'response-format', value: 'table', pattern: /表格|\btable\b/iu },
]

/** 语言变体保留精度且通用中文能与具体字形兼容。 */
function samePreference(left, right) {
    return left === right || ([left, right].includes('zh') && left.startsWith('zh') && right.startsWith('zh'))
}

/** 从有来源的单一表达偏好派生类别以避免回写历史资料。 */
export function deriveResponsePreference(record) {
    if (record.kind !== 'fact' || record.layer === 'deep' || record.source?.kind === 'tool') return null
    const evidence = record.source?.kind === 'user' && record.source.confirmed === true ? record.content
        : !record.replaces && record.learning?.category === 'preference'
            ? record.learning.evidence.map((item) => item.quote).join('\n') : ''
    if (!evidence || /[“”「」『』"`]|日志|引用|假设|是不是|是否|能否|这次|本次|仅此|暂时|今天|这回|如果|当.+时|仅在|只有|不要|不必|别用|\b(?:if|when|only|today|don't)\b|this time/iu.test(evidence)) return null
    if (!/^(?:请|以后|今后|后续|默认|一直|平时|通常|尽量|我|回复|回答|答复|用|使用|please\b|i\b|my\b|always\b|reply\b|respond\b)/iu.test(evidence.trim())) return null
    if (!RESPONSE.test(evidence) && !/^(?:请|以后|今后|一直|默认|尽量|\s)*(?:用|使用).{1,12}[。.!！\s]*$/u.test(evidence)) return null
    const matches = PREFERENCE_VALUES.filter((item) => item.pattern.test(evidence))
        .filter((item) => item.value !== 'zh' || !/简体|繁体|simplified|traditional/iu.test(evidence))
    if (matches.length !== 1 || !matches[0].pattern.test(record.content)) return null
    const current = PREFERENCE_VALUES.filter((item) => item.pattern.test(record.content))
        .filter((item) => item.value !== 'zh' || !/简体|繁体|simplified|traditional/iu.test(record.content))
    if (current.length !== 1 || !samePreference(current[0].value, matches[0].value)) return null
    return { category: matches[0].category, value: matches[0].value }
}

/** 当前明确要求覆盖本轮偏好而不改写长期记录。 */
function preferenceOverridden(preference, query) {
    const text = query.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|`[^`]*`/gu, '')
    if (/只(?:给|输出|返回).{0,8}(?:代码|命令|json|数字)|(?:code|json|command) only|only (?:return|output)/iu.test(text)) return true
    const choices = PREFERENCE_VALUES.filter((item) => item.category === preference.category && item.pattern.test(text))
        .filter((item) => item.value !== 'zh' || !/简体|繁体|simplified|traditional/iu.test(text))
    if (!choices.length) return false
    if (preference.category === 'response-language'
        && !/(?:用|使用|以|换成|改为|翻译成).{0,12}(?:中文|英文|英语|汉语|日语|日文|韩语|法语|德语|西班牙语)|(?:reply|respond|answer|translate).{0,18}(?:chinese|english|japanese|french|german|spanish|korean)/iu.test(text)) return false
    if (preference.category === 'response-detail' && !/回答|回复|解释|说明|介绍|总结|讲|展开|answer|respond|explain|brief|detail/iu.test(text)) return false
    if (preference.category === 'response-format' && !/回答|回复|输出|用|写成|列出|整理成|answer|respond|output|use/iu.test(text)) return false
    if (/不要|不必|别用|不使用|don't|do not|without/iu.test(text)) return true
    return choices.some((item) => !samePreference(item.value, preference.value))
}

/** 同类别项目偏好优先且未裁决冲突不会转成自动指令。 */
export function planResponsePreferences(records, query, projectId) {
    const entries = records.map((record) => ({ record, preference: deriveResponsePreference(record) }))
        .filter((entry) => entry.preference)
    const groups = new Map()
    const projectCategories = new Set()
    for (const entry of entries) {
        const key = JSON.stringify([entry.record.projectId ?? null, entry.preference.category])
        if (!groups.has(key)) groups.set(key, new Set())
        groups.get(key).add(entry.preference.value)
        if (projectId != null && entry.record.projectId === projectId) projectCategories.add(entry.preference.category)
    }
    const matches = new Map()
    const suppressed = new Set()
    for (const entry of entries) {
        const values = groups.get(JSON.stringify([entry.record.projectId ?? null, entry.preference.category]))
        const conflicted = values.size - Number(values.has('zh') && (values.has('zh-hans') || values.has('zh-hant'))) > 1
        const projectPreferred = projectId != null && entry.record.projectId == null
            && projectCategories.has(entry.preference.category)
        if (projectPreferred || conflicted || preferenceOverridden(entry.preference, query)) {
            suppressed.add(entry.record.id)
            continue
        }
        matches.set(entry.record.id, { ...entry.preference, reason: '用户长期表达偏好适用于本轮回复且当前要求优先' })
    }
    return { matches, suppressed }
}
