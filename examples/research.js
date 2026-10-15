const api = JsPsychAI;
const query = new URLSearchParams(location.search);
const group = query.get('group') ?? 'judgment';
const full = query.get('full') === '1';
const definition = api.RESEARCH_DEFINITIONS.find(item => item.group === group);
const live = query.get('live') === '1';
const options = api.researchDefaults(group, full);
const mode = query.get('mode') ?? definition.modes[0];
document.getElementById('research-title').textContent = `${definition.title} · ${full ? '完整研究' : '最小流程'} · ${live ? '真实模型' : '模拟模型'}`;
const client = api.createAIClient({ timeoutMs: 300000, transport: live ? api.createProxyTransport() : api.createMockTransport({ respond: api.mockResearchResponse }) });
const speechClient = api.createSpeechClient(live ? {} : { transport: api.createMockSpeechTransport() });
const media = new Map();
const jsPsych = initJsPsych({ display_element: 'experiment', on_finish() {
  window.researchData = jsPsych.data.get().values(); window.researchCSV = jsPsych.data.get().csv();
  document.getElementById('result').hidden = false; document.getElementById('data').textContent = jsPsych.data.get().json(true);
} });
const timeline = [];
if (full) timeline.push({ type: jsPsychHtmlKeyboardResponse, stimulus: '请阅读任务并按任意键开始。', choices: 'ALL_KEYS' });
timeline.push(api.createAITrial(mode, { ...options, client, speech_client: speechClient, condition: { example: group, full }, persist_media(blob, reference) {
  media.set(reference.id, blob); return { url: URL.createObjectURL(blob), filename: `${reference.id}.wav` };
} }));
if (full && group === 'learning') timeline.push(
  { type: jsPsychHtmlKeyboardResponse, stimulus: '短暂休息后完成延迟测验。', choices: 'NO_KEYS', trial_duration: 1000, data: { phase: 'same_session_delay' } },
  { type: jsPsychSurveyText, questions: [{ name: 'delayed', prompt: '请独立解释如何研究运动时间与情绪之间的因果关系。', required: true }], data: { phase: 'delayed_test', ai_calls: 0 } }
);
if (full) timeline.push({ type: jsPsychSurveyText, questions: [{ name: 'reflection', prompt: '你如何评价这次任务中的 AI 帮助？', required: true }] });
jsPsych.run(timeline);
function download(extension, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = `research-${group}.${extension}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.getElementById('json').onclick = () => download('json', jsPsych.data.get().json(true), 'application/json');
document.getElementById('csv').onclick = () => download('csv', jsPsych.data.get().csv(), 'text/csv');
