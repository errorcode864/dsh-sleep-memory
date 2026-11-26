/** 触发条件只接受可索引的具体线索以避免每轮扫描全库给模型判断。 */
export function validateRecallTriggers(triggers) {
    if (triggers === undefined) return []
    if (!Array.isArray(triggers) || triggers.length > 4 || triggers.some((trigger) =>
        !trigger || typeof trigger !== 'object' || Array.isArray(trigger)
        || Object.keys(trigger).some((key) => !['when', 'cues'].includes(key))
        || typeof trigger.when !== 'string' || !trigger.when.trim() || trigger.when.length > 200
        || !Array.isArray(trigger.cues) || trigger.cues.length < 1 || trigger.cues.length > 8
        || trigger.cues.some((cue) => typeof cue !== 'string' || cue !== cue.trim() || cue.length < 2
            || cue.length > 80 || !/\p{L}/u.test(cue)))) {
        return ['recallTriggers 必须为最多 4 条包含 when 和 1 至 8 个具体 cues 的情境条件']
    }
    return []
}

/** 完整短语命中才激活条件且英文技术实体不接受组件碰撞。 */
export function matchRecallTriggers(record, query) {
    const normalized = query.normalize('NFKC').toLowerCase()
    return (record.recallTriggers ?? []).flatMap((trigger) => {
        const cues = trigger.cues.filter((cue) => {
            const phrase = cue.normalize('NFKC').toLowerCase()
            const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const start = /^[a-z0-9_]/.test(phrase) ? '(?<![a-z0-9_$.-])' : ''
            const end = /[a-z0-9_]$/.test(phrase) ? '(?![a-z0-9_$.-])' : ''
            return new RegExp(`${start}${escaped}${end}`, 'u').test(normalized)
        })
        return cues.length ? [{ when: trigger.when, cues }] : []
    })
}

export const RECALL_TRIGGERS_SCHEMA = {
    type: 'array', description: '可选情境条件；when 说明用途，cues 为当前用户消息中可匹配的具体短语',
    items: {
        type: 'object', properties: {
            when: { type: 'string' },
            cues: { type: 'array', items: { type: 'string' } },
        },
        required: ['when', 'cues'], additionalProperties: false,
    },
}
