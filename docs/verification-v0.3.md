# 0.3 独立包验收

日期：2026-10-15。版本 jspsych-ai-research@0.3.0，运行时 jsPsych 7.3.4。

表中 artifacts/ 报告位于开发环境。运行 npm run check 可复现自动化检查并生成本地报告；真实模型检查另需配置自己的服务凭据。实际麦克风诊断记录保留在本地。

## 功能结果

- 六组研究流程、九类底层入口、独立配置器、HTML/ESM/JSON 导出、十二个研究示例及语音测试页已实现。
- 学习独立与迁移阶段新增 AI 请求为 0；多代理独立阶段上下文隔离；共创输入事件与最终未失焦编辑保留。
- 配置器逐组保存重开、预览完成，并将导出的 HTML 在普通页面运行完成。
- 与官方按键、图片、问卷插件混用；原生回调和 JSON/CSV 数据导出通过。
- 新增语音代理、WAV 切段、转录修正、流式 PCM、队列清空和旧模型取消。播放包间隙不会被记成整轮播放结束。

## 自动化与真实模型

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript / 构建 | 通过 | npm run check |
| 协议、核心、研究辅助与语音代理 | 57/57 | node --test test/*.test.mjs |
| 九类入口与旧示例 Chrome 回归 | 53/53 | artifacts/browser-report.json |
| 六组研究、配置器、导出与语音 Chrome 检查 | 36/36 | artifacts/research-browser-report.json |
| DeepSeek deepseek-flash 六组真实场景 | 6/6 | artifacts/research-deepseek-report.json |
| MiniMax 国内 M-plan / MiniMax-M3.1-Flash-Preview 六组真实场景 | 6/6 | artifacts/research-minimax-cn-mplan-report.json |
| 实际 ASR、TTS、打断与再次回复 | 3/3 | artifacts/voice-live-v0.3.json |
| 冻结模块字符限制、解压与原生插件运行 | 通过 | research-browser 中 frozen module 检查 |

真实文本场景使用国内已配置路线，保留 low 思考策略和充足生成预算。图像呈现使用合成材料；真实 DeepSeek 多模态场景使用文字材料及独立语音服务，图像理解需要支持图像的连接。

## 语音实测

合成音频经真实浏览器代理调用：1.34675 秒输入，ASR 等待约 4699.8ms；两次 TTS 正文发送至首包约 643.1ms / 660.9ms。完成本地打断并成功播放下一轮完整回复。各次调用速度会变化，数值仅代表该次记录。

实际桌面 Edge 获得 Senary Audio 麦克风阵列输入，识别出“开始。”，再经 DeepSeek 返回文本并完成 7.59 秒 WebAudio 播放。该次 ASR 约 4739.5ms、TTS 首包约 1058.8ms。记录保存在 artifacts/voice-physical-diagnostic-v0.3.json，截图同名 png。

这次设备诊断还发现：内置浏览器获取麦克风没有返回，以及连续声音错误取消尚未完成的 ASR。已增加麦克风请求超时、设备选择、音量条、转录秒数、环境音校准，并修复 ASR 取消范围。新增声音不会取消正在识别的片段。

真人听感、识别准确性和实际说话插入播报的体验仍待再次确认；自动化的合成麦克风与按钮打断检查不能替代该项。当前页面已提供桌面浏览器复测入口。

## 本轮边界

本轮交付为独立功能版本。跨日随访由编辑器承担。生产部署、全面异常与跨浏览器测试、迁移界面及安全补充沿用独立安排。
