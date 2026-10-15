import type { JsPsych } from 'jspsych';
import { createResearchSession } from './core/session';
import { DATA_VERSION, JSPSYCH_VERSION, PLUGIN_VERSION, type ResearchMode } from './core/types';
import { initializeFeature } from './features';
import type { AITrialOptions } from './parameters';
import { TrialRuntime } from './runtime';
import { createAIClient, createMockTransport } from './core/client';
import { mockResearchResponse } from './research/mock';
import { createMockSpeechTransport, createSpeechClient } from './speech/client';

export function simulateResearchTrial(psych: JsPsych, mode: ResearchMode, trial: AITrialOptions, simulationMode: string,
  simulationOptions: { data?: Record<string, unknown> } = {}, loadCallback: () => void = () => {}) {
  const simulated = { ai_simulated: true, ai_simulation_mode: simulationMode };
  const merge = (data: Record<string, unknown>) => ({ ...psych.pluginAPI.mergeSimulationData(data, simulationOptions), ...simulated });
  if (simulationMode === 'data-only') {
    loadCallback();
    psych.finishTrial(merge({ ai_data_version: DATA_VERSION, ai_plugin_version: PLUGIN_VERSION,
      jspsych_runtime_version: JSPSYCH_VERSION, research_mode: mode, ai_status: 'complete',
      ai_delivery_mode: 'simulation', ai_calls: [], ai_messages: [], ai_events: [], rt: 1000,
      response: mode === 'advice' ? 60 : '模拟作答' }));
    return;
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  const simulatedPsych = new Proxy(psych, { get(target, property) {
    if (property === 'finishTrial') return (data: Record<string, unknown>) => { clearInterval(timer); target.finishTrial(merge(data)); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const options: AITrialOptions = { ...trial, client: undefined, persist: undefined, on_event: undefined,
    session: createResearchSession({ id: `simulation-${mode}`, seed: 42 }), memory_key: null,
    min_turns: mode === 'feedback' ? 0 : 1, max_turns: 1, allow_regenerate: false, response_schema: null,
    presentation: {}, attachments: {}, initial_attachments: [], generate_questions: false, survey_feedback: false,
    questions: trial.questions?.length ? trial.questions : [{ name: 'simulation', prompt: '模拟问题', required: true }],
    transfer_questions: trial.transfer_questions?.length ? trial.transfer_questions : [{ name: 'transfer', prompt: '模拟迁移问题', required: true }],
    advice: 65, candidates: Math.min(30, Math.max(1, trial.candidates ?? 3)),
    agents: trial.agents?.length ? trial.agents : [{ id: 'simulation', label: '模拟角色', system_prompt: '' }],
    delivery: { mode: 'replay', materials: Array.from({ length: 80 }, () => ({ text: '模拟模型回复', model: 'simulation-model' })) } };
  if (trial.research) {
    options.client = createAIClient({ transport: createMockTransport({ respond: mockResearchResponse }) });
    options.delivery = { mode: 'live' }; options.min_turns = 0; options.max_turns = 30;
    options.speech_client = createSpeechClient({ transport: createMockSpeechTransport() });
    options.speech = null; options.persist_media = null;
    options.initial_attachments = [];
    if (options.research?.group === 'multimodal') options.research = { ...options.research, materials: [] };
  }
  const display = psych.getDisplayElement();
  const runtime = new TrialRuntime(simulatedPsych, display, mode, options);
  timer = setInterval(() => {
    if (runtime.done || !display.contains(runtime.view.root)) { clearInterval(timer); return; }
    const root = display.querySelector<HTMLElement>('.ai-research');
    if (!root || root.getAttribute('aria-busy') === 'true') return;
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')) {
      if (input.disabled || input.closest('[hidden]') || input.type === 'file' || input.type === 'range') continue;
      if (input instanceof HTMLInputElement && input.type === 'radio') { if (!input.checked) input.click(); continue; }
      if (input instanceof HTMLSelectElement) input.value = [...input.options].find(option => option.value)?.value ?? '';
      else if (input instanceof HTMLInputElement && input.type === 'number') {
        const value = input.name === 'final' ? 60 : 50;
        input.value = String(Math.max(input.min ? Number(input.min) : -Infinity, Math.min(input.max ? Number(input.max) : Infinity, value)));
      } else if (!input.value) input.value = '模拟作答';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const researchButton = trial.research ? [...root.querySelectorAll<HTMLButtonElement>('.ai-content button:not(:disabled)')].find(control => ['获取AI建议', '开始独立测验', '接受', '拒绝', '接受修改稿', '提交最终稿'].includes(control.textContent ?? ''))
      ?? root.querySelector<HTMLButtonElement>('.ai-evidence button:not(:disabled)')
      ?? root.querySelector<HTMLButtonElement>('.ai-content button:not(:disabled)') : null;
    const button = root.querySelector<HTMLButtonElement>('.ai-question-form button[type=submit]:not(:disabled)')
      ?? researchButton
      ?? root.querySelector<HTMLButtonElement>('.ai-footer button:not(:disabled):not([hidden])')
      ?? root.querySelector<HTMLButtonElement>('.ai-controls:not([hidden]) button:not(:disabled)');
    button?.click();
  }, 40);
  void runtime.run(() => initializeFeature(runtime));
  loadCallback();
}
