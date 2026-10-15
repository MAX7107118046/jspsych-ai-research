import test from 'node:test';
import assert from 'node:assert/strict';
import { textEdit, scoreAnswers, validateResearch, RESEARCH_DEFINITIONS, researchDefaults } from '../dist/research.js';
import { encodeWave, resampleAudio, createSpeechClient, createMockSpeechTransport, createSpeechProxyTransport, PCMPlayer } from '../dist/speech.js';
import { createDevelopmentServer } from '../server/dev.mjs';
import { createMiniMaxSpeechTransport, speechConnectionFromEnvironment } from '../server/speech.mjs';
import { WebSocket } from 'ws';

test('research text changes preserve unblurred edits and Unicode offsets', () => {
  const previous = '书📚故事'; const current = '书📚新故事'; const edit = textEdit(previous, current);
  assert.equal(previous.slice(0, edit.start) + edit.inserted + previous.slice(edit.start + edit.removed.length), current);
  assert.equal(textEdit(current, current), null);
});
test('research scoring keeps open answers unscored and accepts alternate keys', () => {
  const score = scoreAnswers({ first: ' YES ', second: 3, open: '任意回答' }, { first: ['yes','是'], second: '3' });
  assert.equal(score.scored, 2); assert.equal(score.correct, 2); assert.equal(score.items[2].correct, null);
});
test('research catalog supplies valid minimal and full configurations for six groups', () => {
  for (const definition of RESEARCH_DEFINITIONS) for (const full of [false,true]) {
    const defaults = researchDefaults(definition.group, full); validateResearch(definition.modes[0], defaults.research); assert.ok(definition.fields.length);
  }
  assert.throws(() => validateResearch('chat', { group: 'judgment' }));
  assert.throws(() => validateResearch('advice', { group: 'judgment', response_type: 'choice' }));
});
test('speech waveform conversion produces complete 16 kHz mono WAV', async () => {
  const samples = new Float32Array(48000).fill(0.25); const downsampled = resampleAudio(samples, 48000);
  assert.equal(downsampled.length, 16000); const blob = encodeWave(downsampled); const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.toString('ascii',0,4), 'RIFF'); assert.equal(bytes.readUInt32LE(24),16000); assert.equal(bytes.readUInt32LE(40),32000); assert.equal(blob.type,'audio/wav');
});
test('speech mock client binds callable methods and cancels synthesis', async () => {
  const client = createSpeechClient({ transport: createMockSpeechTransport({ transcript: '测试' }) }); const { transcribe } = client;
  assert.equal((await transcribe(encodeWave(new Float32Array(1600)), {})).text,'测试');
  let bytes = 0; const output = client.synthesize({ turn_id: 'one', onAudio: chunk => { bytes += chunk.length; } }); output.write('测试。'); await output.flush(); assert.ok(bytes > 0);
  const cancelled = client.synthesize({ turn_id: 'two', onAudio() {} }); cancelled.cancel(); await assert.rejects(cancelled.flush(), { code: 'cancelled' });
});
test('speech playback waits for synthesis flush across empty queue gaps', () => {
  const sources=[]; const events=[];
  const context={ currentTime:0,state:'running',destination:{},removeEventListener(){}, createBuffer(channels,count,rate) { return {duration:count/rate,getChannelData() {return new Float32Array(count);} }; }, createBufferSource() { const source={connect(){},disconnect(){},start(){},stop(){}}; sources.push(source); return source; } };
  const player=new PCMPlayer(context,(type,detail)=>events.push(type));
  player.append(new Uint8Array(3200),16000); sources[0].onended(); assert.equal(events.includes('playback_end'),false);
  player.append(new Uint8Array(3200),16000); player.finish(); assert.equal(events.includes('playback_end'),false);
  sources[1].onended(); assert.deepEqual(events,['playback_start','playback_end']);
});
test('speech region selection is explicit and never falls back', () => {
  assert.equal(speechConnectionFromEnvironment({}),null);
  assert.equal(speechConnectionFromEnvironment({ MINIMAX_SPEECH_API_KEY: 'test', SPEECH_REGION: 'cn' }).asrURL,'https://api.minimax.cn/v1/speech_to_text');
  assert.throws(() => speechConnectionFromEnvironment({ MINIMAX_SPEECH_API_KEY: 'test', SPEECH_REGION: 'unknown' }));
});
test('speech MiniMax ASR consumes split SSE and preserves timing and model', async () => {
  const transport = createMiniMaxSpeechTransport({ apiKey: 'test', asrURL: 'https://unused.test', region: 'cn' }, { fetch: async (url, options) => {
    assert.equal(options.body.get('model'),'asr-1.0'); assert.equal(options.body.get('stream'),'true'); assert.equal(options.headers.language,'zh');
    const data = new TextEncoder().encode('data: {"delta":"今天","finish":false}\n\ndata: {"delta":"很好","finish":true,"duration":1.2}\n\n');
    return new Response(new ReadableStream({ start(controller) { for (let offset=0; offset<data.length; offset+=7) controller.enqueue(data.slice(offset,offset+7)); controller.close(); } }), { headers: { 'Content-Type':'text/event-stream' } });
  } });
  const result = await transport.transcribe(encodeWave(new Float32Array(1600)), { language:'zh' }); assert.equal(result.text,'今天很好'); assert.equal(result.model,'asr-1.0'); assert.ok(result.firstDeltaMs >= 0); assert.equal(result.duration,1.2);
});
test('speech proxy handles multipart ASR and bidirectional synthesis', async () => {
  let cancelled = false; let text = '';
  const server = createDevelopmentServer({ speech: { transport: {
    async transcribe(blob) { assert.ok(blob.size > 44); return { text: '代理识别', model: 'test-asr', requestMs: 1 }; },
    synthesize(context) { return { write(value) { text += value; }, async flush() { context.onAudio(new Uint8Array([1,2,3,4]),16000); }, cancel() { cancelled=true; }, close() { cancelled=true; } }; }
  } } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const transport = createSpeechProxyTransport(`${base}/api/speech`); const result = await transport.transcribe(encodeWave(new Float32Array(1600)),{}); assert.equal(result.text,'代理识别');
    const socket = new WebSocket(`${base.replace('http','ws')}/api/speech/synthesize`); const events = [];
    await new Promise((resolve,reject) => { socket.on('open',() => socket.send(JSON.stringify({ type:'start',turn_id:'test' }))); socket.on('error',reject); socket.on('message',raw => {
      const event=JSON.parse(raw.toString()); events.push(event.type);
      if (event.type==='ready') { socket.send(JSON.stringify({ type:'text',text:'语音文本。' })); socket.send(JSON.stringify({ type:'flush' })); }
      if (event.type==='complete') { socket.close(); resolve(); }
    }); });
    assert.equal(text,'语音文本。'); assert.deepEqual(events,['ready','audio','complete']);
    await new Promise(resolve => setTimeout(resolve,20)); assert.equal(cancelled,true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
