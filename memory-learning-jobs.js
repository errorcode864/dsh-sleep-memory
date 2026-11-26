import { backupChecksum, createRecordView } from './memory-contract.js'

const POLICY_VERSION = 'evidence-v1'

/** 来源键不含助手答案，重放同一已完成轮次仍能找到原任务。 */
export function learningJobKey(sessionId, turn, projectId) {
    return `learning_${backupChecksum({
        policy: POLICY_VERSION, sessionId, turn: turn.turn, projectId,
        messages: turn.messages.filter((message) => message.role === 'user').map((message) => message.id),
    })}`
}

export function learningJobsDomainSpec(parseRecord) {
    return {
        name: 'memory_learning_jobs', version: 1, layout: 'per-record',
        tables: {
            records: {
                valueSchema: {
                    parse(value) {
                        if (!value || typeof value !== 'object' || Array.isArray(value)
                            || typeof value.id !== 'string' || !/^learning_[a-f0-9]{64}$/.test(value.id)
                            || !['ready', 'complete'].includes(value.state) || value.policy !== POLICY_VERSION
                            || typeof value.sessionId !== 'string' || !value.sessionId
                            || (value.projectId !== null && typeof value.projectId !== 'string')
                            || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)
                            || !Number.isSafeInteger(value.at) || value.at < 0
                            || !Array.isArray(value.memories) || value.memories.length > 5) {
                            throw new Error('学习任务格式不合法')
                        }
                        const ids = new Set()
                        for (const record of value.memories) {
                            parseRecord(record)
                            if (ids.has(record.id) || (record.projectId ?? null) !== value.projectId
                                || record.source?.sessionId !== value.sessionId || !record.learning) {
                                throw new Error('学习任务的候选来源或范围不一致')
                            }
                            ids.add(record.id)
                        }
                        return value
                    },
                },
            },
        },
    }
}

/** 先落完整候选再写事实，跨域中断依靠固定 ID 继续而不是再次抽取。 */
export function createLearningJobs({ jobs, records, resolveScope, state, maxRecords }) {
    async function commit(job) {
        const table = await records()
        const storedBefore = state.stored
        if ((await resolveScope({}, job.sessionId)).projectId !== job.projectId) {
            state.skipped += 1
            state.lastReason = '待恢复学习任务的会话范围已改变'
            return
        }
        for (const record of job.memories) {
            if (table.get(record.id)) continue
            if ([...table.entries()].some(([, existing]) => (existing.projectId ?? null) === job.projectId
                && existing.content.normalize('NFKC').replace(/\s+/g, ' ').trim()
                    === record.content.normalize('NFKC').replace(/\s+/g, ' ').trim())) {
                state.duplicates += 1
                continue
            }
            const view = createRecordView([...table.entries()])
            if (table.size >= maxRecords || record.learning.relatedIds.some((id) =>
                !table.get(id) || !view.isCurrent(table.get(id)))) {
                state.skipped += 1
                continue
            }
            await table.put(record.id, record)
            state.stored += 1
            if (record.lifecycle?.state === 'review') state.reviewRequired += 1
        }
        await (await jobs()).put(job.id, { ...job, state: 'complete' })
        if (!job.memories.length) state.skipped += 1
        state.lastReason = state.stored > storedBefore ? '已保存有来源的可复用记忆'
            : job.memories.length ? '学习任务已处理，本次未新增记忆' : '没有通过价值与来源检查的新记忆'
    }
    return {
        async get(id) { return (await jobs()).get(id) },
        async prepare(id, sessionId, projectId, sourceHash, memories) {
            const job = { id, sessionId, projectId, sourceHash, memories, state: 'ready', policy: POLICY_VERSION, at: Date.now() }
            await (await jobs()).put(id, job)
            return job
        },
        commit,
        async recover() {
            for (const [, job] of (await jobs()).entries()) {
                if (job.state === 'ready') await commit(job)
            }
        },
    }
}
