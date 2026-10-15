import { mkdir, writeFile } from 'node:fs/promises';
import { createAIClient } from '../dist/core.js';
import { connectionFromEnvironment } from '../server/connection.mjs';

const connection = connectionFromEnvironment();
if (!connection?.apiKey) throw new Error('请设置 AI_PRESET（或 AI_BASE_URL、AI_MODEL）与 AI_API_KEY');
const client = createAIClient({ connection });
const checks = [];
for (const stream of [false, true]) {
  try {
    let streamed = '';
    const result = await client.complete({ messages: [{ role: 'user', content: '只输出 OK。' }], stream }, { onDelta: delta => { streamed += delta; } });
    checks.push({ stream, status: 'passed', requestedModel: result.requestedModel, returnedModel: result.model, requestMs: result.requestMs, firstTokenMs: result.firstTokenMs,
      text: result.text, streamedTextMatches: !stream || result.firstTokenMs !== null && streamed === result.text, attempts: result.attempts, usage: result.usage, metadata: result.metadata });
  } catch (error) {
    checks.push({ stream, status: 'failed', code: error.code, message: String(error.message).replaceAll(connection.apiKey, '[redacted]') });
  }
}
await mkdir('artifacts', { recursive: true });
const report = { protocol: connection.protocol, endpoint: new URL(connection.baseURL).origin, requestedModel: connection.model, checkedAt: new Date().toISOString(), checks };
await writeFile(`artifacts/live-${connection.protocol}-${new URL(connection.baseURL).hostname}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (checks.some(check => check.status !== 'passed' || !check.streamedTextMatches)) process.exitCode = 1;
