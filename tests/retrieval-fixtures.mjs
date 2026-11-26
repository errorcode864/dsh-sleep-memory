const AREAS = ['发布流程', '数据迁移', '权限审核', '日志归档', '库存盘点', '账号开通', '索引重建', '任务调度']
const ACTIONS = ['先完成', '重新核对', '暂停执行', '逐步排查', '等待确认', '记录变更', '补充说明', '安排演练']
const OBJECTS = ['备份清单', '服务配置', '恢复步骤', '失败原因', '当前约束', '历史证据', '依赖关系', '操作边界']
const OUTCOMES = ['可用性', '一致性', '响应时间', '资源占用', '异常分支', '重复请求', '审计记录', '适用范围']

/** 不同正文由固定种子生成，避免性能对照只覆盖重复句子。 */
export function createVariedRetrievalRecords(size) {
    return Array.from({ length: size }, (_, position) => {
        let seed = position + 1
        const sentences = []
        for (let index = 0; index < 100; index++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            sentences.push(`${AREAS[seed >>> 29]}${ACTIONS[(seed >>> 20) & 7]}${OBJECTS[(seed >>> 11) & 7]}后核对${OUTCOMES[(seed >>> 2) & 7]}。`)
        }
        const identity = `节点 node-${position} 使用 /srv/service-${position}/配置.yml，端口 ${8000 + position}，retry_limit=-1。`
        return {
            id: `smm_varied_${position}`, content: (identity + sentences.join('')).slice(0, 2000),
            tags: ['演练'], keywords: [`node-${position}`],
        }
    })
}
