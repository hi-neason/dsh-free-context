# dsh-free-context

DeepSeek Harness（dsh）的独立上下文优化插件，目标是在保持 Agent 任务质量的前提下降低累计 token 消耗与实际费用。

当前实现工具结果接入与安全回退管线，默认保持原文；尚未启用压缩策略，也没有实测节省比例。使用 ESM JavaScript 和 Node.js 24，无运行时依赖，服务由宿主 dsh 提供。

## 接入

在已加载 `tools` 服务的 Cordis 上下文中加载命名导出：

```js
import * as FreeContext from 'dsh-free-context'

const fiber = await ctx.plugin(FreeContext)
// 卸载时由 Cordis 清理本插件的事件监听器。
await fiber.dispose()
```

插件通过 `tools/post-execute` 的前置监听器先等待 `next()`，再读取下游决策。仅处理模型可见内容，保留结构化 `value` 与附加上下文；阻止决策、结构化值替换、失败结果、取消和 PTC 内部调用直接通过。内部转换函数收到内容副本，失败保留既有决策。当前未注册历史改写或 PTC 日志转换。

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
| `minInputBytes` | `1024` | 输入 UTF-8 字节数下界，含边界 |
| `maxInputBytes` | `1048576` | 输入 UTF-8 字节数上界，含边界；必须大于零且不小于下界 |
| `minSavingsTokens` | `32` | 候选策略要求的最小估算 token 节省量 |
| `json.enabled` | `true` | JSON 策略开关 |
| `logs.enabled` | `false` | 有损日志策略开关，默认关闭 |

所有数字必须为非负安全整数；未知键、错误类型和无效配置会在加载时明确报错，即使 `mode` 为 `off` 也要通过校验。配置经过复制和递归冻结，不受调用方后续修改影响。两种策略都关闭时不注册监听器。

目前配置校验、禁用开关、工具/体积资格判定与观察记录已就绪，压缩策略将在后续功能接入。因此此阶段 `observe` 和 `apply` 都保持原文，符合条件时记录 `eligible/no-strategy`；`minSavingsTokens` 将用于后续候选收益检查。路径、命令、错误码和数值的内容保护仍由后续具体策略验收，本阶段不提供会静默丢弃字段的配置。

## 观察与诊断

```js
ctx.on('free-context/decision', record => {
  console.log(record)
})
```

诊断包含工具名、调用 ID、可取得的会话 ID、模式、处理结果与原因、策略名（有候选时）、输入/候选输出字节数和 token 估算、处理耗时。不会记录工具正文、参数、结构化值或异常消息。事件中的标识仍可能具有业务敏感性，日志存储与访问控制由订阅方负责。

`observe` 会计算候选并报告 `observed`，保持原决策不变；`apply` 选择候选时报告 `selected`。这些结果只代表插件策略选择，不证明 Session 已写入、宿主已接受或已经产生计费收益；诊断期间取消时仍保留原决策。目前没有启用候选策略。失败、阻止决策、结构化值替换、取消和 PTC 内部调用报告跳过原因，不扫描其内容。`off`、空工具列表或全部策略关闭时不注册监听器，也不产生诊断。

字节数按内容块 JSON 序列化后的 UTF-8 计算，包含块结构开销；默认 token 估算为 `ceil(bytes / 3)`，只是启发式估算，不是精确 tokenizer、媒体 token 计量、provider usage 或实际计费，也不是已节省 token。`elapsedMs` 不含下游工具策略和诊断订阅方耗时。原文快照引用与回读记录将在恢复能力接入后增加。

事件使用 Cordis `parallel` 分发到普通 `ctx.on` 订阅，等待全部订阅完成，以隔离异步拒绝；监听器异常只产生固定警告，不改变工具结果。订阅方应快速完成，避免延迟工具结果返回。

## JSON 编解码候选

纯 JSON 编解码器可独立调用，目前尚未接入插件生产路由：

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

候选可能比原文更长，获得候选不代表 token 节省。后续路由仍需计算包含格式说明与恢复引用的总成本。当前固定查询测试只验证恢复数据的筛选、求和和嵌套查询一致性，尚未证明模型能直接使用紧凑格式完成同等质量的任务。

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

默认测试目录为 `.omx/integration-runtime`。已验证 Cordis `4.0.5`、Loader `1.0.6`、dsh `0.2.1-rc.2`：实际工具执行、策略组合顺序、结构化值保留、命名导出解析及卸载。此测试不包含 CLI YAML 启动、真实模型请求、完整任务成本或任务质量评估。
