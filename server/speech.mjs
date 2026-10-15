import { WebSocket, WebSocketServer } from 'ws';

export function speechConnectionFromEnvironment(env = process.env) {
  if (!env.MINIMAX_SPEECH_API_KEY) return null;
  const region = env.SPEECH_REGION ?? 'cn';
  if (!['cn', 'global'].includes(region)) throw new Error('SPEECH_REGION must be cn or global');
  const host = region === 'cn' ? 'api.minimax.cn' : 'api.minimax.io';
  return { apiKey: env.MINIMAX_SPEECH_API_KEY, region, asrURL: env.SPEECH_ASR_URL ?? `https://${host}/v1/speech_to_text`,
    ttsURL: env.SPEECH_TTS_URL ?? `wss://${host}/ws/v1/t2a_v2_bidi`, asrModel: 'asr-1.0', ttsModel: 'speech-2.8-turbo' };
}

export function createMiniMaxSpeechTransport(connection, options = {}) {
  const fetcher = options.fetch ?? fetch;
  return {
    async transcribe(blob, context = {}) {
      const started = performance.now(); const form = new FormData();
      form.append('file', blob, 'recording.wav'); form.append('model', connection.asrModel ?? 'asr-1.0'); form.append('response_format', 'json'); form.append('stream', 'true');
      const response = await fetcher(connection.asrURL, { method: 'POST', body: form, headers: { Authorization: `Bearer ${connection.apiKey}`, ...(context.language ? { language: context.language } : {}) }, signal: context.signal });
      if (!response.ok) throw new Error(`MiniMax ASR HTTP ${response.status}`);
      let text = ''; let duration; let firstDeltaMs; let finished = false;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
        const accept = line => {
          if (!line.startsWith('data:')) return;
          const body = line.slice(5).trim(); if (!body || body === '[DONE]') return;
          const event = JSON.parse(body);
          if (event.base_resp?.status_code) throw new Error(`MiniMax ASR ${event.base_resp.status_code}: ${event.base_resp.status_msg}`);
          if (event.delta) { firstDeltaMs ??= performance.now() - started; text += event.delta; context.onDelta?.(event.delta); }
          duration = event.duration ?? duration; finished ||= Boolean(event.finish);
        };
        while (true) { const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done }); const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(accept); if (chunk.done) { if (pending) accept(pending); break; } }
        if (!finished) throw new Error('MiniMax ASR stream ended before finish');
      } else {
        const result = await response.json(); if (result.base_resp?.status_code) throw new Error(`MiniMax ASR ${result.base_resp.status_code}: ${result.base_resp.status_msg}`);
        text = result.text ?? ''; duration = result.duration;
      }
      return { text, duration, model: connection.asrModel ?? 'asr-1.0', requestMs: performance.now() - started, firstDeltaMs, metadata: { provider: 'minimax', region: connection.region } };
    },
    synthesize(context) {
      const socket = new WebSocket(connection.ttsURL, { headers: { Authorization: `Bearer ${connection.apiKey}` } });
      let ready = false; let complete = false; const queue = []; let resolveFlush; let rejectFlush;
      const flushed = new Promise((resolve, reject) => { resolveFlush = resolve; rejectFlush = reject; }); void flushed.catch(() => {});
      const send = event => { if (complete) return; if (ready) socket.send(JSON.stringify(event)); else queue.push(event); };
      const close = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', cancel); if (socket.readyState < WebSocket.CLOSING) socket.close(); };
      const fail = error => { if (complete) return; complete = true; rejectFlush(error); context.onEvent?.('error', { message: String(error.message ?? error) }); close(); };
      const cancel = () => { if (socket.readyState === WebSocket.OPEN && ready) socket.send(JSON.stringify({ event: 'task_cancel' })); fail(new Error('cancelled')); };
      const timer = setTimeout(() => fail(new Error('MiniMax TTS timeout')), 90000);
      context.signal?.addEventListener('abort', cancel, { once: true });
      socket.on('message', raw => {
        if (complete) return;
        try {
          const event = JSON.parse(raw.toString());
          if (event.base_resp?.status_code) throw new Error(`MiniMax TTS ${event.base_resp.status_code}: ${event.base_resp.status_msg}`);
          if (event.event === 'connected_success') socket.send(JSON.stringify({ event: 'task_start', model: connection.ttsModel ?? 'speech-2.8-turbo', language_boost: context.language === 'zh' ? 'Chinese' : 'auto',
            voice_setting: { voice_id: context.voice_id ?? 'male-qn-qingse', speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: context.sample_rate ?? 16000, format: 'pcm', channel: 1 } }));
          if (event.event === 'task_started') { ready = true; context.onEvent?.('ready'); queue.splice(0).forEach(item => socket.send(JSON.stringify(item))); }
          if (event.data?.audio) context.onAudio(Buffer.from(event.data.audio, 'hex'), context.sample_rate ?? 16000);
          if (event.event === 'task_flushed') { complete = true; resolveFlush(); socket.send(JSON.stringify({ event: 'task_finish' })); close(); }
        } catch (error) { fail(error); }
      });
      socket.on('error', fail); socket.on('close', () => { if (!complete) fail(new Error('MiniMax TTS disconnected')); });
      if (context.signal?.aborted) cancel();
      return { write: text => send({ event: 'task_continue', text }), flush: () => { send({ event: 'task_flush' }); return flushed; }, cancel, close: cancel };
    }
  };
}

export function attachSpeechProxy(server, options = {}) {
  const connection = options.connection ?? speechConnectionFromEnvironment();
  const transport = options.transport ?? (connection ? createMiniMaxSpeechTransport(connection, options) : null);
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/api/speech/synthesize') { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request));
  });
  sockets.on('connection', client => {
    const abort = new AbortController(); let synthesis;
    const send = body => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(body)); };
    client.on('message', async raw => {
      try {
        if (!transport) throw new Error('请设置 MINIMAX_SPEECH_API_KEY');
        const message = JSON.parse(raw.toString());
        if (message.type === 'start' && !synthesis) {
          synthesis = transport.synthesize({ ...message, signal: abort.signal,
            onAudio: (bytes, sample_rate) => send({ type: 'audio', audio: Buffer.from(bytes).toString('base64'), sample_rate }),
            onEvent: (type, metadata) => { if (type === 'error') send({ type, code: 'speech_provider', message: metadata?.message }); } });
          send({ type: 'ready' });
        } else if (message.type === 'text') synthesis?.write(message.text);
        else if (message.type === 'flush') { await synthesis?.flush(); send({ type: 'complete' }); }
        else if (message.type === 'cancel') { abort.abort(); synthesis?.cancel(); }
      } catch (error) { send({ type: 'error', code: 'speech_provider', message: String(error.message ?? error) }); }
    });
    client.on('close', () => { abort.abort(); synthesis?.close(); });
  });
  server.on('close', () => { for (const client of sockets.clients) client.terminate(); sockets.close(); });
  return async (request, response) => {
    if (!transport) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'speech_not_configured', message: '请设置 MINIMAX_SPEECH_API_KEY' } })); return; }
    const abort = new AbortController(); const stopped = () => { if (!response.writableEnded) abort.abort(); }; response.on('close', stopped);
    const timer = setTimeout(() => abort.abort(), 90000);
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const form = await new Request('http://localhost', { method: 'POST', headers: request.headers, body: Buffer.concat(chunks) }).formData();
      const file = form.get('file'); if (!(file instanceof Blob)) throw new Error('缺少录音文件');
      const result = await transport.transcribe(file, { signal: abort.signal, language: form.get('language') || 'zh' });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { if (!response.destroyed) { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'speech_provider', message: String(error.message ?? error) } })); } }
    finally { clearTimeout(timer); response.off('close', stopped); }
  };
}
