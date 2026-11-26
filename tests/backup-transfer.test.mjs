import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPACITY_EXPORT, createCapacityBackup } from './capacity-fixtures.mjs'
import { createHarness } from './harness.mjs'

const MIN_BYTES = 10 * 1024 * 1024
const original = createCapacityBackup(10, 'dense')

async function upload(api, backup) {
    const parts = Buffer.from(`${' '.repeat(MIN_BYTES)}${JSON.stringify(backup)}`)
    const { transferId, chunkBytes } = await api.backupTransfer({ action: 'start', bytes: parts.length })
    for (let offset = 0; offset < parts.length; offset += chunkBytes) {
        const data = parts.subarray(offset, offset + chunkBytes)
        assert.equal((await api.backupTransfer({ action: 'append', transferId, offset, data: data.toString('base64') })).received, offset + data.length)
    }
    return transferId
}

test('大文件分片拒绝超限、错误顺序和不完整预演且不会写入', async () => {
    const host = createHarness()
    try {
        for (const bytes of [MIN_BYTES, 160 * 1024 * 1024 + 1, MIN_BYTES + 0.5]) {
            await assert.rejects(host.api.backupTransfer({ action: 'start', bytes }), /160 MiB/)
        }
        const { transferId, chunkBytes } = await host.api.backupTransfer({ action: 'start', bytes: MIN_BYTES + 1 })
        assert.equal(chunkBytes, 256 * 1024)
        const data = Buffer.alloc(chunkBytes).toString('base64')
        const append = { action: 'append', transferId, offset: 0, data }
        await assert.rejects(host.api.backupTransfer({ ...append, offset: 1 }), /顺序或长度/)
        await assert.rejects(host.api.backupTransfer({ ...append, data: `!${data.slice(1)}` }), /Base64/)
        await host.api.backupTransfer(append)
        await assert.rejects(host.api.backupTransfer(append), /顺序或长度/)
        await assert.rejects(host.api.backupTransfer({ action: 'preview', transferId }), /尚未上传完整/)
        await assert.rejects(host.api.backupTransfer({ action: 'confirm', transferId }), /确认凭据/)
        await host.api.backupTransfer({ action: 'start', bytes: MIN_BYTES + 1 })
        await assert.rejects(host.api.backupTransfer({ action: 'preview', transferId }), /已失效/)
        assert.equal(host.writes.length, 0)
    } finally { await host.dispose() }
})

test('大文件预演只接受摘要正确的 v4 且确认不会重复写入', async () => {
    const host = createHarness()
    try {
        for (const [backup, reason] of [
            [{ ...original, version: 3 }, /仅支持 v4/],
            [{ ...original, checksum: '0'.repeat(64) }, /校验摘要/],
        ]) {
            const transferId = await upload(host.api, backup)
            await assert.rejects(host.api.backupTransfer({ action: 'preview', transferId }), reason)
        }
        const transferId = await upload(host.api, original)
        const plan = await host.api.backupTransfer({ action: 'preview', transferId })
        assert.deepEqual([plan.planned, plan.plannedAudits, plan.plannedFeedback, plan.plannedNarratives], [10, 1, 10, 40])
        assert.equal(host.writes.length, 0)
        assert.equal((await host.call('memory_manage', { action: 'import', backup: original, dryRun: false, planToken: plan.planToken })).code, 'forbidden')
        assert.equal((await host.call('memory_manage', { action: 'backupTransfer', transferId, planToken: plan.planToken })).code, 'invalid_args')
        const confirm = { action: 'confirm', transferId, planToken: plan.planToken }
        await assert.rejects(host.api.backupTransfer({ ...confirm, planToken: '错误凭据' }), /确认凭据/)
        const [first, replay] = await Promise.all([host.api.backupTransfer(confirm), host.api.backupTransfer(confirm)])
        assert.equal(first.imported, 10)
        assert.deepEqual(first, replay)
        assert.equal(host.writes.length, 10)
        assert.equal((await host.api.manage(CAPACITY_EXPORT)).backup.checksum, original.checksum)
    } finally { await host.dispose() }
})

test('用户确认后叙述写入中断仍可重载恢复四域历史', async () => {
    const host = createHarness({}, {
        beforeDomainPut: async (name) => {
            if (name === 'memory_narratives') throw new Error('模拟叙述写入中断')
        },
    })
    try {
        const transferId = await upload(host.api, original)
        const plan = await host.api.backupTransfer({ action: 'preview', transferId })
        await assert.rejects(host.api.backupTransfer({ action: 'confirm', transferId, planToken: plan.planToken }), /写入中断/)
        assert.equal(host.domains.get('memory_backup_state').get('restore').state, 'prepared')
        const reloaded = createHarness({}, { data: host.data, domains: host.domains, runtimeData: host.runtimeData })
        try {
            await assert.rejects(reloaded.api.backupTransfer({ action: 'confirm', transferId, planToken: plan.planToken }), /已失效/)
            assert.equal((await reloaded.api.manage(CAPACITY_EXPORT)).backup.checksum, original.checksum)
            assert.equal(reloaded.domains.get('memory_backup_state').get('restore').state, 'complete')
            assert.equal(reloaded.writes.length, 0)
        } finally { await reloaded.dispose() }
    } finally { await host.dispose() }
})
