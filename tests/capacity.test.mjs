import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness } from './harness.mjs'
import { CAPACITY_CONFIG, CAPACITY_EXPORT, CAPACITY_PROFILES, createCapacityBackup, summarizeCapacitySamples } from './capacity-fixtures.mjs'

test('固定容量样本经真实 v4 预演与恢复保留四域摘要和密集边', async () => {
    for (const profile of Object.keys(CAPACITY_PROFILES)) {
        const backup = createCapacityBackup(20, profile)
        assert.equal(backup.checksum, createCapacityBackup(20, profile).checksum)
        assert.ok(backup.records.every((record) => record.content.length === CAPACITY_PROFILES[profile].chars))
        assert.equal(backup.records.reduce((sum, record) => sum + record.edges.length, 0), 20 * CAPACITY_PROFILES[profile].edges)
        const host = createHarness({ ...CAPACITY_CONFIG, maxRecords: 20 })
        try {
            const plan = await host.api.manage({ action: 'import', backup })
            await host.api.manage({ action: 'import', backup, dryRun: false, planToken: plan.planToken })
            assert.equal((await host.api.manage(CAPACITY_EXPORT)).backup.checksum, backup.checksum)
            assert.equal((await host.api.manage({ action: 'narrativeHistory', id: 'smm_capacity_0', projectId: 'capacity-project' })).items[0].state, 'retracted')
        } finally { await host.dispose() }
    }
})

test('容量报告保留原始样本并使用最近秩分位数', () => {
    const samples = [9, 1, 3, 5, 7]
    assert.deepEqual(summarizeCapacitySamples(samples), { samples, count: 5, p50: 5, p95: 9, max: 9 })
    assert.deepEqual(samples, [9, 1, 3, 5, 7])
})
