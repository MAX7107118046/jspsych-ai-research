# 模型连接与思考配置

适用：插件 0.2.0 / 0.3.0，jsPsych 7.3.4。模型规则日期：2026-10-12。

## 选预设，填凭据

```js
import { createConnection, createAIClient } from 'jspsych-ai-research/core';

const client = createAIClient({
  connection: createConnection('minimax-cn-mplan', {
    apiKey: process.env.AI_API_KEY,
    thinking: { mode: 'on', effort: 'low' }
  })
});
const result = await client.complete({
  messages: [{ role: 'user', content: '请给出一句简短的学习建议。' }],
  stream: true
});
```

此示例在服务端运行。普通 HTML 实验通过本包通用代理调用；浏览器包提供相同的 `JsPsychAI.createConnection` 接口。

| 预设 | 地区 / 账户 | 协议 | 地址前缀 | 默认模型 |
| --- | --- | --- | --- | --- |
| deepseek | 官方 API | Chat | https://api.deepseek.com/v1 | deepseek-flash |
| minimax-cn-mplan | 国内 / M Plan | Chat | https://api.minimax.cn/v1 | MiniMax-M3.1-Flash-Preview |
| minimax-cn-anthropic | 国内 / M Plan | Anthropic | https://api.minimax.cn/anthropic/v1 | 同上 |
| minimax-cn-responses | 国内 / M Plan | Responses | https://api.minimax.cn/v1 | 同上 |
| minimax-global-mplan | 国际 / M Plan | Chat | https://api.minimax.io/v1 | 同上 |
| minimax-global-anthropic | 国际 / M Plan | Anthropic | https://api.minimax.io/anthropic/v1 | 同上 |
| minimax-global-responses | 国际 / M Plan | Responses | https://api.minimax.io/v1 | 同上 |
| minimax-cn-payg | 国内 / 按量 | Chat | https://api.minimax.cn/v1 | MiniMax-M3 |
| minimax-global-payg | 国际 / 按量 | Chat | https://api.minimax.io/v1 | MiniMax-M3 |

M Plan 与按量预设使用相同地区的网关；账户和默认模型分别配置。M3.1 Flash Preview 当前需要 M Plan。国际端点拒绝本次提供的国内凭据，返回 HTTP 401；这项检查确认凭据与地区的匹配要求，国际模型生成尚未验收。插件不会自动更换地区、账户或模型。旧 `minimax` 预设保留国际 Anthropic 地址，模型仍需手填。

此外保留 OpenAI、Anthropic、Gemini、Ollama、LM Studio 和自定义服务。模型 ID 可以直接填写，按原样发送。官方主机名触发已登记模型规则；自建兼容网关可设置 `provider: 'deepseek'` 或 `'minimax'`。`provider: 'custom'` 使用通用协议和原生 `extra`。未知模型使用通用规则并提示，插件不按名称片段推断能力。

## 思考深度与预算

`connection.thinking` 为默认配置，单次调用的 `request.thinking` 或 trial 的 `generation.thinking` 可以覆盖：

```js
thinking: { mode: 'auto', effort: 'low' }
```

| 模型规则 | 可关闭 | 档位 | 具体映射 |
| --- | --- | --- | --- |
| deepseek-flash / deepseek-v4-pro | 可以 | low / high / max | Chat `thinking.type` 与 `reasoning_effort` |
| MiniMax-M3.1-Flash-Preview | 要求开启 | low / medium / high / xhigh / max | Chat `reasoning_effort`；Anthropic `output_config.effort`；Responses `reasoning.effort` |
| MiniMax-M3 | 可以 | 服务控制 | Chat / Anthropic `thinking.type`；Responses `reasoning.effort` |
| 已登记 MiniMax M2.x | 要求开启 | 服务控制 | 开启思考，关闭请求会被本包明确拒绝 |

已登记 M2.x：M2、M2.1、M2.1-highspeed、M2.5、M2.5-highspeed、M2.7、M2.7-highspeed。它们的图像与音频输入默认关闭。M3、M3.1 和 DeepSeek V4 系列允许图像输入，音频输入默认关闭。本次只验收了 deepseek-flash 与 M3.1 的文本和结构化调用，其余模型及真实图像调用仍需对应账号验证。

插件默认开启 `low` 思考。关闭 DeepSeek 思考时温度仍支持 0；开启思考时按厂商文档省略无效温度，并记录说明。M3.1 的关闭思考请求会在发送前报 `thinking_required`。未登记模型的思考控制通过厂商原生 `extra` 设置，避免发送不支持的统一参数。

下表是本包的交互默认值，研究者可以显式覆盖；这些数值没有承诺所有任务都能在时限内完成。

| 思考深度 | 默认生成 token 上限 | 默认超时 |
| --- | --- | --- |
| low / 服务控制 | 8192 | 120 秒 |
| medium | 16384 | 120 秒 |
| high | 32768 | 180 秒 |
| xhigh | 65536 | 300 秒 |
| max | 131072 | 300 秒 |
| 关闭思考 | 2048 | 60 秒 |

思考与正文共享 token 上限。`maxTokens` 是整个生成预算，正文长度可通过任务说明与 `presentation.max_characters` 控制。显式设置的预算保持原值，偏小配置显示提示。`maxTokens` 也可从原生扩展字段读取；统一字段优先。MiniMax Chat 使用 `max_completion_tokens`，DeepSeek Chat 使用 `max_tokens`。连接测试遵循模型预算，已移除固定 32-token 探测。

预算耗尽、空正文、超时、结构错误都保存为明确错误。插件不会为这些情况自动提高预算或切换模型；普通网络错误、429 与 5xx 保留原有显式重试策略。若研究使用更高深度，请同时设置生成预算、代理等待时间及 trial 时长。

## 结构化输出

- DeepSeek 使用官方 `json_object`，附加 JSON Schema 指令，并在本地执行 Ajv 校验。
- MiniMax 默认使用 JSON 指令加本地校验，记录 `schemaMode: 'prompt-json'`。服务端没有强制本包 schema，生成结果不符合结构时会返回错误。
- 其他连接沿用原生 schema 映射。`schemaMode: 'native'` 或 `'json-object'` 可以显式选择，需确认实际服务支持。JSON Object 模式需要对象根节点。
- 结构配置与思考档位分别合并，生成 schema 不会覆盖 `output_config.effort` 或 Responses 的其他 `text` 配置。

## 通用代理

```powershell
$env:AI_PRESET='minimax-cn-mplan'
$env:AI_API_KEY='<你的 M Plan 凭据>'
$env:AI_EFFORT='low'
npm.cmd start
```

可选变量：`AI_PROTOCOL`、`AI_BASE_URL`、`AI_MODEL`、`AI_PROVIDER`、`AI_ACCOUNT`、`AI_THINKING`、`AI_EFFORT`、`AI_MAX_TOKENS`、`AI_TIMEOUT_MS`、`AI_EXTRA`。DeepSeek 使用 `AI_PRESET=deepseek`。默认值来自相同模型规则。正式实验固定服务端连接和模型。

```js
const client = JsPsychAI.createAIClient({
  transport: JsPsychAI.createProxyTransport('/api/ai'),
  timeoutMs: 300000
});
```

代理客户端要留出服务端完整调用时间；配置器及导出的实验代码使用 300 秒外层等待，服务器仍按模型与实验配置终止调用。配置器的连接表单控制直连，代理连接由服务器环境配置。

## 调用证据与真实验证

每次完成结果的 `metadata.connectionPolicy` 保存规则版本、实际端点、协议、请求模型、地区、账户类型、实际思考深度、预算、超时、结构化方式和配置提示；错误也保留此信息。响应的 `model` 保存服务实际返回的 ID。

`endpoint` 保存连接地址前缀，`requestEndpoint` 保存最终请求路径，均排除 URL 查询参数。自定义网关可通过 provider 显式选择模型规则；地区标记根据实际网关主机名记录。

`usage` 按服务原样保存。思考内容不会送入参与者正文或保存为推理文本；`reasoningCharacters` 和流式 `firstReasoningMs` 描述收到的思考增量。`firstTokenMs` 始终测量正文首个增量。若服务未返回独立思考 token 字段，本包不会从字符数推算 token。

2026-10-12 真实检查：DeepSeek 开启/关闭思考各通过普通、流式、结构化 3 项；MiniMax 国内 3 个协议各通过同样 3 项，共 15 项生成检查通过。国际 3 个协议均为 HTTP 401，当前凭据无法验证其生成。Chrome 中两家各完成反馈与建议采纳 2 个 jsPsych trial，共 4 个 trial，均记录实际模型与调用设置。

两家还分别验证了显式 1-token 预算耗尽会返回 `incomplete_output`，随后使用默认 8192 预算的独立调用均得到正文。该检查复现思考消耗全部预算的情形，插件保持显式预算并保存错误证据。

复跑命令：`npm run test:providers`、`node test/live-browser.mjs`、`node scripts/verify-output-budget.mjs`。通过环境变量提供 `DEEPSEEK_API_KEY`、`MINIMAX_API_KEY`；报告存放在 `artifacts`，不包含凭据。协议构建与本地测试可离线复跑，真实调用需要服务可用。

## 官方依据

- [DeepSeek Chat 参数](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [MiniMax 国内 Chat 与 M3.1 参数](https://platform.minimax.cn/docs/api-reference/text-openai-api)
- [MiniMax 国内 Anthropic 参数](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
- [MiniMax 国内 Responses 参数](https://platform.minimax.cn/docs/api-reference/responses-create)
- [MiniMax M Plan 国内调用方式](https://platform.minimax.cn/docs/m-plan/other-tools)
- [MiniMax M Plan 国际调用方式](https://platform.minimax.io/docs/m-plan/other-tools)

DeepSeek 官方页面当前只列出统一 API 地址，本包未虚构另一条国内/国际 DeepSeek 路线。官方地址、模型权限和参数会变化；更新模型规则时发布新的插件版本，已有实验保留锁定版本。
