import { randomUUID } from 'node:crypto'

export const GUI_BACKUP_LIMIT = 10 * 1024 * 1024
const MAX_TRANSFER_BYTES = 160 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const IDLE_TIMEOUT_MS = 15 * 60 * 1000
const INPUT_FIELDS = {
    start: ['action', 'bytes'],
    append: ['action', 'transferId', 'offset', 'data'],
    preview: ['action', 'transferId'],
    confirm: ['action', 'transferId', 'planToken'],
}

/** 大文件仅在界面会话中暂存，确认后仍交由原有恢复计划写入。 */
export function createBackupTransfer(manage, fail) {
    let transfer
    let timer
    const dispose = () => {
        clearTimeout(timer)
        transfer = undefined
    }
    const refresh = () => {
        clearTimeout(timer)
        timer = setTimeout(dispose, IDLE_TIMEOUT_MS).unref()
    }

    const run = async (input) => {
        if (typeof input?.action !== 'string' || !Object.hasOwn(INPUT_FIELDS, input.action)
            || Object.keys(input).some((key) => !INPUT_FIELDS[input.action].includes(key))) {
            throw fail('bad-request', '不支持该备份分片操作')
        }
        if (input.action === 'start') {
            if (!Number.isSafeInteger(input.bytes) || input.bytes <= GUI_BACKUP_LIMIT || input.bytes > MAX_TRANSFER_BYTES) {
                throw fail('bad-request', '大文件通道仅接受超过 10 MiB 且不超过 160 MiB 的 v4 备份')
            }
            // 重新选择文件可以替换旧上传，但不能打断预演或已经授权的写入。
            if (transfer?.busy) throw fail('backup-transfer-busy', '正在处理备份，请等待当前操作结束')
            transfer = { id: randomUUID(), buffer: Buffer.allocUnsafe(input.bytes), received: 0 }
            refresh()
            return { transferId: transfer.id, chunkBytes: CHUNK_BYTES }
        }
        const current = transfer
        if (!current || input.transferId !== current.id) {
            throw fail('backup-transfer-expired', '备份上传已失效，请重新预演')
        }
        if (input.action === 'confirm') {
            // 凭据必须来自这次上传的预演，不能从别的文件或旧上传借用。
            if (!current.planToken || input.planToken !== current.planToken) {
                throw fail('confirmation_required', '请使用本次备份预演返回的确认凭据')
            }
            if (current.confirmation) return current.confirmation
            current.busy = true
            clearTimeout(timer)
            current.confirmation = manage({ action: 'import', backup: current.backup, dryRun: false, planToken: current.planToken })
                .then((result) => {
                    current.backup = undefined
                    current.busy = false
                    if (transfer === current) refresh()
                    return result
                }, (error) => {
                    if (transfer === current) dispose()
                    throw error
                })
            return current.confirmation
        }
        if (!current.buffer || current.busy) {
            throw fail('backup-transfer-state', '备份已进入预演或确认阶段，不能继续上传')
        }
        if (input.action === 'append') {
            const bytes = Math.min(CHUNK_BYTES, current.buffer.length - current.received)
            if (input.offset !== current.received || bytes === 0 || typeof input.data !== 'string'
                || input.data.length !== Math.ceil(bytes / 3) * 4) {
                throw fail('invalid-backup-chunk', '备份分片顺序或长度不正确')
            }
            const chunk = Buffer.from(input.data, 'base64')
            if (chunk.length !== bytes || chunk.toString('base64') !== input.data) {
                throw fail('invalid-backup-chunk', '备份分片不是有效的 Base64 数据')
            }
            chunk.copy(current.buffer, current.received)
            current.received += chunk.length
            refresh()
            return { received: current.received }
        }
        if (current.received !== current.buffer.length) throw fail('backup-upload-incomplete', '备份尚未上传完整')
        let backup
        try {
            backup = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.buffer))
        } catch {
            dispose()
            throw fail('invalid_args', '备份不是有效的 UTF-8 JSON 文件')
        }
        current.buffer = undefined
        if (backup?.version !== 4) {
            dispose()
            throw fail('invalid_args', '大文件通道仅支持 v4 备份')
        }
        current.busy = true
        clearTimeout(timer)
        try {
            const plan = await manage({ action: 'import', backup, dryRun: true })
            current.backup = backup
            current.planToken = plan.planToken
            return plan
        } catch (error) {
            if (transfer === current) dispose()
            throw error
        } finally {
            current.busy = false
            if (transfer === current) refresh()
        }
    }
    return { run, dispose }
}
