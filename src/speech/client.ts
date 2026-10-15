import { AIError } from '../core/types';
import type { SpeechClientLike, SpeechTransport, TranscriptionResult } from './types';

export interface SpeechClientOptions { transport?: SpeechTransport; proxyURL?: string; fetch?: typeof fetch }

export function createSpeechProxyTransport(baseURL = '/api/speech', fetcher: typeof fetch = globalThis.fetch): SpeechTransport {
  const base = baseURL.replace(/\/$/, '');
  return {
    async transcribe(blob, options = {}) {
      const started = performance.now();
      const form = new FormData(); form.append('file', blob, 'recording.wav');
      if (options.language) form.append('language', options.language);
      const response = await fetcher(`${base}/transcribe`, { method: 'POST', body: form, signal: options.signal });
      const result = await response.json();
      if (!response.ok || result.error) throw new AIError(result.error?.code ?? 'speech_http', result.error?.message ?? `语音识别失败（${response.status}）`);
      if (typeof result.text !== 'string') throw new AIError('speech_output', '语音服务缺少识别文本');
      options.onDelta?.(result.text);
      return { ...result, requestMs: performance.now() - started } as TranscriptionResult;
    },
    synthesize(options) {
      const url = new URL(`${base}/synthesize`, globalThis.location?.href ?? 'http://localhost');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      const queue: object[] = [];
      let ready = false;
      let settled = false;
      let resolveFlush: () => void;
      let rejectFlush: (error: unknown) => void;
      const flushed = new Promise<void>((resolve, reject) => { resolveFlush = resolve; rejectFlush = reject; });
      void flushed.catch(() => {});
      const timer = setTimeout(() => fail(new AIError('speech_timeout', '语音合成等待超时')), 90000);
      const send = (message: object) => { if (settled) return; if (ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); else queue.push(message); };
      const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled); };
      const fail = (error: unknown) => { if (settled) return; settled = true; dispose(); rejectFlush(error); socket.close(); };
      const cancelled = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel' })); fail(new AIError('cancelled', '语音合成已取消')); };
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'start', turn_id: options.turn_id, voice_id: options.voice_id, sample_rate: options.sample_rate, language: options.language })));
      socket.addEventListener('message', event => {
        if (settled) return;
        const message = JSON.parse(String(event.data));
        if (message.type === 'ready') { ready = true; queue.splice(0).forEach(item => socket.send(JSON.stringify(item))); }
        else if (message.type === 'audio') {
          const bytes = Uint8Array.from(atob(message.audio), character => character.charCodeAt(0));
          options.onAudio(bytes, message.sample_rate);
        } else if (message.type === 'complete') { settled = true; dispose(); resolveFlush(); socket.close(); }
        else if (message.type === 'error') fail(new AIError(message.code ?? 'speech_provider', message.message ?? '语音服务失败'));
        options.onEvent?.(message.type, message.metadata ?? null);
      });
      socket.addEventListener('error', () => fail(new AIError('speech_connection', '无法连接语音代理')));
      socket.addEventListener('close', () => { if (!settled) fail(new AIError('speech_disconnected', '语音连接提前结束')); });
      options.signal?.addEventListener('abort', cancelled, { once: true });
      if (options.signal?.aborted) cancelled();
      return { write: text => send({ type: 'text', text }), flush: () => { send({ type: 'flush' }); return flushed; }, cancel: cancelled, close: cancelled };
    }
  };
}

export function createSpeechClient(options: SpeechClientOptions = {}): SpeechClientLike {
  const transport = options.transport ?? createSpeechProxyTransport(options.proxyURL, options.fetch);
  return { transcribe: transport.transcribe.bind(transport), synthesize: transport.synthesize.bind(transport) };
}

export function createMockSpeechTransport(options: { transcript?: string; delayMs?: number; sampleRate?: number } = {}): SpeechTransport {
  return {
    async transcribe(blob, context = {}) {
      const started = performance.now();
      await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 5));
      context.signal?.throwIfAborted();
      const text = options.transcript ?? '这是模拟识别文本。'; context.onDelta?.(text);
      return { text, model: 'mock-asr', duration: blob.size / 32000, requestMs: performance.now() - started, firstDeltaMs: performance.now() - started };
    },
    synthesize(context) {
      let cancelled = false;
      let text = '';
      return { write: value => { text += value; }, async flush() {
        context.signal?.throwIfAborted();
        if (cancelled) throw new AIError('cancelled', '模拟语音已取消');
        const rate = options.sampleRate ?? 16000;
        const length = Math.floor(Math.min(2, Math.max(0.1, text.length / 20)) * rate);
        const bytes = new Uint8Array(Math.floor(length) * 2); const view = new DataView(bytes.buffer);
        for (let index = 0; index < length; index++) view.setInt16(index * 2, Math.sin(index / rate * 440 * Math.PI * 2) * 1000, true);
        context.onAudio(bytes, rate); context.onEvent?.('complete', { model: 'mock-tts' });
      }, cancel: () => { cancelled = true; }, close: () => { cancelled = true; } };
    }
  };
}
