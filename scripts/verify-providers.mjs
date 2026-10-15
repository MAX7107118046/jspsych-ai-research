import { mkdir, writeFile } from 'node:fs/promises';
import { createAIClient, createConnection, PLUGIN_VERSION } from '../dist/core.js';

const targets = [];
if (process.env.DEEPSEEK_API_KEY) for (const mode of ['off', 'on']) targets.push({ name: `deepseek-${mode}`, preset: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY, thinking: { mode } });
if (process.env.MINIMAX_API_KEY) for (const preset of ['minimax-cn-mplan', 'minimax-cn-anthropic', 'minimax-cn-responses', 'minimax-global-mplan', 'minimax-global-anthropic', 'minimax-global-responses']) targets.push({ name: preset, preset, apiKey: process.env.MINIMAX_API_KEY });
if (!targets.length) throw new Error('请设置 DEEPSEEK_API_KEY 或 MINIMAX_API_KEY');
const schema = { type: 'object', additionalProperties: false, required: ['advice', 'explanation'], properties: { advice: { type: 'number', minimum: 0, maximum: 100 }, explanation: { type: 'string' } } };
const results = [];
for (const target of targets) {
  const statuses = [];
  const client = createAIClient({ connection: createConnection(target.preset, { apiKey: target.apiKey, ...(target.thinking ? { thinking: target.thinking } : {}) }) });
  for (const scenario of [{ name: 'nonstream', stream: false }, { name: 'stream', stream: true }, { name: 'structured', stream: true, schema }]) {
    let streamed = '';
    try {
      const result = await client.complete({ messages: [{ role: 'user', content: scenario.schema ? '返回 JSON，advice 为 65，explanation 为一句简短的中文建议。' : '为实验参与者写一句不超过20字的中文鼓励。' }], stream: scenario.stream, ...(scenario.schema ? { schema } : {}) }, { onDelta: delta => { streamed += delta; } });
      const matches = !scenario.stream || streamed === result.text && result.firstTokenMs !== null;
      statuses.push({ scenario: scenario.name, status: matches ? 'passed' : 'failed', requestedModel: result.requestedModel, actualModel: result.model, text: result.text, data: result.data, requestMs: Math.round(result.requestMs), firstTokenMs: result.firstTokenMs, usage: result.usage, metadata: result.metadata, streamedTextMatches: matches });
    } catch (error) {
      statuses.push({ scenario: scenario.name, status: 'failed', code: error.code, message: String(error.message).replaceAll(target.apiKey, '[redacted]'), details: error.details });
      if ([401, 402, 403].includes(Number(error.details?.status))) break;
    }
    console.log(`${target.name} ${scenario.name}: ${statuses.at(-1).status}`);
  }
  results.push({ name: target.name, checks: statuses });
}
await mkdir('artifacts', { recursive: true });
const report = { plugin: PLUGIN_VERSION, checkedAt: new Date().toISOString(), results };
await writeFile('artifacts/provider-acceptance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: results.flatMap(value => value.checks).filter(value => value.status === 'passed').length, total: results.flatMap(value => value.checks).length, report: 'artifacts/provider-acceptance.json' }));
if (results.some(value => value.checks.some(check => check.status === 'failed'))) process.exitCode = 1;
