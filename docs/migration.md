# 兼容与迁移

| 组件 | 首发支持 |
| --- | --- |
| jsPsych | 精确 7.3.4，peerDependency 固定 |
| 插件 | 0.3.0 |
| 数据 | AIResearchData.v1 |
| 可视化配置 | AIExperimentConfig.v1 |
| CloudPsych | r205 / StudioWorkflow.v3 / CodeModule.v1 接口 |
| 其他 jsPsych 7.x、6.x、8.x | 待独立适配与验收 |

浏览器需要 fetch、ReadableStream、AbortController 和 structuredClone。CloudPsych 内嵌模块使用 DecompressionStream；验收浏览器为当前 Chrome。实机麦克风、Safari/Firefox 和不同服务商账号需要对应环境验证。

0.1.0、0.2.0 与 0.3.0 使用独立安装包。配置导入检查精确版本，已有实验使用原锁定包。需要升级时，在新版本中用 `createConfiguration(mode, oldParameters)` 创建新配置并保存；0.3 的 research 和 speech 为可选参数，数据格式沿用 AIResearchData.v1 并增加研究字段。参数迁移工具单独安排。

旧文件按功能迁移到独立插件：

| 原有能力 | 新接口 |
| --- | --- |
| AI interaction / chat_mode | AIChatPlugin / AIInterviewPlugin |
| 量表问卷 / auto_generate | AISurveyPlugin / generate_questions |
| 自定义反馈 | AIFeedbackPlugin |
| JAS | AIAdvicePlugin |
| 多轮生成与创意任务 | AIGeneratePlugin / AICoeditPlugin |
| 多 AI | AIMultiAgentPlugin 的 agents |
| 跨轮记忆 | ResearchSession + memory_key |
| 认知同步呈现 | presentation 的速度、延迟、暂停及事件 |
| 图像/音频材料 | attachments / initial_attachments |
| provider 列表与模型名称判断 | createConnection 地区/账户预设 + 已登记模型规则 + 显式 capabilities / extra |

迁移时明确选择插件类，避免依赖旧代码中 chat_mode、auto_generate 等组合开关的隐含优先级。问卷条目和身份条件按研究设计迁移；自动生成条目需要由研究者检查测量性质。

旧问题的处理：温度使用空值判断；重新生成发起新调用并记录旧输出；RT 使用 performance.now 的时间差；流式输出保存最终文本；取消与超时忽略迟到结果；同值建议的采纳比例保存 null；jsPsych 参数使用数值 ParameterType。

升级插件时同时更新包锁和模块版本。当前编辑器冻结同一模块 ID 与版本的源码；修改研究指令、配置或模块包装时创建新版本，已有发布产物保留其冻结内容。
