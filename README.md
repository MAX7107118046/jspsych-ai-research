# jsPsych AI Research

面向研究实验的独立 AI 插件包，支持 **jsPsych 7.3.4**，当前插件版本 **0.3.0**。保留九类插件，提供判断、学习、访谈、共创、多代理和多模态六组研究流程。

0.3.0 增加 `research` 阶段配置、独立参数面板、阶段数据及 MiniMax 转录和流式播报。模型连接保留国内/国际与账户预设、统一思考设置。使用方法见 [六组功能 API](docs/research-v0.3.md)，验收范围见 [0.3 验收记录](docs/verification-v0.3.md)。

## 本地运行

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

打开 <http://127.0.0.1:4177>。每类功能提供最小示例和包含官方问卷插件的研究示例；默认模拟模型，无需凭据。可视化配置器位于 `/examples/builder.html`，支持保存、重新读取、导入 JSON、预览以及导出 HTML/ESM。

六组能力的最小和完整研究示例位于 `/examples/research-index.html`。语音单独测试页为 `/examples/voice.html`，添加 `?live=1` 使用真实服务。

```js
const client = JsPsychAI.createAIClient({
  transport: JsPsychAI.createMockTransport({ respond: JsPsychAI.mockResearchResponse })
});
const options = JsPsychAI.researchDefaults('judgment', true);
const jsPsych = initJsPsych({ on_finish: () => console.log(jsPsych.data.get().json()) });
jsPsych.run([JsPsychAI.createAITrial('advice', { ...options, client })]);
```

语音服务独立设置 `$env:MINIMAX_SPEECH_API_KEY`，国内线路使用 `$env:SPEECH_REGION='cn'`。浏览器的 `speech` 控制收音与播报；`speech_client` 可以注入自定义服务。原始录音由 `persist_media` 回调保存。详见 [语音接口](docs/speech.md)。

## 直接写 jsPsych 代码

在普通 HTML 中引入运行时和插件：

```html
<link rel="stylesheet" href="./node_modules/jspsych/css/jspsych.css">
<link rel="stylesheet" href="./dist/style.css">
<script src="./node_modules/jspsych/dist/index.browser.js"></script>
<script src="./dist/jspsych-ai.browser.js"></script>
<script>
const client = JsPsychAI.createAIClient({
  transport: JsPsychAI.createMockTransport()
});
const jsPsych = initJsPsych({
  on_finish: () => console.log(jsPsych.data.get().json())
});
jsPsych.run([{
  type: JsPsychAI.AIChatPlugin,
  client,
  prompt: '请讨论你处理复杂任务的方式。',
  max_turns: 3,
  generation: { temperature: 0 }
}]);
</script>
```

npm 工程通过 ESM 导入：

```js
import { initJsPsych } from 'jspsych';
import { AIInterviewPlugin, createAIClient, createProxyTransport } from 'jspsych-ai-research';
import 'jspsych/css/jspsych.css';
import 'jspsych-ai-research/style.css';

const client = createAIClient({ transport: createProxyTransport('/api/ai'), timeoutMs: 300000 });
const jsPsych = initJsPsych();
jsPsych.run([{ type: AIInterviewPlugin, client, prompt: '访谈主题：使用 AI 的经历。' }]);
```

也可使用 `createAITrial('interview', options)`。`prompt` 支持 jsPsych 动态函数；`on_start`、`on_load`、`on_finish` 沿用 jsPsych 原生接口。模型客户端和会话对象已经处理 jsPsych 7 的参数复制与函数求值行为，可直接传给 trial。

九类插件支持 jsPsych 的 `data-only` / `visual` 模拟。模拟使用合成回复，不调用真实模型；数据通过 `ai_simulated` 标记。

## 连接真实模型

通用服务器代理自带 `/api/ai`，浏览器配置无需依赖 CloudPsych。服务器环境：

```powershell
$env:AI_PROTOCOL = 'openai-chat'
$env:AI_BASE_URL = 'https://your-provider.example/v1'
$env:AI_MODEL = 'your-model-id'
$env:AI_API_KEY = 'your-api-key'
npm.cmd start
```

示例网址加 `?live=1` 使用该代理。模型 ID 直接填写服务提供的名称；`AI_PROTOCOL` 可选 `openai-chat`、`openai-responses`、`anthropic`、`gemini`。`AI_TIMEOUT_MS` 设置等待时间，`AI_EXTRA` 接收协议扩展参数的 JSON。

也可只填写 `AI_PRESET=deepseek` 或 `AI_PRESET=minimax-cn-mplan` 与 `AI_API_KEY`。`AI_EFFORT=low` 调整思考深度；`AI_MAX_TOKENS` 和 `AI_TIMEOUT_MS` 显式覆盖模型默认预算与等待时间。

服务允许浏览器跨域请求时，可直接配置 `createAIClient({ connection: { protocol, baseURL, model, apiKey } })`。配置器提供浏览器直连、服务器代理和模拟三种调用方式；导出实验代码默认连接 `/api/ai`。配置 JSON 和代码导出省略凭据及运行时对象。

协议适配器负责消息、结构化格式和流事件。模型的流式、结构化、图像与音频能力通过 `connection.capabilities` 显式配置；实际调用错误保留在数据中。`client.probe()` 测试基本连接，其成功结果只覆盖本次请求。已有 attachments.record_audio 录音产生浏览器媒体格式；0.3 的 speech 收音转成 WAV 并通过独立 ASR 提交文本，可与文本模型组合。

## 研究控制

- `labels.assistant` 和 `condition` 设置身份呈现与实验条件，调用记录保存实际返回模型。
- `delivery` 支持实时生成、预生成、固定回放、配对回放；回放不需要模型客户端。
- `session` 配合 `memory_key` 共享跨 trial 历史；每个参与者创建自己的会话。`snapshot()` / `ResearchSession.restore()` 支持由研究者保存和恢复。
- `presentation` 控制延迟、呈现速度、最大字符数与暂停。最终原始回复完整记录。
- `generation` 设置温度、输出 token 上限和协议扩展参数；数值 `0` 保持有效。
- `response_schema` 使用 JSON Schema 校验输出，实时与回放执行同一校验。

```js
const session = JsPsychAI.createResearchSession({ id: 'P001', seed: 42 });
const trial = JsPsychAI.createAITrial('chat', {
  session, memory_key: 'study',
  delivery: { mode: 'yoked', sourceParticipant: 'P000', materials: [
    { text: '此前记录的回复', model: 'recorded-model', sourceParticipant: 'P000' }
  ] },
  condition: { identity_label: 'AI', generation_source: 'recorded' }
});
```

`pregenerateMaterials(client, requests)` 生成可保存材料；`createReplayMaterials(rows, participantId)` 从既有试次提取材料；`createYokedDelivery(participantId, rows)` 创建配对回放配置。固定 seed 控制本包的角色随机顺序，模型返回仍受外部服务影响。

## CloudPsych

`jspsych-ai-research/cloudpsych` 提供现有 `CloudPsychAIRuntime.request` 的 transport 与 trial 适配。`jspsych-ai-research/cloudpsych/module` 可生成版本化 `CodeModule.v1`，通过 r205 的 `jspsych_plugin` 入口使用。模块冻结同一版本的构建产物，自带样式，发布页面无需再次下载插件。详见 [CloudPsych 接入](docs/cloudpsych.md)。

## 验证与打包

```powershell
npm.cmd run check
npm.cmd pack
```

核心测试使用协议夹具，浏览器测试使用实际 jsPsych 7.3.4、Chromium/Chrome/Edge 和模拟服务。`test:browser` 自动寻找本机 Chrome/Edge，也可设置 `PLAYWRIGHT_BROWSER_PATH`，或运行 `npx.cmd playwright install chromium`。真实模型验证通过 `npm.cmd run test:live` 单独执行，读取上述环境变量。

文档：[API](docs/api.md) · [研究设计](docs/research-designs.md) · [数据字典](docs/data.md) · [迁移与兼容](docs/migration.md) · [接入说明](docs/cloudpsych.md) · [验收记录](docs/verification.md) · [依赖许可](THIRD_PARTY.md)。
