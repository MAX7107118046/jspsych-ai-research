import { AIError, type AIRequest, type AIResult, type Capabilities, type Connection, type ContentPart, type Message, type Protocol, type Transport } from './types';
import { connectionEvidence, resolveConnectionPolicy } from './profiles';
export { CONNECTION_PRESETS } from './profiles';

export const PROTOCOL_CAPABILITIES: Record<Protocol, Capabilities> = {
  'openai-chat': { stream: true, structured: true, image: true, audio: true },
  'openai-responses': { stream: true, structured: true, image: true, audio: false },
  anthropic: { stream: true, structured: true, image: true, audio: false },
  gemini: { stream: true, structured: true, image: true, audio: true }
};

function plainText(content: Message['content']): string {
  return typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function dataURL(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function contentParts(content: Message['content'], protocol: Protocol, assistant: boolean): unknown {
  if (typeof content === 'string') return protocol === 'gemini' ? [{ text: content }] : content;
  return content.map((part: ContentPart) => {
    if (part.type === 'text') {
      if (protocol === 'gemini') return { text: part.text };
      if (protocol === 'openai-responses') return { type: assistant ? 'output_text' : 'input_text', text: part.text };
      return { type: 'text', text: part.text };
    }
    if (part.type === 'audio') {
      if (protocol === 'gemini') return { inlineData: { mimeType: part.mimeType, data: part.data } };
      if (protocol === 'openai-chat' && ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(part.mimeType)) {
        return { type: 'input_audio', input_audio: { data: part.data, format: part.mimeType.includes('wav') ? 'wav' : 'mp3' } };
      }
      throw new AIError('unsupported_audio', '此协议或音频格式无法直接传入；请转换格式或注入转录接口');
    }
    if (protocol === 'openai-chat') return { type: 'image_url', image_url: { url: part.url } };
    if (protocol === 'openai-responses') return { type: 'input_image', image_url: part.url };
    const inline = dataURL(part.url);
    if (protocol === 'anthropic') return { type: 'image', source: inline ? { type: 'base64', media_type: inline.mimeType, data: inline.data } : { type: 'url', url: part.url } };
    return inline ? { inlineData: inline } : { fileData: { mimeType: part.mimeType ?? 'image/jpeg', fileUri: part.url } };
  });
}

export function prepareRequest(connection: Connection, request: AIRequest) {
  if (!connection.baseURL || !connection.model) throw new AIError('configuration', '请填写服务地址和模型 ID');
  if (!PROTOCOL_CAPABILITIES[connection.protocol]) throw new AIError('configuration', '未知模型协议');
  const policy = resolveConnectionPolicy(connection, request);
  if (request.schema && policy.schemaMode === 'json-object' && connection.protocol === 'anthropic') throw new AIError('unsupported_schema', 'Anthropic 协议不提供 JSON Object 开关，请选择 native 或 prompt-json');
  const capabilities = { ...PROTOCOL_CAPABILITIES[connection.protocol], ...policy.capabilities };
  if (request.stream && !capabilities.stream) throw new AIError('unsupported_stream', '此连接未启用流式输出');
  if (request.schema && !capabilities.structured) throw new AIError('unsupported_schema', '此连接未启用结构化输出');
  for (const message of request.messages) {
    if (Array.isArray(message.content)) for (const part of message.content) {
      if (part.type === 'image' && !capabilities.image) throw new AIError('unsupported_image', '此连接未启用图像输入');
      if (part.type === 'audio' && !capabilities.audio) throw new AIError('unsupported_audio', '此连接未启用音频输入');
    }
  }
  const baseURL = connection.baseURL.replace(/\/+$/, '');
  const model = request.model ?? connection.model;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...connection.headers };
  const temperature = policy.omitTemperature ? undefined : request.temperature ?? connection.temperature ?? policy.extra.temperature;
  const maxTokens = policy.maxTokens;
  let url: string;
  let body: Record<string, unknown>;
  const extra = { ...policy.extra };
  for (const field of ['temperature', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) delete extra[field];
  const sourceMessages = [...request.messages];
  if (request.schema && policy.schemaMode !== 'native') sourceMessages.unshift({ role: 'system', content: `Return only JSON that satisfies this JSON Schema. Do not use Markdown. JSON Schema: ${JSON.stringify(request.schema)}` });
  const messages = sourceMessages.map(message => ({ role: message.role, content: contentParts(message.content, connection.protocol, message.role === 'assistant') }));
  if (connection.protocol === 'anthropic') {
    url = /\/messages$/.test(baseURL) ? baseURL : `${baseURL}/messages`;
    headers['anthropic-version'] ??= '2023-06-01';
    if (connection.apiKey) headers['x-api-key'] = connection.apiKey;
    body = { ...extra, model, max_tokens: maxTokens, stream: request.stream ?? false,
      system: sourceMessages.filter(message => message.role === 'system').map(message => plainText(message.content)).join('\n'),
      messages: messages.filter(message => message.role !== 'system') };
    if (temperature !== undefined) body.temperature = temperature;
    if (request.schema && policy.schemaMode === 'native') body.output_config = { ...(extra.output_config as object), format: { type: 'json_schema', schema: request.schema } };
  } else if (connection.protocol === 'gemini') {
    url = `${baseURL}/models/${encodeURIComponent(model)}:${request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    if (connection.apiKey) headers['x-goog-api-key'] = connection.apiKey;
    const generationConfig: Record<string, unknown> = { ...((extra.generationConfig ?? {}) as object), maxOutputTokens: maxTokens };
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (request.schema && policy.schemaMode !== 'prompt-json') Object.assign(generationConfig, { responseMimeType: 'application/json', ...(policy.schemaMode === 'native' ? { responseJsonSchema: request.schema } : {}) });
    body = { ...extra, generationConfig,
      systemInstruction: { parts: [{ text: sourceMessages.filter(message => message.role === 'system').map(message => plainText(message.content)).join('\n') }] },
      contents: messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: message.content })) };
    if (!sourceMessages.some(message => message.role === 'system' && plainText(message.content))) delete body.systemInstruction;
  } else {
    if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
    const responses = connection.protocol === 'openai-responses';
    const suffix = responses ? '/responses' : '/chat/completions';
    url = baseURL.endsWith(suffix) ? baseURL : `${baseURL}${suffix}`;
    body = { ...extra, model, stream: request.stream ?? false, [responses ? 'input' : 'messages']: messages,
      [responses ? 'max_output_tokens' : policy.tokenField]: maxTokens };
    if (responses) body.store = false;
    if (temperature !== undefined) body.temperature = temperature;
    if (request.schema && policy.schemaMode === 'native') {
      const format = { type: 'json_schema', name: 'research_response', strict: true, schema: request.schema };
      if (responses) body.text = { ...(extra.text as object), format };
      else body.response_format = { type: 'json_schema', json_schema: { name: format.name, strict: true, schema: request.schema } };
    }
    if (request.schema && policy.schemaMode === 'json-object') {
      if (responses) body.text = { ...(extra.text as object), format: { type: 'json_object' } };
      else body.response_format = { type: 'json_object' };
    }
  }
  const endpoint = new URL(url);
  return { url, headers, body, policy: { ...connectionEvidence(policy), requestEndpoint: `${endpoint.origin}${endpoint.pathname}` } };
}

function ensureFinish(reason?: string, partialText = '', usage?: Record<string, unknown>): void {
  if (reason && ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS', 'content_filter', 'SAFETY', 'RECITATION'].includes(reason)) {
    const tokenLimit = ['length', 'max_tokens', 'MAX_TOKENS', 'max_output_tokens'].includes(reason);
    throw new AIError('incomplete_output', tokenLimit && !partialText ? '生成预算已用尽，未收到正文；思考 token 也占用预算，请提高 maxTokens 或降低思考档位' : `模型输出未正常完成：${reason}`, { finishReason: reason, partialText, usage });
  }
}

export function normalizeResult(protocol: Protocol, payload: any, requestedModel: string): AIResult {
  assertProviderSuccess(payload);
  let text = '';
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let media: AIResult['media'];
  if (protocol === 'openai-chat') {
    const message = payload.choices?.[0]?.message;
    text = typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    finishReason = payload.choices?.[0]?.finish_reason;
    usage = payload.usage;
  } else if (protocol === 'openai-responses') {
    text = payload.output_text ?? (payload.output ?? []).flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('');
    finishReason = payload.status;
    usage = payload.usage;
    if (payload.status === 'incomplete' || payload.status === 'failed') throw new AIError('incomplete_output', !text ? 'Responses 未收到正文；请提高 maxTokens 或降低思考档位' : 'Responses 输出未正常完成', { responseStatus: payload.status, finishReason: payload.incomplete_details?.reason, partialText: text, usage });
  } else if (protocol === 'anthropic') {
    text = (payload.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    finishReason = payload.stop_reason;
    usage = payload.usage;
  } else {
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    text = parts.filter((part: any) => part.text && !part.thought).map((part: any) => part.text).join('');
    finishReason = payload.candidates?.[0]?.finishReason;
    usage = payload.usageMetadata;
    media = parts.filter((part: any) => part.inlineData).map((part: any) => ({
      type: part.inlineData.mimeType.startsWith('audio/') ? 'audio' : 'image',
      url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
    }));
  }
  ensureFinish(finishReason, text, usage);
  if (!text && !media?.length) throw new AIError('empty_output', '模型未返回可呈现内容');
  const reasoningCharacters = protocol === 'openai-chat' ? payload.choices?.[0]?.message?.reasoning_content?.length ?? 0
    : protocol === 'anthropic' ? (payload.content ?? []).filter((part: any) => part.type === 'thinking').reduce((count: number, part: any) => count + (part.thinking?.length ?? 0), 0)
    : protocol === 'openai-responses' ? (payload.output ?? []).filter((item: any) => item.type === 'reasoning').flatMap((item: any) => item.content ?? []).reduce((count: number, part: any) => count + (part.text?.length ?? 0), 0)
    : (payload.candidates?.[0]?.content?.parts ?? []).filter((part: any) => part.thought).reduce((count: number, part: any) => count + (part.text?.length ?? 0), 0);
  return { text, model: payload.model ?? payload.modelVersion ?? requestedModel, id: payload.id ?? payload.responseId, usage, finishReason, metadata: { reasoningCharacters }, ...(media?.length ? { media } : {}) };
}

function assertProviderSuccess(payload: any): void {
  const providerCode = payload.error?.code ?? payload.error?.type ?? payload.base_resp?.status_code;
  if (payload.error || payload.base_resp?.status_code) throw new AIError('provider_error', payload.error?.message ?? payload.base_resp?.status_msg ?? '模型服务返回错误', { providerCode });
}

export async function readSSE(response: Response, onEvent: (event: string, data: string) => void, signal: AbortSignal): Promise<void> {
  if (!response.body) throw new AIError('empty_stream', '响应缺少可读数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) onEvent(event, data.join('\n'));
    event = 'message'; data = [];
  };
  const line = (value: string) => {
    if (!value) dispatch();
    else if (value.startsWith('event:')) event = value.slice(6).trimStart();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  const consume = (final = false) => {
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\n|\r/.exec(buffer))) {
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
      line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (final) { if (buffer) line(buffer); dispatch(); }
  };
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      consume();
    }
    signal.throwIfAborted();
    buffer += decoder.decode();
    consume(true);
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createHTTPTransport(connection: Connection, fetcher: typeof fetch = globalThis.fetch): Transport {
  return async (request, context) => {
    const started = performance.now();
    const prepared = prepareRequest(connection, request);
    try {
      const response = await fetcher(prepared.url, { method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body), signal: context.signal });
      if (!response.ok) {
        let message = `模型服务返回 HTTP ${response.status}`;
        const payload = await response.json().catch(() => null) as any;
        if (payload?.error?.message) message = payload.error.message;
        if (response.status === 401 && prepared.policy.provider === 'minimax') message = `MiniMax 凭据认证失败（${prepared.policy.region === 'cn' ? '国内' : prepared.policy.region === 'global' ? '国际' : '自定义'}端点）；请核对密钥所属地区与 M Plan / 按量账户。服务返回：${message}`;
        if (response.status === 402) message = `模型账户余额或可用额度不足。服务返回：${message}`;
        if (response.status === 429) message = `模型服务限流或额度窗口已满。服务返回：${message}`;
        throw new AIError('http_error', connection.apiKey ? message.replaceAll(connection.apiKey, '[redacted]') : message, { status: response.status, providerCode: payload?.error?.code ?? payload?.error?.type, connectionPolicy: prepared.policy });
      }
      if (!request.stream || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const result = normalizeResult(connection.protocol, await response.json(), request.model ?? connection.model);
        return { ...result, metadata: { ...result.metadata, connectionPolicy: prepared.policy } };
      }
      let text = '';
      let model = request.model ?? connection.model;
      let id: string | undefined;
      let usage: Record<string, unknown> | undefined;
      let finishReason: string | undefined;
      let complete = false;
      let reasoningCharacters = 0;
      let firstReasoningMs: number | null = null;
      let media: AIResult['media'] = [];
      await readSSE(response, (event, data) => {
        if (data === '[DONE]') { complete = true; return; }
        let payload: any;
        try { payload = JSON.parse(data); } catch { throw new AIError('invalid_stream', '模型流包含无效 JSON'); }
        assertProviderSuccess(payload);
        if (payload.type === 'response.incomplete') throw new AIError('incomplete_output', !text ? 'Responses 生成预算已用尽，未收到正文；请提高 maxTokens 或降低思考档位' : 'Responses 输出未正常完成', { partialText: text, usage: payload.response?.usage, finishReason: payload.response?.incomplete_details?.reason });
        if (event === 'error' || payload.type === 'response.failed') {
          throw new AIError('provider_error', payload.error?.message ?? '模型流返回错误', { partialText: text });
        }
        model = payload.model ?? payload.message?.model ?? payload.response?.model ?? payload.modelVersion ?? model;
        id = payload.id ?? payload.message?.id ?? payload.response?.id ?? id;
        usage = { ...usage, ...(payload.usage ?? payload.message?.usage ?? payload.response?.usage ?? payload.usageMetadata ?? {}) };
        let delta = '';
        let reasoning = '';
        if (connection.protocol === 'openai-chat') {
          delta = payload.choices?.[0]?.delta?.content ?? '';
          reasoning = payload.choices?.[0]?.delta?.reasoning_content ?? '';
          finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
          if (finishReason) complete = true;
        } else if (connection.protocol === 'openai-responses') {
          if (payload.type === 'response.output_text.delta') delta = payload.delta ?? '';
          if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(payload.type)) reasoning = payload.delta ?? '';
          if (payload.type === 'response.completed') { complete = true; finishReason = 'completed'; }
        } else if (connection.protocol === 'anthropic') {
          if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') delta = payload.delta.text ?? '';
          if (payload.type === 'content_block_start' && payload.content_block?.type === 'text') delta = payload.content_block.text ?? '';
          if (payload.delta?.type === 'thinking_delta') reasoning = payload.delta.thinking ?? '';
          if (payload.content_block?.type === 'thinking') reasoning = payload.content_block.thinking ?? '';
          finishReason = payload.delta?.stop_reason ?? finishReason;
          if (payload.type === 'message_stop') complete = true;
        } else {
          const parts = payload.candidates?.[0]?.content?.parts ?? [];
          delta = parts.filter((part: any) => part.text && !part.thought).map((part: any) => part.text).join('');
          reasoning = parts.filter((part: any) => part.thought).map((part: any) => part.text ?? '').join('');
          media.push(...parts.filter((part: any) => part.inlineData).map((part: any) => ({ type: part.inlineData.mimeType.startsWith('audio/') ? 'audio' as const : 'image' as const, url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` })));
          finishReason = payload.candidates?.[0]?.finishReason ?? finishReason;
          if (finishReason) complete = true;
        }
        if (reasoning) { reasoningCharacters += reasoning.length; firstReasoningMs ??= performance.now() - started; }
        if (delta) { text += delta; context.onDelta(delta); }
      }, context.signal);
      if (!complete) throw new AIError('interrupted_stream', '模型流中断，已生成内容保留在调用记录中', { partialText: text });
      ensureFinish(finishReason, text, usage);
      if (!text && !media.length) throw new AIError('empty_output', '模型未返回可呈现内容');
      return { text, model, id, usage, finishReason, metadata: { connectionPolicy: prepared.policy, reasoningCharacters, firstReasoningMs }, ...(media.length ? { media } : {}) };
    } catch (error) {
      if (error instanceof AIError) {
        error.details = { ...error.details, connectionPolicy: prepared.policy };
        if (connection.apiKey) error.message = error.message.replaceAll(connection.apiKey, '[redacted]');
      }
      throw error;
    }
  };
}
