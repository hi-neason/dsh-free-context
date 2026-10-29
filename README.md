# dsh-free-context

DeepSeek Harness（dsh）的独立上下文优化插件，目标是在保持 Agent 任务质量的前提下降低累计 token 消耗与实际费用。

当前支持工具结果处理、观察诊断、保守 JSON 路由与可选 Node TAP/spec 日志精简；默认保持原文，显式配置允许工具并选择 `apply` 后才采用合格候选。已有固定任务的完整模型对照，尚未通过全部十四项验收，结果与限制见下文。使用 ESM JavaScript 和 Node.js 24，无运行时依赖，服务由宿主 dsh 提供。

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
  text: { enabled: false },
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
| `text.enabled` | `false` | 对允许列表中的非 `read` 工具结果尝试自包含无损文本编码 |
| `readText.enabled` | `false` | 对明确属于源文件的 `read` 文本尝试可逆编码；需要宿主分类服务及原文存储 |
| `readText.encodeArtifacts` | `false` | 配合 `readText.enabled`，对宿主确认的 artifact 读取输出自包含可逆 frame，不创建新快照 |
| `retirement.enabled` | `false` | 历史结果退场；具有独立工具允许列表和经济门槛，见下文 |

字节和 token 数必须为非负安全整数；未知键、错误类型和无效配置会在加载时明确报错，即使 `mode` 为 `off` 也要通过校验。配置经过复制和递归冻结，不受调用方后续修改影响。即时策略与历史退场全部关闭时不注册监听器。

JSON 路由只接收单个纯文本内容块：通过工具允许列表与完整内容块体积检查后，编码适用的对象数组，解码并比较 JSON 数据，然后要求完整候选字节数和估算 token 均严格减少，且估算差值达到 `minSavingsTokens`。输入预算包含 JSON 转义与块元数据，正文单独低于上限不足以通过检查。已有编码 envelope、未知格式、非规范 JSON、多块或媒体内容保留原文。JSON 路由不丢弃字段；打开 `logs.enabled` 后可进一步匹配下文限定的 Node TAP 日志。

### 可选普通工具文本编码

设置 `text: { enabled: true }` 并将工具名加入 `tools` 后，JSON 路由未命中的单文本结果会在日志精简之前尝试 `tool-lossless-text-v1`。例如 `{ mode: 'apply', tools: ['bash'], text: { enabled: true } }` 可以处理重复较多的命令输出。完整候选的序列化字节数与估算 token 均须至少减少 50%，同时满足 `minSavingsTokens`；短文本、缺少重复或节省不足时继续原有路由。

编码包含该次工具呈现文本的完整字典、文字片段、UTF-8 字节数和 SHA-256，采用前校验精确往返，不调用模型或创建快照。内容块元数据与程序消费的 `value` 保持原样；工具错误、PTC 内部调用和结构化值替换仍跳过，PTC 最终输出可以按允许列表处理。`read` 始终排除在本开关外，读取编码继续使用独立的 `readText` 分类规则。`observe` 只报告候选、不改变模型输入。文本可还原不等于模型任务质量或完整任务 token 收益已通过验证；该选项默认关闭。

### 2026-10-28 文本策略限定实测

官方 `0.2.1-rc.2` AgentLoop、真实 DeepSeek `deepseek-flash`，默认原生 spill 12500、调优及插件组 1200，插件先于原生 spill 处理输出。三个固定材料分别重复两次，第二轮逆转组顺序；18/18 完整任务事实与用量检查通过。下表为两次完整任务累计 token，包含缓存与非缓存输入、输出及恢复；没有辅助模型调用。

| 材料与任务 | 默认 dsh | 调优 dsh | 插件 | 相对调优减少 |
| --- | ---: | ---: | ---: | ---: |
| 重复普通文本中的 MAGIC 字段 | 18,560 | 11,297 | 2,862 | 74.7% |
| 编译日志全部诊断与退出码 | 7,558 | 15,697 | 7,391 | 52.9% |
| 重复 JSON 中指定记录（原有策略回归） | 9,292 | 16,856 | 4,392 | 73.9% |

前两项实际采用 `tool-lossless-text-v1`，编码内容哈希与后续模型请求逐一匹配；JSON 仍采用原有 `json-rows-v1`。额外关闭新 text 开关运行四项完整对照，4/4 答案和用量完整：重复文本两次合计 9,966 token、编译诊断 11,528 token；启用时分别 2,862、7,391。这些对照顺序执行、缓存不受控，只作同版本配置差异的限定证据。编译材料沿用测试中的 compiler 原文和首阶段问题，另定义单阶段完整任务，不强制已有完整输出时额外回读；未重算旧验收结果。编译插件组两次分别 2,433、4,958 token，后一次模型在首步同时调用原文 read，超过默认组同次 3,779；这项恢复开销已计入。三种固定材料和两次重复只能证明限定场景，不能推出一般开发任务质量或收益，也不能把全部 JSON 收益归因于本次新增策略。缓存与模型行为未受实验控制，token 总量与实际费用分别衡量，策略保持默认关闭。

### 可选读取文本编码

`readText.enabled: true` 仅处理允许列表中的直接 `read` 调用。宿主先注册 `freeContextReadClassifier` 服务，其 `classify(read.value.path)` 必须返回与输入路径绑定的 `{kind:'source', complete:true, inputPath, canonicalPath}` 才能编码源文件；artifact 默认保持原文，unknown、服务缺失或失败始终保持原文。分类声明来自可信宿主，不能来自工具正文或“快照登记未命中”。PTC 内部调用、工具错误和结构化值替换继续跳过。

本地文件系统宿主可以使用 `dsh-free-context/read-source-classifier` 的 `createFilesystemReadClassifier({sourceRoots, artifactRoots, artifactInventoryComplete:true})`。只有宿主确认清单覆盖同一文件系统中**当前和历史全部产物根目录**，并保证读取至分类期间路径映射及清单稳定时，才能声明完整。每次分类重新检查目录、真实路径、文件类型和硬链接；缺失目录、源根外文件、opaque locator 等返回 unknown。远程或不透明存储需要对应宿主适配器。此辅助函数不能证明宿主声明、消除并发路径替换或授予恢复权限。

源文件策略先验证精确文本往返，通过原生 spillStore 保存当时的完整呈现文本，再附恢复引用。完整候选（包含说明、字典、元数据及引用）的序列化字节数和估算 token 均至少减少一半，且满足 `minSavingsTokens` 才采用；保存失败或取消保持原文。程序消费的 `value` 保持原样。编码仅保证**该次工具呈现文本**可还原，不能恢复原生 read 已规范化的换行或已截断的文件部分，也不保证模型理解等价或任务费用下降。独立 `dsh-free-context/lossless-text` 编解码器仅接受编码 frame；源文件候选尾部的快照引用不属于 frame。当前尚无启用此策略的完整真实模型净收益验收通过结果。

另行设置 `readText: { enabled: true, encodeArtifacts: true }` 后，同样绑定当前路径且 `complete:true` 的 `kind:'artifact'` 可以采用 `read-artifact-lossless-text-v1`。该策略只返回包含完整当次呈现文本、UTF-8 字节数与 SHA-256 的独立 frame，**不访问存储、不登记新快照、不追加新 receipt**，因此重复读取不会产生新的渲染快照链。完整 frame 同样须满足 50% 字节与估算 token 节省及 `minSavingsTokens`；取消或转换失败保持原文。原 artifact 文件、结构化值和元数据不变。此策略不承诺存在额外的 raw 回读工具；它的文本还原能力来自 frame 自身，不能与原 artifact 文件的字节验证混用。恢复遥测依据最终工具结果标记为 `modified`，仍为 `verifiedFull:false`。该选项尚待完整真实模型任务评测。

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

## Node 测试日志精简

设置 `logs: { enabled: true }` 后，单文本块的 JSON 路由未命中时可识别严格限定的 Node TAP v13 输出：完整顶层 `Subtest`、连续编号 `ok`/`not ok`、Node 的 duration/type 元数据、匹配的 plan 与完整总结。嵌套 suite、跳过/待办/取消测试、截断输出、额外成功诊断、普通控制台输出、非匹配格式及明显指令提示内容均保留原文。指令检测是有限的保守规则，不是任意恶意文本检测保证。

预览保留每个成功测试的名称与状态、所有完整失败块（包括错误 YAML、路径、行号和堆栈）、plan 与总结；仅省略成功测试重复的 `Subtest` 标签以及已识别的 duration/type 元数据。预览明确标为 `LOSSY`，说明省略范围与数量，并非完整 TAP 流。失败工具结果本身仍直接通过，不因日志内存在可识别结构而改写。

同一 `logs.enabled` 开关也支持严格限定的 Node 默认 spec 报告（`node-spec-v1`）：平铺的 `✔`/`✖` 测试状态及毫秒耗时、匹配的 `ℹ` 汇总、零 suite/跳过/取消/待办，以及与失败状态逐项匹配的 `test at 路径:行:列` 诊断附录。该预览明确标记为 `LOSSY`，省略成功测试的名称和耗时并汇总数量，保留每个失败状态、完整原文诊断附录和汇总；官方 bash 附加的非零 exit code 也原样保留。查询成功测试名称或精确耗时时需要恢复原始快照。ANSI/控制字符、嵌套报告、未知输出、计数不一致、缺失失败附录或额外未识别内容均回退原文。

2026-10-28 限定真实模型对照：从本仓库实际运行的五组平铺单测（config、JSON codec、selector prompt、text selection、read text）捕获 100 项成功报告，未增加噪声。官方 rc.2 AgentLoop、DeepSeek flash、插件先于原生 spill，完整任务包含实际所有输入/缓存/输出及回读。仅取汇总的两次任务三组均正确，累计 token 默认 6,364、调优 4,988、插件 3,196（相对调优减少 35.9%）。随后追问被省略的成功测试精确耗时，三组均正确，插件确实从原始快照恢复；累计默认 5,886、调优 6,920、插件 6,382，插件比默认多 8.4%，该负例保留。

实际短失败报告计入恢复说明后回退原文。首轮控制问题的 `code` 含义不明确，三组均未匹配固定期望；前瞻 v2 明确要求诊断元数据的 code 属性后，三组均正确，未重算旧失败。此处只证明固定报告的汇总、失败字段和精确回读，不能外推为编码任务质量。另一次真实 CLI 修复任务三组都通过独立 82 项边界检查，但插件组耗尽 20 步且未按要求完成重测/收尾，整体失败；三组均无压缩采用，不声称开发任务净收益。

有损候选必须先通过宿主 `spillStore` 成功保存完整原文，再附上真实快照引用与恢复说明，最后对包含引用的完整候选执行字节数和估算 token 收益门槛。缺少后端或会话/调用标识、归档失败、取消、收益不足均保留原文。JSON 路由无需该存储服务；日志功能开启也不强制新增存储后端。

**观察模式有存储副作用**：`observe` 为计算真实引用成本也会归档原文，但不改变模型输入。即使最终引用太长、收益不足或归档后取消，后端也可能已留下快照；由宿主存储清理策略管理。预览可恢复不代表任务语义无损；真实 Agent 评测仅覆盖指定固定材料（部分来自实际 Node 输出），其结果不能外推到其他日志与工作负载。

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

`free-context/recovery` 只观察同一 Session 对象中、`read.file_path` 精确等于已登记 locator 的现有 read 调用，报告 `recoveryCallId`、原引用及 `success/failed/blocked/modified/cancelled` 状态；成功且返回结构有效时附实际 `startLine/endLine/totalLines`。不推断别名，不重新读取源文件，也不提供额外恢复工具。所有事件均为 `verifiedFull: false`：返回全部行仍不能证明原始换行、字节数和哈希完全一致，更不能证明模型使用了这些内容。诊断在 `tools/post-execute` 捕获基线，于 `tools/result` 观察冻结的最终工具结果；这不证明 Session 持久化或后续模型请求消费了该内容。观察者异常不改变工具决策。

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

### 可选的重复片段编码

设置 `promptEncoding: 'auto'` 可在辅助选择器输入中尝试字面量字典和重复计数编码；默认仍为 `'plain'`。插件先本地解码，逐个核对原始段落 ID、完整文本和重复次数，再比较包含解码说明的完整请求字节；更小才采用，否则发送普通文本。编码异常或往返不一致会明确拒绝此次选择，不会静默改为一次付费普通请求。

该编码只改变辅助模型看到的表示。问题、必选 ID 保持原值，返回给主 Agent 的摘录仍取自原始文本，偏移、诊断保护和审计校验继续生效。可逆性不证明模型理解等价；即使字节缩小，仍需用真实模型验证选段质量、实际 token、额外回读和完整任务净费用。

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

### 2026-10-27 诊断策略重复验证

新增源码评测接口 `scripts/evaluate-diagnostic-trial.js`，对长日志候选和实际 Clang 短日志各执行三组、三次重复。长日志候选是错误与进度交错的受控合成材料；短日志由本机实际编译两个 C 文件产生，记录源码、命令、版本及完整输出。普通单测使用明确标注的合成协议数据，不依赖系统编译器；这组集成测试和默认评测需要 `/usr/bin/clang`，也可显式捕获其他路径的 Clang 后传入 `controlCapture`。

```js
import { evaluateDiagnosticTrial, summarizeDiagnosticTrial } from './scripts/evaluate-diagnostic-trial.js'

const replay = await evaluateDiagnosticTrial({ replay: true, promptEncoding: 'auto' })
// 回放只验证协议。真实调用另需 key、完整 pricing/provenance、
// 成功持久化的 onPlan 和逐次 onResult；显式设置 replay: false。
const checked = summarizeDiagnosticTrial(replay.plan, replay.results)
```

模型、单价、源码标识、完整选择器与 runner 配置在首次模型调用前复制、冻结并写入清单哈希；之后的回调不能更改执行价格。每个要求执行工具的阶段都单独验证成功调用；真实评测强制等待计划与逐次记录写入。候选通过要求质量、实际采用、完整计价、累计收益及三次配对收益中位数均通过。短日志成本单列，候选通过不能解释为整个研究或全部十四项通过。

两种表示分别完成 18 次真实 `deepseek-flash` 任务；全部任务质量通过，长日志候选均有实际采用，但净收益未通过：

| 选择器表示 | 长日志质量 | 长日志累计净收益 USD | 三次配对收益中位数 USD | 候选验收 |
| --- | ---: | ---: | ---: | --- |
| plain | 9/9 | -0.003635508 | -0.001312740 | 未通过 |
| auto | 9/9 | -0.001079940 | -0.000266676 | 未通过 |

净收益为调优原生组费用减插件组费用，负数表示插件更贵。两条件总费用分别为 0.027664788 和 0.026783616 USD；真实短日志控制的净收益分别为 +0.000158544 和 +0.000184908 USD，但它不属于预先声明的长日志收益候选，也不能替代其验收。选择器输入缩短后，完整任务仍有多次原文读取；较小请求不保证净节费。

两条件采用相同冻结源码和相同控制材料，分别使用独立清单；共享服务端缓存仍不可控，不能把跨条件费用差异完全归因于编码。单价继续采用明确声明的统一历史高峰价，金额是 usage 估算而非账单。此前单次试验的正收益和负收益全部保留，未用后续运行覆盖。本轮仍未通过 FC12—14 的原始完整验收。

### 2026-10-27 校准与独立负样本回测

另行冻结了一个 bootstrap 压力协议：仍声明未来 200 次请求，将退场摘录预算设为 64 字符；先前 256 字符配置的经济拒绝保留。该参数只用于收集实际退场后轨迹，不是合理预测或收益承诺。三个训练执行的真实剩余请求数分别为 **3、2、2**，据此得到保守建议 **2 次请求**和 **0.000338736 USD** 恢复费用预算。后者按携带目标快照读取结果的完整模型调用费用计算，是保守观测额度，不是恢复的因果增量费用。

第四个执行预先指定为独立留出，未进入训练；它实际剩余 2 次请求，插件比调优组贵 **0.000735660 USD**。基于训练记录的校准决策和事后观测决策均拒绝这次退场。12 次真实任务的质量与用量记录完整，总费用估算 **0.020951520 USD**。原始训练/留出记录、哈希及首次失败均保留，没有删除失败后凑够成功样本。

在同一个冻结运行配置中，随后实际加载该预测，三组任务均完成；插件将 200 次假设收紧到 2 次并拒绝退场。该运行验证了配置生效，仍不证明完整任务节费。校准压力协议中插件原生上限为 12500、调优组为 1200，不能拿它作公平的盈利对照，也不能直接套用到不同预算、安装顺序或纠错设置。校准范围现在绑定实际三组运行配置；旧记录缺少的执行上限不能默认补成新记录的值。

### 2026-10-27 选择阶段覆盖说明的限定收益场景

诊断选段现在可报告受支持的带行列号编译器诊断头及状态块保留计数，绑定原始哈希并校验完整源片段。这些计数明确属于 **下游保留策略之前的已验证选段**，不表示最终 inline 内容或语义完整；原生 spill 仍可能省略部分摘录。真实原生组合回归验证了“计数保留而部分诊断被裁剪”的情况，提示会区分回读完整 spill 输出和核对原始快照。评测记录新增数值读取窗口和返回行范围，不记录路径或正文，也不把行覆盖视作字节校验。

同样的完整枚举任务、三组配置及三次均衡重复，在独立冻结的 `auto` 研究中得到：

| 配对重复 | 调优原生费用 USD | 插件费用 USD | 净收益 USD |
| --- | ---: | ---: | ---: |
| 0 | 0.002615976 | 0.002713008 | -0.000097032 |
| 1 | 0.003631548 | 0.002980716 | +0.000650832 |
| 2 | 0.003734472 | 0.002724408 | +0.001010064 |
| 累计 | 0.009981996 | 0.008418132 | **+0.001563864** |

18 次任务、27 个阶段全部质量通过，三次候选运行均验证已持久化且被模型使用的选择。配对收益中位数为 **+0.000650832 USD**，通过预先声明的候选门槛；整个研究包括真实 Clang 短日志控制，费用为 **0.029345280 USD**。短日志控制没有实际压缩采用或辅助调用，其费用差异不能归功于压缩。清单哈希为 `503dad276c8e6aca89447e79c0b0495976cd92697be4d19d068877892ff39d47`。

这为 **一个受控合成长日志任务** 提供了真实模型的限定净收益证据，首轮亏损保留。所有候选阶段仍读取了覆盖工具所报告全部源行的内容，因此不能声称已经消除恢复；也不能将跨研究的费用差异完全归因于覆盖说明或编码。缓存未受控、仅三次重复、金额为声明单价下的 usage 估算，尚无真实业务项目泛化结论。此前所有负收益研究继续保留；截至该研究，FC12/13 尚无通过重复对照的限定收益场景，全部十四项也未通过原始完整验收。后续独立协议见下节。

### 2026-10-27 三类模型选择的重复任务对照

新的独立 v2 协议对任务无关文本选择、当前问题选段和编译器诊断抽取，各执行三组、三次均衡重复。三组使用相同问题、工具、12 步和 120 秒上限；插件叠加同样的原生 1200 token 上限。两项文本任务显式禁止占位回答，三组均可在每阶段最多接受两次不含标准答案的协议反馈；默认行为仍允许原文中的 `null` 或 `unknown`。所有初稿、纠正及其费用均计入，未重评分旧研究。

| 实验模式 | 调优原生总费用 USD | 插件总费用 USD | 累计净收益 USD | 配对净收益中位数 USD |
| --- | ---: | ---: | ---: | ---: |
| FC12 任务无关文本选择 | 0.007974012 | 0.007494936 | +0.000479076 | +0.000117612 |
| FC13 当前问题选段 | 0.009420960 | 0.005685972 | +0.003734988 | +0.000929508 |
| FC14 诊断证据抽取 | 0.008885436 | 0.006504324 | +0.002381112 | +0.001193244 |

27/27 任务、54/54 阶段通过精确事实验收，三种模式的三次插件运行均验证了持久化内容被模型实际消费；155 次模型调用包括 12 次辅助选择调用，总费用估算 **0.072954588 USD**。8 次协议纠正分别发生在默认组和调优组，各 4 次，插件组为 0，原因是 1 次 JSON 格式及 7 次缺少本阶段工具调用；本轮没有触发占位纠正，不能把通过归功于新检查。费用差异包含这些纠正，不能解释为纯输入压缩的因果收益。FC12 和 FC14 各有一次配对亏损，仍保留于原始记录。清单哈希为 `393bc2b4b19f4d32a3fc2296bc0a5789f5b487b41fc1b04b9cb8d67512a9c31e`。

旧 v1 的 27 次任务只有 26 次质量通过：FC13 调优组返回占位字段，因此该模式即使账面便宜也未通过；v1 结果及先前负收益研究保持原样。v2 没有删除该失败或追溯启用新反馈规则。

查询选段有一次选择了普通背景段落，最终通过原文回读或已有历史完成正确答案；通过的是完整任务及恢复流程，不能据此声称每次选择都覆盖所需事实。

三类实验因此各有一个通过预设质量、实际采用、累计收益与配对中位数门槛的**受控合成任务场景**。金额按 provider usage 与统一声明价格估算，非发票；缓存不受控、每模式仅三次重复，实验使用显式 `measured-trial`，不代表默认经济准入策略会采用或获利。全部十四项仍未通过同版本完整组合验收，真实开发任务泛化也未验证。

### v3 完整验收入口

`--version 3` 保留 13 项任务和 117 次运行，逐个要求三项模型实验的质量、实际采用、累计收益与配对收益中位数通过；不会用一个模式的收益抵消另一个模式的失败。v1/v2 的清单和旧结论保持原样。

```sh
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:acceptance -- --version 3 \
  --output /private/path/replay-v3.json
```

真实运行沿用 `--live --credential-file ... --pricing-file ...`。CLI 在首次模型调用前以独占创建方式写入 `<output>.plan.json`，随后逐条保存 `<output>.jsonl`；已有文件会拒绝覆盖。直接调用 `evaluateAcceptanceV3()` 时，真实模式必须提供异步 `onPlan` 和 `onResult` 持久化回调。计划、价格、来源标识及结果使用独立冻结副本；每项任务结束后独立核对全部原始模型调用用量、provider/model 和价格，记录不完整就停止后续付费任务。

`fullAccepted` 表示这份固定基准通过。原始十四项的联合验收还须调用 `originalAcceptanceV3()`，核验同源码、同运行配置的预先登记校准训练记录，以及独立的短期负样本回测。生产插件的模型实验仍默认关闭；v3 显式使用 `measured-trial` 收集真实成本，不能据此宣称默认经济准入策略获利。

### v3 联合真实运行仍未通过

首次联合运行在校准阶段遇到一次传输错误，模型随后答对，但失败请求没有 usage；该批完整费用未知，已知调用费用下界为 **0.007601400 USD**，没有把缺失调用补成零。原始失败保持原样。

随后另行冻结整批重试，未复用首次运行的成功片段。重试实际执行 12 次校准任务和 116 次基准任务，共 498 次模型调用，已记录调用费用 **0.200403528 USD**。任务间预算检查使其略超预设的 0.20 USD，最后一个默认组基准任务未执行；它以零调用失败记录保留，不能算已完成的真实任务。

| 基准组 | 实际执行任务 | 质量通过 | 已执行部分费用 USD |
| --- | ---: | ---: | ---: |
| 默认 dsh | 38 | 37 | 0.073025484 |
| 调优原生 dsh | 39 | 37 | 0.067722132 |
| 插件 + 调优原生 | 39 | 39 | 0.049491480 |

失败包括默认组将文件内容包进额外字段、调优组混淆两个服务的字段，以及调优组遗漏一项 TAP 错误。表中费用包含失败任务，默认组还缺一次运行，不能用其差额宣称完整任务净收益已验收。

校准任务本身全部答对，但第一份训练中，模型将 `fixture` 和 `read` 放在同一轮工具请求，随后直接结束；策略正确地没有产生可观察退场后请求，因此这份训练不满足校准条件。其余两份训练实际各剩余 2 次请求，独立留出为 3 次；训练成员不能事后替换，旧短期回测的上限也不会追溯放宽。

因此本批 **`fullAccepted=false`，原始十四项联合验收仍未通过**。此前三类实验的独立限定收益结果继续成立，但不能拼接为本批通过。重试清单哈希为 `d09a56cfdddf58d2b1e9b95ed7b7ffd1cb1fb930c1403563cc195e51038e734b`；完整原始记录、预算停止及先前失败均保留。

自定义评测 fixture 可显式设置 `discoverSourcePath: true`：初始提示不再提前提供文件路径，`fixture` 工具返回数据及末尾的原始文件 locator，模型据此读取随机文件名的原始数据。这为“先观察结果、再读取源文件”的任务建立工具数据依赖；真实调用顺序仍须从记录验证。默认关闭，旧提示和工具内容保持不变；现有冻结 v1/v2/v3 任务及结论不会追溯启用它。官方运行时测试覆盖三组读取、原生 1200 上限后的 locator 保留，以及包含 locator 的精确工具快照恢复；尚未将该新场景作为真实校准通过证据。

评测 fixture 或单独 phase 还可声明可选 `responseSchema`，用于约束答案格式。例如文件内容任务可显式要求 `version`、`retryLimit` 为整数并禁止额外包装字段。支持的类型为 object、array、string、number、integer、boolean、null；关键字子集为 `type`、对象 `properties`/`required`/`additionalProperties` 和数组 `items`，不支持 `const`、`enum`、`$ref` 等关键字；非法、递归或过大的 schema 在模型调用前拒绝。反馈只包含声明的路径、类型和格式问题，不提供标准答案值。三组沿用同一纠正上限，额外调用仍计费；汇总器独立重算格式约束，精确事实验收保持单独执行。未声明时保持旧行为，既有冻结任务和结果不追溯更改。这只能检查格式，不能证明字段事实正确或诊断完整。

`type` 也可用非空、无重复的类型列表，如 `['string', 'null']`；最多包含上述七种类型。联合节点仅允许 `type`，不同时接受对象或数组的结构关键字。混合 JSON 数组可用 `items: {type: ['boolean', 'number', 'string', 'object', 'null']}` 声明元素类型范围，不规定元素数量、顺序或值；容器内部未声明的结构仍由独立事实验收检查。

前瞻 fixture `test/fixtures/acceptance/tasks-v4.js` 为原有 13 个场景的每个阶段声明字段和类型，不改变 v3 原文、标准事实、工具要求、实验开关或恢复条件，也不从标准答案生成 schema。最初的 39 次场景回放验证单轮覆盖；完整 V4 入口进一步执行下述 117 次均衡调度。旧协议与失败结果不重算。

`test/fixtures/acceptance/retirement-v4.js` 另提供独立的来源定位校准场景：先从工具结果发现原始文件路径，再定向读取首行，并在历史结果退场后读取当时快照。只依赖模型可见消息的串行回放中，两组基线各 3 次请求，插件 4 次请求、退场后 2 次请求，快照结果进入后续模型输入。PTC 批处理对照可在 2 次请求中正确完成，但没有退场轨迹，不能用于校准；它与直接调用场景保持独立 scope。三次训练和一次独立留出仍必须用真实模型、同 fixture/策略/运行配置完成；留出不超过 2 次后续请求、实际负收益及训练预测拒绝退场的原门槛均未放宽。

### v4 完整响应协议

`--version 4` 保留同一 13 项任务、三次重复及 117 次调度，逐阶段绑定声明式 schema，并独立检查原始 JSON、解析值和精确事实。原核心收益、三模式各自实际采用和累计／配对中位数正收益、生命周期、回退及预算门槛保留；不会把 schema 正确当作事实正确，也不接受旧版本报告改标签。新问题中声明 schema 的开销会计入真实任务用量。

```sh
DSH_RUNTIME_ROOT=/path/to/runtime npm run evaluate:acceptance -- --version 4 \
  --output /private/path/replay-v4.json
```

CLI 仍在调用前独占保存计划，并逐任务保存完整结果；原始账本不完整会停止后续执行。直接调用的对应接口为 `evaluateAcceptanceV4()`、`summarizeAcceptanceV4()`、`originalAcceptanceV4()`，真实模式继续要求冻结的价格／来源和异步计划／结果检查点。117 次官方 AgentLoop 脚本回放通过，只证明协议执行；货币收益为 `null`，`accepted=false`。原始十四项仍需同版本真实校准、独立负回测和完整任务对照，不能用回放或旧研究拼接通过。

首次 V4 付费冻结前，两项 history 任务启用了来源路径发现：不再提前把原始路径放入用户消息，而由 `fixture` 返回随机文件名的 locator；三组都据此形成读取依赖。原始正文、标准事实、必需工具及 short 的 2／stress 的 1000 次预测策略不变，但模型输入与工具输出确实变化。对应回放只从模型可见消息提取原始路径、快照路径和答案，短期插件场景明确经过经济拒绝，压力场景明确退场并恢复。修订重新跑完整 117 次，旧 V4 manifest 不能混入，新 manifest 与源码须重新冻结；历史提交、先前回放日志及 V3 失败保留。PTC 批处理仍是独立无退场反例，不能由此保证真实模型轨迹或收益。

### 历史缺陷编码任务材料

`development-fixtures.js` 提供 `json-output-limit`，来自本仓库真实修复：旧源码提交 `916fe21`，修复及完整回归测试提交 `bbedaa5`。问题是重复 schema 字段可使不足 25 KB 的编码输入展开约 20 MB；任务要求修复输出字节预算，并保留正常解码及 UTF-8 边界行为。

`materializeDevelopmentFixture(id, newDirectory)` 只向新目录复制旧模块、固定的 9 项测试、原 package 元数据及许可证；历史参考修复不进入 Agent 工作区。`verifyDevelopmentWorkspace(id, directory)` 在 POSIX 平台独立启动 Node 24 测试进程组，超时或输出超限时终止并确认清理该组，再核对受保护文件及执行前后哈希，拒绝修改测试/package、符号链接或额外文件，并要求源码实际改变且 9 项测试全通过。离线控制确认旧源码 8/9 通过、历史修复 9/9 通过。

这仅是可重复的真实缺陷任务材料和验证器；尚未完成模型驱动的 CLI 修复任务对照，也不提供 token 或费用收益证明。它将作为独立开发任务扩展，不能替代原固定验收矩阵中失败的任务。

### 真实 CLI 编码任务入口

源码接口 `runDevelopmentTask()` 会启动官方 rc.2 headless CLI 子进程，使用独立目录、编码所需的 bash、文件读写与检索工具及公开插件配置。任务目录必须新建且位于本仓库外，并通过公开配置关闭 Agent 指令发现，避免继承本项目或其他祖先仓库的附加指令；文件和记录保留供调用方审计、清理。

```js
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDevelopmentTask } from './scripts/evaluate-development.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-development-'))
const result = await runDevelopmentTask('json-output-limit', 'plugin', {
  directory: join(root, 'run'), replay: true,
  runtimeRoot: '/private/path/to/official-cli-runtime',
})
console.log(result.replayComplete, result.verification.testRun)
```

三组分别为 `baseline-default`、`baseline-tuned`、`plugin`，原生上限为 12500/1200/1200。它们使用相同的编码工具、禁止后台任务和子 Agent 的任务配置。评测组合器通过各插件公开的 `apply` 和配置接口，顺序安装输入观察器、本插件、输出观察器、原生 spill 和最终观察器；这保证实际 hook 顺序，不依赖模块加载快慢。审计器先就绪，CLI 才能启动任务；它只观察模型和工具结果，不改写历史。插件前后哈希用于区分实际返回变化与候选选中后回退；下游原生策略仍可能改变结果，单独记录的 `selected` 或最终结果链路不能证明压缩已采用。此组合验证不替代各插件独立加载的生命周期测试。验证还包含初次测试失败、修改源码后的重跑成功、外部固定测试通过、结构化值保持一致，以及实际 Session 文件中工具结果与模型输入哈希的对应情况。

遇到全局超时或输出超限，入口先向 CLI 发送 `SIGTERM`，最多等待 6 秒，让 dsh 终止并等待其独立管理的工具进程。超过期限再强制终止 CLI 进程组；这种情况不能确认工具清理。只有 CLI 进程组消失、未发生强杀兜底，且退出记录确认没有进行中的工具调用，才运行外部验证。真实 CLI 回归检查执行中的 bash 在中断后进程消失且不再延迟写入，包括工具忽略 `SIGTERM` 的情况；中断任务仍判为失败。

默认是脚本回放：已知历史修复仅供回放适配器使用，不复制到任务工作区。三组回放各完成 5 次合成模型调用、真实工具读写和外部 9/9 测试；这不是模型自行修复的证据，合成用量不会计为费用。步数上限和计划保存失败的测试也会保留明确失败。

真实模式必须显式提供 `replay: false`、`key`、完整 `pricing` 及异步 `onPlan`/`onResult` 回调。计划在模型进程启动前保存；所有模型请求的开始、结束和用量独立核对，缺失用量阻止后续请求，不能按零费用补齐。账本逐行核对；损坏或截断会令完整性检查失败，但可核实的调用和用量小计仍保留。`passed` 表示任务质量，`withinBudget` 是单任务预算检查；请求间检查仍可能超额，两者都不是净收益验收。入口保留原始记录，并区分完整费用估算与可计价用量小计。`transformations` 只关联选中策略与下游处理后的最终结果，不证明裁剪后的内容完整。转换路径另有实际 CLI 回归，覆盖 JSON 压缩及随后原生 spill 的最终结果、Session 与模型输入哈希一致。

目前仅通过无付费 CLI 回放，尚未执行该编码任务的真实模型三组对照。单任务结果也不能替代原 117 次矩阵或原始十四项联合验收。

`evaluateDevelopmentStudy()`（`scripts/evaluate-development-study.js`）将同一历史任务按三次轮换顺序运行三组，共 9 个独立 CLI 任务。调用时指定仓库外新目录、官方运行时和总费用上限；真实模式另需显式凭据与完整价格。它先持久化研究计划，再逐任务保存绑定计划，预留完整的单任务调用数和费用额度，余额不足时停止，不缩小后续组的任务配置。预算是请求间检查的观测上限，最后一次请求仍可能超额，超额报告不能通过。

联合研究可提供异步 `onTaskPlan(taskPlan, slot, studyPlan)`：每个子任务计划与关联记录落盘后、CLI 启动前等待回调，用于核对父子计划和全局预算预留。回调失败会保留该次未启动任务的计划与失败记录，停止后续任务；不会补成零费用成功。

研究记录保留原始账本、Session 事件、单任务结果和耗时。`summarizeDevelopmentStudy(plan, records)` 独立重算调用用量、费用、工具执行顺序与最终内容哈希链路，拒绝缺失计价、来源漂移、未确认清理或不完整的 9 项覆盖。只有全部质量和预算通过、每个插件任务有可核对的实际采用，且累计收益和配对收益中位数均为正，才报告该场景通过。采用检查要求插件边界返回更小的内容，且其哈希与最终持久化及后续模型可见内容相同；原生 spill 再次改变内容时保守排除压缩归因，这不代表任务质量失败。没有采用时，观测费用差不能归因压缩。脚本回放始终不报告货币收益；缓存与样本限制仍然适用。

### V4 联合验收入口

`evaluateAcceptanceBundleV4()`（`scripts/evaluate-acceptance-bundle-v4.js`）将同一源码下的校准、独立留出、运行期预测、117 次基准和 9 次历史编码任务组织为一个计划。调用前需安装官方 `0.2.1-rc.2` AgentLoop 与 CLI 两套运行时；计划同时绑定两份 lock、源码及历史任务材料哈希。

```js
import { evaluateAcceptanceBundleV4 } from './scripts/evaluate-acceptance-bundle-v4.js'

const report = await evaluateAcceptanceBundleV4({
  rootDir: '/private/tmp/dsh-acceptance-unique', // 父目录已存在，目标目录必须不存在
  bundleId: 'local-replay-v4', replay: true,
  agentRuntimeRoot: '/private/path/to/agent-runtime',
  cliRuntimeRoot: '/private/path/to/cli-runtime',
  maxTotalCostUSD: 1, maxTotalCalls: 1992,
  knownPriorSpendUSD: 0, priorUnpricedCalls: 0, // 填写调用方实际历史账目
})
console.log(report.replayComplete, report.accepted, report.totalCostUSD)
```

启动 Node 时须将 `DSH_RUNTIME_ROOT` 指向同一 AgentLoop 运行时；已缓存模块不能通过中途修改环境变量切换。根目录必须位于仓库外。入口先独占创建目录并保存计划，逐任务预留完整预算、复核来源，结果写入 journal 后才等待可选的 `onResult` 回调。回调、核算或清理失败会停止后续任务，原始调用、已知费用和 CLI Session 保留；这些记录可能包含任务内容，应按本地评测资料管理。

脚本回放固定执行 138 项，明确跳过真实预测校准验证，费用为 `null`，不会通过真实验收。真实模式显式使用 `replay:false`、完整 `pricing` 和 `key` 或 `credentialFile` 二选一；凭据文件在计划保存及 `onPlan` 完成后读取。最多执行 141 项：12 项校准／留出、3 项由有效训练证据决定是否运行的预测验证、117 项基准及 9 项编码任务。预算是任务边界的预留与事后核验，单请求仍可能超额；无法计价的调用保持未知。

`summarizeAcceptanceBundleV4()` 独立重算原始记录，不信任子报告的通过标记。原三模式的采用、质量、累计及配对中位数收益门槛保留；独立留出仍要求退场后最多 2 次请求。历史编码任务是质量与费用对照，不强求压缩采用，但其费用纳入与基准的合计净收益。校准、预测和压力测试费用也计入整批预算，不能隐去。当前尚无该联合入口的真实模型验收通过结果，原始十四项仍未验收。

联合计划和开发研究的价格预检允许显式设置 `cacheWritePolicy: 'reject-nonzero'` 并省略 `cacheWrite` 费率，表示该项尚无报价。它不会把缓存写入当作免费：观测到非零写入时拒绝完整计价并停止后续任务，保留原始用量和已知费用。未声明此策略且缺少写入费率时，计划仍被拒绝。当前[官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)仅单列缓存命中、未命中与输出价格；DSH 的 Anthropic 兼容调用可能报告写入计数，因此不能用 Chat API 字段缺失来假定所有调用写入恒为零。旧价格文件及失败报告不作补填或重算。

### 2026-10-28 V4 真实联合评测：未通过

使用源码 `646150d`、官方 rc.2 的 AgentLoop 与 headless CLI，按新冻结计划执行了 133/141 项任务、526 次模型调用。计划 manifest 为 `c9940386dc575a06213aed8da3db52272a76ddb0106a321dc01a51ebb029008b`。最初一次启动在计划检查点停止，0 次模型调用；其失败记录另行保留。本批按声明的统一高峰价格估算为 **$0.212974956**，包括辅助调用和失败的编码任务，不等于实际分时账单。供应商缓存仍不可控，三组按固定轮换顺序运行。

校准、独立短期负收益留出与运行期预测验证通过：三份训练导出剩余请求数 2，留出实际也为 2；预测实装后，插件以经济性不足拒绝退场。完整 117 项基准结果如下。

| 组别 | 质量通过 | 累计估算费用 USD |
| --- | --- | --- |
| 默认 dsh | 38/39 | 0.072378624 |
| 调优 dsh | 39/39 | 0.063796860 |
| 插件 | 39/39 | 0.058689108 |

默认组的一次快照任务把 YAML 路径值的外层单引号也放入答案，未满足精确事实要求；保留失败，不作规范化重评。三种模型实验各自均为三组共 9/9 质量通过，插件 3/3 实际采用，但收益并不都达标：

| 实验 | 相对调优组的累计净节省 USD | 三次配对净节省中位数 USD |
| --- | --- | --- |
| 任务无关文本选择 | +0.003977148 | +0.001624812 |
| 当前问题相关选择 | −0.000921492 | −0.000379932 |
| 诊断证据抽取 | −0.000403980 | −0.000192864 |

查询相关选择两次遗漏所需段落，最终靠回读保持质量，额外选择调用抵消了主 Agent 的节省；诊断模式即使扣除辅助调用，主 Agent 部分仍比调优组贵。引用和采用链路有效，不能代替证据选择完整或净收益验证。

首个真实 CLI 编码任务在第七次调用达到 1024 token 输出上限，外部测试仅 8/9；全部调用费用均有用量可计价，但执行与费用完整性门槛未通过。执行器保留账本并停止，后续八项编码任务未启动。该批次 `accepted=false`，原始十四项仍未验收；不能把基准总费用下降或单项实验通过解释为整体验收完成。

联合入口可显式设置 `maxTaskCostUSD`，范围大于 0 且不超过原单任务上限 $0.05；该选项只收紧各阶段任务费用上限及启动前预留，不改变任务覆盖、质量、采用或收益要求。未设置时保留原 $0.05。新增评测的累计授权包含失败批次费用，重试不会获得一份新的预算；更小的单任务上限仍是观测与核验门槛，不能阻止单次请求超额。

后续优化源码 `8f5cf53` 又执行了一份独立冻结计划（manifest `efdd9a23851fa81e1df3609e082f5b021e3631bd60ab1fd5f05d40d642292b41`）。该批在 83/141 项、324 次调用后停止，已知费用估算 **$0.124442832**；已执行任务的质量检查均通过，但第 83 项的辅助选择调用达到 120 token 输出上限。选择器拒绝该结果并回退原文，主 Agent 答案正确，未产生压缩采用。该调用完整报告了用量；根执行器仍因辅助 `max-tokens` 不在费用完整性白名单而停止。失败报告保持原样，不将其重评为实验成功。

两批合计 **850 次模型调用、$0.337417788** 的已知费用估算，辅助费用和失败均计入，无新增未计价调用。第二批没有完成剩余 58 项或执行新的 CLI 开发任务，因此尚不能证明这些优化的完整任务净收益，原始十四项仍未验收。

生产实验的 `pricing` 也可在没有缓存写入报价时显式声明 `cacheWritePolicy: 'reject-nonzero'`，同时提供 USD 的未缓存输入、缓存读取和输出费率。未声明该策略且缺少写入报价的 measured trial 仍拒绝启动；实际出现未报价写入时保留原文、拒绝采用并封闭本次 trial 预算。V4 评测配置沿用此策略，不会把报价缺失转换为零费率。

后续 V4 前瞻计划将辅助响应预算调整为 **400 tokens**，其余输出字节、调用次数及金额上限保持不变。所有实际输出费用仍计入完整任务。资源配置进入 manifest；旧 120-token 计划或执行记录即使换上新标签，也不能混入新批次。版本号须结合 manifest 和源码哈希识别实验条件；旧报告使用其冻结源码核验。这是给已观察到的截断留出余量，尚不证明采用率、质量或净收益改善。

评测 API 还记录辅助调用中已观察到的 `block-end` 文本：最多 16 块、16 KiB 正文，超限保留哈希、字节数和遗漏标记；相关 CLI 移除正文。该字段仅用于本地失败诊断，不代表响应完整、有效或压缩已采用，也不会改写模型请求或历史。

后续 400-token 配置完成一批同来源的 **141/141 项、619 次调用**真实联合评测，费用估算 **$0.278509176**。117 项基准中三组各 39/39 通过质量检查；任务无关和问题相关选择的累计及配对中位数净收益为正。诊断选择虽累计节省 $0.000069504，其配对中位数为 **−$0.000254592**；独立留出退场后实际用了 **3** 次请求，超过最多 2 次的门槛；真实 CLI 编码任务仅 **1/9** 通过。整批仍未验收，合计正收益不能覆盖这些失败。

三批新增评测累计 **1469 次调用、$0.615926964**，无新增未计价调用；历史另有一次未计价调用。以上为统一声明费率的用量估算，含失败、辅助调用及开发任务，并非服务商账单。该批未启用后续新增的读取文本编码，不能作为该策略的收益证据。

后续编码验收在不改变历史材料和原 9 项测试的基础上，新增 **82 项**外部 UTF-8、JSON 转义及输出预算边界检查；验证器身份在执行前固定并参与父子计划，汇总器独立核验结果与源码哈希。前瞻联合计划为三组编码任务统一预留 **20 步、24 次调用**，9 项研究最多 216 次调用，仍受整批 1992 次及原金额上限约束。旧计划及失败记录不混入新批次，也不据此承诺真实编码任务已通过。

读取编码接入后的新前瞻计划执行到 **62/141 项、234 次调用**后停止：已完成的前 61 项通过质量检查，第 62 项的第二次模型调用未返回 usage，整批因此以 `incomplete-cost-accounting` 停止。已知费用 **$0.084850500**，另有 **1 次新增未计价调用**，不按零费用处理；其余任务没有继续执行。校准三份训练、独立留出的退场后最多 2 请求，以及运行期预测检查已通过，但覆盖不足，仍未通过完整验收。

本机电源日志显示，最后一项开始约 1 秒后进入合盖休眠，休眠约 1065 秒；该任务记录的耗时约 1066.8 秒。休眠与请求中断时间重合，不能据此确定服务商是否处理或计费。该失败保留原记录，不能用重跑结果替换。

四批新增评测累计 **1703 次调用、已知 $0.700777464**，另有上述新增未计价调用；更早还有 1 次历史未计价调用。未知费用使实际累计费用尚不能完整核算。读取策略的单次缩减和部分任务正收益不构成全部十四项验收通过。

artifact 可逆表示的新批次在 **31/141 项、114 次本地逻辑调用**后停止。调优原生组的一次 `TRANSPORT` 错误未返回 usage；已知回调用量按统一峰价估算为 **$0.039657564**。虽然最终两阶段事实均正确，原始记录仍含失败 turn 和用量缺口，因此整批以 `incomplete-cost-accounting` 拒绝，不能通过聚合账单把该任务重评为成功。

后续评测在发现**已结束调用**缺少完整用量后，阻止下一 Agent 步骤、反馈重试和后续阶段，保留原调用及已知费用。它不取消服务商已处理的请求，也不提供严格单请求费用上限。模型错误仅记录白名单类别、错误码、有效 HTTP 状态及请求 ID 哈希，不保存错误正文、请求头或原始请求 ID；公开接口未暴露的信息仍保持未知。

本地对账区分进入客户端的逻辑尝试与服务商记入账单的请求，也区分实际钱包扣费与统一峰价研究指标。账单聚合核验可用于预算控制，不能补造失败调用的逐调用 usage、删除失败记录或拼接旧批次的成功结果。AgentLoop 报告中的 `readAdoptions` 单独关联有效编码帧、Session 持久化及后续请求内容哈希；它不能代替辅助模型实验的采用证据。

### 2026-10-29 精简恢复说明后的真实对照

缩短恢复说明及辅助选择器共享说明后，在固定 V4 材料上独立运行三种实验、三组对照、每组三次重复，共 **27/27** 任务通过质量检查且调用用量完整。下表为调优原生组与插件组的完整任务累计值，包含辅助选择调用；费用均采用统一峰价估算，不代表实际账单。

| 实验 | 调优原生 token | 插件 token | 调优原生费用 USD | 插件费用 USD |
| --- | ---: | ---: | ---: | ---: |
| 任务无关选择 | 102432 | 40144 | 0.008991564 | 0.004119600 |
| 问题相关选择 | 84175 | 41336 | 0.007723740 | 0.004126476 |
| 编译诊断证据选择 | 82137 | 47688 | 0.008236452 | 0.005458980 |

每种模式的三个配对均同时减少累计 token 和估算费用。两阶段插件任务均实际采用两次；任务无关和编译诊断模式复用第一次辅助结果，问题相关模式调用两次辅助模型。这是固定受控材料的证据，不能推出任意开发任务也能节省。

同版本三组真实 CLI 编码对照均通过原 9 项测试和 82 项外部边界验证，但未发生压缩采用：默认、调优原生、插件组分别消耗 63107、117326、139597 token。因此不宣称编码任务收益。

后续完整联合批次执行至 **102/141** 项时因一次 `TRANSPORT` 调用缺失 usage 停止，已知统一峰价费用 **$0.151070460**；原报告仍为未通过。独立补充批次完成剩余 **40** 个槽位，**35/40** 通过，全部用量完整，估算费用 **$0.133423320**。其中 9 项编码任务仅 5 项通过，另有文件修改任务虽然答复事实正确，文件内容校验失败。补充批次保留失败，不与原批次拼接成一次成功验收。原始十四项仍未全部验收。

后续生产修复允许未达到收益门槛的 JSON 表格候选继续尝试显式启用的无损文本策略；JSON 合格候选仍优先。新增回归验证原文逐字符恢复，以及官方 AgentLoop 持久化内容与后续模型输入；这些运行时回放证明处理链正确，不构成该修复的真实模型净收益证据。

JSON 后续策略修复另做了两份独立真实研究，每份四组、每组两次重复、每任务两阶段。长单行材料上，新插件 2/2 通过，累计 6532 token；调优原生和旧插件均 0/2，因此不能把其低用量作为双方质量通过的净收益对照。原生内联预算以内的短材料上，调优原生 2/2 通过、7794 token，新插件仅 1/2 通过、7831 token：有一次首阶段答复未解析成要求的 JSON，对应原始报告没有保存该阶段答复正文，不能进一步认定是事实错误还是格式错误。这一负例不被后续重跑替换。16 个任务用量完整，统一峰价费用共 **$0.013054044**。该修复的路由与字符恢复检查已通过，但真实任务质量和净收益尚未验收；`text.enabled` 继续默认关闭。

针对编码能力另以官方 `deepseek-v4-pro` 做同模型三组前瞻对照。调优原生组通过原 9 项测试、全部 82 项外部边界验证及执行流程，12 步、108713 token；插件组第 4 次调用达到 4096 token 输出上限，任务失败且未发生压缩采用，第三组未启动。两组已知用量按 Pro 统一峰价合计 **$0.058309504**。截断调用有完整 provider usage，但原执行器将 `max-tokens` 排除在完整调用之外，原报告仍标核算不完整，不追溯重评。单纯换模型尚不能解决完整编码验收，也没有证明插件降低了这项任务的 token。

后续前瞻编码任务说明要求每次进度不超过一句、简洁报告验证结果，其余历史源码、修复要求、9 项测试、82 项外部边界验证、4096 输出上限和 20 步门槛不变。以同一 Pro 模型运行三组，**3/3** 均通过任务质量、流程和用量检查：默认组 86226 token / 10 步，调优原生组 95796 token / 10 步，插件组 81969 token / 9 步；三组费用合计 **$0.101868888**。插件费用 $0.039949624，略高于调优原生的 $0.038295488；全部没有压缩采用，因此不能将 token 差异归因于插件，也不能用这一次对照证明重复开发任务稳定通过。此前输出截断及质量失败保留，原始十四项仍未全部验收。

读取策略另在保存快照前排除字节缩减已不可能达到 50% 的候选，避免最终必定回退原文时仍发生快照写盘。该优化减少无效存储，不改变最终压缩门槛，也不宣称模型 token 节省。

联合入口可显式传入 `developmentPricing`，为 9 个编码任务固定另一套模型及完整价格；编码任务的三个对照组使用相同模型。省略时沿用原 `pricing`，既有计划形状保持不变。校准、预测和 117 项基准继续使用原模型；独立汇总按计划固定的各阶段模型重新核算原始调用，模型或价格不符即拒绝。此选项不改变质量、覆盖、净收益、逐任务费用、步数或留出校准门槛；合计费用仍包括所有阶段。

### 2026-10-29 分阶段模型联合评测：未通过

冻结源码 `819c549`，Flash 用于校准、预测和 117 项基准，Pro 用于编码；同一任务的三组始终使用相同模型。计划 manifest 为 `3a70f989641120cc041a886877bd9331034563ae7a57ef1092a88ef7e8c9e8ad`。单任务 $0.05、编码 90 秒、20 步及全部原质量门槛保持不变。

| 117 项基准分组 | 质量通过 | 完整任务累计 token | 统一峰价费用 USD |
| --- | ---: | ---: | ---: |
| 默认 dsh | 38/39 | 480607 | 0.071738376 |
| 调优原生 dsh | 38/39 | 634288 | 0.070007880 |
| 插件 | 39/39 | 416795 | 0.050709072 |

本批插件组累计 token 较调优组少约 **34.3%**，但两项基线质量失败仍计入原始门槛和成本：默认组文件答复正确而实际字节不符；调优组一次任务无关场景混淆两项服务的属性。不能剔除失败、用成功子集替代全批，或据此宣称对任意任务质量有保证。问题相关选择与诊断证据选择各自通过本批原模式门槛；任务无关选择因该基线失败未通过，尽管插件三个重复均正确。

校准、独立短期负收益留出及运行期预测检查通过。第一项 Pro 编码任务在第 5 次调用达到 4096 输出上限，尚未编辑便输出长篇方案分析；本批在 **133/141 项、523 次调用**后按原完整性规则停止，后续八项编码任务未运行。所有调用均有 provider usage，按各阶段固定价格独立核算的已知费用共 **$0.229259256**；原执行器仍将截断调用标为不完整，`accepted=false`，原报告不重评。

后续仅修复文件编辑反馈：在原有有界重试结束前检查用户要求的精确文件内容，反馈不包含目标答案；零重试或重试耗尽仍失败，末尾独立字节校验保留。这是新源码的修复，不改变上述失败记录。

后续编码核算将完整计费与任务成功分别判断：流正常结束、终止类型为 `max-tokens`、且用量完整有效时，新记录会将该调用计入费用及预算；持久化截断 turn 仍使任务质量失败。缺失用量、传输异常、错误终止或异常退出仍拒绝完整核算。历史 `complete=false` 记录和已有失败报告保持原样。官方 CLI 合成回归验证了实际截断 turn、完整用量与预算计入；独立联合汇总即使遇到伪造的成功标记，也会根据持久化 turn 拒绝质量验收。

2026-10-29 核对官方 [Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api) 与 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)：安装包将 `reasoningEffort: off` 映射为 `thinking.type: disabled`，请求构造与文档一致；没有证据表明该映射导致长篇普通文本。关闭 thinking 不构成普通文本不会含规划的保证；启用 `low` 也尚无本项目完成率或成本改善证据。
