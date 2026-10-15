import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDevelopmentServer } from '../server/dev.mjs';

const executableCandidates = [process.env.PLAYWRIGHT_BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let executablePath;
for (const candidate of executableCandidates) { try { await access(candidate); executablePath = candidate; break; } catch {} }
const server = createDevelopmentServer({ connection: { protocol: 'openai-chat', baseURL: 'https://unused.test', model: 'proxy-test' },
  clientOptions: { transport: async (_, context) => { context.onDelta('服务端代理测试回复'); return { text: '服务端代理测试回复', model: 'proxy-test' }; } } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results = [];
await mkdir('artifacts', { recursive: true });

async function run(name, action) {
  if (process.env.BROWSER_TEST_FILTER && !name.includes(process.env.BROWSER_TEST_FILTER)) return;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await action(page);
    assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack, pageErrors: errors });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: `artifacts/failure-${results.length}.png`, fullPage: true }).catch(() => {});
  } finally { await page.close(); }
}

async function idle(page) {
  await page.waitForFunction(() => document.querySelector('.ai-research')?.getAttribute('aria-busy') === 'false');
}

async function officialSurvey(page, answer) {
  const control = page.locator('#jspsych-survey-text-form input[type=text], #jspsych-survey-text-form textarea').first();
  await control.fill(answer);
  await page.locator('#jspsych-survey-text-next').click();
}

async function interact(page, mode, full) {
  await idle(page);
  if (['chat', 'interview', 'learning', 'multiagent'].includes(mode)) {
    await page.getByLabel('你的回答', { exact: true }).fill('我会先比较几个备选方案，再判断证据是否充分。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await idle(page);
  }
  if (mode === 'survey') {
    await page.locator('.ai-question-form textarea').first().fill('我使用逐项比较策略。');
    const number = page.locator('.ai-question-form input[type=number]');
    if (await number.count()) await number.first().fill('75');
    await page.getByRole('button', { name: '提交回答', exact: true }).click();
    if (full) await idle(page);
  }
  if (mode === 'advice') {
    await page.getByLabel('你的初始判断', { exact: true }).fill('50');
    await page.getByRole('button', { name: '获取建议', exact: true }).click();
    await page.getByLabel('你的最终判断', { exact: true }).fill('60');
    await page.getByRole('button', { name: '提交判断', exact: true }).click();
  }
  if (mode === 'generate') await page.locator('.ai-candidate input').first().check();
  if (mode === 'coedit') {
    await page.getByLabel('共同创作稿件').fill('参与者修改后的稿件。');
    await page.getByLabel('你的回答', { exact: true }).fill('加入可实施的维护建议');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await idle(page);
  }
  if (!['advice'].includes(mode) && !(mode === 'survey' && !full)) await page.getByRole('button', { name: '完成', exact: true }).click();
  if (mode === 'learning') {
    assert.equal(await page.getByRole('button', { name: '重新生成', exact: true }).count(), 0);
    await page.locator('.ai-question-form textarea').fill('无法确定因果关系，气温可能影响两者。');
    await page.getByRole('button', { name: '提交测验', exact: true }).click();
  }
}

async function scenario(page, name) {
  await page.goto(`${base}/examples/test.html`);
  await page.evaluate(name => {
    const api = JsPsychAI;
    const session = api.createResearchSession({ id: 'browser-participant', seed: 42 });
    const client = api.createAIClient({ transport: api.createMockTransport() });
    window.acceptanceData = null;
    const jsPsych = initJsPsych({ display_element: 'experiment', on_finish() {
      window.acceptanceData = jsPsych.data.get().values();
      window.acceptanceCSV = jsPsych.data.get().csv();
    } });
    window.acceptanceJsPsych = jsPsych;
    let timeline;
    if (name === 'regeneration') timeline = [api.createAITrial('chat', { client, max_turns: 1, min_turns: 1 })];
    if (name === 'timeout') timeline = [api.createAITrial('feedback', { client: api.createAIClient({ timeoutMs: 25, transport: () => new Promise(() => {}) }) })];
    if (name === 'cancel') timeline = [api.createAITrial('chat', { client: api.createAIClient({ transport: api.createMockTransport({ delayMs: 1000 }) }) })];
    if (name === 'retry') {
      let calls = 0;
      timeline = [api.createAITrial('chat', { error_policy: 'retry', max_retries: 1, client: api.createAIClient({ transport: async () => {
        if (++calls === 1) throw new api.AIError('http_error', 'synthetic 503', { status: 503 });
        return { text: 'retry-success', model: 'same-model' };
      } }) })];
    }
    if (name === 'trial-timeout-late') timeline = [api.createAITrial('feedback', { trial_duration: 30,
      client: api.createAIClient({ transport: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return { text: 'late-output', model: 'late' }; } }) }),
      api.createAITrial('feedback', { delivery: { mode: 'replay', materials: [{ text: 'next-trial', model: 'recorded' }] } })];
    if (name === 'replay') timeline = [api.createAITrial('chat', { delivery: { mode: 'yoked', sourceParticipant: 'P001', materials: [{ text: '配对的原始回复', model: 'recorded-v1', sourceParticipant: 'P001' }] } })];
    if (name === 'invalid-replay-schema') timeline = [api.createAITrial('feedback', { delivery: { mode: 'replay', materials: [{ text: '{"score":99}' }] }, response_schema: { type: 'object', properties: { score: { type: 'integer', maximum: 10 } }, required: ['score'] } })];
    if (name === 'media') timeline = [api.createAITrial('chat', { attachments: { image: true, audio: true }, client: api.createAIClient({ transport: async request => {
      window.mediaRequest = request;
      return { text: 'media-received', model: 'media-test' };
    } }) })];
    if (name === 'native') timeline = [
      { type: jsPsychHtmlKeyboardResponse, stimulus: '按键插件', choices: 'NO_KEYS', trial_duration: 15 },
      { type: jsPsychImageKeyboardResponse, stimulus: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>', choices: 'NO_KEYS', trial_duration: 15 },
      { timeline: [api.createAITrial('feedback', { client, session, memory_key: 'shared', prompt: () => jsPsych.timelineVariable('topic', true),
        on_finish: data => { data.native_callback = true; } })], timeline_variables: [{ topic: '主题一' }, { topic: '主题二' }], repetitions: 2 },
      { type: jsPsychSurveyText, questions: [{ name: 'post', prompt: '任务结束后的回答', required: true }] }
    ];
    if (name === 'cloudpsych') {
      window.callbackOrder = [];
      window.platformRequests = [];
      const runtime = { hasStartConsent: () => true, lastTurn: { model: 'platform-model', turn_id: 'T1' }, async request(input) { window.platformRequests.push(input); return { reply: '平台回复', score: 1 }; } };
      timeline = [api.createCloudPsychTrial({ runtime, interaction: { id: 'interview-1', role: 'role_player', promptVersion: '1', contextAllowlist: ['group'], outputSchema: { type: 'object', properties: { reply: { type: 'string' }, score: { type: 'integer' } }, required: ['reply', 'score'] } },
        context: () => ({ group: 'A', omitted: 'private' }), on_finish: data => { window.callbackOrder.push('user'); data.user_callback = true; },
        platform_on_finish: data => { window.callbackOrder.push('platform'); window.platformData = data; } }, { mode: 'chat' })];
    }
    if (name === 'persistence') timeline = [api.createAITrial('feedback', { client, persist: async data => { window.persistedData = JSON.parse(JSON.stringify(data)); } })];
    if (name === 'speed') timeline = [api.createAITrial('feedback', { client: api.createAIClient({ transport: async () => ({ text: 'ABCDEFGHIJ', model: 'fixed' }) }), presentation: { characters_per_second: 5, allow_pause: true } })];
    jsPsych.run(timeline);
  }, name);
}

try {
  for (const simulationMode of ['data-only', 'visual']) for (const mode of ['chat', 'interview', 'survey', 'feedback', 'advice', 'generate', 'coedit', 'learning', 'multiagent']) {
    await run(`simulation ${simulationMode}: ${mode}`, async page => {
      await page.goto(`${base}/examples/test.html`);
      await page.evaluate(({ mode, simulationMode }) => {
        window.realCalls = 0;
        const client = JsPsychAI.createAIClient({ transport: async () => { window.realCalls++; throw new Error('Simulation called live model'); } });
        const psych = initJsPsych({ display_element: 'experiment', on_finish: () => { window.simulatedRows = psych.data.get().values(); } });
        psych.simulate([JsPsychAI.createAITrial(mode, { client })], simulationMode);
      }, { mode, simulationMode });
      await page.waitForFunction(() => window.simulatedRows);
      const rows = await page.evaluate(() => window.simulatedRows);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ai_status, 'complete');
      assert.equal(rows[0].research_mode, mode);
      assert.equal(rows[0].ai_simulated, true);
      assert.equal(await page.evaluate(() => window.realCalls), 0);
    });
  }
  for (const mode of ['chat', 'interview', 'survey', 'feedback', 'advice', 'generate', 'coedit', 'learning', 'multiagent']) {
    for (const full of [false, true]) await run(`${mode}: ${full ? 'research' : 'minimal'} example`, async page => {
      await page.goto(`${base}/examples/${mode}-${full ? 'research' : 'minimal'}.html`);
      if (full) await officialSurvey(page, 'P001');
      await interact(page, mode, full);
      if (full) await officialSurvey(page, '过程清楚');
      await page.waitForFunction(() => window.exampleData);
      const rows = await page.evaluate(() => window.exampleData);
      const data = rows.find(row => row.research_mode === mode);
      assert.equal(data.ai_status, 'complete'); assert.ok(data.rt > 0 && data.rt < 60000);
      assert.equal(data.ai_plugin_version, '0.3.0'); assert.equal(data.jspsych_runtime_version, '7.3.4');
      assert.ok(data.ai_calls.every(call => call.status === 'complete'));
      if (mode === 'advice') assert.ok(Math.abs(data.weight_of_advice - 2 / 3) < 1e-10);
      if (mode === 'coedit') assert.ok(data.revisions.some(revision => revision.author === 'participant'));
      if (mode === 'learning') assert.equal(typeof data.transfer_response.transfer, 'string');
    });
  }
  await run('regeneration makes a fresh request and replaces conversation response', async page => {
    await scenario(page, 'regeneration'); await idle(page);
    await page.getByLabel('你的回答', { exact: true }).fill('first input');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    const first = await page.locator('.ai-message-assistant').innerText();
    await page.getByRole('button', { name: '重新生成', exact: true }).click(); await idle(page);
    assert.notEqual(await page.locator('.ai-message-assistant').innerText(), first);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const data = await page.evaluate(() => window.acceptanceData[0]);
    assert.equal(data.ai_calls.length, 2); assert.equal(data.messages.filter(message => message.role === 'assistant').length, 1); assert.equal(data.participant_turns, 1);
  });
  await run('request timeout keeps error evidence and finishes once', async page => {
    await scenario(page, 'timeout'); await idle(page);
    await page.getByRole('button', { name: '结束试次', exact: true }).click();
    const data = await page.evaluate(() => window.acceptanceData);
    assert.equal(data.length, 1); assert.equal(data[0].ai_status, 'error'); assert.equal(data[0].ai_calls[0].error.code, 'timeout');
  });
  await run('duplicate clicks and cancellation do not duplicate trial completion', async page => {
    await scenario(page, 'cancel'); await idle(page);
    await page.getByLabel('你的回答', { exact: true }).fill('cancel this');
    await page.evaluate(() => { const send = [...document.querySelectorAll('button')].find(button => button.textContent === '发送'); send.click(); send.click(); });
    await page.getByRole('button', { name: '取消请求', exact: true }).click(); await idle(page);
    await page.evaluate(() => { const finish = [...document.querySelectorAll('button')].find(button => button.textContent === '结束试次'); finish.click(); finish.click(); });
    const data = await page.evaluate(() => window.acceptanceData);
    assert.equal(data.length, 1); assert.equal(data[0].ai_calls.length, 1); assert.equal(data[0].ai_status, 'cancelled');
  });
  await run('explicit retry retains one participant turn and fixed model', async page => {
    await scenario(page, 'retry'); await idle(page);
    await page.getByLabel('你的回答', { exact: true }).fill('original input');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '重试', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const data = await page.evaluate(() => window.acceptanceData[0]);
    assert.equal(data.ai_status, 'complete'); assert.equal(data.participant_turns, 1); assert.equal(data.ai_calls.length, 2);
    assert.equal(data.messages.filter(message => message.role === 'user').length, 1); assert.equal(data.ai_calls[1].request.messages.at(-1).content, 'original input');
  });
  await run('trial timeout ignores late response during next trial', async page => {
    await scenario(page, 'trial-timeout-late'); await idle(page);
    await page.waitForFunction(() => document.querySelector('.ai-message-assistant')?.textContent.includes('next-trial'));
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal((await page.locator('.ai-transcript').innerText()).includes('late-output'), false);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const rows = await page.evaluate(() => window.acceptanceData);
    assert.equal(rows.length, 2); assert.equal(rows[0].ai_status, 'timeout'); assert.equal(rows[0].ai_calls[0].status, 'cancelled');
  });
  await run('empty input keeps the trial editable and makes no model call', async page => {
    await scenario(page, 'regeneration'); await idle(page);
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    assert.equal(await page.getByLabel('你的回答', { exact: true }).isEnabled(), true);
    await page.getByLabel('你的回答', { exact: true }).fill('corrected input');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    assert.equal(await page.evaluate(() => window.acceptanceData[0].ai_calls.length), 1);
    assert.equal(await page.evaluate(() => window.acceptanceData[0].ai_status), 'complete');
  });
  await run('direct plugin class works with ordinary handwritten timeline', async page => {
    await page.goto(`${base}/examples/test.html`);
    await page.evaluate(() => {
      const client = JsPsychAI.createAIClient({ transport: JsPsychAI.createMockTransport() });
      const jsPsych = initJsPsych({ display_element: 'experiment', on_finish() { window.directRows = jsPsych.data.get().values(); } });
      jsPsych.run([{ type: JsPsychAI.AIChatPlugin, client, prompt: () => 'dynamic handwritten prompt', generation: { temperature: 0 } }]);
    });
    await idle(page); await page.getByLabel('你的回答', { exact: true }).fill('direct trial');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const row = await page.evaluate(() => window.directRows[0]); assert.equal(row.ai_status, 'complete'); assert.equal(row.ai_calls[0].request.temperature, 0);
  });
  await run('yoked replay runs without model client and records provenance', async page => {
    await scenario(page, 'replay'); await idle(page);
    await page.getByLabel('你的回答', { exact: true }).fill('new participant input');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const data = await page.evaluate(() => window.acceptanceData[0]);
    assert.equal(data.ai_output, '配对的原始回复'); assert.equal(data.source_participant, 'P001'); assert.equal(data.ai_calls[0].result.attempts, 0);
  });
  await run('replayed structured outputs follow the same schema validation', async page => {
    await scenario(page, 'invalid-replay-schema'); await idle(page);
    await page.getByRole('button', { name: '结束试次', exact: true }).click();
    assert.equal(await page.evaluate(() => window.acceptanceData[0].ai_calls[0].error.code), 'invalid_output');
  });
  await run('image and audio file inputs reach injectable transport', async page => {
    await scenario(page, 'media'); await idle(page);
    await page.locator('input[accept="image/*"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=', 'base64') });
    await idle(page);
    await page.locator('input[accept="audio/*"]').setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFFtestWAVE') });
    await idle(page);
    await page.getByLabel('你的回答', { exact: true }).fill('请描述材料');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    const parts = await page.evaluate(() => window.mediaRequest.messages.at(-1).content);
    assert.deepEqual(parts.map(part => part.type), ['text', 'image', 'audio']);
    await page.getByRole('button', { name: '完成', exact: true }).click();
  });
  await run('native jsPsych plugins, loops, dynamic parameters, callbacks and memory', async page => {
    await scenario(page, 'native');
    for (let index = 0; index < 4; index++) { await idle(page); await page.getByRole('button', { name: '完成', exact: true }).click(); }
    await officialSurvey(page, 'native response');
    const rows = await page.evaluate(() => window.acceptanceData);
    assert.equal(rows.length, 7);
    const aiRows = rows.filter(row => row.research_mode);
    assert.equal(aiRows.length, 4); assert.ok(aiRows.every(row => row.native_callback));
    assert.deepEqual(aiRows.map(row => row.ai_calls[0].request.messages[0].content), ['主题一', '主题二', '主题一', '主题二']);
    assert.ok(aiRows[3].messages.length > aiRows[0].messages.length);
    assert.ok((await page.evaluate(() => window.acceptanceCSV)).includes('ai_calls'));
  });
  await run('CloudPsych adapter maps contracts and composes callbacks', async page => {
    await scenario(page, 'cloudpsych'); await idle(page);
    await page.getByLabel('你的回答', { exact: true }).fill('platform input');
    await page.getByRole('button', { name: '发送', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const value = await page.evaluate(() => ({ data: window.acceptanceData[0], order: window.callbackOrder, request: window.platformRequests[0] }));
    assert.deepEqual(value.order, ['user', 'platform']); assert.deepEqual(value.request.context, { group: 'A' });
    assert.equal(value.data.ai_calls[0].result.model, 'platform-model'); assert.equal(value.data.ai_package_lock.version, '0.3.0'); assert.equal(value.data.user_callback, true);
  });
  await run('optional persistence callback receives complete trial data', async page => {
    await scenario(page, 'persistence'); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.waitForFunction(() => window.acceptanceData);
    assert.equal(await page.evaluate(() => window.acceptanceData[0].persistence_status), 'complete');
    assert.equal(await page.evaluate(() => window.persistedData.ai_calls[0].status), 'complete');
  });
  await run('presentation pause and speed change affect actual rendering', async page => {
    await scenario(page, 'speed');
    await page.waitForFunction(() => document.querySelector('.ai-message-text')?.textContent.length >= 1);
    await page.getByRole('button', { name: '暂停呈现', exact: true }).click();
    const paused = await page.locator('.ai-message-text').innerText();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await page.locator('.ai-message-text').innerText(), paused);
    await page.getByLabel('每秒呈现字符数').fill('200');
    await page.getByRole('button', { name: '继续呈现', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const events = await page.evaluate(() => window.acceptanceData[0].events);
    assert.ok(events.some(event => event.type === 'presentation_speed')); assert.equal(events.filter(event => event.type === 'presentation_pause').length, 2);
  });
  await run('builder saves, reopens, exports and previews the shared configuration', async page => {
    await page.goto(`${base}/examples/builder.html`);
    await page.locator('#mode').selectOption('feedback'); await page.locator('#prompt').fill('builder task'); await page.locator('#temperature').fill('0'); await page.locator('#apiKey').fill('must-not-export');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.locator('#prompt').fill('changed'); await page.getByRole('button', { name: '读取配置', exact: true }).click();
    assert.equal(await page.locator('#prompt').inputValue(), 'builder task'); assert.equal(await page.locator('#temperature').inputValue(), '0');
    const serialized = await page.evaluate(() => localStorage.getItem('jspsych-ai-configuration'));
    assert.equal(serialized.includes('must-not-export'), false);
    await page.getByRole('button', { name: '运行预览', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.waitForFunction(() => window.builderData);
    assert.equal(await page.evaluate(() => window.builderData[0].ai_status), 'complete');
    await page.screenshot({ path: 'artifacts/builder-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'artifacts/builder-mobile.png', fullPage: true });
  });
  await run('builder preserves regional route, thinking and explicit budgets on save and reopen', async page => {
    await page.goto(`${base}/examples/builder.html`);
    await page.locator('#preset').selectOption('minimax-cn-anthropic');
    assert.equal(await page.locator('#model').inputValue(), 'MiniMax-M3.1-Flash-Preview');
    assert.match(await page.locator('#effective-policy').innerText(), /8192/);
    await page.locator('#thinking-mode').selectOption('off');
    assert.match(await page.locator('#effective-policy').innerText(), /要求开启思考/);
    await page.locator('#thinking-mode').selectOption('on');
    await page.locator('#thinking-effort').selectOption('high');
    await page.locator('#max-tokens').fill('16384'); await page.locator('#timeout-ms').fill('90000');
    await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.reload();
    await page.getByRole('button', { name: '读取配置', exact: true }).click();
    assert.equal(await page.locator('#baseURL').inputValue(), 'https://api.minimax.cn/anthropic/v1');
    assert.equal(await page.locator('#thinking-effort').inputValue(), 'high');
    assert.equal(await page.locator('#max-tokens').inputValue(), '16384');
    assert.equal(await page.locator('#timeout-ms').inputValue(), '90000');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jspsych-ai-configuration')));
    assert.equal(saved.parameters.connection.account, 'm-plan');
    await page.locator('#preset').selectOption('deepseek'); await page.locator('#thinking-mode').selectOption('off');
    assert.match(await page.locator('#effective-policy').innerText(), /json-object/);
    assert.match(await page.locator('#effective-policy').innerText(), /"mode": "off"/);
  });
  await run('exported HTML runs with standard jsPsych and generic proxy', async page => {
    await page.goto(`${base}/`);
    const html = await page.evaluate(() => JsPsychAI.exportExperimentCode(JsPsychAI.createConfiguration('feedback', { prompt: 'exported trial' })));
    await page.setContent(html, { waitUntil: 'load' }); await idle(page);
    assert.ok((await page.locator('.ai-message-assistant').innerText()).includes('服务端代理测试回复'));
    await page.getByRole('button', { name: '完成', exact: true }).click();
  });
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  const reportName = process.env.BROWSER_TEST_FILTER ? `browser-report-${process.env.BROWSER_TEST_FILTER.replace(/[^a-zA-Z0-9-]/g, '-')}.json` : 'browser-report.json';
  await writeFile(`artifacts/${reportName}`, JSON.stringify({ runtime: 'jsPsych 7.3.4', results }, null, 2));
}
const failed = results.filter(result => result.status === 'failed');
console.log(`${results.length - failed.length}/${results.length} browser cases passed.`);
if (failed.length) process.exitCode = 1;
