import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createConnection, PLUGIN_VERSION } from '../dist/core.js';
import { createDevelopmentServer } from '../server/dev.mjs';

const targets = [
  { preset: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY },
  { preset: 'minimax-cn-mplan', apiKey: process.env.MINIMAX_API_KEY }
].filter(target => target.apiKey);
if (!targets.length) throw new Error('请设置 DEEPSEEK_API_KEY 或 MINIMAX_API_KEY');
let executablePath;
for (const candidate of [process.env.PLAYWRIGHT_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean)) {
  try { await access(candidate); executablePath = candidate; break; } catch {}
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results = [];
try {
  for (const target of targets) {
    const server = createDevelopmentServer({ connection: createConnection(target.preset, { apiKey: target.apiKey }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage(); page.setDefaultTimeout(125000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/examples/test.html`);
      await page.evaluate(() => {
        const client = JsPsychAI.createAIClient({ transport: JsPsychAI.createProxyTransport(), timeoutMs: 120000 });
        const jsPsych = initJsPsych({ on_finish: () => { window.liveData = jsPsych.data.get().values(); } });
        jsPsych.run([
          JsPsychAI.createAITrial('feedback', { client, prompt: '请用一句简短中文鼓励实验参与者。', stream: true }),
          JsPsychAI.createAITrial('advice', { client, prompt: '请建议数值65，并提供一句简短中文解释。', stream: true })
        ]);
      });
      await page.waitForFunction(() => document.querySelector('.ai-research')?.getAttribute('aria-busy') === 'false');
      assert.ok((await page.locator('.ai-message-assistant').innerText()).trim().length > 0);
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByLabel('你的初始判断', { exact: true }).fill('50');
      await page.getByRole('button', { name: '获取建议', exact: true }).click();
      await page.getByLabel('你的最终判断', { exact: true }).fill('60');
      await page.getByRole('button', { name: '提交判断', exact: true }).click();
      await page.waitForFunction(() => window.liveData);
      const records = await page.evaluate(() => window.liveData);
      assert.equal(records.length, 2); assert.deepEqual(errors, []);
      for (const record of records) {
        assert.equal(record.ai_status, 'complete'); assert.equal(record.ai_plugin_version, PLUGIN_VERSION);
        assert.equal(record.ai_calls[0].result.model, target.preset === 'deepseek' ? 'deepseek-flash' : 'MiniMax-M3.1-Flash-Preview');
        assert.equal(record.ai_calls[0].result.metadata.connectionPolicy.thinking.effort, 'low');
      }
      assert.equal(records[1].advice, 65); assert.ok(Number.isFinite(records[1].weight_of_advice));
      results.push({ preset: target.preset, status: 'passed', trials: records });
      console.log(`PASS ${target.preset}: feedback, structured advice, jsPsych data`);
    } catch (error) {
      results.push({ preset: target.preset, status: 'failed', message: String(error.message).replaceAll(target.apiKey, '[redacted]'), errors });
      console.log(`FAIL ${target.preset}: ${results.at(-1).message}`);
    } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); }
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/live-browser-report.json', JSON.stringify({ plugin: PLUGIN_VERSION, checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
