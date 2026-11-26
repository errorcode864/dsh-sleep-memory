/** 可访问性独立于事实有效性以保留巩固关系。 */
export function validateMemoryAccess(value) {
    const access = value.access
    if (access === undefined) return []
    if (!access || typeof access !== 'object' || Array.isArray(access)
        || !['deep', 'archive'].includes(value.layer)
        || !['awake', 'dormant'].includes(access.state)
        || !Number.isSafeInteger(access.at) || access.at < 0
        || typeof access.reason !== 'string' || !access.reason.trim() || access.reason.length > 300
        || Object.keys(access).some((key) => !['state', 'at', 'reason', 'lastWake'].includes(key))) {
        return ['access 必须为深层或归档记忆的合法可访问状态']
    }
    if (access.lastWake !== undefined) {
        const wake = access.lastWake
        if (!wake || typeof wake !== 'object' || Array.isArray(wake)
            || !Number.isSafeInteger(wake.at) || wake.at < 0
            || !['context', 'association'].includes(wake.via)
            || (wake.via === 'association' && (typeof wake.fromId !== 'string' || !wake.fromId
                || !Number.isInteger(wake.hops) || wake.hops < 1 || wake.hops > 3))
            || (wake.via === 'context' && (wake.fromId !== undefined || wake.hops !== undefined))
            || Object.keys(wake).some((key) => !['at', 'via', 'fromId', 'hops'].includes(key))) {
            return ['access.lastWake 必须包含合法唤醒时间和路径']
        }
    }
    return []
}

/** 关闭休眠功能后沿用原召回规则但保留历史状态。 */
export function isDormant(record, cfg) {
    return cfg.dormancyEnabled && record.access?.state === 'dormant'
}

/** 只有通过呈现筛选的候选才能结束休眠。 */
export function awakenedRecord(record, wake, now) {
    return {
        ...record, updatedAt: now,
        access: {
            state: 'awake', at: now, reason: wake.via === 'context' ? '情境条件命中并通过呈现筛选' : '关联路径命中并通过呈现筛选',
            lastWake: { at: now, ...wake },
        },
    }
}
