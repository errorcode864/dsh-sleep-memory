const MAX_ENTRIES = 128

/** 缓存只保存输入摘要和已完成审核的 ID 集合且在重载时清空。 */
export function createReviewCache(seconds) {
    const entries = new Map()
    const state = { hits: 0, misses: 0, entries: 0 }
    return {
        state,
        read(key) {
            const cached = entries.get(key)
            if (!cached || cached.expiresAt <= performance.now()) {
                entries.delete(key)
                state.entries = entries.size
                state.misses += 1
                return null
            }
            // 移动到末尾只更新淘汰顺序而不延长有效期。
            entries.delete(key)
            entries.set(key, cached)
            state.hits += 1
            return new Set(cached.accepted)
        },
        write(key, accepted) {
            entries.delete(key)
            entries.set(key, { accepted: [...accepted], expiresAt: performance.now() + seconds * 1000 })
            if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
            state.entries = entries.size
        },
    }
}
