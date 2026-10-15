import Ajv from 'ajv';
import { createHTTPTransport, readSSE } from './protocols';
import { AIError, type AIRequest, type AIResult, type ClientOptions, type CompleteOptions, type Completion, type Transport } from './types';
import { connectionEvidence, resolveConnectionPolicy } from './profiles';

const validator = new Ajv({ strict: false, allErrors: true });

export function validateStructuredResult(result: AIResult, schema: Record<string, unknown>): void {
  try { result.data = result.data ?? JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new AIError('invalid_output', '模型返回内容无法解析为 JSON', { partialText: result.text }); }
  const validate = validator.compile(schema);
  if (!validate(result.data)) throw new AIError('invalid_output', '模型返回数据不符合指定结构', { errors: validate.errors, partialText: result.text });
}

export class AIClient {
  private transport: Transport;
  constructor(readonly options: ClientOptions) {
    if (!options.transport && !options.connection) throw new AIError('configuration', '请配置模型连接或提供 transport');
    this.transport = options.transport ?? createHTTPTransport(options.connection!, options.fetch);
    this.complete = this.complete.bind(this);
    this.probe = this.probe.bind(this);
  }

  async complete(request: AIRequest, options: CompleteOptions = {}): Promise<Completion> {
    const started = performance.now();
    const controller = new AbortController();
    const policy = this.options.connection && !this.options.transport ? resolveConnectionPolicy(this.options.connection, request) : null;
    const timeoutMs = this.options.timeoutMs ?? policy?.timeoutMs ?? this.options.connection?.timeoutMs ?? 60000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AIError('configuration', 'timeoutMs 必须为正数');
    const retries = this.options.retries ?? this.options.connection?.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new AIError('configuration', 'retries 必须为 0 到 5 的整数');
    const abort = () => controller.abort(options.signal?.reason ?? new AIError('cancelled', '调用已取消'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new AIError('timeout', '模型调用超时')), timeoutMs);
    let firstTokenMs: number | null = null;
    let partialText = '';
    let active = true;
    const normalized: AIRequest = { ...request, model: request.model ?? this.options.connection?.model ?? 'custom-transport' };
    let rejectAbort: (reason: unknown) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        controller.signal.throwIfAborted();
        try {
          const result = await Promise.race([this.transport(normalized, {
            signal: controller.signal,
            onDelta: delta => {
              if (!active || controller.signal.aborted) return;
              if (firstTokenMs === null) firstTokenMs = performance.now() - started;
              partialText += delta;
              options.onDelta?.(delta);
            }
          }), interrupted]);
          controller.signal.throwIfAborted();
          if (!result || typeof result.text !== 'string') throw new AIError('invalid_transport', 'transport 必须返回 text 和 model');
          if (request.schema) validateStructuredResult(result, request.schema);
          return { ...result, ...(policy ? { metadata: { ...result.metadata, connectionPolicy: { ...connectionEvidence(policy), ...(result.metadata?.connectionPolicy as object), timeoutMs } } } : {}), model: result.model || normalized.model!, requestMs: performance.now() - started,
            firstTokenMs, attempts: attempt + 1, requestedModel: normalized.model! };
        } catch (caught) {
          const error = controller.signal.aborted ? controller.signal.reason : caught;
          const status = error instanceof AIError ? Number(error.details.status) : 0;
          const retryable = error instanceof TypeError || status === 429 || status >= 500;
          if (attempt >= retries || partialText || !retryable || controller.signal.aborted) throw error;
        }
      }
      throw new AIError('request_failed', '调用失败');
    } catch (caught) {
      const error = caught instanceof AIError ? caught : new AIError(controller.signal.aborted ? 'cancelled' : 'request_failed', caught instanceof Error ? caught.message : String(caught));
      error.details = { ...error.details, ...(policy ? { connectionPolicy: { ...connectionEvidence(policy), ...(error.details.connectionPolicy as object), timeoutMs } } : {}), partialText: error.details.partialText ?? partialText, requestMs: performance.now() - started, firstTokenMs };
      throw error;
    } finally {
      active = false;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async probe(options: CompleteOptions = {}) {
    const result = await this.complete({ messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false }, options);
    return { ok: true as const, model: result.model, requestMs: result.requestMs, text: result.text, usage: result.usage, metadata: result.metadata };
  }
}

export function createAIClient(options: ClientOptions): AIClient { return new AIClient(options); }

export function createProxyTransport(url = '/api/ai', fetcher: typeof fetch = globalThis.fetch): Transport {
  return async (request, context) => {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }), signal: context.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as any;
      throw new AIError(payload.error?.code ?? 'proxy_error', payload.error?.message ?? `代理返回 HTTP ${response.status}`, { ...payload.error?.details, status: response.status });
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return await response.json() as AIResult;
    let result: AIResult | undefined;
    await readSSE(response, (event, data) => {
      const value = JSON.parse(data);
      if (event === 'delta') context.onDelta(value.text);
      else if (event === 'complete') result = value;
      else if (event === 'error') throw new AIError(value.code, value.message, value.details);
    }, context.signal);
    if (!result) throw new AIError('interrupted_stream', '代理流未收到完成事件');
    return result;
  };
}

export function createMockTransport(options: { delayMs?: number; respond?: (request: AIRequest, call: number) => string | AIResult | Promise<string | AIResult> } = {}): Transport {
  let call = 0;
  return async (request, context) => {
    const current = ++call;
    const last = request.messages.at(-1)?.content;
    const input = typeof last === 'string' ? last : last?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
    const value = options.respond ? await options.respond(request, current) : `模拟回复 ${current}：${input}`;
    const result = typeof value === 'string' ? { text: value, model: 'mock' } : value;
    if (options.delayMs) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(context.signal.reason); };
      const timer = setTimeout(() => { context.signal.removeEventListener('abort', abort); resolve(); }, options.delayMs);
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
    });
    context.signal.throwIfAborted();
    if (request.stream) for (const character of result.text) { context.signal.throwIfAborted(); context.onDelta(character); }
    return result;
  };
}
