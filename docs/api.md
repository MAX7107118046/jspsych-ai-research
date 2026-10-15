# API

0.3 新增的 research / speech 参数、六组研究流程见 [研究功能 API](research-v0.3.md) 和 [语音接口](speech.md)。下列九类入口继续保留。

## jsPsych 模拟

九类插件均支持 `jsPsych.simulate(timeline, 'data-only')` 与 `jsPsych.simulate(timeline, 'visual')`。模拟不会请求真实模型。输出带 `ai_simulated: true` 和 `ai_simulation_mode`，研究分析需排除模拟记录。

data-only 直接生成标记过的合成记录。visual 使用实际交互界面、固定合成回复及自动回答完成一轮任务，覆盖表单、方案选择和迁移测验。它用于程序检查，不能代替实际模型、完整多轮设计或参与者验收。


## 模型接口

`createAIClient({ connection?, transport?, timeoutMs?, retries?, fetch? })` 返回 `AIClient`。至少提供一个 connection 或 transport。调用 `client.complete(request, { signal?, onDelta? })` 返回 `Completion`；`probe()` 返回基本连接结果。

`connection`：

| 字段 | 含义 |
| --- | --- |
| protocol | openai-chat / openai-responses / anthropic / gemini |
| baseURL | API 前缀，通常含 `/v1`；也支持 Chat/Responses/Anthropic 完整端点 |
| model | 原样发送的模型 ID |
| provider / account | 可选模型规则来源；MiniMax 的 m-plan / payg / unknown 账户标记 |
| thinking | `{mode?: 'auto' / 'on' / 'off', effort?: 'low' / 'medium' / 'high' / 'xhigh' / 'max'}`，按模型支持范围验证 |
| schemaMode | native / json-object / prompt-json |
| apiKey / headers | 请求凭据与额外请求头 |
| temperature / maxTokens | 默认生成参数 |
| timeoutMs / retries | 整次调用的等待上限；重试默认 0，最多 5 |
| capabilities | stream / structured / image / audio，按实际模型设置 |
| extra | 协议原生扩展参数；核心字段由统一接口生成 |

请求格式：

```ts
{
  messages: Array<{role: 'system' | 'user' | 'assistant', content: string | ContentPart[]}>,
  model?: string,
  temperature?: number,
  maxTokens?: number,
  stream?: boolean,
  thinking?: {mode?: 'auto' | 'on' | 'off', effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'},
  schema?: Record<string, unknown>,
  extra?: Record<string, unknown>,
  metadata?: Record<string, unknown>
}
```

`ContentPart` 为 `{type:'text', text}`、`{type:'image', url, mimeType?}`、`{type:'audio', data, mimeType}`；音频 data 为不带 data URL 前缀的 Base64。

自定义 `transport(request, { signal, onDelta })` 返回 `{ text, model, id?, usage?, finishReason?, data?, media?, metadata? }`。`media` 支持图像和音频 URL，由自定义服务完成生成。本包内建协议主要处理文本生成与图像/音频输入。

返回增加 `requestMs`、`firstTokenMs`、`attempts`、`requestedModel`。内建 HTTP 调用返回 `metadata.connectionPolicy` 与思考增量统计。`createConnection(preset, overrides)` 创建地区与账户预设；`resolveConnectionPolicy(connection, request?)` 计算实际规则，`connectionEvidence(policy)` 返回可导出的调用设置。完整路线、预算与验证范围见 [模型连接指南](providers.md)。超时会结束等待，客户端忽略迟到结果。自动重试只针对输出开始前的网络错误、429 和 5xx，保持同一请求模型。流中断、非法 JSON、结构不符和截断输出返回错误。

## 插件

| mode | 导出类 | 核心专用参数 |
| --- | --- | --- |
| chat | AIChatPlugin | initial_message / start_with_ai |
| interview | AIInterviewPlugin | 默认先由 AI 发问 |
| survey | AISurveyPlugin | questions / generate_questions / survey_feedback |
| feedback | AIFeedbackPlugin | generation_prompt |
| advice | AIAdvicePlugin | advice / correct_answer |
| generate | AIGeneratePlugin | candidates / response_required |
| coedit | AICoeditPlugin | generation_prompt，保存参与者与 AI 修订 |
| learning | AILearningPlugin | transfer_questions，测验阶段关闭 AI 入口 |
| multiagent | AIMultiAgentPlugin | agents / turn_order |

共享参数：

| 参数 | 默认 / 行为 |
| --- | --- |
| prompt | 实验 HTML 刺激；可用 jsPsych 动态函数；其文本内容加入任务上下文 |
| system_prompt / generation_prompt | 系统指令 / AI 主动生成的首条请求 |
| client / connection | 可直接传客户端对象，或传连接配置，由插件创建客户端 |
| session / memory_key | 无共享历史；显式设置同一个会话与 key 才跨 trial 共享 |
| history_window | 30 条；0 表示只带当前最后一条消息 |
| max_turns / min_turns | 3 / 0，控制参与者提交次数 |
| max_input_characters | 10000 |
| stream | true |
| generation | `{temperature?, maxTokens?, thinking?, extra?}` |
| response_schema | 无；设置后校验最终结构化结果 |
| delivery | `{mode:'live'}`；其他模式需 materials |
| condition | 实验条件对象，随数据保存 |
| labels | participant / assistant / send / finish |
| allow_regenerate | true；重新请求并替换当前历史中的该条回复，保留两次调用记录 |
| presentation | delay_ms / characters_per_second / max_characters / allow_pause |
| trial_duration | 无；设置毫秒上限，结束试次并取消未完成请求 |
| error_policy / max_retries | stop / 1；stop 阻止继续发送，允许结束带错误状态的试次；continue 允许新输入；retry 提供显式重试按钮 |
| attachments | image / audio / record_audio / max_bytes，文件默认上限 10MB |
| initial_attachments | 已准备的 ContentPart 数组 |
| on_event | 观察交互事件，异常写入 callback_error |
| persist | 可选持久化回调；最长等待 2 秒，结果写入 persistence_status |

实验是否继续后续 timeline 可由 jsPsych 的条件节点、原生 `on_finish` 或实验自己的错误策略决定。

`questions` 和 `transfer_questions`：`{ name, prompt, type?:'text'|'number'|'choice'|'scale', required?, options?, min?, max? }[]`，name 必须唯一。数值为空时保存 null。

`agents`：`{id, label, system_prompt, client?}[]`。角色 ID 必须唯一；顺序可选 sequential/random，随机顺序由 session.seed 控制。请求保留发言者身份。

## 配置器与代码导出

`createConfiguration(mode, parameters)`、`serializeConfiguration(config)`、`parseConfiguration(json)`、`configurationToTrial(config, runtime)`、`exportExperimentCode(config, 'browser'|'esm')` 共用 `AIExperimentConfig.v1`。配置包含精确插件和 jsPsych 版本；版本不匹配时显示错误。客户端、会话、回调和凭据由运行环境重新注入。

## 协议参考

- [jsPsych 7 插件开发](https://www.jspsych.org/v7/developers/plugin-development/)
- [OpenAI Responses 流事件](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)

这些文档用于协议映射；具体账号、模型能力和网络环境由真实调用验证。
