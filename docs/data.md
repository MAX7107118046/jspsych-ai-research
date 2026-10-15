# 数据字典

结果通过标准 `jsPsych.data.get().values()`、`.json()` 和 `.csv()` 获取。嵌套数组/对象在 CSV 中保存为 JSON 字符串，分析时解析相应字段。

| 字段 | 含义 |
| --- | --- |
| ai_data_version | AIResearchData.v1 |
| ai_plugin_version / jspsych_runtime_version | 0.3.0 / 7.3.4 |
| research_mode | 九类插件功能之一 |
| ai_status | complete / error / cancelled / timeout / interrupted |
| ai_session_id / ai_seed | 当前参与者会话与本包随机顺序种子 |
| condition | 原样记录的研究条件 |
| delivery_mode / source_participant | 材料模式与配对来源 |
| rt | trial 开始到结束的毫秒数，包含请求和呈现时间 |
| participant_rt | 参与者有效响应窗口的累计毫秒数；等待模型与受控呈现结束后重开窗口 |
| response_windows | 各次响应窗口的毫秒数 |
| participant_turns | 参与者提交次数 |
| response | 当前功能的参与者回答、选择或稿件 |
| ai_output | 最后一次文本或结构化 AI 结果 |
| messages | 最终对话历史，包含角色、多模态材料和 agentId |
| ai_calls | 每次生成调用的完整记录，包含失败和被替换的输出 |
| events | 相对 trial 开始的事件时间、类型与细节 |

`ai_calls` 包含 `id`、`agent_id`、`request`、`source`、`status`、`started_ms`、`ended_ms`、`result`、`error`。request 保存实际发送的消息、生成参数、结构 schema 和请求 ID；连接凭据不在此记录中。

result 保存 `text`、实际返回 `model`、`requestedModel`、`requestMs`、`firstTokenMs`、`attempts`、usage 和结构化 data。固定材料的 requestMs=0、attempts=0、firstTokenMs=null。错误的 partialText 保留已收到内容，供分析流中断和截断情况。

0.2.0 的内建 HTTP 调用还记录 `result.metadata.connectionPolicy`：规则日期、provider、profile、端点、地区、账户类型、协议、模型、思考档位、总生成预算、实际超时与结构化方式。`reasoningCharacters` 记录服务单独返回的思考字符数，流式 `firstReasoningMs` 记录首个思考增量时间；未返回时为 0 / null。`firstTokenMs` 继续测量正文首个增量。思考文本不写入结果。错误记录中的 connectionPolicy 同样可用于检查条件偏差。

| 专用字段 | 所属功能 |
| --- | --- |
| generated_questions / question_timings | 问卷；题目时间从首次获得焦点到提交，未获得焦点时从表单创建开始 |
| initial_estimate / final_estimate / advice | 建议采纳 |
| weight_of_advice | `(final-initial)/(advice-initial)`，分母为 0 保存 null |
| initial_error / final_error | 提供 correct_answer 时计算绝对误差，缺少答案时 null |
| initial_confidence / final_confidence | 参与者信心评价 |
| candidates / selected_candidate | 全部生成方案与从 0 开始的选择索引 |
| document / revisions | 共同创作的最终稿与 AI/参与者修改 |
| transfer_response / transfer_rt | 学习任务的独立测验回答与耗时 |
| agent_orders | 多代理的实际发言顺序 |
| persistence_status / persistence_error | 自定义持久化结果 |
| ai_callback_errors | CloudPsych 适配层回调错误及所属阶段 |

事件覆盖发送、请求开始/完成/错误、重新生成、重试、呈现起止、速度与暂停、文件添加、录音、候选选择、编辑、测验和试次结束。暂停与呈现事件可用于计算时间指标；认知负荷等研究构念需要研究者提供对应测量和分析设计。

JSON/CSV 数据包含研究者配置的提示词和材料。分析时分别使用真实模型字段、身份标签条件和材料来源字段。

## 0.3 研究流程字段

新增字段不删除 AIResearchData.v1 的已有字段。旧版交互与 research 交互有不同专用字段，按 research_group 区分。

| 字段 | 定义 |
| --- | --- |
| research_group / research_config | 六组方向与执行配置快照 |
| phases | id、name、started_ms、ended_ms、participant、response；相对 trial 开始 |
| events.phase / phase_id / speech_turn_id | 事件所属阶段与触发语音轮次 |
| ai_calls.request.metadata.phase / agentId / speech_turn_id | 实际请求关联 |
| advice_condition / advice_explanation / advice_adopted / advice_error | 建议条件、解释、采纳、与正确答案的差异 |
| evidence_operations / evidence_viewed / evidence_response | 打开、关闭、来源链接、可见时长与核查回答 |
| tutoring_strategy / help_events / answer_revealed | 辅导策略、求助类型、提示层级、答案揭示 |
| pretest_response / practice_response / posttest_response / transfer_response | 各学习阶段回答 |
| 各阶段 _score | items（name、answer、correct）、scored、correct；开放回答为 null |
| ai_calls_at_withdrawal / independent_ai_calls | 撤除 AI 时累计请求数与独立测验新增请求数 |
| interview_turns | 实际题目 id、topic_id、prompt、answer、parent_id、kind、order |
| covered_topics / missing_required_topics / unasked_questions / interview_end_reason | 主题覆盖、缺失、跳过与结束原因 |
| initial_draft / final_draft / revisions | 稿件与输入事件；差异使用 UTF-16 索引，含完整快照 |
| suggestion_decisions / revision_rounds / unresolved_suggestions | 建议接受、拒绝、部分采纳与未处理计数 |
| candidate_comparison / selected_candidate / candidates | 排名评分、0 起始选择索引与全部方案 |
| independent_answers / discussion / agent_orders | 代理独立输出、共享讨论、实际发言顺序 |
| consensus_proposal / final_positions / consensus | 共同方案及未解决分歧、逐个角色表态与是否达成共识 |
| participant_initial / participant_final | 参与者独立与讨论后的立场 |
| presented_materials | 研究材料；image_presented 记录加载与绘制完成 |
| speech_turns | id、source、status、原始/修正转录、queued_ms、asr_ms、asr_first_delta_ms、review_ms、committed_ms、response_ready_ms |
| speech_playback | id、input_turn_id、text、audio_bytes、首包/合成/播放时间、status、打断原因和已播/排队秒数 |
| media | id、kind、mime_type、bytes、turn_id、status、url、filename；原始 Blob 通过回调传出 |

requestMs 表示模型请求；presentation_end.presentation_ms 表示视觉呈现过程；speech_playback 中的播放时间表示 WebAudio 实际运行时间。participant_rt 汇总作答窗口，研究分析也可从 phases 按阶段计算。
