# 验收记录

以下为 2026-10-12 的 0.2.0 历史验收。0.3.0 当前记录见 [0.3 验收记录](verification-v0.3.md)。目标运行时为 jsPsych 7.3.4。

## 独立包

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| TypeScript 类型与构建 | 通过 | ESM、浏览器包、类型声明、样式 |
| 核心、模型规则与服务器测试 | 48/48 | 四协议、地区和账户、思考字段、生成预算、结构校验、错误、超时、取消、历史、材料及代理 |
| Chrome 浏览器测试 | 53/53 | 18 个示例、18 个两模式模拟、手写 trial、官方插件混用、循环、动态参数、回调、CSV/JSON、配置器保存思考/地区/预算与异常流程 |

测试还覆盖重新生成、重复点击、手动重试、空输入、迟到回复隔离、学习迁移阶段关闭 AI、配对回放、图像和音频文件输入。音频文件输入使用合成文件；实体麦克风尚未验收。

本地报告：`artifacts/browser-report.json`，配置器截图：`artifacts/builder-desktop.png` / `builder-mobile.png`。`npm run check` 可复跑核心与浏览器测试；浏览器测试需要可用的 Chrome、Edge 或 Playwright Chromium。

## CloudPsych r205 候选：0.1.0 历史验收

- 固定 tgz 依赖与原生代码模块测试：7/7 通过。
- 完整实验、阶段、节点、Routine 及平台 transport 的合成浏览器验收：5/5 通过。
- 实际隔离的 r205 API 与作者页面：4 项验收通过，覆盖保存与重开、实际编译预览、作者页面修改插件参数并保存重开、本地发布页面运行。参数修改保持冻结模块源码不变。
- 合成工程通过平台自动审计，分数 89.99；该分数只描述此验收工程。发布页遗漏 vendor 目录的问题已在候选 API 修复。
- 报告：候选 `reports/ai-plugin-20261012/api-acceptance-report.json`；作者页面记录另存 `api-acceptance-filtered-report.json`。生产发布与真实数据服务验收尚未执行，合成回执不能代替这些检查。

候选集成目录：`C:/Users/user/Documents/coludpsych/cloudpsych-editor-r205/packages/jspsych-ai-bridge`。本任务未调整生产网站。

本次 0.2.0 模型适配工作未升级该候选。独立模块导出器已使用版本化缓存及样式，构建产物通过 100000 字符限制检查。

## 真实模型调用

- DeepSeek `deepseek-flash`：新凭据在官方端点通过关闭/开启思考各 3 项，共 6 项普通、流式与结构化调用。
- MiniMax `MiniMax-M3.1-Flash-Preview`：新凭据在国内 Chat、Anthropic、Responses 各通过 3 项，共 9 项普通、流式与结构化调用。
- MiniMax 国际的上述 3 个协议均返回 HTTP 401，当前凭据无法验证其生成；插件保留明确地区预设并提供认证提示。
- 两家在实际 Chrome + jsPsych 7.3.4 + 通用服务器代理中，各完成反馈和结构化建议采纳两种 trial，共 4 个真实模型 trial；实际模型及思考配置正确保存到 jsPsych 数据。
- 两家分别验证显式 1-token 预算触发 incomplete_output，随后独立调用使用默认 8192 预算均得到正文。小预算保持原值，插件记录错误并提示调整。
- OpenAI 和 Gemini：协议夹具已覆盖，未提供可用账号进行实际服务验收。

报告：`artifacts/provider-acceptance.json`（15 项生成通过、3 项国际认证失败）、`artifacts/live-browser-report.json`（两家共 4 个 trial）、`artifacts/output-budget-report.json`（两家预算耗尽与默认预算正文）。旧凭据的失败记录仅描述旧请求，不适用于本次新凭据。凭据不写入配置导出或交付包。Safari、Firefox 和实体音频设备尚未验收。

安装产物也已单独验证：npm 安装后的依赖文件均能加载，示例首页显示九类功能，普通 jsPsych 反馈 trial 正常完成。

源码目录支持完整测试与重新构建；安装包包含真实调用验证脚本和运行所需产物，浏览器回归测试需要源码中的开发依赖。
