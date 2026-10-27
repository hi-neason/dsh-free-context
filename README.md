# dsh-free-context

DeepSeek Harness（dsh）的独立上下文优化插件，目标是在保持 Agent 任务质量的前提下降低累计 token 消耗与实际费用。

当前支持工具结果处理、观察诊断、保守 JSON 路由与可选 Node TAP 日志精简；默认保持原文，显式配置允许工具并选择 `apply` 后才采用合格候选。已有固定任务的完整模型对照，尚未通过全部十四项验收，结果与限制见下文。使用 ESM JavaScript 和 Node.js 24，无运行时依赖，服务由宿主 dsh 提供。

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

`observe` 会计算候选并报告 `observed`，保持原决策不变；`apply` 选择候选时报告 `selected`。这些结果只代表插件策略选择，不证明 Session 已写入、宿主已接受或已经产生计费收益；诊断期间取消或等待超过默认 1 秒时仍保留原决策；普通观察者异常会被隔离。独立 `createPostExecuteHandler` 可通过 `diagnosticsTimeoutMs` 设置等待期限。没有适用或达到门槛的候选时记录 `eligible/no-strategy`。失败、阻止决策、结构化值替换、取消和 PTC 内部调用报告跳过原因，不扫描其内容。`off`、空工具列表或全部策略关闭时不注册监听器，也不产生诊断。

字节数按内容块 JSON 序列化后的 UTF-8 计算，包含块结构开销；默认 token 估算为 `ceil(bytes / 3)`，只是启发式估算，不是精确 tokenizer、媒体 token 计量、provider usage 或实际计费，也不是已节省 token。`elapsedMs` 不含下游工具策略和诊断订阅方耗时。日志候选正文包含原文快照引用；候选诊断通过受控标识关联快照与实际回读事件，详见下文快照诊断说明。

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

编码器将非空、各对象键及顺序完全一致的对象数组转换为版本化 JSON：`{ format: 'dsh-json-rows', version: 1, schema, rows }`。嵌套值保持 JSON 数据，解码返回规范 JSON 文本；原始缩进和字符串外空白不会恢复。两函数默认输入上限均为 1 MiB，按 UTF-8 字节计。解码还具有独立的 `maxOutputBytes`（默认 1 MiB），在构造完整对象数组前核算 schema 展开体积；输入和输出超出默认预算时需分别明确设置上限。

编码器采取保守准入：解析后去除字符串外空白的输入必须与重新序列化完全相同，并拒绝不安全整数、非有限数和负零。因此重复键、精度变化，以及部分合法但非规范的指数、转义形式会返回 `undefined`，调用方应保留原文。解码器严格校验格式版本、字段、schema 唯一性和行长度，非法输入会抛错；`__proto__` 等键作为普通自有数据属性恢复。

独立编码器产生的候选可能比原文更长，获得候选不代表 token 节省；生产路由会计入完整 envelope 和内容块开销后执行字节数与估算 token 收益门槛。后续若加入格式说明或恢复引用，也须纳入候选总成本。固定查询测试验证恢复数据的筛选、求和和嵌套查询一致性；下文有限的真实 Agent JSON 任务也验证了紧凑格式上的指定记录定位与字段提取，不能外推为任意任务的质量保证。

## Node TAP 日志精简

设置 `logs: { enabled: true }` 后，单文本块的 JSON 路由未命中时可识别严格限定的 Node TAP v13 输出：完整顶层 `Subtest`、连续编号 `ok`/`not ok`、Node 的 duration/type 元数据、匹配的 plan 与完整总结。嵌套 suite、跳过/待办/取消测试、截断输出、额外成功诊断、普通控制台输出、非匹配格式及明显指令提示内容均保留原文。指令检测是有限的保守规则，不是任意恶意文本检测保证。

预览保留每个成功测试的名称与状态、所有完整失败块（包括错误 YAML、路径、行号和堆栈）、plan 与总结；仅省略成功测试重复的 `Subtest` 标签以及已识别的 duration/type 元数据。预览明确标为 `LOSSY`，说明省略范围与数量，并非完整 TAP 流。失败工具结果本身仍直接通过，不因日志内存在可识别结构而改写。

有损候选必须先通过宿主 `spillStore` 成功保存完整原文，再附上真实快照引用与恢复说明，最后对包含引用的完整候选执行字节数和估算 token 收益门槛。缺少后端或会话/调用标识、归档失败、取消、收益不足均保留原文。JSON 路由无需该存储服务；日志功能开启也不强制新增存储后端。

**观察模式有存储副作用**：`observe` 为计算真实引用成本也会归档原文，但不改变模型输入。即使最终引用太长、收益不足或归档后取消，后端也可能已留下快照；由宿主存储清理策略管理。预览可恢复不代表任务语义无损；下文真实 Agent 评测仅覆盖指定合成任务，其结果不能外推到其他日志与工作负载。

## 与原生 spill 的加载顺序

要在原生 spill 前完成结构压缩，应先加载本插件，再加载原生 `spill-policy`；原生监听器在回程中对处理后的结果执行同样的大小上限。若原生策略先加载，本插件仍保持安全回退，但可能只能看到已裁剪的预览。不要为提高压缩命中率而关闭原生兜底，或把更大的 inline 预算当成插件收益。

官方 CLI 的公开 patch 接口可禁用原 `spill-policy` 条目，再依次追加本插件和新的原生策略条目（例如 `maxInlineTokens: 1200`）。这属于公开配置组合，不修改官方代码。集成测试覆盖两种顺序、未知文本的原生兜底，以及不会同时替换结构化值与模型内容的约束。

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

宿主必须加载 `spillStore` 后端，执行上下文必须具有 `agent.session.header.id`、`callId` 和工具 `name`。模块固定保存时的身份，返回冻结的 `sessionId`、`callId`、`toolName`、`sha256`、`bytes`、`locator` 和 `retrievalHint`。默认原文上限为 1 MiB UTF-8 字节；不成对的 Unicode surrogate 会被拒绝。存储失败、返回引用无效、字节数不符、执行身份变化或保存前后取消都会抛错。保存等待默认最多 10 秒，可由独立 API 的 `timeoutMs` 调整；同一后端默认最多 4 个尚未结束的保存，可由 `maxPendingSaves` 调整。取消或超时会结束等待并拒绝采用，不能保证底层写入已停止；未结束的写入继续占用名额，直到后端实际结束。迟到的文件仍由后端管理。

`locator` 与 `retrievalHint` 原样来自后端，不由插件推导路径。`formatSnapshotReference` 提供精确引用与恢复说明：按后端指引使用现有 read/grep 能力，完整恢复时读取全部分页并核对 UTF-8 字节数与 SHA-256。局部读取或 grep 命中不代表全文校验，也不能用源文件当前内容代替快照。存储保留期限和访问权限由宿主后端管理；保存成功不保证引用永久有效。

当前 JSON 路由使用可逆编解码，不调用该模块；有损日志路由已接入，替换前必须取得快照引用。官方 `spill-local` 集成测试验证了完整文件回读的字节与哈希、源文件变化后的快照稳定性及存储失败；下文真实 Agent TAP 任务另验证了模型通过官方 read 回读指定快照；原始字节分页与失败边界另见下节；不能以官方 read 的显示文本代替字节校验。


## 原始字节校验与模型分页恢复

官方 `read` 面向阅读，会规范化换行并截断超长行；`fs.readText` 也可能去除 BOM。因此它们的可见文本不能证明 CRLF、BOM 或长行的字节完全恢复。`dsh-free-context/recovery` 提供 `verifySnapshot(receipt, bytes)` 与 `recoverSnapshot(receipt, readPage, options)`；后者仅通过显式提供的后端适配器读取不透明 locator，完整验证字节数及 SHA-256 后才返回原始字节。默认最大 1 MiB、每页 16 KiB、等待 10 秒；同一适配器最多 4 个未结束读取，取消或超时不会提前释放底层名额。

需要模型精确分页时，宿主可显式安装可选工具，并让主插件和实验共用授权登记表：

```js
import { installSnapshotTracking } from 'dsh-free-context/snapshot-telemetry'
import { installSnapshotRecovery } from 'dsh-free-context/recovery-tool'

const tracking = installSnapshotTracking(ctx)
ctx.provide('freeContextSnapshots', tracking) // 在加载主插件或实验前提供。
const recall = installSnapshotRecovery(ctx, {
  tracking,
  // 只适用于已明确采用本地 spill 后端、并由宿主授权读取的配置。
  // 其他后端必须提供自己的授权适配器，不能把 locator 猜成文件路径。
  readPage: async (locator, { offset, length, signal }) =>
    ctx.fs.readByteRange(await ctx.fs.resolve(locator, { signal }), { offset, length }, signal),
  pageCharacters: 2048,
})
// 然后通过 ctx.plugin 加载主插件/实验；结束时 recall.dispose()。
```

`free_context_recall` 只接受当前 Session 登记的 `referenceId` 和字符范围，不接受模型提交的 locator 或 receipt。主插件的快照提示包含相同 ID。每次返回前校验完整快照，按 Unicode 码点分页，JSON 字符串保持 CRLF、BOM 与 emoji；沿 `nextOffset` 读取到 `null`。`snapshotVerified` 表示内部完整字节校验成功，`pageComplete` 才表示本页包含全文。引用过期、内容改变、错误会话、取消或超出预算均失败，不改读当前源文件。

该工具不是根插件默认安装项。登记表有界且仅属于当前 Session 对象；重启、恢复或 fork 不自动获得原登记表的授权。宿主需先确认后端权限，再显式重新登记，不能仅凭日志中出现 ID 就授予访问。已有官方 AgentLoop 测试验证真实插件产生的快照进入同一登记表、模型逐页回读及持久化文本重放；脚本化 provider 验证协议，不代表真实模型推理收益。

## 快照与回读诊断关联

产生原文快照的主插件路径与独立实验会登记 `free-context/snapshot`；候选的 `free-context/decision.snapshots` 关联相同引用。事件仅含不透明 `referenceId`（locator 与 SHA-256 的哈希）、`sha256`、`bytes`、`sourceCallId`、`sessionId` 和 `purpose`（`original`、`audit`、`retirement`），不含 locator、恢复提示、原文或工具参数。归档记录不等于候选已采用。

`free-context/recovery` 只观察同一 Session 对象中、`read.file_path` 精确等于已登记 locator 的现有 read 调用，报告 `recoveryCallId`、原引用及 `success/failed/blocked/modified/cancelled` 状态；成功且返回结构有效时附实际 `startLine/endLine/totalLines`。不推断别名，不重新读取源文件，也不提供额外恢复工具。所有事件均为 `verifiedFull: false`：返回全部行仍不能证明原始换行、字节数和哈希完全一致，更不能证明模型使用了这些内容。这些状态反映该 post-execute 观察点的结果；外层策略之后仍可能修改内容，不证明最终 Session 或模型消费。观察者异常不改变工具决策。

`installSnapshotTracking(ctx, { maxEntriesPerSession: 128 })` 从 `dsh-free-context/snapshot-telemetry` 导出，返回 `record(exec, receipt, purpose)` 与 `dispose()`。登记表按 Session 对象弱引用隔离并限制条目数；淘汰或卸载只删除诊断元数据。恢复/fork 不自动重建表。只有目标 Session 的 ID 与 receipt.sessionId 一致时才可显式重新登记；新 ID 的 fork 不能登记父会话 receipt，但原文能否读取仍由后端权限决定。存储权限与保留期限仍由宿主负责。

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

可选 `calibrateRequestForecast(observations, options)` 从至少 3 个同范围的完整真实运行生成保守建议：未来轮数取观测最小值并受默认 8 次上限限制，回读费用取观测最大值。它拒绝重复、失败、用量缺失、模拟或范围不一致的样本。范围应明确包含任务类型、模型、策略与计价制度；数据真实性仍由调用方负责，历史最小值不是未来保证。

历史配置可显式提供 `retirement.forecast: { scope, observations, maximumRequests }`。每条观测包含 `runId`、同一 `scope`、`usageKind: 'provider-reported'`、`usageComplete: true`、`qualityPassed: true`、`remainingRequests` 和 `recoveryCost`。该配置只会缩短已有 `minimumFutureRequests`、提高已有 `expectedRecoveryCost`；样本不足或不可用时未来轮数归零，禁止据此采用。未提供时继续使用明确声明的人工假设，不应把假设称为实测预测。

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

快照保存后，会重新检查 Session 修订号、当前表面、原消息和读取覆盖状态，任何并发变化或取消都拒绝该候选。正式退场保留原始事件，并同步相邻追加 dsh 内建 `compaction/prune` 影子计量与 `tool/result` 替换事件，保留消息身份、source 和工具调用配对；不注册额外必需事件解释器。真实 Session 测试验证 JSONL 事件序列恢复、fork，以及卸载插件后的消息派生一致性。再次运行不会重复退场已带引用的结果。历史调用与曝光次数每步建立一次索引；超大原文在消耗保存尝试预算前跳过，候选轮转避免反复尝试同一项。每个 Session 对象最多保留 256 份成功快照凭据，后端或保存方法变化会清空缓存；缓存仅供预评估与拒绝重试使用；实际退场前重新归档原文，并按新引用重新计算大小、收益和提交条件，避免采用已过期快照。恢复后的新 Session 对象重新归档。

这两个 append 沿用官方协议，并非数据库事务。插件诊断不会插入二者之间，但宿主的同步事件观察者仍会运行；一旦影子计量已提交，完成紧随的替换不会因观察者随后取消而中断。若第二次 append 失败，会检查真实日志和表面是否已经提交成功；确认部分提交时报告 `partial-commit`、输出固定警告，并抛出 `RETIREMENT_INCOMPLETE_PROTOCOL` 拒绝继续该模型步骤。后续发现未配对的影子计量同样报告 `incomplete-shadow-protocol` 并拒绝该步骤，需由宿主检查和恢复计量状态。不能将这种部分提交报告当作成功。

退场默认还要求 `minModelUses: 2`、`minStepsBetweenRetirements: 1`，并保留 `excerptCharacters: 256` 的片段。曝光计数只接受已提交的 `assistant/message` 和有正 usage 证据的 `assistant/attempt`；单独 `step/start` 不是模型曝光或语义使用证据。冷却按上次退场后的新 `step/start` 计数。已识别的诊断、shell 失败/超时/信号/停止/后台/stderr 状态证据，即使 `isError: false` 也受保护。

`phasePolicy` 默认为 `'any'`；选择 `'boundary'` 时由宿主明确提供同步状态：

```js
ctx.provide('freeContextTaskState', {
  getState: ({ session }) => ({ phase: 'inspection', boundaryId: 'inspection-1', status: 'complete' }),
})
```

未知、进行中或缺失状态拒绝退场，不解析 planner 文本。归档完成后重新校验状态；每个 `boundaryId` 的退场标记持久化，恢复后不重复执行该边界。真实快照回读测试覆盖恢复、fork 和卸载后的 read；已验证字节相等的测试限于 LF 样本，后端访问控制仍由宿主管理。

底层 `resolveRetirementConfig`、`retireHistory` 和 `installRetirement` 也由 `dsh-free-context/retirement` 导出。历史退场是有损的模型上下文缩减，原日志与快照可恢复不等于模型任务语义无损；已有下文受控历史退场完整任务实测，但未证明一般工作负载收益。

## 可选的任务无关段落选择实验

`dsh-free-context/experiments` 是独立函数插件，主插件不会自动加载它，默认 `mode: 'off'`。这是受论文启发的 LLM 段落选择实验，不是 LLMLingua-2 的模型训练或算法复现。宿主必须已有 `tools`、`llm` 和可用的 `spillStore`，并配置模型凭据；插件不自行读取环境密钥或创建 SDK。

```js
import * as Experiments from 'dsh-free-context/experiments'

const experimentConfig = {
  mode: 'observe',
  tools: ['prose'], // 换为明确返回纯说明文本的实际工具；精确允许列表。
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxInputBytes: 40000,
  maxPromptBytes: 50000,
  maxOutputBytes: 8000,
  maxOutputTokens: 2048,
  maxArtifactBytes: 70000,
  timeoutMs: 60000,
  maxParagraphs: 50,
  maxCacheEntries: 2,
  maxInFlight: 4, // 同一 selector 尚未结束的底层调用上限。
  protectedTerms: [], // 在此明确列出必须保留所在段落的精确词语。
  // 下列价格/未来轮数仅为演示，不是供应商报价或推荐预测。
  pricing: {
    currency: 'USD',
    uncachedInputPerMillion: 1,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 1,
  },
  futureCacheReadPerMillion: 0.1,
  minimumFutureRequests: 1000,
  expectedRecoveryCost: 0,
  safetyMargin: 0.1,
  maxCallCost: 1,
}
const experiment = await ctx.plugin(Experiments, experimentConfig)
// await experiment.dispose()
```

`pricing` 只用于辅助模型的实际调用用量；`futureCacheReadPerMillion` 是被优化的主请求在未来命中缓存时的独立读价，两者不得因模型不同而混用。所有金额须与 `currency` 一致，价格均为每百万 token 单价。若用量包含缓存写入，必须补充 `pricing.cacheWritePerMillion`，否则不采用候选。`maxCallCost` 在调用前用“每个实际序列化 prompt 字节按一个 token、取最高已声明输入价，加输出上限费用”作保守估算门槛；它不是供应商计费硬上限。调用后的真实 usage 会再次检查费用。缺少价格、未来请求假设、必要用量，或预测净收益不足均不采用；已发生的辅助调用费用不会因此撤销。

`maxInputBytes` 限制原输入，`maxPromptBytes` 限制完整请求消息序列化后的 UTF-8 字节数，不能等同模型输入 token 硬上限；`maxOutputBytes` 包括输出文本与 reasoning 流的字节数，`maxOutputTokens` 传给宿主请求的 `maxTokens`。`maxArtifactBytes` 限制调用审计文件。明确的代码围栏、JSON、TAP、列表及其他已识别结构保留原文，纯说明文本允许列表本身仍需调用方正确配置。

模型仅返回 `selectedIds`；插件拒绝额外字段、改写文本、重复或越界 ID、空选择、未成功结束的流和遗漏保护词所在段落的选择。候选文本按原顺序从原文抽取，附段落 ID、UTF-16 起止位置与策略版本。来源匹配只证明这些片段来自原文，不证明未选段落没有必要证据。

**`observe` 也会产生辅助模型费用并写入快照**，只是保持模型输入不变。插件先以纯准备阶段检查格式、分段、实际 prompt 字节和包含完整请求的 manifest 最低大小；这些检查不写存储、不调用模型。通过后保存原文，成功选择后保存会话归属的审计 manifest（完整 prompt、response、原始与本次 usage、选择范围和预算），候选附两份真实恢复引用。只有包含引用的完整候选仍缩小，并通过净收益门槛时，`apply` 才选择替换模型可见工具内容；不改程序结构化值，也不直接改写主 Agent 请求或历史日志。存储失败或取消均保留原文，已写快照由宿主后端清理。

`free-context/experiment` 事件只报告调用标识、模式、原因、用量、估算费用与缓存命中，不报告正文、工具参数或密钥。缓存按会话对象隔离，键包含完整原文哈希和模型/策略配置，每个会话最多保存 `maxCacheEntries` 项。命中时复用经过校验的选择，`originUsage` 表示原选择调用用量，`callUsage` 缺省且 `llmCalled: false` 表示本次没有新调用，不能再次计费。相同 Session、配置、原文和查询的并发选择合并为一次模型调用；各等待方独立取消，最后一方退出才中止底层请求。一次调用的 `callUsage` 只归因到一个存活等待方，其他方以 `shared: true`、`llmCalled: false` 表示无新增费用，保留 `originUsage`；超时或取消后，尚未结束的底层流继续占用 `maxInFlight` 名额；已完成的缓存命中不占调用名额。取消不能保证远端停止计费，缺少 usage 仍禁止采用。

纯选择核心也可从 `dsh-free-context/text-selection` 导入 `createTextSelector`；原 callable 接口保留，另提供 `select.prepare(input)` 和 `select.execute(token, { session, signal })`。准备 token 仅在创建它的 selector 中有效，暴露 `requestBytes` 和 `minimumManifestBytes` 供调用前拒绝；最低大小通过后，完整 manifest 仍须通过最终预算。独立调用者需自行完成归档与经济门槛。

已用官方 dsh runtime/provider 和 `deepseek-flash` 完成一次合成文本观察探针：实际输入 4,224 token、输出 9 token，保留保护段落；第二次命中缓存且无新模型调用，两次均保持原工具内容。该探针和 fake-adapter 集成测试验证了接口、归档、保护规则及失败边界，不是完整任务质量或账单收益证明；演示价格换算不等于供应商实收。

### 有预算的真实试验

默认 `admission: 'forecast'` 要求压缩预测收益覆盖成本；命中已经完成的选择缓存时不再计新增模型费用。可选 `comparatorTokenCap` 同时限制基线与候选的预测体积，例如与原生 1200 上限比较，避免按完整原文高估增量收益。

为收集完整任务的真实收益证据，可以显式采用 `admission: 'measured-trial'`。它允许在预算内试用候选，跳过预测净收益准入；仍要求原文与审计归档、保护证据、完整用量、查询一致、输出缩减和实际单次费用检查。试验采用不代表已证明获益，审计和事件明确记录 `predictedSavings: null`。

在已有实验配置上设置：

```js
const trialConfig = {
  ...experimentConfig,
  admission: 'measured-trial',
  maxCalls: 2,
  maxTotalCost: 0.03, // USD；辅助调用的会话预算示例。
  maxCallCost: 0.02,
  pricing: verifiedAuxiliaryPrices, // 必须显式提供 USD 及全部四种单价。
}
```

`verifiedAuxiliaryPrices` 包含 `currency`、`uncachedInputPerMillion`、`cacheReadPerMillion`、`cacheWritePerMillion` 和 `outputPerMillion`；填写实际服务的适用价格。试验模式不需要未来请求数和未来缓存读价假设。调用前按估算原子预留，确认没有新增调用才退回；付费失败、用量不完整或超出估算时封闭后续付费准入。已完成缓存仍可复用。

该预算仅属于插件实例中的 live Session 对象，重启、重开或另一个插件实例会重新计数；它不是持久化总预算，也不是供应商账单硬上限。`observe` 同样可能花费辅助调用费用。完整任务成本还必须另行包括主模型、回读、缓存与重试，并通过质量、实际采用和净收益对照才能验收。

## 当前任务相关的段落选择实验

同一个实验插件可显式设置 `selectionMode: 'query-dependent'`，复用上述选择、归档、费用与失败保护流程。默认仍是 `task-independent`，不会读取任务。查询模式通过调用方提供的同步 `freeContextQuery.getQuery` 服务获取当前任务，不读取历史消息，也不会把工具参数或 `agent/pre-step` inbox 当作完整任务。

```js
// 延续上节 example 配置；不要同时保留同一实例的两种模式。
await experiment.dispose()
const currentTasks = new WeakMap()
ctx.provide('freeContextQuery', {
  getQuery: ({ session }) => currentTasks.get(session),
})
const queryExperiment = await ctx.plugin(Experiments, {
  ...experimentConfig,
  selectionMode: 'query-dependent',
  maxQueryBytes: 4096,
})
// agent 是宿主的实际 Agent；应用在用户任务明确更新时维护此值。
currentTasks.set(agent.session, '当前需要确认 Alpha 的保留期限和限制条件。')
// 后续任务变化时更新，不需要重新加载插件。
currentTasks.set(agent.session, '现在需要确认 Beta 的保留期限和限制条件。')
```

`maxQueryBytes` 是显式的 UTF-8 字节上限。缺少服务、空查询、Promise 返回值、超过预算或计算期间查询变化，都不会采用候选；最后一次同步校验在全部异步诊断订阅者完成后执行，查询服务实例替换也会使旧候选失效；调用后变化仍可能已产生辅助费用。纯核心可使用 `createTextSelector({ ...selectorOptions, selectionMode: 'query-dependent', maxQueryBytes })` 并在每次 `select` 中显式传 `query`，没有宿主服务依赖。

缓存键包含完整查询哈希，因此同一原文的 A/B 任务分别计算，切回 A 时才可复用 A 的已验证选择；仍按 Session 对象隔离。审计 manifest 保存本次完整 prompt、查询哈希、原文哈希和范围，诊断事件只报告查询哈希而不报告查询正文。使用完整原始快照可重新选择：先按引用读取并校验原文，再以新任务调用选择器；不要把旧摘录当成完整来源，插件不会自动把已丢弃段落补回历史。

查询相关性与证据覆盖仍是模型判断。任务改变会增加辅助调用并可能影响缓存收益，不能将单轮问答的选择效果外推为完整 Agent 任务收益。官方 runtime 的 A/B/A 集成测试覆盖不同选择与缓存隔离、缺少查询、缺 usage、取消和诊断订阅期间的任务变化。真实 `deepseek-flash` 合成探针中，A/B 分别选择原文 p1/p2（各输入 4,273、输出 9 token），切回 A 命中缓存；两类查询使用同一原文哈希、不同查询哈希，原文快照均校验通过。此探针不证明任意任务上的相关性或收益。


## 诊断证据选择实验

同一独立实验插件还支持 `selectionMode: 'diagnostic-evidence'`，复用上述显式模型、预算、原文快照、完整审计、费用门槛和失败回退配置：

```js
await ctx.plugin(Experiments, {
  ...experimentConfig,
  selectionMode: 'diagnostic-evidence',
  tools: ['your-diagnostic-tool'],
})
```

仅接受空行分隔的编译器诊断、明确的退出码/状态摘要和 INFO/DEBUG/TRACE 信息块。诊断与状态块全部强制保留；信息块中匹配到错误、状态、错误码或路径位置时也强制保留，`protectedTerms` 进一步保护包含指定词语的块。模型只能从剩余信息块中选择，不能改写或拆分多行诊断。未知块、ANSI 转义、围栏或无诊断证据的输入回退原文；不是通用日志解析器，也不自动识别所有测试框架。

候选附块 ID、原始行号、UTF-16 范围，审计保存源哈希与词法保护证据。`maxParagraphs` 在此模式限制诊断块数。独立纯函数 `prepareDiagnosticEvidence`、`validateDiagnosticSelection` 从 `dsh-free-context/diagnostic-evidence` 导出；`createTextSelector` 在此模式要求 `kind: 'diagnostic'`。保留命中的词法规则和精确来源不能证明遗漏的信息没有语义价值，仍需完整任务质量与净费用验证。默认关闭，生产主插件不自动加载此实验。

官方 runtime 集成测试覆盖原文/manifest 实际回读、结构化值不变、错误/状态/代码位置保护、缓存不重复计费以及未知格式、缺 usage、取消回退。真实 `deepseek-flash` 合成观察探针输入 4,414、输出 18 token，保留全部四个强制证据块；两份 manifest 的原文哈希、字节数和行范围均校验通过，重复调用命中缓存且无新增模型调用。观察模式两次均保留原工具结果；该探针仅验证受限样本的选择与接口，假设价格换算不是实收账单或完整任务净收益。

## 验证

```sh
npm test
npm run check
```

完整 CLI 验证使用另一个隔离目录的官方可执行包，不向插件添加生产依赖：

```sh
npm install --prefix /path/to/cli-runtime @deepseek-ai/dsh@0.2.1-rc.2
DSH_CLI_RUNTIME_ROOT=/path/to/cli-runtime node --test test/integration/cli.test.js
```

该测试真正启动官方 headless CLI 子进程，验证 YAML 加载、结构化值、原生 spill 组合、持久化 Session 重启和关闭策略。官方 headless 不支持直接采用 fork 会话；fork 由 Session API 集成测试覆盖。

单元测试覆盖下游顺序、结构化值保留、取消、失败回退和导出约定。`check` 是 JavaScript 语法检查，不代表类型检查或完整静态分析。

测试和评测从源码 checkout 运行，要求 Node.js 24+。官方运行时装在独立目录，不是插件的生产依赖：

```sh
npm install --prefix /path/to/runtime \
  @deepseek-ai/cordis@4.0.5 \
  @deepseek-ai/cordis-plugin-loader@1.0.6 \
  @deepseek-ai/cordis-plugin-include@1.0.10 \
  @deepseek-ai/dsh-agent-loop-testkit@0.2.1-rc.2 \
  @deepseek-ai/dsh-compaction-tool-result-pruner@0.2.1-rc.2 \
  @deepseek-ai/dsh-llm-deepseek-api-key@0.2.1-rc.2 \
  @deepseek-ai/dsh-session@0.2.1-rc.2 \
  @deepseek-ai/dsh-system-prompt@0.2.1-rc.2 \
  @deepseek-ai/dsh-tools@0.2.1-rc.2 \
  @deepseek-ai/dsh-token-meter@0.2.1-rc.2 \
  @deepseek-ai/dsh-spill@0.2.1-rc.2 \
  @deepseek-ai/dsh-spill-local@0.2.1-rc.2 \
  @deepseek-ai/dsh-spill-policy@0.2.1-rc.2 \
  @deepseek-ai/dsh-fs-local@0.2.1-rc.2 \
  @deepseek-ai/dsh-tool-fs@0.2.1-rc.2 \
  @deepseek-ai/dsh-ptc-runtime-node@0.2.1-rc.2 \
  @deepseek-ai/dsh-subprocess-local@0.2.1-rc.2 \
  @deepseek-ai/dsh-sandbox-local@0.2.1-rc.2 \
  @deepseek-ai/dsh-sandbox-policy@0.2.1-rc.2
```

```sh
DSH_RUNTIME_ROOT=/path/to/runtime npm run test:integration
```

默认测试目录为 `.omx/integration-runtime`。已验证 Cordis `4.0.5`、Loader `1.0.6`、dsh `0.2.1-rc.2`：实际工具执行、策略组合顺序、结构化值保留、命名导出解析及卸载。已验证官方 Include/Loader YAML 组合，以及生产路由 baseline/observe/apply、下游内容与附加上下文保留、允许列表与收益门槛、PTC/失败/value 替换跳过及候选取消。另已通过真实 Node PTC 子进程与官方 `run_code` 桥接验证：内部结构化值和 dispatch 日志保持原样，仅最终模型可见 JSON 压缩；observe/apply 与卸载恢复均通过。未验证完整 dsh CLI/GUI 启动；有限的真实 Agent 任务评测见下节，不能外推到所有功能或工作负载。


## 可复现评测

```sh
# 无模型调用：真实 router/pipeline/codec 与官方原生裁剪的内容微基准。
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate

# 无凭据：真实 AgentLoop、工具、spill/read，脚本化 provider 验证控制流。
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:agent -- --replay

# 真实官方 provider：显式提供私有凭据文件，勿提交该文件或运行日志。
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:agent -- \
  --credential-file /private/path/deepseek.key --model deepseek-flash \
  --pricing-file /private/path/pricing.json
```

也可通过 `DEEPSEEK_API_KEY` 环境变量提供凭据。Agent runner 使用官方 `deepseek-official` provider，关闭 thinking，单次输出上限 1024 token、流空闲超时 30 秒、每任务最多 8 个模型步骤和 120 秒。质量要求在运行前固定：精确事实零遗漏、实际调用 fixture；TAP 任务必须执行 read，插件提供快照时必须读取该快照。答复不合要求、恢复失败、超限或 usage 不完整会使完整评测非零退出。工具调用和回读都计入该任务后续请求及累计 provider usage。

三组均使用真实官方 AgentLoop、SpillLocal、ToolFs 和 SpillPolicy：`baseline-default` 采用 base bundle 的 12500 inline token 上限；`baseline-tuned` 改为 1200；`plugin` 在 12500 上限上启用本插件 JSON/TAP 策略。这是明确声明的运行时组合，不包含完整 CLI profile 的所有插件，也未启用历史退场。离线 `evaluate` 中同名基线则仅调用官方 `pruneContent` 的默认/调优配置，不能等同完整 Agent 基线；离线字节除以三的估算不属于 provider 实耗。

真实费用验收要求显式价格 JSON，使用每百万 token 的 USD 单价，例如以下**有日期范围的历史快照**，重新运行前应核对当前模型、峰谷时段和假期规则：

```json
{
  "currency": "USD",
  "model": "deepseek-flash",
  "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing/",
  "verifiedDate": "2026-10-23",
  "ratePeriod": "peak",
  "uncached": 0.3,
  "cacheRead": 0.006,
  "output": 1.2
}
```

费用按 dsh **互斥计数**计算：uncached input、cache read、output 分别乘价，不把缓存读重复计入未缓存输入。脚本不会自动判断价格时段；调用者须确保统一价格适用于整次运行。未提供价格、计数缺失或无效、存在未定价的 cache write 时，费用为 `null`，真实评测的整体完成验收不会通过；回放可单独验证控制流。金额是根据 provider usage 的费用估算，不是账单扣款。`evaluate:live` 仅提供原文/插件文本的同 query 单轮问答辅助对照，不替代 AgentLoop 任务评测。

### 2026-10-23 有限任务结果

`deepseek-flash` 在 UTC 08:47、上列 peak 价格下运行两个固定任务：重复 JSON 中精确定位记录；Node TAP 中回读原文确认被预览省略的耗时。修正后的统一查询六组均通过，结果包含全部工具回读与模型步骤：

| 任务 | 组 | 模型步骤 | 累计实耗 token（含缓存读） | 费用估算 USD |
| --- | --- | ---: | ---: | ---: |
| JSON | 默认 | 2 | 4509 | 0.001160208 |
| JSON | 调优 | 4 | 9118 | 0.001326360 |
| JSON | 插件 | 2 | 2063 | 0.000426408 |
| TAP 原文恢复 | 默认 | 4 | 14760 | 0.001718604 |
| TAP 原文恢复 | 调优 | 3 | 11108 | 0.002357172 |
| TAP 原文恢复 | 插件 | 3 | 9473 | 0.002134596 |

两任务累计默认 19269 token / $0.002878812，调优 20226 / $0.003683532，插件 11536 / $0.002561004。插件 TAP 任务虽然 token 较少，费用仍高于默认组，因为未缓存输入与输出占比不同；不能仅按总 token 推断费用。

首轮不是全通过：JSON 三组通过，TAP 调优组答复未满足 JSON 验收，插件组事实正确但读取了原文件而非指定快照。随后对三组使用相同的明确快照优先与 JSON 输出要求，再运行完整套件得到上表；首轮失败未被当作成功或从历史记录删除。这是调整过任务说明后的结果，不能用作未见样本的泛化证明。

任务按固定组顺序执行，共享 provider cache，存在顺序和缓存混杂；样本仅两个、每组一次。以上不证明一般 coding 任务收益，也不证明历史退场或其他未参与策略的净收益。后续需要固定任务说明、多次重复并交错组序、扩充真实工作负载，再评估质量与费用分布。


### 历史退场与经济预测的完整任务复核

```sh
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:retirement -- --replay
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:retirement -- \
  --credential-file /private/path/deepseek.key --pricing-file /private/path/pricing.json \
  --model deepseek-flash
```

该 runner 对同一 TAP 快照问题运行默认、调优和历史退场三组；插件组关闭即时 JSON/TAP 策略，实际通过 `agent/pre-step` 退场并使用官方 read 回读原始快照。脚本是明确的乐观预测压力场景，仅接受 `deepseek-flash`：实验事先声明未来 200 次请求、预期回读费用 0、peak 输入价 0.3/缓存读价 0.006 USD/百万 token、安全余量 25%；这些不是产品默认值或对实际任务的预测。实验把最小曝光配置为 1，产品默认仍为 2。实际费用另按明确提供的价格与全部 provider usage 计算。

2026-10-23 UTC 09:48 的修订统一查询中，三组均通过精确事实验收且各执行 4 个模型步骤；插件实际退场后仅剩 **2 次**模型请求，并成功回读快照：

| 组 | 完整任务费用估算 USD |
| --- | ---: |
| 默认 | 0.001816644 |
| 调优 | 0.001570512 |
| 历史退场 | 0.001988868 |

插件比默认贵 $0.000172224、比调优贵 $0.000418356。门槛在未来 200 次假设下预测保守净收益 $0.000807534、回本需 103 次，但实际只有 2 次；预期回读费用为零也不符合该任务。这说明乐观假设不能替代实测，短任务可能负收益。相同任务使用未来 2/5 次假设的官方 AgentLoop 回放均拒绝退场，保持完整任务质量；这是控制流证据，不是额外真实模型实测。

首轮未来 100 次假设被真实经济门槛拒绝，默认和插件组答复还未满足严格 JSON 输出要求。保留首轮失败后，对三组统一强化最终输出要求，再以明确标注的 200 次压力假设运行上表；不能把这种修订当作泛化质量或预测准确率证明。固定组序、共享缓存和每组一次的限制仍然适用，费用是估算而非账单扣款。


### 2026-10-26 版本化完整任务对照

验收工具提供固定任务清单、每任务三次重复、三组均衡顺序、逐次 JSONL 记录及源码/运行时摘要。默认回放仅验证控制流；真实运行须显式提供凭据文件与价格。输出已存在时拒绝覆盖。

```sh
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:acceptance -- --version 2 \
  --output /private/path/replay-v2.json
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:acceptance -- --version 2 --live \
  --credential-file /private/path/deepseek.key --pricing-file /private/path/pricing.json \
  --output /private/path/live-v2.json
```

v2 在官方 rc.2 AgentLoop 上运行 13 个固定任务，共 117 次真实模型任务。模型为 `deepseek-flash`，清单哈希 `5e220ecd0d2b156fa9b02cfc0e927ea74bbb767eaa991739adefb25b20e30bcd`，执行源码摘要 `024fb203f0d61742d16227ceab4652fec0d4e5c093f8bcb49a659c7133905552`。插件与调优原生组均使用 1200 inline 上限；允许每阶段至多两次不含答案的协议纠错，全部调用均计费。

| 组 | 核心任务质量 | 核心任务费用 USD | 全套质量 | 全套费用 USD |
| --- | ---: | ---: | ---: | ---: |
| 默认 dsh | 24/24 | 0.037454184 | 39/39 | 0.071092596 |
| 调优原生 dsh | 24/24 | 0.031636800 | 33/39 | 0.058349604 |
| 插件 + 调优原生 | 24/24 | 0.024350904 | 36/39 | 0.050911176 |

核心任务累计与逐任务收益中位数均为正，通过本轮 `coreAccepted`。未知格式和文件编辑任务仍分别有小额负收益。模型实验没有发生实际采用；其质量失败、全部成本及无采用结果均保留，`fullAccepted=false`。1000 次未来请求的历史压力用例只验证退场和恢复，不参与净收益验收。

先前冻结 v1 的 90 次真实运行未通过：插件费用约 0.066018 USD，调优原生约 0.060105 USD，存在质量失败、原生预算不一致和无实验采用。v2 明确修订任务表述与组合配置，保留 v1 数据；两版不能当作同一协议的连续重复。

所有费用采用 2026-10-26 核实的统一官方高峰单价，以便组间比较；实际峰谷账单可能不同。均衡顺序仍无法控制服务端共享缓存，这些合成固定任务不能证明一般工作负载节费。核心通过也不等于历史预测已实证校准，或三项模型实验已有净收益。

`originalAcceptance()` 另要求完整原始校准记录和绑定的负收益回测；不会信任单独的成功标志。校准器校验来源、策略、每阶段新答案、所有模型调用及用量总和，并从调用位置推导真实剩余请求数。旧报告缺少这些记录会被拒绝。每份报告仍依赖可信运行器提供，不能用本地校验认证伪造的模型记录。
