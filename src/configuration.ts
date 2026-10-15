import { JSPSYCH_VERSION, PLUGIN_VERSION, type ResearchMode } from './core/types';
import { FEATURE_DEFINITIONS, type AITrialOptions } from './parameters';
import { createAITrial } from './plugins';
import { validateResearch } from './research/helpers';

export interface ExperimentConfiguration {
  schema: 'AIExperimentConfig.v1';
  package: { name: 'jspsych-ai-research'; version: string; jspsych: string };
  mode: ResearchMode;
  parameters: AITrialOptions;
}

export function createConfiguration(mode: ResearchMode, parameters: AITrialOptions = {}): ExperimentConfiguration {
  if (!FEATURE_DEFINITIONS.some(feature => feature.mode === mode)) throw new Error('未知研究功能');
  if (parameters.research) validateResearch(mode, parameters.research);
  return { schema: 'AIExperimentConfig.v1', package: { name: 'jspsych-ai-research', version: PLUGIN_VERSION, jspsych: JSPSYCH_VERSION }, mode, parameters };
}

export function serializeConfiguration(configuration: ExperimentConfiguration): string {
  return JSON.stringify(configuration, (key, value) => ['apiKey', 'headers', 'client', 'session', 'persist', 'on_event', 'speech_client', 'persist_media'].includes(key) || typeof value === 'function' ? undefined : value, 2);
}

export function parseConfiguration(source: string): ExperimentConfiguration {
  const configuration = JSON.parse(source) as ExperimentConfiguration;
  if (configuration.schema !== 'AIExperimentConfig.v1' || configuration.package?.name !== 'jspsych-ai-research') throw new Error('配置格式不受支持');
  if (configuration.package.jspsych !== JSPSYCH_VERSION || configuration.package.version !== PLUGIN_VERSION) throw new Error(`此配置需要插件 ${configuration.package.version} / jsPsych ${configuration.package.jspsych}，当前为 ${PLUGIN_VERSION} / ${JSPSYCH_VERSION}`);
  if (!FEATURE_DEFINITIONS.some(feature => feature.mode === configuration.mode) || !configuration.parameters || typeof configuration.parameters !== 'object' || Array.isArray(configuration.parameters)) throw new Error('配置缺少有效的研究功能或参数');
  if (configuration.parameters.research) validateResearch(configuration.mode, configuration.parameters.research);
  return configuration;
}

export function configurationToTrial(configuration: ExperimentConfiguration, runtime: AITrialOptions = {}) {
  const verified = parseConfiguration(serializeConfiguration(configuration));
  return createAITrial(verified.mode, { ...verified.parameters, ...runtime });
}

export function exportExperimentCode(configuration: ExperimentConfiguration, format: 'browser' | 'esm' = 'browser'): string {
  const verified = parseConfiguration(serializeConfiguration(configuration));
  const json = JSON.stringify(verified.parameters, null, 2).replace(/</g, '\\u003c');
  const setup = `const client = createAIClient({ transport: createProxyTransport('/api/ai'), timeoutMs: 300000 });\nconst jsPsych = initJsPsych({ on_finish: () => console.log(jsPsych.data.get().json()) });\njsPsych.run([createAITrial(${JSON.stringify(verified.mode)}, { ...${json}, client })]);`;
  if (format === 'esm') return `import { initJsPsych } from 'jspsych';\nimport { createAIClient, createProxyTransport, createAITrial } from 'jspsych-ai-research';\nimport 'jspsych/css/jspsych.css';\nimport 'jspsych-ai-research/style.css';\n\n${setup}\n`;
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 研究实验</title>\n<link rel="stylesheet" href="./node_modules/jspsych/css/jspsych.css"><link rel="stylesheet" href="./dist/style.css">\n<script src="./node_modules/jspsych/dist/index.browser.js"></script><script src="./dist/jspsych-ai.browser.js"></script></head><body><script>\nconst { createAIClient, createProxyTransport, createAITrial } = JsPsychAI;\n${setup}\n</script></body></html>\n`;
}
