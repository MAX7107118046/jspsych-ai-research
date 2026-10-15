import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAIClient, createConnection, PLUGIN_VERSION } from '../dist/core.js';

const results = [];
for (const [preset, apiKey] of [['deepseek', process.env.DEEPSEEK_API_KEY], ['minimax-cn-mplan', process.env.MINIMAX_API_KEY]]) {
  if (!apiKey) continue;
  const client = createAIClient({ connection: createConnection(preset, { apiKey }) });
  const messages = [{ role: 'user', content: '比较53.13和53.9，再计算抛7次公平硬币恰好3次正面的概率。仅给两个结果。' }];
  try {
    let exhausted;
    try { await client.complete({ messages, maxTokens: 1 }); }
    catch (error) { exhausted = error; }
    assert.equal(exhausted?.code, 'incomplete_output');
    const result = await client.complete({ messages, stream: true });
    assert.ok(result.text.trim().length > 0);
    assert.equal(result.metadata.connectionPolicy.maxTokens, 8192);
    results.push({ preset, status: 'passed', exhausted: { code: exhausted.code, message: exhausted.message, details: exhausted.details }, recovery: result });
    console.log(`PASS ${preset}: explicit budget exhaustion, default-budget visible output`);
  } catch (error) { results.push({ preset, status: 'failed', message: String(error.message).replaceAll(apiKey, '[redacted]') }); console.log(`FAIL ${preset}`); }
}
if (!results.length) throw new Error('请设置 DEEPSEEK_API_KEY 或 MINIMAX_API_KEY');
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/output-budget-report.json', JSON.stringify({ plugin: PLUGIN_VERSION, checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
