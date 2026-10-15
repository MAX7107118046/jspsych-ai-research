# 语音接口

## 本地运行

在已配置文本模型代理的 PowerShell 中设置：

```powershell
$env:MINIMAX_SPEECH_API_KEY = 'your-speech-key'
$env:SPEECH_REGION = 'cn'
npm.cmd start
```

打开 `/examples/voice.html?live=1`。文本模型与语音服务分别配置；MINIMAX_SPEECH_API_KEY 只用于语音。SPEECH_REGION 可为 cn 或 global，服务地址按选择固定；本轮真实验收使用 cn。也可显式提供 SPEECH_ASR_URL / SPEECH_TTS_URL。

## 插件参数

```js
const speechClient = JsPsychAI.createSpeechClient({ proxyURL: '/api/speech' });
const trial = JsPsychAI.createAITrial('chat', {
  client, speech_client: speechClient,
  research: { group: 'multimodal', materials: [] },
  speech: {
    enabled: true, input_mode: 'automatic', output: true,
    review_transcript: true, save_audio: false,
    voice_id: 'male-qn-qingse', language: 'zh',
    silence_ms: 600, min_speech_ms: 300, pre_roll_ms: 200,
    max_segment_ms: 20000, threshold: 0.008, auto_threshold: true
  }
});
```

输入支持 automatic、push-to-talk、file、off。按住说话支持指针及聚焦按钮后的空格键。浏览器收音转换为单声道 16kHz WAV 片段。ASR 使用完整文件；厂商 SSE 返回转录增量。代理提供最终转录和厂商首个增量时间。

收音界面提供麦克风选择、音量条、收音状态和转录等待秒数。未取得麦克风时在默认 10 秒后提示，microphone_timeout_ms 可调整。未显式设置 threshold 时使用环境音校准；设置 auto_threshold:true 也可启用校准，阈值基线默认为 0.008。需固定阈值的研究设置 auto_threshold:false 并填写 threshold。插话取消文本与播报，尚未完成的 ASR 保留到结果返回。

转录默认要求确认，可修正或丢弃。关闭 review_transcript 后自动提交。表单阶段填入当前问题；对话阶段提交聊天。学习独立测验阶段关闭语音与模型请求。

## 服务契约

`createSpeechClient({transport?,proxyURL?,fetch?})` 返回绑定的方法；可以直接传给 jsPsych trial。

- `transcribe(blob, {signal?,language?,onDelta?})` 返回 `{text,model,requestMs,firstDeltaMs?,duration?,metadata?}`。
- `synthesize({turn_id,voice_id?,sample_rate?,language?,signal?,onAudio,onEvent?})` 同步返回连接，内部排队等待服务就绪。
- 连接提供 `write(text)`、`flush(): Promise<void>`、`cancel()`、`close()`；onAudio 接收有符号 16 位小端单声道 PCM 字节和采样率。
- `createSpeechProxyTransport()` 使用 POST `/api/speech/transcribe` 和 WebSocket `/api/speech/synthesize`。
- POST 接收 multipart file/language，返回 TranscriptionResult。WebSocket 接收 start/text/flush/cancel，返回 ready/audio/complete/error；audio 为 Base64 PCM。

`server/speech.mjs` 提供 MiniMax 适配与可注入代理。MiniMax ASR 为 asr-1.0，TTS 为 speech-2.8-turbo。每段播报使用独立双向连接，隔离旧轮次音频；新文本流按句子或短块发送，末尾 flush。

## 播报与打断

播报文本来自实际呈现文本，遵守 max_characters。结构化任务先格式化供参与者阅读的内容再播报。浏览器自动播放受手势约束时，点击启用播报或收音按钮恢复 AudioContext；状态会提示等待。

语音活动或打断按钮立即停止全部本地声源，清空播放队列，并取消旧模型与 TTS。迟到音频通过轮次标识忽略。播放结束只在合成完成且队列耗尽后记录，网络包间隙不记为整轮结束。打断位置按音频秒数保存，逐字听到的位置保持未知。

研究流程的连续材料呈现等待当前播报结束后再展示下一段；多代理逐个角色播报。参与者可在等待中主动打断，流程随后继续。

## 保存与时间

`save_audio: true` 配合 `persist_media(blob, reference)` 保存原音频；回调返回 `{url?,filename?}`。缺少回调时记录 callback_missing。示例中的 memory/blob URL 只用于当前页面，长期保存应返回实验服务器的媒体引用。

speech_turns 保存原始与修正转录、ASR 时间、确认时间、队列等待和响应就绪时间。speech_playback 保存实际文本、首包、合成完成、播放起止与打断。tts_first_packet_ms 从首次发送正文到首包；first_packet_wait_ms 从本轮输出开始计时，包含正文等待。时间均为毫秒，音频位置单位为秒。

实际扬声器音量、麦克风音质与回声需要设备实测。自动化使用 Chrome 合成麦克风与合成音频，不代表真人设备验收。

接口依据：[MiniMax ASR](https://platform.minimax.cn/docs/api-reference/speech-to-text)、[MiniMax 双向 TTS](https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket-bidi)。
