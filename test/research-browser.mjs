import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDevelopmentServer } from '../server/dev.mjs';
import { createConnection, PLUGIN_VERSION, createMockTransport } from '../dist/core.js';
import { mockResearchResponse } from '../dist/research.js';
import { createCloudPsychCodeModule } from '../integrations/cloudpsych.mjs';

const livePreset = process.env.RESEARCH_LIVE_PRESET;
const apiKey = livePreset === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.MINIMAX_API_KEY;
if (livePreset && !apiKey) throw new Error('Missing live provider credential');
const server = createDevelopmentServer({ ...(livePreset ? { connection: createConnection(livePreset, { apiKey }) } : { connection: {protocol:'openai-chat',baseURL:'https://unused.test',model:'export-mock',capabilities:{image:true,audio:true}}, clientOptions:{transport:createMockTransport({respond:mockResearchResponse})} }), speech: { transport: {
  async transcribe(blob) { return { text: '模拟音频的原始转录', model: 'proxy-mock-asr', requestMs: 2, duration: blob.size / 32000, firstDeltaMs: 1 }; },
  synthesize(context) { let text = ''; return { write(value) { text += value; }, async flush() { context.onAudio(new Uint8Array(16000), 16000); }, cancel() {}, close() {} }; }
} } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let executablePath;
for (const candidate of [process.env.PLAYWRIGHT_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean)) { try { await access(candidate); executablePath = candidate; break; } catch {} }
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(executablePath ? { executablePath } : {}) });
const results = [];
const filter = process.env.RESEARCH_TEST_FILTER;

async function test(name, callback) {
  if (filter && !name.includes(filter)) return;
  const page = await browser.newPage(); page.setDefaultTimeout(livePreset ? 180000 : 8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try { await callback(page); assert.deepEqual(errors, []); results.push({ name, status: 'passed', ...(page.acceptanceData ? { trial: page.acceptanceData } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: String(error.stack).replaceAll(apiKey ?? 'nonexistent-secret', '[redacted]'), pageErrors: errors }); console.log(`FAIL ${name}: ${error.message}`); }
  finally { await page.close(); }
}
async function start(page, group, overrides = {}, mode) {
  await page.goto(`${base}/examples/test.html`);
  await page.evaluate(({ group, overrides, mode, livePreset }) => {
    const api = JsPsychAI; const defaults = api.researchDefaults(group, true);
    const options = { ...defaults, ...overrides, research: { ...defaults.research, ...overrides.research } };
    const client = api.createAIClient({ timeoutMs: 300000, transport: livePreset ? api.createProxyTransport() : api.createMockTransport({ respond: api.mockResearchResponse }) });
    const speechClient = api.createSpeechClient(overrides.test_speech_delay_ms ? {transport:api.createMockSpeechTransport({delayMs:overrides.test_speech_delay_ms})} : { proxyURL: '/api/speech' });
    const jsPsych = initJsPsych({ display_element: 'experiment', on_finish() { window.records = jsPsych.data.get().values(); window.csv = jsPsych.data.get().csv(); } });
    window.testPsych = jsPsych;
    jsPsych.run([
      { type: jsPsychHtmlKeyboardResponse, stimulus: '原生按键插件', choices: 'NO_KEYS', trial_duration: 5 },
      { type: jsPsychImageKeyboardResponse, stimulus: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', choices: 'NO_KEYS', trial_duration: 5 },
      api.createAITrial(mode ?? api.RESEARCH_DEFINITIONS.find(item => item.group === group).modes[0], { ...options, client, speech_client: speechClient, on_finish(data) { data.native_callback = true; }, persist_media(blob, reference) { window.savedMedia = { bytes: blob.size, id: reference.id }; return { url: `memory:${reference.id}` }; } })
    ]);
  }, { group, overrides, mode, livePreset });
}
async function form(page, values = {}) {
  await page.locator('.ai-question-form').waitFor();
  for (const control of await page.locator('.ai-question-form textarea,.ai-question-form input,.ai-question-form select').all()) {
    const name = await control.getAttribute('name'); const tag = await control.evaluate(input => input.tagName);
    if (tag === 'SELECT') { const options = await control.locator('option').evaluateAll(items => items.map(item => item.value).filter(Boolean)); await control.selectOption(String(values[name] ?? options[0])); }
    else await control.fill(String(values[name] ?? (await control.getAttribute('type') === 'number' ? 60 : '我会检查证据并考虑其他解释。')));
  }
  await page.locator('.ai-question-form button[type=submit]').click();
}
async function record(page) {
  await page.waitForFunction(() => window.records);
  const result = await page.evaluate(() => ({ records: window.records, csv: window.csv }));
  const data = result.records.at(-1); assert.equal(data.ai_status, 'complete'); assert.equal(data.native_callback, true); assert.ok(data.phases.length); assert.ok(result.csv.includes('research_group'));
  page.acceptanceData = { group: data.research_group, status: data.ai_status, models: [...new Set(data.ai_calls.map(call => call.result?.model))], calls: data.ai_calls.length,
    phases: data.phases, independent_ai_calls: data.independent_ai_calls, speech_turns: data.speech_turns, speech_playback: data.speech_playback };
  assert.equal(result.records.length, 3); assert.equal(data.ai_plugin_version, PLUGIN_VERSION); return data;
}
async function chat(page, text = '请给我一个具体提示。') { await page.getByLabel('你的回答', { exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.ai-research')?.getAttribute('aria-busy') === 'false'); }
async function drive(page,group) {
  if (group === 'judgment') { await form(page); await page.getByRole('button', { name: '历史记录', exact: true }).click(); await form(page); await form(page); }
  if (group === 'learning') { await form(page); await chat(page); await page.getByRole('button', { name: '开始独立测验', exact: true }).click(); await form(page); await form(page); }
  if (group === 'interview') { await form(page); await form(page); }
  if (group === 'creation') { await form(page); await page.getByRole('button', { name: '请求修改建议', exact: true }).click(); await page.getByRole('button', { name: '接受', exact: true }).click(); await page.getByRole('button', { name: '提交最终稿', exact: true }).click(); }
  if (group === 'multiagent') { await form(page); await form(page); }
  if (group === 'multimodal') { await chat(page); await page.getByRole('button', { name: '完成', exact: true }).click(); }
}

try {
  await test('judgment numeric evidence and timing', async page => {
    await start(page, 'judgment', { research: { help_timing: 'on_request' } }); await form(page, { initial: 50 }); await page.getByRole('button', { name: '获取AI建议', exact: true }).click();
    await page.getByRole('button', { name: '历史记录', exact: true }).click(); await form(page); await form(page, { final: 65 });
    const data = await record(page); assert.equal(data.initial_estimate, 50); assert.ok(data.evidence_operations.length); assert.ok(data.advice === data.initial_estimate ? data.weight_of_advice === null : Number.isFinite(data.weight_of_advice)); assert.equal(data.ai_calls.length, 1);
  });
  if (!livePreset) await test('judgment categorical delayed assistance', async page => {
    await start(page, 'judgment', { research: { response_type: 'choice', choices: ['A','B'], advice: 'B', correct_answer: 'B', help_timing: 'delayed', help_delay_ms: 20, evidence: [], require_evidence: false } });
    await form(page, { initial: 'A' }); await page.getByRole('button', { name: '获取AI建议', exact: true }).click(); await form(page, { final: 'B' });
    const data = await record(page); assert.equal(data.weight_of_advice, null); assert.equal(data.advice_adopted, true); assert.equal(data.final_correct, true);
  });
  for (const strategy of livePreset ? ['hints'] : ['answer','hints','socratic']) await test(`learning ${strategy} withdrawal and scores`, async page => {
    await start(page, 'learning', { research: { strategy, pretest: [{ name: 'pre', prompt: '前测', required: true }], practice: [{ name: 'practice', prompt: '练习', required: true }], answer_key: { post: '因果未确定', transfer: '混淆变量' } } });
    await form(page); await form(page); await chat(page); await page.getByRole('button', { name: '开始独立测验', exact: true }).click();
    assert.equal(await page.locator('.ai-controls:visible').count(), 0); await form(page, { post: '因果未确定' }); await form(page, { transfer: '混淆变量' });
    const data = await record(page); assert.equal(data.independent_ai_calls, 0); assert.equal(data.posttest_score.correct, 1); assert.equal(data.transfer_score.correct, 1); assert.equal(data.help_events.length, 1);
  });
  await test('interview generated mandatory topics', async page => {
    await start(page, 'interview'); await form(page); await form(page); const data = await record(page);
    assert.equal(data.interview_end_reason, 'topics_covered'); assert.equal(data.covered_topics.length, 2); assert.equal(data.ai_calls.length, 2);
  });
  if (!livePreset) {
    await test('frozen module decodes and runs existing jsPsych entry', async page => {
      const artifact=await createCloudPsychCodeModule({mode:'feedback'}); assert.ok(artifact.module.source.length<100000);
      await page.goto(`${base}/examples/test.html`); await page.evaluate(source=>{
        const module={exports:{}}; new Function('module','window',source)(module,window);
        const jsPsych=initJsPsych({display_element:'experiment',on_finish(){window.moduleData=jsPsych.data.get().values()[0];}});
        jsPsych.run([{type:module.exports.Plugin,configuration:{delivery:{mode:'replay',materials:[{text:'冻结模块成功运行',model:'recorded'}]}}}]);
      },artifact.module.source);
      await page.getByText('冻结模块成功运行',{exact:true}).waitFor(); await page.getByRole('button',{name:'完成',exact:true}).click(); await page.waitForFunction(()=>window.moduleData);
      assert.equal(await page.evaluate(()=>window.moduleData.ai_status),'complete');
    });
    await test('speech pending microphone request reports a usable timeout', async page => {
      await page.goto(`${base}/examples/test.html`); await page.evaluate(()=>{
        Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>new Promise(()=>{})});
        const api=JsPsychAI; const jsPsych=initJsPsych({display_element:'experiment'}); jsPsych.run([api.createAITrial('chat',{client:api.createAIClient({transport:api.createMockTransport()}),speech:{enabled:true,input_mode:'automatic',microphone_timeout_ms:150},research:{group:'multimodal',materials:[]}})]);
      });
      await page.getByRole('button',{name:'开启连续收音',exact:true}).click(); await page.getByText('浏览器尚未提供麦克风。请查看设备提示，或在桌面 Chrome / Edge 中打开此页。',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'开启连续收音',exact:true}).isEnabled(),true);
    });
    await test('interview bank rules and followup cap', async page => {
      await start(page, 'interview', { research: { question_mode: 'bank', selection: 'rules', topics: [{ id: 'main', title: '经历', required: true }], bank: [
        { id: 'first', topic_id: 'main', prompt: '是否使用过AI？', required: true }, { id: 'follow', topic_id: 'main', prompt: '如何核查？', when: { question_id: 'first', equals: '使用过' } }, { id: 'skip', topic_id: 'main', prompt: '跳过题', when: { question_id: 'first', equals: '没有' } }
      ], allowed_followup_topics: ['main'], finish_when_topics_covered: false, max_questions: 3, max_followups_per_topic: 1 } });
      await form(page, { answer: '使用过' }); await form(page); const data = await record(page);
      assert.equal(data.interview_turns.length, 2); assert.equal(data.interview_turns[1].parent_id, 'first'); assert.equal(data.unasked_questions[0].reason, 'condition_not_met');
    });
    await test('interview model selects only bank IDs', async page => {
      await start(page, 'interview', { research: { question_mode: 'bank', selection: 'model', topics: [{ id: 'main', title: '经历', required: true }], bank: [{ id: 'one', topic_id: 'main', prompt: '第一题' }, { id: 'two', topic_id: 'main', prompt: '第二题' }] } });
      await form(page); const data = await record(page); assert.equal(data.interview_turns[0].id, 'one'); assert.equal(data.ai_calls[0].request.schema.properties.question_id.enum.length, 2);
    });
  }
  for (const startMode of livePreset ? ['fixed'] : ['participant','ai','fixed']) await test(`creation ${startMode} revisions and partial acceptance`, async page => {
    await start(page, 'creation', { research: { start: startMode, initial_draft: '把读过的书分享给邻居，让故事继续。', minimum_revisions: 1 } });
    if (startMode === 'participant') await form(page, { draft: '把读过的书分享给邻居，让故事继续。' });
    await page.getByRole('button', { name: '请求修改建议', exact: true }).click();
    await page.locator('.ai-suggestion').first().waitFor(); await page.locator('.ai-suggestion textarea').first().fill('带一本旧书，换一段故事。');
    await page.getByRole('button', { name: '部分采纳', exact: true }).first().click();
    while (await page.getByRole('button', { name: '拒绝', exact: true }).count()) await page.getByRole('button', { name: '拒绝', exact: true }).first().click();
    await page.getByLabel('共同创作稿件').fill('最终编辑尚未失去焦点');
    await page.getByRole('button', { name: '提交最终稿', exact: true }).click(); const data = await record(page);
    assert.equal(data.final_draft, '最终编辑尚未失去焦点'); assert.equal(data.suggestion_decisions[0].decision, 'partial'); assert.ok(data.revisions.length >= 2);
  });
  if (!livePreset) {
    await test('creation accepts and rejects suggestions', async page => {
      await start(page, 'creation', { research: { start: 'fixed', minimum_revisions: 1 } });
      await page.getByRole('button', { name: '请求修改建议', exact: true }).click(); await page.getByRole('button', { name: '接受', exact: true }).click();
      await page.getByRole('button', { name: '请求修改建议', exact: true }).click(); await page.getByRole('button', { name: '拒绝', exact: true }).click();
      await page.getByRole('button', { name: '提交最终稿', exact: true }).click(); const data = await record(page); assert.deepEqual(data.suggestion_decisions.map(entry => entry.decision), ['accepted','rejected']);
    });
    await test('creation replacement draft', async page => {
      await start(page, 'creation', { research: { start: 'fixed', suggestion_mode: 'replace' } }); await page.getByRole('button', { name: '请求修改建议', exact: true }).click(); await page.getByRole('button', { name: '接受修改稿', exact: true }).click();
      await page.getByRole('button', { name: '提交最终稿', exact: true }).click(); const data = await record(page); assert.equal(data.suggestion_decisions[0].decision, 'accepted');
    });
    await test('creation candidates ranking and rating', async page => {
      await start(page, 'creation', { research: { comparison: 'rank-rate' } }, 'generate');
      await form(page, { rank_1: 2, rank_2: 1, rank_3: 3, rating_1: 50, rating_2: 90, rating_3: 40 }); const data = await record(page); assert.equal(data.selected_candidate, 1); assert.equal(data.candidates.length, 3);
    });
  }
  await test('multiagent isolated answers order and consensus', async page => {
    await start(page, 'multiagent', { research: { collect_participant: true, order: ['skeptic','benefit'] } }); await form(page); await form(page);
    const data = await record(page); const calls = data.ai_calls.filter(call => call.request.metadata.phase === 'agent_independent');
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.request.messages.length === 2)); assert.ok(calls.every(call => !JSON.stringify(call.request.messages).includes('参与者初始立场')));
    assert.deepEqual(data.agent_orders[0], ['skeptic','benefit']); assert.equal(data.final_positions.length, 2); assert.equal(typeof data.consensus, 'boolean');
  });
  if (!livePreset) await test('multiagent sequential speech completes each role', async page => {
    await start(page,'multiagent',{speech:{enabled:true,input_mode:'off',output:true},research:{collect_participant:false}}); await form(page);
    const data=await record(page); assert.ok(data.speech_playback.length>=7); assert.ok(data.speech_playback.every(output=>output.status==='complete'&&output.playback_ended_ms));
  });
  await test('multimodal material presentation and conversation', async page => {
    await start(page, 'multimodal', { speech: null, ...(livePreset ? { research: { materials: [{ type: 'text', text: '参与者观察到两种不同形状。' }] } } : {}) }); await chat(page); await page.getByRole('button', { name: '完成', exact: true }).click();
    const data = await record(page); assert.equal(data.ai_calls.length, 1); if (!livePreset) assert.ok(data.events.some(event => event.type === 'image_presented'));
  });
  if (!livePreset) {
    for (const group of ['judgment','learning','interview','creation','multiagent','multimodal']) await test(`research visual simulation ${group}`, async page => {
      await page.goto(`${base}/examples/test.html`); await page.evaluate(group => {
        const api=JsPsychAI; const defaults=api.researchDefaults(group,true); const jsPsych=initJsPsych({display_element:'experiment',on_finish(){window.simulatedData=jsPsych.data.get().values()[0];}});
        jsPsych.simulate([api.createAITrial(api.RESEARCH_DEFINITIONS.find(item=>item.group===group).modes[0],defaults)],'visual');
      },group);
      await page.waitForFunction(()=>window.simulatedData); const data=await page.evaluate(()=>window.simulatedData); assert.equal(data.ai_status,'complete'); assert.equal(data.ai_simulated,true); assert.equal(data.research_group,group);
    });
    await test('speech interruption cancels pending model and permits next turn', async page => {
      await page.goto(`${base}/examples/test.html`); await page.evaluate(()=>{
        const api=JsPsychAI; let count=0;
        const client=api.createAIClient({transport:async(request,context)=>{
          if(++count===1) {context.onDelta('等待回应。'); await new Promise(resolve=>setTimeout(resolve,1000)); return {text:'旧回应',model:'old'};}
          return {text:'新回应。',model:'new'};
        }});
        const jsPsych=initJsPsych({display_element:'experiment',on_finish(){window.records=jsPsych.data.get().values();}});
        jsPsych.run([api.createAITrial('chat',{client,speech_client:api.createSpeechClient({transport:api.createMockSpeechTransport()}),speech:{enabled:true,input_mode:'off',output:true},research:{group:'multimodal',materials:[]}})]);
      });
      await page.getByLabel('你的回答',{exact:true}).fill('开始旧请求'); await page.getByRole('button',{name:'发送',exact:true}).click();
      await page.getByRole('button',{name:'打断播报',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.ai-research')?.getAttribute('aria-busy')==='false'); await chat(page,'开始新请求');
      await page.waitForTimeout(1100); await page.getByRole('button',{name:'完成',exact:true}).click(); await page.waitForFunction(()=>window.records);
      const data=await page.evaluate(()=>window.records[0]); assert.equal(data.ai_calls[0].status,'cancelled'); assert.equal(data.ai_calls[1].status,'complete'); assert.equal(data.ai_calls[1].result.model,'new');
      assert.ok(data.speech_playback.every(output=>output.status!=='pending'));
    });
    await test('speech automatic microphone segmentation', async page => {
      await start(page,'multimodal',{speech:{enabled:true,input_mode:'automatic',output:false,review_transcript:true,threshold:0,min_speech_ms:100,max_segment_ms:400},research:{materials:[]}});
      await page.getByRole('button',{name:'开启连续收音',exact:true}).click(); await page.getByLabel('确认转录').waitFor(); await page.getByRole('button',{name:'停止收音',exact:true}).click();
      await page.getByRole('button',{name:'完成',exact:true}).click(); const data=await record(page); assert.ok(data.speech_turns.some(turn=>turn.source==='microphone')); assert.ok(data.events.some(event=>event.type==='speech_segment_end'&&event.detail.turn_id));
    });
    await test('speech subsequent microphone segments preserve pending ASR', async page => {
      await start(page,'multimodal',{test_speech_delay_ms:900,speech:{enabled:true,input_mode:'automatic',output:false,review_transcript:true,threshold:0,min_speech_ms:100,max_segment_ms:250},research:{materials:[]}});
      await page.getByRole('button',{name:'开启连续收音',exact:true}).click(); await page.getByLabel('确认转录').waitFor(); await page.getByRole('button',{name:'停止收音',exact:true}).click();
      await page.getByRole('button',{name:'完成',exact:true}).click(); const data=await record(page);
      assert.ok(data.events.filter(event=>event.type==='speech_segment_end').length>=2); assert.ok(data.speech_turns[0].original_transcript); assert.equal(data.speech_turns[0].error,undefined);
    });
    await test('speech proxy transcript correction playback and interruption', async page => {
      await start(page, 'multimodal', { speech: { enabled: true, input_mode: 'file', output: true, review_transcript: true, save_audio: true }, research: { materials: [] } });
      const wave = Buffer.alloc(32044); wave.write('RIFF'); wave.writeUInt32LE(32036,4); wave.write('WAVEfmt ',8); wave.writeUInt32LE(16,16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22); wave.writeUInt32LE(16000,24); wave.writeUInt32LE(32000,28); wave.writeUInt16LE(2,32); wave.writeUInt16LE(16,34); wave.write('data',36); wave.writeUInt32LE(32000,40);
      await page.getByLabel('转录音频文件').setInputFiles({ name: 'input.wav', mimeType: 'audio/wav', buffer: wave }); await page.getByLabel('确认转录').fill('修正后的转录'); await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.ai-message-assistant')?.textContent.includes('模拟模型回复'));
      await page.waitForFunction(() => document.querySelector('.ai-research')?.getAttribute('aria-busy') === 'false');
      await page.waitForTimeout(100); await page.getByRole('button', { name: '打断播报', exact: true }).click(); await page.getByRole('button', { name: '完成', exact: true }).click();
      const data = await record(page); assert.equal(data.speech_turns[0].original_transcript, '模拟音频的原始转录'); assert.equal(data.speech_turns[0].corrected_transcript, '修正后的转录'); assert.equal(data.media[0].status, 'saved'); assert.ok(data.speech_playback[0].audio_bytes > 0); assert.equal(data.speech_playback[0].status, 'interrupted');
    });
    await test('speech browser microphone capture push to talk', async page => {
      await start(page, 'multimodal', { speech: { enabled: true, input_mode: 'push-to-talk', output: false, review_transcript: true, min_speech_ms: 100 }, research: { materials: [] } });
      const talk = page.getByRole('button', { name: '按住说话', exact: true }); await talk.focus(); await page.keyboard.down('Space'); await page.waitForTimeout(1200); await page.keyboard.up('Space');
      await page.getByLabel('确认转录').waitFor(); await page.getByRole('button', { name: '丢弃转录', exact: true }).click(); await page.getByRole('button', { name: '完成', exact: true }).click(); const data = await record(page); assert.equal(data.speech_turns[0].source, 'microphone'); assert.ok(data.events.some(event => event.type === 'speech_segment_end'));
    });
    for (const group of ['judgment','learning','interview','creation','multiagent','multimodal']) await test(`builder ${group} save reload export preview`, async page => {
      await page.goto(`${base}/examples/builder.html`); await page.locator('#research-group').selectOption(group); await page.locator('#save').click();
      await page.reload(); await page.locator('#load').click(); assert.equal(await page.locator('#research-group').inputValue(), group);
      await page.locator('#export-browser').click(); const code = await page.locator('#code').inputValue(); assert.ok(code.includes(`"group": "${group}"`)); assert.ok(code.includes('createAITrial'));
      await page.locator('#preview-run').click(); await page.locator('.ai-research').waitFor();
      assert.equal(await page.locator('#message').textContent(), '预览已启动');
      await drive(page,group);
      await page.waitForFunction(() => window.builderData); const data = await page.evaluate(() => window.builderData[0]); assert.equal(data.research_group, group); assert.equal(data.ai_status, 'complete');
      const completed=new Promise(resolve=>page.on('console',message=>{if(message.type()==='log'){try{const data=JSON.parse(message.text());if(Array.isArray(data)&&data[0]?.research_group===group)resolve(data[0]);}catch{}}}));
      await page.route(`${base}/exported-${group}.html`,route=>route.fulfill({contentType:'text/html',body:code})); await page.goto(`${base}/exported-${group}.html`);
      await drive(page,group); const exported=await completed; assert.equal(exported.ai_status,'complete'); assert.equal(exported.research_group,group);
    });
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
await mkdir('artifacts', { recursive: true });
const reportSuffix=filter?`-${filter.replace(/[^a-zA-Z0-9-]/g,'-')}`:'';
await writeFile(`artifacts/research-${livePreset ?? 'browser'}${reportSuffix}-report.json`, JSON.stringify({ version: PLUGIN_VERSION, checkedAt: new Date().toISOString(), microphone: 'synthetic Chrome device, physical device unverified', results }, null, 2));
console.log(`${results.filter(result=>result.status==='passed').length}/${results.length} research cases passed.`);
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
