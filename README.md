# dsh-free-context

DeepSeek Harness（dsh）的独立上下文优化插件，目标是在保持 Agent 任务质量的前提下降低累计 token 消耗与实际费用。

当前支持工具结果处理、观察诊断、保守 JSON 路由与可选 Node TAP 日志精简；默认保持原文，显式配置允许工具并选择 `apply` 后才采用合格候选。尚无完整模型任务的实测节省比例。使用 ESM JavaScript 和 Node.js 24，无运行时依赖，服务由宿主 dsh 提供。

## 接入

在已加载 `tools` 服务的 Cordis 上下文中加载命名导出：

```js
import * as FreeContext from 'dsh-free-context'

const fiber = await ctx.plugin(FreeContext)
// 卸载时由 Cordis 清理本插件的事件监听器。
await fiber.dispose()
```

插件通过 `tools/post-execute` 的前置监听器先等待 `next()`，再读取下游决策。仅处理模型可见内容，保留结构化 `value` 与附加上下文；阻止决策、结构化值替换、失败结果、取消和 PTC 内部调用直接通过。内部转换函数收到内容副本，失败保留既有决策。历史退场默认关闭，需另行启用下述 `retirement`；不改写 PTC 内部调用日志。

## 配置与保护

```js
const fiber = await ctx.plugin(FreeContext, {
  mode: 'observe',
  tools: ['read'],
  minInputBytes: 1024,
  maxInputBytes: 1048576,
  minSavingsTokens: 32,
  json: { enabled: true },
  logs: { enabled: false },
})
```

| 配置 | 默认值 | 约束与用途 |
| --- | --- | --- |
| `mode` | `observe` | 仅接受 `observe`、`apply`、`off`；`off` 不注册处理监听器 |
| `tools` | `[]` | 工具名精确允许列表；空列表表示不处理任何工具；拒绝空名、空白字符与重复项 |
| `minInputBytes` | `1024` | 完整内容块序列化后的 UTF-8 字节数下界，含边界 |
| `maxInputBytes` | `1048576` | 完整内容块序列化后的 UTF-8 字节数上界，含边界；必须大于零且不小于下界 |
| `minSavingsTokens` | `32` | 候选策略要求的最小估算 token 节省量 |
| `json.enabled` | `true` | JSON 策略开关 |
| `logs.enabled` | `false` | 有损日志策略开关，默认关闭 |
| `retirement.enabled` | `false` | 历史结果退场；具有独立工具允许列表和经济门槛，见下文 |

字节和 token 数必须为非负安全整数；未知键、错误类型和无效配置会在加载时明确报错，即使 `mode` 为 `off` 也要通过校验。配置经过复制和递归冻结，不受调用方后续修改影响。即时策略与历史退场全部关闭时不注册监听器。

JSON 路由只接收单个纯文本内容块：通过工具允许列表与完整内容块体积检查后，编码适用的对象数组，解码并比较 JSON 数据，然后要求完整候选字节数和估算 token 均严格减少，且估算差值达到 `minSavingsTokens`。输入预算包含 JSON 转义与块元数据，正文单独低于上限不足以通过检查。已有编码 envelope、未知格式、非规范 JSON、多块或媒体内容保留原文。JSON 路由不丢弃字段；打开 `logs.enabled` 后可进一步匹配下文限定的 Node TAP 日志。

## 观察与诊断

```js
ctx.on('free-context/decision', record => {
  console.log(record)
})
```

诊断包含工具名、调用 ID、可取得的会话 ID、模式、处理结果与原因、策略名（有候选时）、输入/候选输出字节数和 token 估算、处理耗时。不会记录工具正文、参数、结构化值或异常消息。事件中的标识仍可能具有业务敏感性，日志存储与访问控制由订阅方负责。

`observe` 会计算候选并报告 `observed`，保持原决策不变；`apply` 选择候选时报告 `selected`。这些结果只代表插件策略选择，不证明 Session 已写入、宿主已接受或已经产生计费收益；诊断期间取消时仍保留原决策。没有适用或达到门槛的候选时记录 `eligible/no-strategy`。失败、阻止决策、结构化值替换、取消和 PTC 内部调用报告跳过原因，不扫描其内容。`off`、空工具列表或全部策略关闭时不注册监听器，也不产生诊断。

字节数按内容块 JSON 序列化后的 UTF-8 计算，包含块结构开销；默认 token 估算为 `ceil(bytes / 3)`，只是启发式估算，不是精确 tokenizer、媒体 token 计量、provider usage 或实际计费，也不是已节省 token。`elapsedMs` 不含下游工具策略和诊断订阅方耗时。日志候选正文包含原文快照引用；当前诊断事件不包含快照引用或回读记录。

事件使用 Cordis `parallel` 分发到普通 `ctx.on` 订阅，等待全部订阅完成，以隔离异步拒绝；监听器异常只产生固定警告，不改变工具结果。订阅方应快速完成，避免延迟工具结果返回。

## JSON 编解码候选

JSON 编解码器已接入上述生产路由，也可独立调用：

```js
import { encodeJsonRows, decodeJsonRows } from 'dsh-free-context/json'

const original = JSON.stringify([
  { descriptive_identifier: 1, descriptive_status: 'ready' },
  { descriptive_identifier: 2, descriptive_status: 'ready' },
])
const candidate = encodeJsonRows(original, { maxInputBytes: 1048576 })
if (candidate !== undefined) {
  const restored = decodeJsonRows(candidate)
  console.log(JSON.parse(restored))
}
```

编码器将非空、各对象键及顺序完全一致的对象数组转换为版本化 JSON：`{ format: 'dsh-json-rows', version: 1, schema, rows }`。嵌套值保持 JSON 数据，解码返回规范 JSON 文本；原始缩进和字符串外空白不会恢复。两函数默认输入上限均为 1 MiB，按 UTF-8 字节计；解码候选超过默认上限时需显式传入足够的 `maxInputBytes`。

编码器采取保守准入：解析后去除字符串外空白的输入必须与重新序列化完全相同，并拒绝不安全整数、非有限数和负零。因此重复键、精度变化，以及部分合法但非规范的指数、转义形式会返回 `undefined`，调用方应保留原文。解码器严格校验格式版本、字段、schema 唯一性和行长度，非法输入会抛错；`__proto__` 等键作为普通自有数据属性恢复。

独立编码器产生的候选可能比原文更长，获得候选不代表 token 节省；生产路由会计入完整 envelope 和内容块开销后执行字节数与估算 token 收益门槛。后续若加入格式说明或恢复引用，也须纳入候选总成本。当前固定查询测试只验证恢复数据的筛选、求和和嵌套查询一致性，尚未证明模型能直接使用紧凑格式完成同等质量的任务。

## Node TAP 日志精简

设置 `logs: { enabled: true }` 后，单文本块的 JSON 路由未命中时可识别严格限定的 Node TAP v13 输出：完整顶层 `Subtest`、连续编号 `ok`/`not ok`、Node 的 duration/type 元数据、匹配的 plan 与完整总结。嵌套 suite、跳过/待办/取消测试、截断输出、额外成功诊断、普通控制台输出、非匹配格式及明显指令提示内容均保留原文。指令检测是有限的保守规则，不是任意恶意文本检测保证。

预览保留每个成功测试的名称与状态、所有完整失败块（包括错误 YAML、路径、行号和堆栈）、plan 与总结；仅省略成功测试重复的 `Subtest` 标签以及已识别的 duration/type 元数据。预览明确标为 `LOSSY`，说明省略范围与数量，并非完整 TAP 流。失败工具结果本身仍直接通过，不因日志内存在可识别结构而改写。

有损候选必须先通过宿主 `spillStore` 成功保存完整原文，再附上真实快照引用与恢复说明，最后对包含引用的完整候选执行字节数和估算 token 收益门槛。缺少后端或会话/调用标识、归档失败、取消、收益不足均保留原文。JSON 路由无需该存储服务；日志功能开启也不强制新增存储后端。

**观察模式有存储副作用**：`observe` 为计算真实引用成本也会归档原文，但不改变模型输入。即使最终引用太长、收益不足或归档后取消，后端也可能已留下快照；由宿主存储清理策略管理。预览可恢复不代表任务语义无损，尚无模型任务质量或端到端成本收益证明。

## 原文快照

需要有损转换时，可先通过宿主 `spillStore` 保存工具执行当时的完整原文：

```js
import { archiveOriginal, formatSnapshotReference } from 'dsh-free-context/snapshot'

// exec 是当前工具执行上下文；originalText 是该次执行的完整原文。
async function prepareSnapshot(ctx, exec, originalText) {
  try {
    const receipt = await archiveOriginal(ctx.spillStore, exec, originalText, {
      maxBytes: 1048576,
    })
    return { receipt, reference: formatSnapshotReference(receipt) }
  } catch {
    // 未取得可用引用时，调用方必须保留原文，不能采用有损候选。
    return undefined
  }
}
```

宿主必须加载 `spillStore` 后端，执行上下文必须具有 `agent.session.header.id`、`callId` 和工具 `name`。模块固定保存时的身份，返回冻结的 `sessionId`、`callId`、`toolName`、`sha256`、`bytes`、`locator` 和 `retrievalHint`。默认原文上限为 1 MiB UTF-8 字节；不成对的 Unicode surrogate 会被拒绝。存储失败、返回引用无效、字节数不符、执行身份变化或保存前后取消都会抛错。保存期间取消可能留下后端已写入的文件，但不会返回可采用的引用。

`locator` 与 `retrievalHint` 原样来自后端，不由插件推导路径。`formatSnapshotReference` 提供精确引用与恢复说明：按后端指引使用现有 read/grep 能力，完整恢复时读取全部分页并核对 UTF-8 字节数与 SHA-256。局部读取或 grep 命中不代表全文校验，也不能用源文件当前内容代替快照。存储保留期限和访问权限由宿主后端管理；保存成功不保证引用永久有效。

当前 JSON 路由使用可逆编解码，不调用该模块；有损日志路由已接入，替换前必须取得快照引用。官方 `spill-local` 集成测试验证了完整文件回读的字节与哈希、源文件变化后的快照稳定性及存储失败；尚未验证真实模型恢复过程或官方 read 工具分页调用。

## 文件读取生命周期

在已加载文件工具的 Cordis 上下文中，可显式安装读取跟踪器：

```js
import { installReadTracking } from 'dsh-free-context/read-lifecycle'

const tracking = installReadTracking(ctx, { maxEntriesPerSession: 256 })
// 在真实 read 调用完成后，用该调用所属的 Session 对象和 callId 查询。
const state = tracking.query(agent.session, callId)
console.log(state) // undefined，或包含 status、start/end、version 等的冻结记录
tracking.dispose() // 移除监听并丢弃优化元数据；所属 Cordis 上下文卸载也会清理。
```

跟踪器将 `fs/observed` 的不透明 `targetKey`、版本与成功 read 的真实返回行范围按 `callId` 关联，不用请求的 `limit` 推断已返回内容。只有相同目标、相同非空版本、新范围完整覆盖旧范围，且重叠行文本哈希一致时，旧记录才标为 `superseded` 并给出 `supersededBy`。行文本比较用于避免不同截断长度造成错误覆盖。部分覆盖、零行和不同 Session 对象不能建立覆盖关系。

`status` 可为 `active`、`superseded`、`stale` 或 `unknown`。版本变化和文件缺失观察会标记 `stale`；缺少版本、观察冲突等情况保守视为 `unknown`。查询不到记录也不能推断内容已过期。跟踪器仅保存本进程优化元数据：每个 Session 对象的读取记录和待完成观察分别最多保留配置条数，淘汰和卸载不影响历史内容；恢复会话或 fork 后不自动重建这些记录。

该跟踪器不归档、删除或替换历史消息。主插件只在启用历史退场且其允许列表包含 `read` 时自动安装；其他调用方也可用 `callId` 关联持久化原文引用。版本只反映宿主发出的观察，无法检测未发出事件的外部修改，不是文件锁或实时新鲜度保证。实际 fs-local/tool-fs 组合测试覆盖部分读取、完整读取、修改后的版本变化和字节上限导致的真实返回范围。

## 缓存与净收益预测

经济门槛作为独立纯函数提供，同时用于下述可选历史退场；即时 JSON/TAP 路由仍使用其字节和 token 门槛：

```js
import { assessNetBenefit } from 'dsh-free-context/economics'

const decision = assessNetBenefit({
  originalTokens: 20000,
  candidateTokens: 10000,
  invalidatedPrefixTokens: 1000,
  minimumFutureRequests: 20,
  // 仅为演示数字，不是任何供应商的报价。
  pricing: { uncachedInputPerMillion: 10, cacheReadPerMillion: 2 },
  compressionCost: 0.02,
  expectedRecoveryCost: 0.01,
  safetyMargin: 0.25,
})
console.log(decision.adopt, decision.reason, decision.conservativeNetBenefit)
```

调用方必须明确提供 token 数、失效且需重建的保留前缀 token 数、未来请求数假设、价格、压缩总费用、预期回读总费用与安全余量。所有金额使用同一货币单位；价格是每百万 token 的单价，压缩和回读费用是本次决策的增量总费用，不是每轮价格。缺少必需输入时返回 `adopt: false` 和缺失原因；负值、非有限数、错误类型、不安全整数等无效输入会抛错。`safetyMargin` 范围为 `[0, 1)`。

保守基线假设将被移除的原 token 在未来请求中全部命中缓存，因此节省按“移除 token × cache-read 单价 × 假设请求数”计算。前缀只计算一次重建，并仅计入重建单价超过 cache-read 单价的非负差额；重建单价使用可选 `cacheWritePerMillion`，未提供时使用 `uncachedInputPerMillion`，两者不相加。若供应商写缓存费用是附加价，调用方必须先转换为本函数要求的完整替代单价。`invalidatedPrefixTokens` 不含已移除 token，压缩/回读费用不得再次包含此处已计入的前缀重建费用；其他额外模型输入、输出费用应纳入这些显式总额。

函数从预测毛节省中预留 `safetyMargin` 比例，再扣除全部增量成本，仅在剩余净收益严格大于零时建议采用。`breakEvenRequests` 是在同一假设下跨过保守门槛的最小整数请求数；无法给出安全有限阈值时为 `null`。无压缩、无未来请求或缓存读价为零均不采用。

这些输出是基于调用方价格和未来请求假设的预测，不是账单证据，也不保证预测轮次一定发生。反复失效需要重新评估；模型质量、额外回合和真实缓存行为仍需完整任务对照验证。

## 历史结果退场

历史退场在 `agent/pre-step` 中运行，默认关闭。它有独立的工具允许列表，即使顶层 `tools: []` 也可单独使用：

```js
await ctx.plugin(FreeContext, {
  mode: 'observe', // 确认诊断和任务质量后，可显式改为 apply。
  retirement: {
    enabled: true,
    tools: ['read'],
    retainRecentResults: 4,
    minAgeSteps: 3,
    minInputBytes: 8192,
    minSavingsTokens: 32,
    maxEntriesPerStep: 1,
    maxSnapshotBytes: 1048576,
    // 下列数字仅演示配置；必须换成实际价格和明确的未来请求/回读假设。
    minimumFutureRequests: 20,
    pricing: { uncachedInputPerMillion: 10, cacheReadPerMillion: 2 },
    expectedRecoveryCost: 0.01,
    safetyMargin: 0.25,
  },
})
ctx.on('free-context/retirement', record => console.log(record))
```

上例的保留数量、年龄、大小和单步尝试上限也是默认值；`tools` 默认为空。价格、未来请求次数、回读费用和安全余量没有默认值，缺少时拒绝退场。宿主还必须提供 `spillStore` 和具有 `measure/estimateMessage` 能力的 `tokenMeter`；缺少计量器会报告 `missing-token-meter`。`off` 不安装监听；`observe` 会保存候选所需快照并计算完整引用成本，但不追加历史替换，`apply` 才执行退场。

候选仅限允许工具的成功、单文本结果，保留最近 N 个工具结果及最近指定步数内的结果。`read` 还必须具有同版本完整覆盖的 `superseded` 记录，且覆盖它的新结果仍留在当前历史表面；`stale`、`unknown` 不代表可以删除。原文先成功保存，包含完整恢复指引的候选必须在字节和 token 上都变小，并达到最小节省量。经济门槛以宿主当前计量的全部保留上下文（含候选）保守计入一次缓存重建成本，扣除预期回读费用和安全余量；压缩本身不调用模型，模型压缩费用固定为零。计量与预测仍不是供应商账单或未来轮次保证。

快照保存后，会重新检查 Session 修订号、当前表面、原消息和读取覆盖状态，任何并发变化或取消都拒绝该候选。正式退场保留原始事件，并同步相邻追加 dsh 内建 `compaction/prune` 影子计量与 `tool/result` 替换事件，保留消息身份、source 和工具调用配对；不注册额外必需事件解释器。真实 Session 测试验证 JSONL 事件序列恢复、fork，以及卸载插件后的消息派生一致性。再次运行不会重复退场已带引用的结果。

这两个 append 沿用官方协议，并非数据库事务。插件诊断不会插入二者之间，但宿主的同步事件观察者仍会运行；一旦影子计量已提交，完成紧随的替换不会因观察者随后取消而中断。若第二次 append 失败，会检查真实日志和表面是否已经提交成功；确认部分提交时报告 `partial-commit`、输出固定警告，并抛出 `RETIREMENT_INCOMPLETE_PROTOCOL` 拒绝继续该模型步骤。后续发现未配对的影子计量同样报告 `incomplete-shadow-protocol` 并拒绝该步骤，需由宿主检查和恢复计量状态。不能将这种部分提交报告当作成功。

底层 `resolveRetirementConfig`、`retireHistory` 和 `installRetirement` 也由 `dsh-free-context/retirement` 导出。历史退场是有损的模型上下文缩减，原日志与快照可恢复不等于模型任务语义无损；目前没有真实模型完整任务质量或净费用收益结论。

## 验证

```sh
npm test
npm run check
```

单元测试覆盖下游顺序、结构化值保留、取消、失败回退和导出约定。`check` 是 JavaScript 语法检查，不代表类型检查或完整静态分析。

真实组合测试需一个独立安装了以下官方包的目录：`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`。

```sh
DSH_RUNTIME_ROOT=/path/to/runtime npm run test:integration
```

默认测试目录为 `.omx/integration-runtime`。已验证 Cordis `4.0.5`、Loader `1.0.6`、dsh `0.2.1-rc.2`：实际工具执行、策略组合顺序、结构化值保留、命名导出解析及卸载。已验证官方 Include/Loader YAML 组合，以及生产路由 baseline/observe/apply、下游内容与附加上下文保留、允许列表与收益门槛、PTC/失败/value 替换跳过及候选取消。未验证完整 dsh CLI/GUI 启动、真实模型请求、完整任务成本或任务质量评估。
