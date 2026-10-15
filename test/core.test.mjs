import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createAIClient, createHTTPTransport, createProxyTransport, prepareRequest, AIError, ResearchSession, adviceMetrics, assignCondition, createReplayMaterials, pregenerateMaterials } from '../dist/core.js';
import { createProxyHandler } from '../server/proxy.mjs';

const request = { messages: [{ role: 'system', content: '研究任务' }, { role: 'user', content: '你好' }], temperature: 0, stream: false };
const schema = { type: 'object', required: ['score'], additionalProperties: false, properties: { score: { type: 'integer', minimum: 0, maximum: 10 } } };
const payloads = {
  'openai-chat': { model: 'actual', choices: [{ message: { content: '你好世界' }, finish_reason: 'stop' }], usage: { total_tokens: 5 } },
  'openai-responses': { model: 'actual', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好世界' }] }], usage: { total_tokens: 5 } },
  anthropic: { model: 'actual', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '你好世界' }], stop_reason: 'end_turn', usage: { output_tokens: 5 } },
  gemini: { modelVersion: 'actual', candidates: [{ content: { parts: [{ text: 'private', thought: true }, { text: '你好世界' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } }
};
const streams = {
  'openai-chat': [ { model: 'actual', choices: [{ delta: { content: '你好' } }] }, { choices: [{ delta: { content: '世界' }, finish_reason: 'stop' }] } ],
  'openai-responses': [ { type: 'response.output_text.delta', delta: '你好' }, { type: 'response.output_text.delta', delta: '世界' }, { type: 'response.completed', response: { model: 'actual', usage: { total_tokens: 5 } } } ],
  anthropic: [ { type: 'message_start', message: { model: 'actual' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '世界' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' } ],
  gemini: [ { modelVersion: 'actual', candidates: [{ content: { parts: [{ text: '你好' }] } }] }, { candidates: [{ content: { parts: [{ text: '世界' }] }, finishReason: 'STOP' }] } ]
};

function streamResponse(events, terminate = true) {
  const body = events.map(value => `event: message\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join('') + (terminate ? ': keepalive\r\n\r\n' : '');
  const encoded = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < encoded.length; index += 3) controller.enqueue(encoded.slice(index, index + 3));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

for (const protocol of Object.keys(payloads)) {
  const connection = { protocol, baseURL: 'https://example.test/v1', model: 'requested', apiKey: 'test-key' };
  test(`${protocol}: wire mapping preserves zero temperature and conversation roles`, () => {
    const prepared = prepareRequest(connection, request);
    assert.equal(prepared.body.generationConfig?.temperature ?? prepared.body.temperature, 0);
    assert.ok(prepared.url.startsWith(connection.baseURL));
    assert.equal(JSON.stringify(prepared.body).includes('test-key'), false);
    if (protocol === 'anthropic') { assert.equal(prepared.body.system, '研究任务'); assert.equal(prepared.body.messages[0].role, 'user'); }
    if (protocol === 'gemini') assert.equal(prepared.body.contents[0].parts[0].text, '你好');
  });
  test(`${protocol}: nonstreaming extracts actual model and visible text`, async () => {
    const client = createAIClient({ connection, fetch: async () => Response.json(payloads[protocol]) });
    const result = await client.complete(request);
    assert.equal(result.text, '你好世界'); assert.equal(result.model, 'actual'); assert.equal(result.requestedModel, 'requested'); assert.equal(result.attempts, 1);
    assert.ok(result.requestMs >= 0);
  });
  test(`${protocol}: streaming tolerates split UTF-8 and CRLF boundaries`, async () => {
    let text = '';
    const client = createAIClient({ connection, fetch: async () => streamResponse(streams[protocol]) });
    const result = await client.complete({ ...request, stream: true }, { onDelta: delta => { text += delta; } });
    assert.equal(text, '你好世界'); assert.equal(result.text, text); assert.equal(result.model, 'actual'); assert.ok(result.firstTokenMs >= 0);
  });
}

test('structured output is parsed and validated rather than trusted', async () => {
  const client = createAIClient({ transport: async () => ({ text: '{"score":4}', model: 'structured' }) });
  assert.deepEqual((await client.complete({ ...request, schema })).data, { score: 4 });
  const invalid = createAIClient({ transport: async () => ({ text: '{"score":40}', model: 'structured' }) });
  await assert.rejects(invalid.complete({ ...request, schema }), { code: 'invalid_output' });
});

test('stream interruption retains partial output and is never silently retried', async () => {
  let calls = 0;
  const client = createAIClient({ connection: { protocol: 'openai-chat', baseURL: 'https://example.test', model: 'model' }, retries: 3,
    fetch: async () => { calls++; return streamResponse([{ choices: [{ delta: { content: '部分内容' } }] }], false); } });
  await assert.rejects(client.complete({ ...request, stream: true }), error => error.code === 'interrupted_stream' && error.details.partialText === '部分内容');
  assert.equal(calls, 1);
});

test('token-limit completion is flagged as incomplete output', async () => {
  const client = createAIClient({ connection: { protocol: 'openai-chat', baseURL: 'https://example.test', model: 'model' },
    fetch: async () => Response.json({ choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }] }) });
  await assert.rejects(client.complete(request), error => error.code === 'incomplete_output' && error.details.partialText === 'truncated');
});

test('timeout stops transports which ignore AbortSignal', async () => {
  const client = createAIClient({ timeoutMs: 15, transport: () => new Promise(() => {}) });
  await assert.rejects(client.complete(request), { code: 'timeout' });
});

test('external cancellation stops transports which ignore AbortSignal', async () => {
  const controller = new AbortController();
  const client = createAIClient({ transport: () => new Promise(() => {}) });
  const pending = client.complete(request, { signal: controller.signal });
  controller.abort(new AIError('cancelled', 'cancel'));
  await assert.rejects(pending, { code: 'cancelled' });
});

test('late stream deltas after completion are ignored', async () => {
  let late;
  let text = '';
  const client = createAIClient({ transport: async (_, context) => { late = context.onDelta; context.onDelta('ok'); return { text: 'ok', model: 'custom' }; } });
  await client.complete(request, { onDelta: delta => { text += delta; } });
  late('late'); assert.equal(text, 'ok');
});

test('only transient pre-output HTTP errors are retried', async () => {
  let calls = 0;
  const client = createAIClient({ retries: 1, transport: async () => { if (++calls === 1) throw new AIError('http_error', 'busy', { status: 503 }); return { text: 'ok', model: 'fixed' }; } });
  assert.equal((await client.complete(request)).attempts, 2); assert.equal(calls, 2);
  const invalid = createAIClient({ retries: 3, transport: async () => { throw new AIError('http_error', 'bad request', { status: 400 }); } });
  await assert.rejects(invalid.complete(request), error => error.details.status === 400);
});

test('unsupported media and capabilities fail before sending', () => {
  assert.throws(() => prepareRequest({ protocol: 'anthropic', baseURL: 'https://test', model: 'm' }, { ...request, messages: [{ role: 'user', content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] }] }), { code: 'unsupported_audio' });
  assert.throws(() => prepareRequest({ protocol: 'openai-chat', baseURL: 'https://test', model: 'm', capabilities: { structured: false } }, { ...request, schema }), { code: 'unsupported_schema' });
});

test('session memory is isolated and snapshot restores random sequence', () => {
  const first = new ResearchSession({ id: 'first', seed: 42 });
  const second = new ResearchSession({ id: 'second', seed: 42 });
  first.append('study', [{ role: 'user', content: 'private' }]);
  assert.deepEqual(second.history('study'), []);
  const external = first.history('study'); external[0].content = 'changed'; assert.equal(first.history('study')[0].content, 'private');
  assert.deepEqual(first.shuffle([1, 2, 3, 4]), second.shuffle([1, 2, 3, 4]));
  const restored = ResearchSession.restore(first.snapshot());
  assert.deepEqual(first.shuffle([1, 2, 3, 4, 5]), restored.shuffle([1, 2, 3, 4, 5]));
  assert.equal(restored.history('study')[0].content, 'private');
});

test('advice adoption is undefined when advice equals initial estimate', () => {
  assert.equal(adviceMetrics(10, 12, 10).weight_of_advice, null);
  assert.equal(adviceMetrics(10, 15, 20, 18).weight_of_advice, 0.5);
  assert.equal(adviceMetrics(10, 15, 20, 18).final_error, 3);
  assert.equal(assignCondition(4, ['A', 'B', 'C']), 'B');
});

test('replay materials preserve actual response and participant provenance', () => {
  assert.deepEqual(createReplayMaterials([{ ai_calls: [{ status: 'complete', result: { text: '真实输出', model: 'actual' }, agent_id: 'first' }, { status: 'error' }] }], 'P001'), [{ text: '真实输出', model: 'actual', data: undefined, agentId: 'first', sourceParticipant: 'P001' }]);
});

test('pregeneration returns ordered reusable materials and actual model evidence', async () => {
  let count = 0;
  const client = createAIClient({ transport: async () => ({ text: String(++count), model: 'actual-model' }) });
  const result = await pregenerateMaterials(client, [request, request], { sourceParticipant: 'P0' });
  assert.deepEqual(result.materials.map(item => item.text), ['1', '2']);
  assert.ok(result.materials.every(item => item.sourceParticipant === 'P0' && item.model === 'actual-model'));
  assert.equal(result.completions.length, 2);
});

test('generic proxy preserves Chinese across incoming UTF-8 chunk boundaries', async () => {
  const handler = createProxyHandler({ protocol: 'openai-chat', baseURL: 'https://unused', model: 'fixed' }, { transport: async input => ({ text: input.messages[0].content, model: 'fixed' }) });
  const body = Buffer.from(JSON.stringify({ request: { messages: [{ role: 'user', content: '中文连续字节' }] } }));
  const response = { writableEnded: false, destroyed: false, on() {}, off() {}, writeHead() {}, end(value) { this.body = JSON.parse(value); this.writableEnded = true; } };
  const input = { async *[Symbol.asyncIterator]() { for (let index = 0; index < body.length; index++) yield body.subarray(index, index + 1); } };
  await handler(input, response);
  assert.equal(response.body.text, '中文连续字节');
});

for (const stream of [false, true]) test(`generic server proxy roundtrip (stream=${stream})`, async () => {
  const connection = { protocol: 'openai-chat', baseURL: 'https://unused.test', model: 'server-fixed', apiKey: 'server-only' };
  const handler = createProxyHandler(connection, { transport: async (input, context) => {
    assert.equal(input.model, 'server-fixed');
    if (input.stream) context.onDelta('代理内容');
    return { text: '代理内容', model: input.model };
  } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createAIClient({ transport: createProxyTransport(`http://127.0.0.1:${server.address().port}`) });
    let text = '';
    const result = await client.complete({ ...request, stream, model: 'browser-model' }, { onDelta: delta => { text += delta; } });
    assert.equal(result.text, '代理内容'); assert.equal(result.model, 'server-fixed');
    if (stream) assert.equal(text, result.text);
    assert.equal(JSON.stringify(result).includes('server-only'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
