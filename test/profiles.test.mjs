import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIClient, createConnection, prepareRequest, resolveConnectionPolicy, connectionEvidence, normalizeResult } from '../dist/core.js';
import { connectionFromEnvironment } from '../server/connection.mjs';
import { createCloudPsychCodeModule, PACKAGE_LOCK } from '../integrations/cloudpsych.mjs';

const request = { messages: [{ role: 'user', content: '研究任务' }] };
const schema = { type: 'object', additionalProperties: false, required: ['score'], properties: { score: { type: 'integer' } } };

test('presets distinguish account and region without rewriting model IDs or moving endpoints', () => {
  const domestic = createConnection('minimax-cn-mplan');
  const international = createConnection('minimax-global-mplan');
  assert.equal(domestic.baseURL, 'https://api.minimax.cn/v1');
  assert.equal(international.baseURL, 'https://api.minimax.io/v1');
  assert.equal(resolveConnectionPolicy(domestic).account, 'm-plan');
  assert.equal(resolveConnectionPolicy(international).region, 'global');
  assert.throws(() => prepareRequest(createConnection('minimax-cn-payg', { model: domestic.model }), request), { code: 'account_mismatch' });
  assert.equal(prepareRequest(createConnection('deepseek', { model: 'my-model-alias' }), request).body.model, 'my-model-alias');
});

for (const [preset, field] of [['minimax-cn-mplan', 'reasoning_effort'], ['minimax-cn-anthropic', 'output_config'], ['minimax-cn-responses', 'reasoning']]) {
  test(`${preset} maps adaptive thinking and sufficient generation budget`, () => {
    const prepared = prepareRequest(createConnection(preset), request);
    assert.equal(prepared.policy.thinking.effort, 'low');
    assert.equal(prepared.body.max_completion_tokens ?? prepared.body.max_tokens ?? prepared.body.max_output_tokens, 8192);
    assert.equal(field === 'reasoning_effort' ? prepared.body[field] : prepared.body[field].effort, 'low');
    if (preset.endsWith('mplan')) assert.equal('max_tokens' in prepared.body, false);
  });
  test(`${preset} prevents disabling required thinking including raw native parameters`, () => {
    const connection = createConnection(preset);
    assert.throws(() => prepareRequest({ ...connection, thinking: { mode: 'off' } }, request), { code: 'thinking_required' });
    const extra = field === 'reasoning_effort' ? { reasoning_effort: 'none' } : { [field]: { effort: 'none' } };
    assert.throws(() => prepareRequest(connection, { ...request, extra }), { code: 'thinking_required' });
    assert.throws(() => prepareRequest(connection, { ...request, extra: { thinking: { type: 'disabled' } } }), { code: 'thinking_required' });
  });
}

test('DeepSeek supports explicit off, low/high/max and JSON Object with schema instructions', () => {
  const connection = createConnection('deepseek');
  const thinking = prepareRequest(connection, { ...request, temperature: 0, schema });
  assert.equal(thinking.body.thinking.type, 'enabled'); assert.equal(thinking.body.reasoning_effort, 'low');
  assert.equal('temperature' in thinking.body, false); assert.equal(thinking.body.response_format.type, 'json_object');
  assert.match(thinking.body.messages[0].content, /JSON Schema/);
  const direct = prepareRequest(connection, { ...request, temperature: 0, thinking: { mode: 'off' } });
  assert.equal(direct.body.temperature, 0); assert.equal(direct.body.thinking.type, 'disabled');
  assert.throws(() => prepareRequest(connection, { ...request, thinking: { effort: 'medium' } }), { code: 'configuration' });
});

test('MiniMax schema instructions preserve effort and still validate actual output locally', async () => {
  const connection = createConnection('minimax-cn-anthropic', { thinking: { effort: 'high' } });
  const prepared = prepareRequest(connection, { ...request, schema });
  assert.equal(prepared.body.output_config.effort, 'high'); assert.equal(prepared.body.output_config.format, undefined);
  assert.match(prepared.body.system, /JSON Schema/);
  const client = createAIClient({ connection, fetch: async () => Response.json({ content: [{ type: 'text', text: '{"score":"wrong"}' }], stop_reason: 'end_turn' }) });
  await assert.rejects(client.complete({ ...request, schema }), { code: 'invalid_output' });
  const native = prepareRequest({ ...connection, schemaMode: 'native', extra: { output_config: { effort: 'max' } } }, { ...request, schema });
  assert.equal(native.body.output_config.effort, 'high'); assert.equal(native.body.output_config.format.type, 'json_schema');
});

test('known nested native configuration merges without discarding effort', () => {
  const prepared = prepareRequest(createConnection('minimax-cn-responses', { extra: { reasoning: { effort: 'high' }, text: { verbosity: 'low' } }, schemaMode: 'native' }), { ...request, schema, extra: { reasoning: { summary: 'auto' } } });
  assert.equal(prepared.body.reasoning.effort, 'high'); assert.equal(prepared.body.reasoning.summary, 'auto');
  assert.equal(prepared.body.text.verbosity, 'low'); assert.equal(prepared.body.text.format.type, 'json_schema');
});

test('explicit budgets are honored with warnings; model defaults never use a 32-token probe', async () => {
  const connection = createConnection('minimax-cn-mplan');
  const small = prepareRequest(connection, { ...request, maxTokens: 32 });
  assert.equal(small.body.max_completion_tokens, 32); assert.ok(small.policy.warnings.length);
  let sent;
  const client = createAIClient({ connection, fetch: async (_, options) => { sent = JSON.parse(options.body); return Response.json({ model: connection.model, choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }); } });
  const result = await client.probe();
  assert.equal(sent.max_completion_tokens, 8192); assert.equal(result.metadata.connectionPolicy.thinking.effort, 'low');
  assert.equal(result.metadata.connectionPolicy.requestEndpoint, 'https://api.minimax.cn/v1/chat/completions');
});

test('exact model profiles differ in forced thinking and media support', () => {
  const legacy = createConnection('minimax-cn-mplan', { model: 'MiniMax-M2.7' });
  assert.throws(() => prepareRequest(legacy, { ...request, thinking: { mode: 'off' } }), { code: 'thinking_required' });
  assert.throws(() => prepareRequest(legacy, { messages: [{ role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,AA' }] }] }), { code: 'unsupported_image' });
  const m3 = prepareRequest(createConnection('minimax-cn-mplan', { model: 'MiniMax-M3', thinking: { mode: 'off' } }), request);
  assert.equal(m3.body.thinking.type, 'disabled');
  assert.throws(() => prepareRequest(createConnection('deepseek'), { messages: [{ role: 'user', content: [{ type: 'audio', data: 'AA', mimeType: 'audio/wav' }] }] }), { code: 'unsupported_audio' });
});

test('custom proxy explicitly selects vendor profile; unknown models preserve native extras', () => {
  const custom = createConnection('minimax-cn-mplan', { baseURL: 'https://my-proxy.test/v1' });
  assert.equal(resolveConnectionPolicy(custom).profile, custom.model);
  const unknown = { protocol: 'openai-chat', baseURL: 'https://other.test/v1', model: 'new-model', extra: { reasoning_effort: 'medium' } };
  assert.equal(prepareRequest(unknown, request).body.reasoning_effort, 'medium');
  assert.equal(resolveConnectionPolicy(unknown).profile, 'generic');
  assert.throws(() => prepareRequest(unknown, { ...request, thinking: { mode: 'on' } }), { code: 'configuration' });
});

test('connection evidence excludes credentials, native extras and query parameters', () => {
  const evidence = connectionEvidence(resolveConnectionPolicy(createConnection('deepseek', { apiKey: 'private-key', headers: { secret: 'private-header' }, extra: { secret: 'private-extra' }, baseURL: 'https://api.deepseek.com/v1?key=private-query' })));
  assert.equal(JSON.stringify(evidence).includes('private-'), false);
});

test('HTTP 200 provider errors and reasoning-only truncation remain visible errors', () => {
  assert.throws(() => normalizeResult('openai-chat', { base_resp: { status_code: 1008, status_msg: 'balance' } }, 'm'), error => error.code === 'provider_error' && error.details.providerCode === 1008);
  assert.throws(() => normalizeResult('openai-chat', { choices: [{ message: { content: '', reasoning_content: 'private' }, finish_reason: 'length' }], usage: { completion_tokens: 32 } }, 'm'), error => error.code === 'incomplete_output' && error.message.includes('思考') && error.details.usage.completion_tokens === 32);
  assert.throws(() => normalizeResult('openai-responses', { status: 'incomplete', output_text: 'partial', incomplete_details: { reason: 'max_output_tokens' } }, 'm'), error => error.details.partialText === 'partial');
});

test('reasoning deltas stay outside visible text and carry timing and token usage', async () => {
  const events = [{ choices: [{ delta: { reasoning_content: 'private reasoning' } }] }, { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { completion_tokens: 30 } }];
  const client = createAIClient({ connection: createConnection('minimax-cn-mplan'), fetch: async () => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }) });
  let visible = '';
  const result = await client.complete({ ...request, stream: true }, { onDelta: delta => { visible += delta; } });
  assert.equal(visible, 'OK'); assert.equal(result.text, 'OK'); assert.ok(result.metadata.firstReasoningMs >= 0);
  assert.equal(result.metadata.reasoningCharacters, 17); assert.equal(result.usage.completion_tokens, 30);
  assert.equal(JSON.stringify(result).includes('private reasoning'), false);
});

test('environment presets use the same profile and optional overrides as handwritten code', () => {
  const connection = connectionFromEnvironment({ AI_PRESET: 'minimax-cn-responses', AI_API_KEY: 'test', AI_EFFORT: 'high' });
  const policy = resolveConnectionPolicy(connection);
  assert.equal(policy.maxTokens, 32768); assert.equal(policy.timeoutMs, 180000);
  assert.equal(connection.timeoutMs, undefined);
  assert.equal(connectionFromEnvironment({}), null);
});

test('frozen module uses the current version and remains within the editor source limit', async () => {
  const artifact = await createCloudPsychCodeModule();
  assert.equal(PACKAGE_LOCK.version, '0.3.0'); assert.equal(artifact.module.version, '0.3.0');
  assert.ok(artifact.module.source.length <= 100000);
});

test('regional authentication errors include route guidance without changing endpoints', async () => {
  const connection = createConnection('minimax-global-mplan');
  const client = createAIClient({ connection, fetch: async () => Response.json({ error: { message: 'invalid api key', code: 2049 } }, { status: 401 }) });
  await assert.rejects(client.probe(), error => error.details.status === 401 && error.message.includes('国际') && error.details.connectionPolicy.region === 'global');
});

test('budget and validation errors preserve the final endpoint and actual client timeout', async () => {
  const client = createAIClient({ connection: createConnection('minimax-cn-mplan'), timeoutMs: 90000, fetch: async () => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) });
  await assert.rejects(client.complete(request), error => error.code === 'incomplete_output' && error.details.connectionPolicy.requestEndpoint === 'https://api.minimax.cn/v1/chat/completions' && error.details.connectionPolicy.timeoutMs === 90000);
});
