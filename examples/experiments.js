const { createAIClient, createMockTransport, createProxyTransport, createResearchSession, createAITrial } = JsPsychAI;
const query = new URLSearchParams(location.search);
const mode = document.body.dataset.mode || query.get('mode') || 'chat';
const full = document.body.dataset.full === 'true' || query.get('full') === '1';
const live = query.get('live') === '1';
const session = createResearchSession({ id: 'example-participant', seed: 314 });
const client = createAIClient({ timeoutMs: live ? 300000 : 60000, transport: live ? createProxyTransport() : createMockTransport({ delayMs: 100, respond(request, call) {
  if (request.schema?.properties?.questions) return JSON.stringify({ questions: [
    { name: 'experience', prompt: '请描述你对任务的理解', type: 'text', required: true, options: [], min: null, max: null },
    { name: 'confidence', prompt: '你对自己的判断有多大信心？', type: 'scale', required: true, options: [], min: 0, max: 100 }
  ] });
  if (request.schema?.properties?.advice) return JSON.stringify({ advice: 65, explanation: '这是用于演示判断修订流程的固定建议。' });
  const content = request.messages.at(-1)?.content;
  const text = typeof content === 'string' ? content : content?.find(part => part.type === 'text')?.text ?? '';
  if (mode === 'interview') return `访谈问题 ${call}：请结合一个具体经历，谈谈${call === 1 ? '你如何使用 AI 完成任务' : '你刚才提到的判断过程'}。`;
  if (mode === 'coedit') return `草稿版本 ${call}\n城市中的公共绿地为居民提供休息空间。可以从使用场景、维护方式和居民参与三个角度继续完善方案。`;
  return `模拟输出 ${call}\n${text}\n可继续输入、修改或完成任务。正式实验通过连接配置调用实际模型。`;
} }) });
const definitions = {
  chat: { prompt: '请与 AI 讨论你处理复杂任务的方式。', min_turns: 1, max_turns: 2 },
  interview: { prompt: '访谈主题：使用 AI 的经历。', min_turns: 1, max_turns: 2 },
  survey: { prompt: '请填写以下问题。', questions: [{ name: 'strategy', prompt: '你采用了什么策略？', required: true }, { name: 'confidence', prompt: '信心（0—100）', type: 'scale', min: 0, max: 100, required: true }], generate_questions: full, survey_feedback: full },
  feedback: { prompt: '为任务中采用逐步比较策略的参与者提供简短反馈。' },
  advice: { prompt: '请估计一个社区中支持增加公共绿地的居民百分比。', advice: full ? null : 65, correct_answer: 60 },
  generate: { prompt: '提出改善社区公共空间的创意。', candidates: 3, response_required: true },
  coedit: { prompt: '撰写一段关于改善社区公共空间的建议。', max_turns: 2 },
  learning: { prompt: '学习主题：区分相关关系与因果关系。', min_turns: 1, max_turns: 2, transfer_questions: [{ name: 'transfer', prompt: '冰淇淋销量和溺水事件同时增加，能否说明吃冰淇淋导致溺水？请解释。', required: true }] },
  multiagent: { prompt: '讨论改善社区公共空间的方案。', max_turns: 2, turn_order: 'random', agents: [{ id: 'planner', label: '规划者', system_prompt: '从可实施性与成本角度分析。' }, { id: 'resident', label: '居民', system_prompt: '从日常体验与可达性角度分析。' }] }
};
const configuration = definitions[mode];
if (!configuration) throw new Error('未知示例');
const display = document.getElementById('experiment');
const badge = document.getElementById('service');
if (badge) badge.textContent = `${live ? '服务端代理' : '模拟模型'} · jsPsych 7.3.4 · ${full ? '研究示例' : '最小示例'}`;
const jsPsych = initJsPsych({ display_element: display, on_finish() {
  window.exampleData = jsPsych.data.get().values();
  const result = document.getElementById('result');
  result.hidden = false;
  result.querySelector('pre').textContent = jsPsych.data.get().json(true);
  document.getElementById('download-json').onclick = () => jsPsych.data.get().localSave('json', `${mode}-data.json`);
  document.getElementById('download-csv').onclick = () => jsPsych.data.get().localSave('csv', `${mode}-data.csv`);
} });
window.exampleJsPsych = jsPsych;
const timeline = [];
if (full) timeline.push({ type: jsPsychSurveyText, questions: [{ prompt: '参与者编号', name: 'participant', required: true }] });
timeline.push(createAITrial(mode, { ...configuration, client, session, memory_key: full ? 'study' : null,
  condition: { study: mode, assignment: 'example', ai_source_label: 'AI' }, generation: { temperature: 0 },
  ...(query.get('multimodal') === '1' ? { attachments: { image: true, audio: true, record_audio: true } } : {}),
  on_event: event => { window.lastAIEvent = event; }
}));
if (full) timeline.push({ type: jsPsychSurveyText, questions: [{ prompt: '你如何评价刚才的互动？', name: 'evaluation', required: true }] });
jsPsych.run(timeline);
