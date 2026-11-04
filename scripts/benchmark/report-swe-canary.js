import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const names = { 'baseline-default': '原生默认', 'baseline-tuned': '原生调优', plugin: '调优 + 插件' }
const order = Object.keys(names)
const tokenTotal = usage => Object.values(usage).reduce((sum, value) => sum + value, 0)
const number = value => value === null || !Number.isFinite(value) ? '未知' : value.toLocaleString('en-US', { maximumFractionDigits: 9 })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function summarizeCanary(report) {
  const schedule = report.plan?.scheduled ?? []
  const identities = report.tasks.map(task => `${task.group}/${task.repetition}`)
  const complete = schedule.length > 0 && report.finished === true && report.sourceAfterMatches === true && report.tasks.length === schedule.length && new Set(identities).size === schedule.length && schedule.every(slot => identities.includes(`${slot.group}/${slot.repetition}`)) && report.tasks.every(task => task.result?.usageComplete && task.result.costUSD !== null)
  const groups = order.map(group => {
    const rows = report.tasks.filter(task => task.group === group)
    const planned = schedule.filter(slot => slot.group === group).length
    const accountingComplete = planned > 0 && rows.length === planned && rows.every(row => row.result?.usageComplete && row.costCNY !== null)
    const selections = rows.reduce((sum, row) => sum + (row.result?.decisions.filter(decision => decision.outcome === 'selected').length ?? 0), 0)
    return { group, label: names[group], planned, completed: rows.length, agentCompleted: rows.filter(row => row.result?.agentCompleted === true).length, solved: rows.filter(row => row.quality?.resolved === true).length,
      tokens: accountingComplete ? rows.reduce((sum, row) => sum + tokenTotal(row.result.usage), 0) : null,
      costCNY: accountingComplete ? rows.reduce((sum, row) => sum + row.costCNY, 0) : null,
      elapsedMs: rows.reduce((sum, row) => sum + (Date.parse(row.result?.endedAt) - Date.parse(row.result?.startedAt) || 0), 0),
      modelCalls: rows.reduce((sum, row) => sum + (row.result?.modelCalls.length ?? 0), 0), selections }
  })
  const baseline = groups[1], plugin = groups[2]
  const repetitions = [...new Set(schedule.map(slot => slot.repetition))]
  return { complete, groups, repetitions: repetitions.length, plannedSlots: schedule.length, noTaskSolved: groups.every(group => group.solved === 0), tokenSavingsVsTuned: complete && baseline.tokens > 0 ? 1 - plugin.tokens / baseline.tokens : null,
    costSavingsVsTuned: complete && baseline.costCNY > 0 ? 1 - plugin.costCNY / baseline.costCNY : null,
    paired: repetitions.map(repetition => { const rows = report.tasks.filter(row => row.repetition === repetition); const b = rows.find(row => row.group === 'baseline-tuned'), c = rows.find(row => row.group === 'plugin'); return { repetition, baselineResolved: b?.quality?.resolved ?? null, pluginResolved: c?.quality?.resolved ?? null } }) }
}

function overview(summary) {
  const colors = ['#64748b', '#2563eb', '#0f766e']
  const panels = [{ key: 'solved', title: `成功次数 / ${summary.repetitions}`, format: value => `${value}/${summary.repetitions}` }, { key: 'tokens', title: '全部尝试累计 token', format: number }, { key: 'costCNY', title: '费用估算 CNY（统一高峰价）', format: number }]
  let content = '<rect width="1020" height="310" fill="#f8fafc"/><text x="28" y="35" font-size="20" font-weight="700" fill="#0f172a">公开 SWE-bench dev 单题试跑 · 不代表完整基准</text>'
  if (summary.noTaskSolved) content += '<text x="28" y="56" font-size="12" fill="#b91c1c">三组均未通过官方验收 · 尚无保持质量下的节省证据</text>'
  for (let panel = 0; panel < panels.length; panel++) {
    const { key, title, format } = panels[panel], x = 28 + panel * 335
    const max = Math.max(...summary.groups.map(group => group[key] ?? 0), 1e-12)
    content += `<text x="${x}" y="76" font-size="15" font-weight="600">${title}</text>`
    summary.groups.forEach((group, index) => {
      const value = group[key], y = 110 + index * 55, width = value === null ? 0 : value / max * 185
      content += `<text x="${x}" y="${y}" font-size="12">${group.label}</text><rect x="${x}" y="${y + 8}" width="${width}" height="12" rx="3" fill="${colors[index]}"/><text x="${x + 190}" y="${y + 19}" font-size="12">${value === null ? '未知' : format(value)}</text>`
    })
  }
  content += `<text x="28" y="290" font-size="12" fill="#475569">1 个开发任务 × ${summary.repetitions} 次运行 × 3 组；无泛化置信结论，失败与恢复均计入。</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1020" height="310" viewBox="0 0 1020 310" font-family="system-ui, sans-serif">${content}</svg>`
}

export async function writeCanaryReport(inputDirectory, outputDirectory) {
  const root = resolve(inputDirectory), output = resolve(outputDirectory)
  const raw = JSON.parse(await readFile(join(root, 'study-report.json'), 'utf8'))
  const summary = summarizeCanary(raw)
  await mkdir(output, { recursive: false })
  await mkdir(join(output, 'figures'))
  await mkdir(join(output, 'evaluator'))
  const dataset = JSON.parse(await readFile(join(root, 'dataset-lock.json'), 'utf8'))
  const manifest = { version: raw.plan.version, dataset, taskId: raw.plan.taskId, split: 'dev', repetitions: summary.repetitions, productionHead: raw.plan.head, evaluationSourceHash: raw.plan.sourceTreeHash, reportGeneratorHash: sha(await readFile(fileURLToPath(import.meta.url))), gradingHash: raw.plan.gradingHash,
    runtimeLockHash: raw.plan.runtimeLockHash, taskHash: raw.plan.taskHash, evalScriptHash: raw.plan.evalScriptHash, imageId: raw.plan.imageId, profile: raw.plan.profile, limits: raw.plan.limits, thinking: 'disabled', reasoningEffort: 'off',
    scheduled: raw.plan.scheduled, pluginConfiguration: raw.plan.pluginConfiguration, pricing: raw.plan.pricing, cnyPricing: { uncached: 2, cacheRead: .04, output: 8 }, limitations: raw.plan.limitations,
    studyPlanHash: raw.planHash, finished: raw.finished, sourceAfterMatches: raw.sourceAfterMatches, stoppedReason: raw.stoppedReason ?? null }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  const columns = ['slot', 'repetition', 'group', 'resolved', 'agentCompleted', 'usageComplete', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'costCNY', 'modelCalls', 'elapsedMs', 'stop']
  const rows = raw.tasks.map(task => { const result = task.result; return [task.slot, task.repetition, task.group, task.quality.resolved, result?.agentCompleted ?? '', result?.usageComplete ?? false, result?.usage.inputTokens ?? '', result?.usage.cacheReadTokens ?? '', result?.usage.cacheWriteTokens ?? 0, result?.usage.outputTokens ?? '', result?.usageComplete ? tokenTotal(result.usage) : '', task.costCNY ?? '', result?.modelCalls.length ?? '', result ? Date.parse(result.endedAt) - Date.parse(result.startedAt) : '', result?.stoppedReason ?? ''] })
  await writeFile(join(output, 'tasks.csv'), [columns, ...rows].map(row => row.map(value => JSON.stringify(value)).join(',')).join('\n') + '\n')
  const calls = raw.tasks.flatMap(task => (task.result?.modelCalls ?? []).map(call => ({ slot: task.slot, group: task.group, repetition: task.repetition, ...call })))
  await writeFile(join(output, 'calls.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  await writeFile(join(output, 'quality-transitions.json'), JSON.stringify(summary.paired, null, 2) + '\n')
  for (const task of raw.tasks) {
    const directory = join(root, 'runs', `${task.slot}-${task.group}-r${task.repetition}`)
    for (const [source, suffix] of [['model.patch', 'patch'], ['model-calls.jsonl', 'raw-ledger.jsonl'], ['evaluation/official-grade.json', 'official-grade.json'], ['evaluation/test_output.txt', 'test-output.txt']]) {
      try { await copyFile(join(directory, source), join(output, 'evaluator', `${task.slot}.${suffix}`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  await writeFile(join(output, 'figures/overview.svg'), overview(summary))
  const pct = value => value === null ? '未知' : `${(value * 100).toFixed(1)}%`
  const table = ['| 配置 | 官方解决次数 | Agent正常结束 | 累计 token | 费用估算 CNY | 模型调用 | 策略选择次数 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...summary.groups.map(group => `| ${group.label} | ${group.solved}/${group.completed}（计划${group.planned}） | ${group.agentCompleted}/${group.completed} | ${number(group.tokens)} | ${number(group.costCNY)} | ${group.modelCalls} | ${group.selections} |`)].join('\n')
  const report = `# 公开 SWE-bench 开发任务真实试跑\n\n研究状态：${summary.complete ? `${summary.plannedSlots}/${summary.plannedSlots}计划槽位已结束且用量齐全` : '不完整；不发布总体节省结论'}。任务：\`${raw.plan.taskId}\`，split=dev，唯一任务数1，三组各${summary.repetitions}次。\n\n本批仅运行官方 AgentLoop、显式 bash/read 工具与原生 spill；不代表完整 dsh CLI 默认 profile，也未覆盖其所有摘要/会话能力。表中原生默认/调优指该受限 profile 的 spill 配置。\n\n${table}\n\n${summary.noTaskSolved ? "三组均未解决该题，不能据本批数据声称保持任务质量的token收益。" : "质量结论仅限本批观测；单题不能证明一般任务无损。"}\n\n相对调优组，尝试累计token减少率：${pct(summary.tokenSavingsVsTuned)}；费用估算减少率：${pct(summary.costSavingsVsTuned)}。负数表示增加。质量应结合上表和[逐次得失](quality-transitions.json)判断，不能由省token推断质量保持。\n\n![试跑概览](figures/overview.svg)\n\n这是单个公开开发任务的描述性结果，不是SWE-bench Verified test成绩，也不证明一般任务质量或稳定节省比例；不对单题给泛化置信区间。使用官方dsh AgentLoop的受限bash/read profile，未运行完整CLI。插件配置见manifest，provider缓存未隔离。\n\n累计token包含已发生模型调用、错误、恢复及重复携带；费用按2026-10-29官方统一高峰价估算，不是充值扣款。原生调优与插件同为1200 inline token，默认组12500。策略选择次数来自selected事件，仅作机制诊断，不等于已持久化并被模型采用。没有策略选择时不把随机运行差异归因于压缩；存在选择时也需另核对最终模型输入，不能把全部差异归因于压缩。\n\n生产源码HEAD：\`${raw.plan.head}\`；评测代码hash：\`${raw.plan.sourceTreeHash}\`。实际镜像ID：\`${raw.plan.imageId}\`。官方任务仓库和评分源码版本见[manifest](manifest.json)。镜像由冻结官方Dockerfile本地构建，amd64仿真；评分调用冻结官方get_eval_report和Python parser，轻量加载，无完整官方CLI依赖安装。\n\n原始provider usage及调用完整性见[calls.jsonl](calls.jsonl)，任务用量见[tasks.csv](tasks.csv)，评分输出与模型补丁见evaluator目录。私有会话正文、凭据和本机路径不发布。运行前空补丁失败、参考补丁成功和容器清场均已预检；具体hash在冻结计划与原始证据中保留。\n\n复现入口：\`scripts/benchmark/run-swe-canary.js --config <私有配置文件>\`；官方评分入口：\`scripts/benchmark/swe-grade.py\`。配置与原始数据按项目公开评测协议准备，任务取自[官方任务仓库](https://github.com/SWE-bench/swe-bench-tasks/tree/${dataset.taskRepositoryCommit}/tasks/${raw.plan.taskId})。当前结果只覆盖manifest声明的资源与推荐配置。评测运行时的精确依赖锁见[运行时说明](../../runtime/README.md)。\n`
  await writeFile(join(output, 'report.md'), report)
  const files = []
  async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await collect(join(directory, entry.name), relative + '/')
      else if (entry.isFile() && relative !== 'checksums.sha256') files.push(relative)
    }
  }
  await collect(output)
  files.sort()
  await writeFile(join(output, 'checksums.sha256'), (await Promise.all(files.map(async file => `${sha(await readFile(join(output, file)))}  ${file}`))).join('\n') + '\n')
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: report-swe-canary.js INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY')
  await writeCanaryReport(process.argv[2], process.argv[3])
}
