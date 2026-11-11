import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** 严格存储替身，执行真实 schema、快照语义和可控 I/O 故障。 */
export function createHarness(config = {}, services = {}) {
    let parser
    const data = services.data ?? new Map()
    const runtimeData = services.runtimeData ?? new Map()
    const tools = new Map()
    const handlers = new Map()
    const provided = new Map()
    const effects = []
    const writes = []
    const table = {
        get size() { return data.size },
        get(id) { return structuredClone(data.get(id)) },
        keys() { return [...data.keys()][Symbol.iterator]() },
        entries() { return structuredClone([...data.entries()])[Symbol.iterator]() },
        async put(id, value) {
            parser.parse(value)
            assert.equal(id, value.id, '存储键与记忆 ID 一致')
            await services.beforePut?.(id, value)
            data.set(id, structuredClone(value))
            writes.push({ action: 'put', id })
        },
        async update(id, updater) {
            await services.beforeUpdate?.(id)
            assert.ok(data.has(id), '只能更新已存在的记录')
            const value = updater(structuredClone(data.get(id)))
            parser.parse(value)
            data.set(id, structuredClone(value))
            writes.push({ action: 'update', id })
            return structuredClone(value)
        },
        async delete() { throw new Error('可靠性测试禁止执行遗忘删除') },
    }
    apply({
        storageDomain: {
            open: async (spec) => {
                if (spec.name === 'memory_runtime') {
                    const runtimeTable = {
                        get: (id) => structuredClone(runtimeData.get(id)),
                        entries: () => structuredClone([...runtimeData.entries()])[Symbol.iterator](),
                        async put(id, value) {
                            spec.tables.records.valueSchema.parse(value)
                            await services.beforeRuntimePut?.(id, value)
                            runtimeData.set(id, structuredClone(value))
                        },
                    }
                    for (const value of runtimeData.values()) spec.tables.records.valueSchema.parse(value)
                    return { table: () => runtimeTable, close: async () => {} }
                }
                parser = spec.tables.records.valueSchema
                return { table: () => table, close: async () => {} }
            },
        },
        tools: { register: (definition) => tools.set(definition.name, definition) },
        reflect: { provide: (key, service) => provided.set(key, service) },
        on: (event, handler) => handlers.set(event, handler),
        effect: (effect) => effects.push(effect),
        get: services.get ?? (() => undefined),
        llm: services.llm,
    }, {
        sleepIntervalMinutes: 0, dreamMaxCandidates: 0, salientScoringEnabled: false,
        // 基础契约使用确定性检索；智能管线测试显式启用并提供模型替身。
        autoLearnEnabled: false, recallReviewEnabled: false, ...config,
    })
    return {
        table, data, runtimeData, tools, handlers, writes, api: provided.get('sleepMemoryApi'),
        call: (name, args, execution) => tools.get(name).execute(args, execution),
        async reloadRecords() {
            const stored = JSON.parse(JSON.stringify([...data.values()]))
            for (const record of stored) parser.parse(record)
            return stored
        },
        async dispose() {
            for (const effect of effects) {
                const cleanup = effect()
                if (typeof cleanup === 'function') await cleanup()
            }
        },
    }
}

export function fixture(id, overrides = {}) {
    const now = Date.now()
    return {
        id, kind: 'fact', content: '部署约定。精确参数 UNIQUE_42 必须保存。',
        layer: 'surface', tags: [], keywords: [], importance: 0, strength: 0.6,
        valence: null, arousal: null, accessCount: 0,
        lastAccessAt: now, createdAt: now, updatedAt: now,
        rewriteCount: 0, edges: [], supersededBy: null, gist: null, ...overrides,
    }
}

export function createMessage(text, id = 'message-test') {
    return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

export async function injectMessage(harness, message, context = {}) {
    return harness.handlers.get('agent/pre-step')(
        { step: 1, messages: [message], modelSelection: { provider: 'mock', model: 'mock' }, ...context },
        async () => ({ kind: 'enter', messages: [message] }),
    )
}

export const flushTasks = () => new Promise(setImmediate)

export function mockAffect() {
    return {
        prepareCall: async () => ({
            config: {},
            stream: async function* () {
                yield { type: 'text-delta', text: '{"valence":0.9,"arousal":0.9}' }
                yield { type: 'finish', reason: { kind: 'stop' } }
            },
        }),
    }
}
