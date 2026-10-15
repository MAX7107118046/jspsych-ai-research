import { createConnection } from '../dist/core.js';

export function connectionFromEnvironment(environment = process.env) {
  if (!environment.AI_PRESET && !(environment.AI_BASE_URL && environment.AI_MODEL)) return null;
  const overrides = {
    ...(environment.AI_PROTOCOL ? { protocol: environment.AI_PROTOCOL } : {}),
    ...(environment.AI_BASE_URL ? { baseURL: environment.AI_BASE_URL } : {}),
    ...(environment.AI_MODEL ? { model: environment.AI_MODEL } : {}),
    apiKey: environment.AI_API_KEY,
    ...(environment.AI_PROVIDER ? { provider: environment.AI_PROVIDER } : {}),
    ...(environment.AI_ACCOUNT ? { account: environment.AI_ACCOUNT } : {}),
    ...(environment.AI_TIMEOUT_MS ? { timeoutMs: Number(environment.AI_TIMEOUT_MS) } : {}),
    ...(environment.AI_MAX_TOKENS ? { maxTokens: Number(environment.AI_MAX_TOKENS) } : {}),
    ...(environment.AI_THINKING || environment.AI_EFFORT ? { thinking: { mode: environment.AI_THINKING ?? 'auto', ...(environment.AI_EFFORT ? { effort: environment.AI_EFFORT } : {}) } } : {}),
    ...(environment.AI_EXTRA ? { extra: JSON.parse(environment.AI_EXTRA) } : {})
  };
  return environment.AI_PRESET ? createConnection(environment.AI_PRESET, overrides) : { protocol: 'openai-chat', ...overrides };
}
