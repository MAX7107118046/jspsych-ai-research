import { createAIClient } from './core/client';
import { AIError, JSPSYCH_VERSION, PLUGIN_VERSION, type AIRequest, type Transport } from './core/types';
import { createAITrial } from './plugins';
import type { AITrialOptions } from './parameters';
import type { ResearchMode } from './core/types';

export interface CloudPsychInteraction {
  id: string;
  role: 'interviewer' | 'narrator' | 'role_player' | 'classifier' | 'evaluator';
  promptVersion: string;
  promptTemplate?: string;
  contextAllowlist?: string[];
  maxTurns?: number;
  maxInputCharacters?: number;
  outputSchema?: Record<string, unknown>;
}

export interface CloudPsychRuntime {
  request(input: { interactionId: string; promptVersion: string; input: string; requestId: string; context: Record<string, unknown>; outputSchema?: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>;
  hasStartConsent?: () => boolean;
  lastTurn?: Record<string, unknown>;
}

export interface CloudPsychOptions {
  runtime: CloudPsychRuntime;
  interaction: CloudPsychInteraction;
  context?: () => Record<string, unknown>;
  persist?: AITrialOptions['persist'];
  on_finish?: (data: Record<string, unknown>) => void;
  platform_on_finish?: (data: Record<string, unknown>) => void;
  model?: string;
}

export const CLOUDPSYCH_PACKAGE_LOCK = { package: 'jspsych-ai-research', version: PLUGIN_VERSION, jspsych: JSPSYCH_VERSION } as const;

export function createCloudPsychTransport(options: CloudPsychOptions): Transport {
  return async (request: AIRequest, context) => {
    if (options.runtime.hasStartConsent && !options.runtime.hasStartConsent()) throw new AIError('ai_start_consent_required', '请确认实验中的 AI 使用说明');
    const values = options.context?.() ?? {};
    const allowed = Object.fromEntries((options.interaction.contextAllowlist ?? []).filter(key => key in values).map(key => [key, values[key]]));
    const latest = request.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
    if (Array.isArray(latest) && latest.some(part => part.type !== 'text')) throw new AIError('unsupported_media', '当前 CloudPsych 互动接口接收文本；多模态请配置对应 transport');
    const text = typeof latest === 'string' ? latest : latest.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const value = await options.runtime.request({
      interactionId: options.interaction.id, promptVersion: options.interaction.promptVersion,
      input: text.slice(0, options.interaction.maxInputCharacters ?? 10000), requestId: String(request.metadata?.requestId ?? globalThis.crypto.randomUUID()),
      context: allowed, outputSchema: options.interaction.outputSchema, signal: context.signal
    });
    context.signal.throwIfAborted();
    const evidence = options.runtime.lastTurn ?? {};
    return { text: typeof value === 'string' ? value : typeof (value as any)?.reply === 'string' ? (value as any).reply : JSON.stringify(value),
      data: value, model: String(evidence.ai_model ?? evidence.model ?? evidence.model_id ?? options.model ?? 'cloudpsych-runtime'),
      id: String(evidence.ai_turn_id ?? evidence.turn_id ?? ''), metadata: { ...evidence } };
  };
}

export function composeFinishCallbacks(user?: CloudPsychOptions['on_finish'], platform?: CloudPsychOptions['platform_on_finish']) {
  return (data: Record<string, unknown>): void => {
    const errors: Array<{ phase: string; message: string }> = [];
    try { user?.(data); } catch (error) { errors.push({ phase: 'user_on_finish', message: String(error) }); }
    if (errors.length) data.ai_callback_errors = errors;
    try { platform?.(data); } catch (error) { errors.push({ phase: 'platform_on_finish', message: String(error) }); }
    if (errors.length) data.ai_callback_errors = errors;
  };
}

export function createCloudPsychTrial(options: CloudPsychOptions, trial: AITrialOptions & { mode?: ResearchMode } = {}) {
  const { mode, ...parameters } = trial;
  const inferred: ResearchMode = options.interaction.role === 'interviewer' ? 'interview' : options.interaction.role === 'narrator' || options.interaction.role === 'evaluator' ? 'feedback' : 'chat';
  return {
    ...createAITrial(mode ?? inferred, {
      prompt: options.interaction.promptTemplate ?? '', max_turns: options.interaction.maxTurns ?? 3,
      max_input_characters: options.interaction.maxInputCharacters ?? 10000,
      response_schema: options.interaction.outputSchema ?? null,
      ...parameters, client: createAIClient({ transport: createCloudPsychTransport(options) }), persist: options.persist ?? parameters.persist
    }),
    on_finish: composeFinishCallbacks(options.on_finish, options.platform_on_finish),
    data: { ai_package_lock: CLOUDPSYCH_PACKAGE_LOCK, interaction_id: options.interaction.id, prompt_version: options.interaction.promptVersion }
  };
}
