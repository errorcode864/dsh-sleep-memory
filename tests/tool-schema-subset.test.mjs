import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness } from './harness.mjs'

/**
 * DSH 注册工具时用 dsh-tools 的 assertSupportedJsonSchema 校验 output.schema；
 * 子集外的关键字（minimum/maximum/minLength/pattern…）或 type 数组会让注册抛错，
 * 整个插件随之加载失败。插件零 npm 依赖、引用不到该校验器，这里镜像同一份规则守住回归。
 */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

function collect(node, path, violations) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        violations.push(`${path} must be a schema object`)
        return
    }
    for (const key of Object.keys(node)) {
        if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
        violations.push(`${path}.${key} is outside the DSH schema subset`)
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
        violations.push(`${path} cannot declare both type and oneOf`)
        return
    }
    if (hasOneOf) {
        for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
        if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
            violations.push(`${path}.oneOf must be an array of at least two schemas`)
            return
        }
        node.oneOf.forEach((branch, index) => collect(branch, `${path}.oneOf[${index}]`, violations))
        return
    }
    if (!hasType) {
        for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
        return
    }
    if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) {
        violations.push(Array.isArray(node.type)
            ? `${path}.type must be a single type string (type arrays are not supported)`
            : `${path}.type must be one of ${[...SCHEMA_TYPES].join('/')}`)
        return
    }
    const allowed = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'] }
    for (const [key, types] of Object.entries(allowed)) {
        if (Object.hasOwn(node, key) && !types.includes(node.type)) violations.push(`${path}.${key} is not supported on type "${node.type}"`)
    }
    if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
        for (const [name, property] of Object.entries(node.properties)) collect(property, `${path}.properties.${name}`, violations)
    }
    if (node.type === 'object' && Array.isArray(node.required) && typeof node.properties === 'object') {
        for (const name of node.required) {
            if (!Object.hasOwn(node.properties, name)) violations.push(`${path}.required names "${name}" which is not in properties`)
        }
    }
    if (node.type === 'array' && Object.hasOwn(node, 'items')) collect(node.items, `${path}.items`, violations)
}

/** @returns {string[]} 子集违规项；空数组表示 schema 可以注册。 */
function subsetViolations(schema) {
    const violations = []
    collect(schema, 'schema', violations)
    return violations
}

const registeredTools = async () => {
    const h = createHarness()
    const tools = [...h.tools.values()]
    await h.dispose()
    return tools
}

test('注册的每个工具 schema 都落在 DSH 支持子集内', async () => {
    const tools = await registeredTools()
    assert.ok(tools.length >= 4, '至少注册写入、召回、睡眠与管理四个工具')
    for (const definition of tools) {
        assert.deepEqual(subsetViolations(definition.parameters), [], `${definition.name} parameters`)
        assert.deepEqual(subsetViolations(definition.output.schema), [], `${definition.name} output.schema`)
    }
})

test('校验器拒绝子集外关键字与 type 数组', () => {
    assert.match(subsetViolations({ type: 'number', minimum: 0 }).join(), /minimum is outside the DSH schema subset/)
    assert.match(subsetViolations({ type: ['string', 'null'] }).join(), /type arrays are not supported/)
    assert.match(subsetViolations({ type: 'object', properties: { a: { type: 'integer', maximum: 1 } } }).join(), /properties\.a\.maximum/)
    assert.deepEqual(subsetViolations({ oneOf: [{ type: 'string' }, { type: 'null' }] }), [])
})
