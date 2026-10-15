const api = JsPsychAI;
const field = name => document.getElementById(name);
field('plugin-version').textContent = api.PLUGIN_VERSION;
let connectionExtras = {};
let generationExtras = {};
let researchState = null;
let speechState = {};
const researchControls = new Map();
const speechControls = new Map();
const trialControls = new Map();
let trialState = {};
const speechFields = [
  { name: 'input_mode', label: '输入方式', kind: 'choice', options: ['automatic', 'push-to-talk', 'file', 'off'] },
  { name: 'output', label: '播报实际呈现的文本', kind: 'boolean' }, { name: 'review_transcript', label: '确认和修正转录', kind: 'boolean' }, { name: 'save_audio', label: '通过媒体回调保存原音频', kind: 'boolean' },
  { name: 'auto_threshold', label: '依据环境音调整判停阈值', kind: 'boolean' },
  { name: 'proxy_url', label: '语音代理路径', kind: 'text' }, { name: 'voice_id', label: '音色 ID', kind: 'text' }, { name: 'language', label: '转录语言', kind: 'text' },
  ...[['silence_ms','判停静音（毫秒）'],['min_speech_ms','最短语音（毫秒）'],['pre_roll_ms','预留收音（毫秒）'],['max_segment_ms','每段最长收音（毫秒）'],['threshold','收音阈值（RMS）']].map(([name,label]) => ({ name, label, kind: 'number' }))
];
const choiceLabels = { number: '数值', choice: '类别', none: '无解释', brief: '简短解释', detailed: '详细解释', after_initial: '提交初判后', on_request: '主动求助', delayed: '延迟提供', answer: '直接给答案', hints: '逐步提示', socratic: '苏格拉底式追问', bank: '固定题库', generated: '即时生成', sequential: '依次选题', rules: '条件规则', model: '模型选题', participant: '人先写', ai: 'AI 先写', fixed: '固定草稿', alternating: '轮流修改', free: '自由修改', suggestions: '局部建议', replace: '完整修改稿', select: '选择', rank: '排序', rate: '评价', 'rank-rate': '排序与评价', automatic: '自动判停', 'push-to-talk': '按住说话', file: '音频文件', off: '关闭收音' };
function renderFields(container, definitions, state, controls) {
  container.replaceChildren(); controls.clear();
  for (const definition of definitions) {
    const label = document.createElement('label'); label.textContent = definition.label;
    const input = document.createElement(definition.kind === 'choice' ? 'select' : ['text','json'].includes(definition.kind) ? 'textarea' : 'input');
    input.dataset.parameter = definition.name; input.setAttribute('aria-label', definition.label);
    if (definition.kind === 'choice') for (const value of definition.options) input.append(new Option(choiceLabels[value] ?? value, value));
    if (definition.kind === 'boolean') { input.type = 'checkbox'; input.checked = Boolean(state[definition.name]); }
    else if (definition.kind === 'number') { input.type = 'number'; input.step = 'any'; input.value = state[definition.name] ?? ''; }
    else input.value = definition.kind === 'json' ? state[definition.name] == null ? '' : JSON.stringify(state[definition.name], null, 2) : state[definition.name] ?? input.value;
    label.append(input); container.append(label); controls.set(definition.name, { definition, input });
  }
}
function readFields(state, controls) {
  const value = { ...state };
  for (const [name, { definition, input }] of controls) {
    if (definition.kind === 'boolean') value[name] = input.checked;
    else if (!input.value.trim()) delete value[name];
    else value[name] = definition.kind === 'json' ? JSON.parse(input.value) : definition.kind === 'number' ? Number(input.value) : input.value;
  }
  return value;
}
function renderResearch() {
  const definition = api.RESEARCH_DEFINITIONS.find(item => item.group === researchState?.group);
  renderFields(field('research-fields'), definition?.fields ?? [], researchState ?? {}, researchControls);
  field('research-group').value = researchState?.group ?? '';
  const trialFields = researchState?.group === 'multiagent' ? [{ name: 'agents', label: '角色配置（id、label、system_prompt）', kind: 'json' }] : researchState?.group === 'creation' ? [{ name: 'candidates', label: '生成方案数', kind: 'number' }] : [];
  renderFields(field('research-trial-fields'), trialFields, trialState, trialControls);
}
for (const definition of api.RESEARCH_DEFINITIONS) field('research-group').append(new Option(definition.title, definition.group));
renderFields(field('speech-fields'), speechFields, { input_mode: 'automatic', output: true, review_transcript: true, auto_threshold: true, proxy_url: '/api/speech', voice_id: 'male-qn-qingse', language: 'zh', silence_ms: 600, min_speech_ms: 300, pre_roll_ms: 200, max_segment_ms: 20000, threshold: 0.008 }, speechControls);
for (const feature of api.FEATURE_DEFINITIONS) field('mode').append(new Option(feature.title, feature.mode));
for (const [name, preset] of Object.entries(api.CONNECTION_PRESETS)) field('preset').append(new Option(preset.label, name));
const modeDefaults = {
  survey: { questions: [{ name: 'answer', prompt: '请描述你的判断', required: true }] },
  advice: { advice: 65 }, generate: { candidates: 3 },
  multiagent: { agents: [{ id: 'first', label: '角色一', system_prompt: '分析可实施性。' }, { id: 'second', label: '角色二', system_prompt: '分析不同使用者的需要。' }] },
  learning: { transfer_questions: [{ name: 'transfer', prompt: '请独立回答迁移问题', required: true }] }
};
const notify = value => { field('message').textContent = value; };
function read() {
  const mode = field('mode').value;
  const modeValue = field('delivery').value;
  const connection = field('baseURL').value && field('model').value ? { ...connectionExtras, protocol: field('protocol').value, baseURL: field('baseURL').value, model: field('model').value,
    thinking: { mode: field('thinking-mode').value, ...(field('thinking-effort').value ? { effort: field('thinking-effort').value } : {}) },
    maxTokens: field('max-tokens').value ? Number(field('max-tokens').value) : undefined,
    timeoutMs: field('timeout-ms').value ? Number(field('timeout-ms').value) : undefined } : null;
  return api.createConfiguration(mode, {
    prompt: field('prompt').value, max_turns: Number(field('max-turns').value), generation: { ...generationExtras, temperature: Number(field('temperature').value) },
    connection, delivery: { mode: modeValue, ...(modeValue === 'live' ? {} : { materials: JSON.parse(field('materials').value), sourceParticipant: field('source-participant').value || undefined }) },
    ...modeDefaults[mode], ...JSON.parse(field('advanced').value), ...readFields({}, trialControls),
    ...(researchState ? { research: readFields(researchState, researchControls) } : {}),
    ...(field('speech-enabled').checked ? { speech: { ...readFields(speechState, speechControls), enabled: true } } : { speech: null })
  });
}
function write(configuration) {
  const value = configuration.parameters;
  field('mode').value = configuration.mode; field('prompt').value = value.prompt ?? '';
  field('max-turns').value = value.max_turns ?? 3; field('temperature').value = value.generation?.temperature ?? 0.7;
  field('protocol').value = value.connection?.protocol ?? 'openai-chat'; field('baseURL').value = value.connection?.baseURL ?? ''; field('model').value = value.connection?.model ?? '';
  connectionExtras = { ...value.connection }; generationExtras = { ...value.generation };
  delete connectionExtras.apiKey; delete connectionExtras.headers;
  field('thinking-mode').value = value.connection?.thinking?.mode ?? 'auto'; field('thinking-effort').value = value.connection?.thinking?.effort ?? '';
  field('max-tokens').value = value.connection?.maxTokens ?? ''; field('timeout-ms').value = value.connection?.timeoutMs ?? '';
  field('preset').value = Object.entries(api.CONNECTION_PRESETS).find(([, preset]) => preset.baseURL === value.connection?.baseURL && preset.protocol === value.connection?.protocol && preset.account === value.connection?.account)?.[0] ?? 'compatible';
  field('delivery').value = value.delivery?.mode ?? 'live'; field('materials').value = JSON.stringify(value.delivery?.materials ?? [], null, 2); field('source-participant').value = value.delivery?.sourceParticipant ?? '';
  trialState = value; researchState = value.research ?? null; renderResearch();
  speechState = value.speech ?? {}; field('speech-enabled').checked = Boolean(value.speech && value.speech.enabled !== false);
  renderFields(field('speech-fields'), speechFields, { input_mode: 'automatic', output: true, review_transcript: true, auto_threshold: true, ...speechState }, speechControls);
  const { prompt, max_turns, generation, connection, delivery, research, speech, ...advanced } = value;
  for (const name of trialControls.keys()) delete advanced[name];
  field('advanced').value = JSON.stringify(advanced, null, 2);
  field('apiKey').value = '';
  updatePolicy();
}
function client() {
  if (field('transport').value === 'proxy') return api.createAIClient({ transport: api.createProxyTransport(), timeoutMs: 300000 });
  if (field('transport').value === 'direct') {
    const connection = read().parameters.connection;
    if (!connection) throw new Error('请填写服务地址和模型 ID');
    return api.createAIClient({ connection: { ...connection, temperature: Number(field('temperature').value), apiKey: field('apiKey').value } });
  }
  return api.createAIClient({ transport: api.createMockTransport({ respond(request, call) {
    if (researchState) return api.mockResearchResponse(request, call);
    if (request.schema?.properties?.advice) return JSON.stringify({ advice: 65, explanation: '配置器模拟建议。' });
    if (request.schema?.properties?.questions) return JSON.stringify({ questions: [{ name: 'response', prompt: '请描述你的想法', type: 'text', required: true, options: [], min: null, max: null }] });
    return `配置器模拟回复 ${call}：${typeof request.messages.at(-1)?.content === 'string' ? request.messages.at(-1).content : '已收到材料'}`;
  } }) });
}
function perform(action) { return async () => { try { await action(); } catch (error) { notify(error.message); } }; }
function download(name, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function updatePolicy() {
  try {
    const parameters = read().parameters;
    if (!parameters.connection) { field('effective-policy').textContent = '选择服务预设，或填写地址与模型 ID。'; return; }
    const policy = api.connectionEvidence(api.resolveConnectionPolicy(parameters.connection, { ...parameters.generation, schema: parameters.response_schema }));
    field('effective-policy').textContent = JSON.stringify(policy, null, 2);
  } catch (error) { field('effective-policy').textContent = error.message; }
}
field('preset').onchange = () => {
  const { label, ...preset } = api.CONNECTION_PRESETS[field('preset').value]; connectionExtras = { ...preset };
  field('protocol').value = preset.protocol; field('baseURL').value = preset.baseURL; field('model').value = preset.model ?? '';
  field('thinking-mode').value = 'auto'; field('thinking-effort').value = ''; field('max-tokens').value = ''; field('timeout-ms').value = ''; updatePolicy();
};
field('baseURL').addEventListener('input', () => { connectionExtras = {}; field('preset').value = 'compatible'; });
for (const id of ['baseURL', 'model', 'protocol', 'thinking-mode', 'thinking-effort', 'max-tokens', 'timeout-ms', 'temperature', 'advanced']) field(id).addEventListener('input', updatePolicy);
field('mode').onchange = () => {
  field('advanced').value = '{}';
  if (researchState && !api.RESEARCH_DEFINITIONS.find(item => item.group === researchState.group).modes.includes(field('mode').value)) { researchState = null; renderResearch(); }
};
field('research-group').onchange = () => {
  const selected = field('research-group').value;
  try {
    const previous = read();
    if (!selected) { researchState = null; renderResearch(); return; }
    const definition = api.RESEARCH_DEFINITIONS.find(item => item.group === selected);
    const defaults = api.researchDefaults(selected, true);
    write(api.createConfiguration(definition.modes[0], { ...previous.parameters, ...defaults }));
  } catch (error) { notify(error.message); }
};
field('probe').onclick = perform(async () => { notify('正在连接…'); const result = await client().probe(); notify(`连接成功：${result.model}，${Math.round(result.requestMs)} ms${result.metadata?.connectionPolicy ? '\n' + JSON.stringify(result.metadata.connectionPolicy, null, 2) : ''}`); });
field('save').onclick = perform(() => { localStorage.setItem('jspsych-ai-configuration', api.serializeConfiguration(read())); notify('配置已保存'); });
field('load').onclick = perform(() => { const value = localStorage.getItem('jspsych-ai-configuration'); if (!value) throw new Error('没有已保存的配置'); write(api.parseConfiguration(value)); notify('配置已读取'); });
field('import').onchange = perform(async () => { const file = field('import').files[0]; if (file) write(api.parseConfiguration(await file.text())); });
for (const [id, format, name, mime] of [['export-browser','browser','experiment.html','text/html'],['export-esm','esm','experiment.js','text/javascript'],['export-json','json','configuration.json','application/json']]) field(id).onclick = perform(() => {
  const value = format === 'json' ? api.serializeConfiguration(read()) : api.exportExperimentCode(read(), format); field('code').value = value; download(name, value, mime);
});
field('preview-run').onclick = perform(() => {
  field('preview-data').textContent = '';
  const configuration = read();
  const jsPsych = initJsPsych({ display_element: 'preview', on_finish() { field('preview-data').textContent = jsPsych.data.get().json(true); window.builderData = jsPsych.data.get().values(); field('preview-run').disabled = false; } });
  field('preview-run').disabled = true;
  jsPsych.run([api.configurationToTrial(configuration, { client: client(), ...(field('transport').value === 'mock' ? { speech_client: api.createSpeechClient({ transport: api.createMockSpeechTransport() }) } : {}) })]); notify('预览已启动');
});
updatePolicy();
