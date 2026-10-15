import { createAIClient, AIError } from '../dist/core.js';
import { StringDecoder } from 'node:string_decoder';

export function createProxyHandler(connection, options = {}) {
  const client = createAIClient({ connection, ...options });
  return async (request, response) => {
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(new AIError('cancelled', '浏览器连接已关闭')); };
    response.on('close', abort);
    let streaming = false;
    const writeEvent = (event, data) => {
      if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      let body = '';
      const decoder = new StringDecoder('utf8');
      for await (const chunk of request) {
        body += decoder.write(chunk);
        if (body.length > 20 * 1024 * 1024) throw new AIError('payload_too_large', '请求超过 20MB');
      }
      body += decoder.end();
      const payload = JSON.parse(body);
      if (!payload.request || !Array.isArray(payload.request.messages)) throw new AIError('invalid_request', '请求缺少 messages');
      const input = { ...payload.request, model: connection.model };
      streaming = input.stream === true;
      if (streaming) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
      }
      const result = await client.complete(input, { signal: controller.signal, onDelta: text => writeEvent('delta', { text }) });
      if (streaming) { writeEvent('complete', result); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(result)); }
    } catch (caught) {
      const error = { code: caught.code ?? 'proxy_error', message: caught.message ?? String(caught), details: caught.details ?? {} };
      if (streaming) { writeEvent('error', error); response.end(); }
      else if (!response.destroyed) { response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error })); }
    } finally { response.off('close', abort); }
  };
}
