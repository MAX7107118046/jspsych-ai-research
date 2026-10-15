import { AIError, type AIRequest, type Connection, type Provider, type SchemaMode, type ThinkingEffort } from './types';

export const PROFILE_VERSION = '2026-10-12';
export interface ConnectionPreset extends Partial<Connection> { label: string; protocol: Connection['protocol']; baseURL: string }
export const CONNECTION_PRESETS: Record<string, ConnectionPreset> = {
  compatible: { label: '自定义兼容服务', protocol: 'openai-chat', baseURL: '' },
  deepseek: { label: 'DeepSeek 官方 · Chat', provider: 'deepseek', protocol: 'openai-chat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  'minimax-cn-mplan': { label: 'MiniMax 国内 · M Plan · Chat', provider: 'minimax', account: 'm-plan', protocol: 'openai-chat', baseURL: 'https://api.minimax.cn/v1', model: 'MiniMax-M3.1-Flash-Preview' },
  'minimax-cn-anthropic': { label: 'MiniMax 国内 · M Plan · Anthropic', provider: 'minimax', account: 'm-plan', protocol: 'anthropic', baseURL: 'https://api.minimax.cn/anthropic/v1', model: 'MiniMax-M3.1-Flash-Preview' },
  'minimax-cn-responses': { label: 'MiniMax 国内 · M Plan · Responses', provider: 'minimax', account: 'm-plan', protocol: 'openai-responses', baseURL: 'https://api.minimax.cn/v1', model: 'MiniMax-M3.1-Flash-Preview' },
  'minimax-global-mplan': { label: 'MiniMax 国际 · M Plan · Chat', provider: 'minimax', account: 'm-plan', protocol: 'openai-chat', baseURL: 'https://api.minimax.io/v1', model: 'MiniMax-M3.1-Flash-Preview' },
  'minimax-global-anthropic': { label: 'MiniMax 国际 · M Plan · Anthropic', provider: 'minimax', account: 'm-plan', protocol: 'anthropic', baseURL: 'https://api.minimax.io/anthropic/v1', model: 'MiniMax-M3.1-Flash-Preview' },
  'minimax-global-responses': { label: 'MiniMax 国际 · M Plan · Responses', provider: 'minimax', account: 'm-plan', protocol: 'openai-responses', baseURL: 'https://api.minimax.io/v1', model: 'MiniMax-M3.1-Flash-Preview' },
  'minimax-cn-payg': { label: 'MiniMax 国内 · 按量 · Chat', provider: 'minimax', account: 'payg', protocol: 'openai-chat', baseURL: 'https://api.minimax.cn/v1', model: 'MiniMax-M3' },
  'minimax-global-payg': { label: 'MiniMax 国际 · 按量 · Chat', provider: 'minimax', account: 'payg', protocol: 'openai-chat', baseURL: 'https://api.minimax.io/v1', model: 'MiniMax-M3' },
  minimax: { label: 'MiniMax 国际 · Anthropic（旧预设）', provider: 'minimax', protocol: 'anthropic', baseURL: 'https://api.minimax.io/anthropic/v1' },
  openai: { label: 'OpenAI · Responses', protocol: 'openai-responses', baseURL: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic · Messages', protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  gemini: { label: 'Google Gemini · 原生接口', protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { label: '本地 Ollama', protocol: 'openai-chat', baseURL: 'http://localhost:11434/v1' },
  lmstudio: { label: '本地 LM Studio', protocol: 'openai-chat', baseURL: 'http://localhost:1234/v1' }
};

export function createConnection(preset: string, overrides: Partial<Connection> = {}): Connection {
  const value = CONNECTION_PRESETS[preset];
  if (!value) throw new AIError('configuration', `未知服务预设：${preset}`);
  const { label, ...connection } = value;
  const result = { ...connection, ...overrides };
  if (!result.model) throw new AIError('configuration', '请填写模型 ID');
  return result as Connection;
}

const deepseekModels = ['deepseek-flash', 'deepseek-v4-pro'];
const minimaxM2 = ['MiniMax-M2', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'];
const budgets: Record<ThinkingEffort, number> = { low: 8192, medium: 16384, high: 32768, xhigh: 65536, max: 131072 };

export function resolveConnectionPolicy(connection: Connection, request: Partial<AIRequest> = {}) {
  let endpoint: URL;
  try { endpoint = new URL(connection.baseURL); } catch { throw new AIError('configuration', '服务地址必须是完整 URL'); }
  const hostname = endpoint.hostname;
  const provider: Provider = connection.provider ?? (hostname === 'api.deepseek.com' ? 'deepseek' : ['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'].includes(hostname) ? 'minimax' : 'custom');
  const model = request.model ?? connection.model;
  const deepseek = provider === 'deepseek' && deepseekModels.includes(model);
  const minimaxFlash = provider === 'minimax' && model === 'MiniMax-M3.1-Flash-Preview';
  const minimaxM3 = provider === 'minimax' && model === 'MiniMax-M3';
  const minimaxLegacy = provider === 'minimax' && minimaxM2.includes(model);
  const recognized = deepseek || minimaxFlash || minimaxM3 || minimaxLegacy;
  if (recognized && (connection.protocol === 'gemini' || deepseek && connection.protocol !== 'openai-chat')) throw new AIError('configuration', '此模型规则尚未支持所选协议；可使用 custom 服务和 extra 显式配置');
  const extra: Record<string, any> = { ...connection.extra, ...request.extra };
  for (const field of ['thinking', 'reasoning', 'output_config', 'text', 'generationConfig', 'stream_options']) {
    if (connection.extra?.[field] && request.extra?.[field]) extra[field] = { ...(connection.extra[field] as object), ...(request.extra[field] as object) };
  }
  const requested = { ...connection.thinking, ...request.thinking };
  const rawEffort = connection.protocol === 'anthropic' ? extra.output_config?.effort : connection.protocol === 'openai-responses' ? extra.reasoning?.effort : extra.reasoning_effort;
  const rawMode = extra.thinking?.type === 'disabled' || rawEffort === 'none' ? 'off' : extra.thinking?.type || rawEffort ? 'on' : undefined;
  const selectedMode = requested.mode && requested.mode !== 'auto' ? requested.mode : rawMode;
  if (requested.mode && !['auto', 'on', 'off'].includes(requested.mode)) throw new AIError('configuration', '未知思考模式');
  if ((minimaxFlash || minimaxLegacy) && selectedMode === 'off') throw new AIError('thinking_required', `${model} 要求开启思考；请选择 low 降低等待时间`);
  if (!recognized && (selectedMode && requested.mode !== undefined && requested.mode !== 'auto' || requested.effort)) throw new AIError('configuration', '此模型的思考规则尚未登记，请在 extra 中填写厂商原生参数');
  const enabled = recognized && selectedMode !== 'off';
  const effort = enabled && (deepseek || minimaxFlash) ? (requested.effort ?? (rawEffort !== 'none' ? rawEffort : undefined) ?? 'low') as ThinkingEffort : undefined;
  const allowed = deepseek ? ['low', 'high', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max'];
  if (effort && !allowed.includes(effort)) throw new AIError('configuration', `${model} 的思考档位支持 ${allowed.join(' / ')}`);
  if (deepseek) {
    extra.thinking = { type: enabled ? 'enabled' : 'disabled' };
    extra.reasoning_effort = enabled ? effort : 'none';
  } else if (minimaxFlash || minimaxM3 || minimaxLegacy) {
    if (connection.protocol === 'openai-responses') extra.reasoning = { ...extra.reasoning, effort: enabled ? effort ?? 'high' : 'none' };
    else {
      extra.thinking = { type: enabled ? 'adaptive' : 'disabled' };
      if (effort && connection.protocol === 'anthropic') extra.output_config = { ...extra.output_config, effort };
      if (effort && connection.protocol === 'openai-chat') extra.reasoning_effort = effort;
    }
    if (connection.protocol === 'openai-chat') {
      extra.reasoning_split = true;
      if (request.stream) extra.stream_options = { ...extra.stream_options, include_usage: true };
    }
  }
  const rawTokens = connection.protocol === 'openai-responses' ? extra.max_output_tokens : connection.protocol === 'gemini' ? extra.generationConfig?.maxOutputTokens : extra.max_completion_tokens ?? extra.max_tokens;
  const maxTokens = request.maxTokens ?? connection.maxTokens ?? rawTokens ?? (enabled ? budgets[effort ?? 'low'] : 2048);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new AIError('configuration', 'maxTokens 必须为正整数');
  if (deepseek && maxTokens > 393216 || (minimaxFlash || minimaxM3) && maxTokens > 524288 || minimaxLegacy && maxTokens > 204800) throw new AIError('configuration', 'maxTokens 超过此模型的生成上限');
  const timeoutMs = connection.timeoutMs ?? (enabled ? (effort === 'max' || effort === 'xhigh' ? 300000 : effort === 'high' ? 180000 : 120000) : 60000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AIError('configuration', 'timeoutMs 必须为正数');
  const schemaMode: SchemaMode = connection.schemaMode ?? (deepseek ? 'json-object' : recognized && provider === 'minimax' ? 'prompt-json' : 'native');
  if (!['native', 'json-object', 'prompt-json'].includes(schemaMode)) throw new AIError('configuration', '未知结构化输出方式');
  if (request.schema && schemaMode === 'json-object' && request.schema.type !== 'object') throw new AIError('unsupported_schema', 'JSON Object 模式要求对象根节点；其他结构可选择 prompt-json 并使用本地结构校验');
  const warnings: string[] = [];
  if (enabled && maxTokens < budgets[effort ?? 'low']) warnings.push(`思考与正文共享生成预算，当前上限可能只够思考；此档位默认预算为 ${budgets[effort ?? 'low']}`);
  if (deepseek && enabled && (request.temperature ?? connection.temperature ?? extra.temperature) !== undefined) warnings.push('DeepSeek 思考模式不使用 temperature，本次省略该参数');
  if (!recognized && provider !== 'custom') warnings.push('模型 ID 未登记，使用通用协议与显式 extra 配置');
  if (request.schema && schemaMode === 'prompt-json') warnings.push('使用 JSON 指令和本地结构校验，服务端未强制 JSON Schema');
  const account = connection.account ?? (provider === 'minimax' && connection.apiKey?.startsWith('sk-cp-') ? 'm-plan' : 'unknown');
  if (minimaxFlash && account === 'payg') throw new AIError('account_mismatch', 'M3.1 Flash Preview 当前需要 M Plan 订阅凭据，请选择 M Plan 预设');
  return {
    provider, profile: recognized ? model : 'generic', profileVersion: PROFILE_VERSION, model, protocol: connection.protocol,
    endpoint: `${endpoint.origin}${endpoint.pathname}`, region: ['api.minimax.cn', 'api.minimaxi.com'].includes(hostname) ? 'cn' : hostname === 'api.minimax.io' ? 'global' : 'custom',
    account, thinking: { mode: recognized ? enabled ? 'on' : 'off' : 'provider-default', ...(effort ? { effort } : {}) },
    maxTokens, timeoutMs, schemaMode, warnings, extra,
    capabilities: recognized ? { image: !minimaxLegacy, audio: false, ...connection.capabilities } : connection.capabilities,
    omitTemperature: deepseek && enabled,
    tokenField: connection.protocol === 'openai-chat' && provider === 'minimax' && recognized ? 'max_completion_tokens' : 'max_tokens'
  };
}

export function connectionEvidence(policy: ReturnType<typeof resolveConnectionPolicy>) {
  const { extra, capabilities, omitTemperature, tokenField, ...evidence } = policy;
  return evidence;
}
