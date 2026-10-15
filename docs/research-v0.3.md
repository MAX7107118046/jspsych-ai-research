# 六组研究功能 API

适用：jspsych-ai-research 0.3.0 / jsPsych 7.3.4。

## 配置与运行

`createAITrial(mode, { research, speech?, ...options })` 沿用九类插件。未设置 `research` 时使用已有交互。`researchDefaults(group, full)` 返回可修改的研究示例参数；`RESEARCH_DEFINITIONS` 提供配置器使用的字段定义。`research` 和 `speech` 均支持 jsPsych 动态参数函数。

```js
const options = JsPsychAI.researchDefaults('learning', true);
options.research.strategy = 'socratic';
const trial = JsPsychAI.createAITrial('learning', { ...options, client });
jsPsych.run([trial]);
```

| group | mode | 主要参数 |
| --- | --- | --- |
| judgment | advice | response_type、choices、advice、correct_answer、quality、source_label、explanation_mode、help_timing、help_delay_ms、evidence、evidence_questions、require_evidence |
| learning | learning | strategy、pretest、practice、posttest、transfer、hints、solution、answer_key、minimum_tutor_turns |
| interview | interview / survey | question_mode、selection、topics、bank、allowed_followup_topics、max_followups_per_topic、min_questions、max_questions、finish_when_topics_covered、allow_early_finish |
| creation | coedit / generate | start、initial_draft、turn_order、suggestion_mode、minimum_revisions、comparison；trial.candidates 设置方案数 |
| multiagent | multiagent | independent_prompt、discussion_rounds、order、collect_participant、consensus；trial.agents 设置角色 |
| multimodal | chat / feedback / survey | materials、questions；speech 设置语音服务 |

完整类型见 `src/research/types.ts`。运行核心与配置器读取相同字段，无平台依赖。配置可保存、导入并导出标准 HTML/ESM。

## 判断与建议

`response_type` 为 `number` 或 `choice`。类别选项通过 `choices` 提供。`advice: null` 请求模型；固定建议可为数值或类别字符串。来源身份、解释和质量条件分别保存。实时生成的质量条件写入请求，实际建议误差在提供正确答案时计算；需要精确材料操纵时设置固定建议。

`help_timing`：`after_initial`、`on_request`、`delayed`。延迟条件在等待时间结束后开放获取按钮。证据格式为 `{id,title,text,url?}`，核查题目沿用 `Question`，`require_evidence` 要求打开全部材料。查看事件表示操作，链接点击不证明阅读完成。

数值 WOA 保留原值；建议等于初判时为 null。类别判断记录是否改判、采纳和正确，WOA 为 null。

## 学习

`strategy`：`answer`、`hints`、`socratic`。所有测验接受 `Question[]`。固定提示通过 `hints: string[]` 提供，`solution` 可主动揭示。求助、提示层级、答案揭示与实际模型输出分别记录。

`answer_key` 将题目 name 映射到答案或可接受答案数组。字符串评分忽略首尾空格与大小写；开放回答保留原文且 correct 为 null，研究者可在原生 `on_finish` 中评分。独立与迁移阶段禁用 AI 及语音入口，记录 `independent_ai_calls`。完整示例使用官方问卷和原生休息 trial 构成同次延迟测验。

## 访谈

`topics`：`{id,title,required?}[]`。`bank`：`{id,topic_id,prompt,required?,when?:{question_id,equals}}[]`。题库支持 sequential、rules、model；模型选题输出被限制为当前合法题目 ID。when 将追问关联到先前答案。

生成问题按剩余必问主题及允许追问范围返回 `{topic_id,question}`，每轮一个问题。主题获得有效回答后记为覆盖。停止原因包括 topics_covered、bank_exhausted、followup_limit、max_questions、participant_stop。记录未覆盖主题和未提问原因。

## 共创与方案比较

起稿：participant、ai、fixed。局部建议格式为 `{id,original,replacement,reason}`。接受或部分采纳要求原文在当前稿件唯一匹配；参与者改稿导致匹配失效时可手动调整或拒绝。替换整稿使用 `suggestion_mode: 'replace'`。

输入事件保存差异与完整快照，最终提交再次读取 textarea 当前值。alternating 顺序要求处理完当前建议再请求下一轮。自由顺序允许继续请求；未处理建议计数随最终稿保存。`minimum_revisions` 控制 AI 修改轮数。

generate 模式的 `comparison` 支持 select、rank、rate、rank-rate。排名必须为不同的整数；评分范围 0—100。数据保存全部方案、比较与最终选择。

## 角色与讨论

角色在 trial.agents 中配置 `{id,label,system_prompt,client?}`。独立阶段每个角色仅取得共同任务与自身系统设定，全部答案取得后才展示讨论。`order` 显式设置角色 ID 顺序，留空时采用 trial.turn_order 的固定或种子随机顺序。

讨论结束后生成同一个共同方案，逐一请求角色表态。共识要求所有角色赞同、无保留意见且无未解决分歧。参与者最终立场单独收集。ai_calls 保存实际上下文、角色、模型、顺序及阶段。

## 多模态

`materials` 使用 ContentPart：text、image、audio。图片加载完成后的浏览器绘制帧记录实际呈现；音频材料记录播放与暂停位置。图像和直接音频输入需要文本模型具备相应能力。DeepSeek 文本连接可配合独立 ASR/TTS；图片内容理解需要支持图像的模型。

六组最小与完整示例：`examples/research-index.html`。每条研究结果使用 AIResearchData.v1 的新增字段，详细定义见 [数据字典](data.md)。
