import { backupChecksum, validateMetadata } from './memory-contract.js'

/** 运行元数据单独存储，旧记忆域的表结构与版本保持兼容。 */
export const runtimeDomainSpec = {
    name: 'memory_runtime',
    version: 1,
    layout: 'per-record',
    tables: {
        records: {
            valueSchema: {
                parse(value) {
                    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string') {
                        throw new Error('记忆运行记录格式不合法')
                    }
                    if (value.kind === 'binding') {
                        if (!isSessionId(value.sessionId) || value.id !== bindingKey(value.sessionId)
                            || !Object.hasOwn(value, 'projectId') || validateMetadata(value).length
                            || typeof value.released !== 'boolean' || !Number.isSafeInteger(value.updatedAt)) {
                            throw new Error('会话项目绑定格式不合法')
                        }
                    } else if (value.kind === 'schedule' && value.id === 'schedule') {
                        for (const key of ['lastSuccessAt', 'lastAttemptAt', 'retryAt']) {
                            if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
                                throw new Error(`睡眠调度 ${key} 格式不合法`)
                            }
                        }
                        if (!Number.isInteger(value.failures) || value.failures < 0
                            || (value.lastError !== null && typeof value.lastError !== 'string')) {
                            throw new Error('睡眠失败记录格式不合法')
                        }
                    } else {
                        throw new Error('记忆运行记录类型不合法')
                    }
                    return value
                },
            },
        },
    },
}

export function isSessionId(value) {
    return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200
}

/** per-record 后端直接以键生成文件名，使用摘要避免冒号、斜杠等非法路径字符。 */
export function bindingKey(sessionId) {
    return `binding_${backupChecksum(sessionId)}`
}

/** 宿主 Agent 身份等于 session.id；不从消息正文或工作目录猜测身份。 */
export function getSessionId(context) {
    const id = context?.agent?.session?.id ?? context?.agent?.id
    return isSessionId(id) ? id : null
}

export function listWorkspaceScopes(ctx) {
    const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return []
    return registry.list().filter((workspace) => isSessionId(workspace.id) && workspace.id.length <= 190).map((workspace) => ({
        workspaceId: workspace.id,
        projectId: `workspace:${workspace.id}`,
        title: workspace.title || workspace.id,
        sessionIds: [...workspace.sessionIds].filter(isSessionId),
    }))
}

/** 所有入口共享范围优先级；显式 null 始终表示全局。 */
export function resolveMemoryScope(args, sessionId, table, cfg, workspaces) {
    if (Object.hasOwn(args, 'projectId')) {
        return { projectId: args.projectId, source: 'explicit', sessionId }
    }
    const binding = sessionId ? table.get(bindingKey(sessionId)) : null
    if (binding && !binding.released) return { projectId: binding.projectId, source: 'session', sessionId }
    const workspace = sessionId ? workspaces.find((item) => item.sessionIds.includes(sessionId)) : null
    if (workspace) return { projectId: workspace.projectId, source: 'workspace', sessionId, workspaceId: workspace.workspaceId }
    return { projectId: cfg.projectId || null, source: cfg.projectId ? 'config' : 'global', sessionId }
}

export function initialSchedule() {
    return {
        id: 'schedule', kind: 'schedule', lastSuccessAt: null, lastAttemptAt: null,
        retryAt: null, failures: 0, lastError: null,
    }
}

/** 失败退避从一分钟起步，封顶一小时，重启仍尊重已记录的重试时刻。 */
export function failedSchedule(previous, error, now) {
    const failures = previous.failures + 1
    return {
        ...previous, lastAttemptAt: now, failures,
        retryAt: now + Math.min(3_600_000, 60_000 * 2 ** Math.min(failures - 1, 6)),
        lastError: String(error.message ?? error).slice(0, 1000),
    }
}

export function nextSleepTime(state, cfg, loadedAt, now = Date.now()) {
    if (cfg.sleepIntervalMinutes <= 0) return null
    if (state.retryAt !== null) return Math.max(now, state.retryAt)
    const due = (state.lastSuccessAt ?? loadedAt) + cfg.sleepIntervalMinutes * 60_000
    if (due > now) return due
    return cfg.sleepOnStart ? now : now + cfg.sleepIntervalMinutes * 60_000
}

/** 内容版本排除强化计数，避免一次召回令相同正文绕过去重。 */
export function memoryVersion(record, lifecycle) {
    return backupChecksum({
        id: record.id, content: record.content, gist: record.gist,
        projectId: record.projectId ?? null, source: record.source, lifecycle,
        replaces: record.replaces, layer: record.layer,
    })
}

/** 会话级有限缓存；无稳定会话 ID 时禁用跨轮去重，避免不同会话互相抑制。 */
export function createInjectionTracker(maxSessions = 200, maxEntries = 200) {
    const sessions = new Map()
    return {
        begin(sessionId, projectId, triggerId) {
            if (!sessionId) return { turn: 0, entries: new Map() }
            const key = JSON.stringify([sessionId, projectId])
            let session = sessions.get(key)
            if (!session) session = { turn: 0, entries: new Map(), triggerId: null }
            if (!triggerId || session.triggerId !== triggerId) {
                session.turn += 1
                session.triggerId = triggerId
            }
            sessions.delete(key)
            sessions.set(key, session)
            if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
            return session
        },
        seen(session, version, repeatAfter) {
            const turn = session.entries.get(version)
            return repeatAfter > 0 && turn !== undefined && session.turn - turn < repeatAfter
        },
        remember(session, versions) {
            for (const version of versions) {
                session.entries.delete(version)
                session.entries.set(version, session.turn)
            }
            while (session.entries.size > maxEntries) session.entries.delete(session.entries.keys().next().value)
        },
    }
}
