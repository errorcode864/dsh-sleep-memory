import { backupChecksum, createRecordView } from '../memory-contract.js'
import { recollectionVersion } from '../memory-recollection.js'
import { fixture } from './harness.mjs'

export const CAPACITY_EXPORT = { action: 'export', includeAudit: true, includeFeedback: true, includeNarratives: true }
export const CAPACITY_QUERY = '定向恢复线索'
export const CAPACITY_CONFIG = {
    sleepIntervalMinutes: 0, sleepOnStart: false, autoLearnEnabled: false, recallReviewEnabled: false,
    semanticRecallEnabled: false, salientScoringEnabled: false, feedbackEnabled: false,
    dreamMaxCandidates: 0, sleepAuditEnabled: true, recallPlanMode: 'local', spreadDepth: 2,
}
export const CAPACITY_PROFILES = {
    short: { chars: 160, edges: 0 },
    long: { chars: 2000, edges: 0 },
    dense: { chars: 600, edges: 16 },
}

/** 固定内容与时间保证同一参数生成相同备份及检索目标。 */
export function createCapacityBackup(size, profile) {
    const spec = CAPACITY_PROFILES[profile]
    const at = 1_795_132_800_000
    const padding = '本次只核对恢复步骤和适用条件，不代表已获得生产上线许可。'
    const records = Array.from({ length: size }, (_, index) => {
        const opening = index === size - 1 ? '定向恢复线索：先核对备份完整性，未确认不得执行。' : '常规演练记录：先核对备份完整性，未确认不得执行。'
        return fixture(`smm_capacity_${index}`, {
            kind: 'experience', projectId: 'capacity-project',
            content: opening + padding.repeat(Math.ceil(spec.chars / padding.length)).slice(0, spec.chars - opening.length),
            keywords: index === size - 1 ? [CAPACITY_QUERY] : [],
            createdAt: at, updatedAt: at, lastAccessAt: at, occurredAt: at, eventEndAt: at, lastDecayAt: at,
            edges: Array.from({ length: Math.min(spec.edges, size - 1) }, (_, offset) => ({
                target: `smm_capacity_${(index + offset + 1) % size}`, relation: 'dream-associate', weight: 0.8,
            })),
        })
    })
    const view = createRecordView(records.map((record) => [record.id, record]))
    const narratives = Array.from({ length: Math.min(1000, size * 4) }, (_, index) => ({
        id: `narrative_${index.toString(16).padStart(64, '0')}`, memoryId: records[Math.floor(index / 4)].id,
        projectId: 'capacity-project', sourceVersion: recollectionVersion(records[Math.floor(index / 4)], view),
        style: 'reflective', reflections: [{ quote: records[Math.floor(index / 4)].content.slice(0, 30), text: '或许应在下次操作前继续核对适用条件。' }],
        reviewReason: '合成基准固定反思，不代表模型生成质量。', provider: 'synthetic', model: 'no-model',
        createdAt: at + index, previousId: index % 4 ? `narrative_${(index - 1).toString(16).padStart(64, '0')}` : null,
        state: index % 4 === 3 ? 'retracted' : 'confirmed', retractedAt: index % 4 === 3 ? at + index + 1 : null,
        policy: 1, requestHash: backupChecksum(['capacity', index]),
    }))
    const feedback = Array.from({ length: Math.min(200, size) }, (_, index) => {
        const id = `exposure_${index.toString(16).padStart(32, '0')}`
        return { id, kind: 'exposure', projectId: 'capacity-project', sessionId: 'capacity-session', at,
            mode: 'explicit', queryHash: backupChecksum(CAPACITY_QUERY),
            items: [{ id: `${id}_0`, memoryId: records[index].id, version: backupChecksum(records[index]) }] }
    })
    const audits = [{
        id: 'sleep_00000000-0000-0000-0000-000000000001', state: 'applied', createdAt: at,
        changes: records.slice(0, 32).map((record) => ({ id: record.id, before: record, after: record })),
        report: { synthetic: true },
    }]
    for (const entries of [records, audits, feedback, narratives]) entries.sort((a, b) => a.id.localeCompare(b.id))
    return {
        format: 'dsh-sleep-memory', version: 4, scope: 'memory-audit-feedback-and-narratives', exportedAt: at,
        records, audits, feedback, narratives, checksum: backupChecksum({ records, audits, feedback, narratives }),
    }
}

/** 小样本分位数只描述本次实测，不推断总体延迟分布。 */
export function summarizeCapacitySamples(samples) {
    const sorted = [...samples].sort((a, b) => a - b)
    const rounded = (value) => Math.round(value * 100) / 100
    return { samples: samples.map(rounded), count: samples.length,
        p50: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
        max: rounded(sorted.at(-1)) }
}
