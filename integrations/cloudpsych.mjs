import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

import { PLUGIN_VERSION, JSPSYCH_VERSION } from '../dist/core.js';
export const PACKAGE_LOCK = { name: 'jspsych-ai-research', version: PLUGIN_VERSION, jspsych: JSPSYCH_VERSION };
const modes = ['chat', 'interview', 'survey', 'feedback', 'advice', 'generate', 'coedit', 'learning', 'multiagent'];
const alphabet = Array.from({ length: 94 }, (value, index) => String.fromCharCode(index + 33)).filter(character => !'"\'\\`<>&?:'.includes(character)).join('');

function encodePackage(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value = 0;
    for (let index = 0; index < 4; index++) value = value * 256 + (bytes[offset + index] ?? 0);
    let group = '';
    for (let index = 0; index < 5; index++) { group = alphabet[value % 85] + group; value = Math.floor(value / 85); }
    result += group;
  }
  return result;
}

export async function createCloudPsychCodeModule({ mode = 'chat', interaction = null, parameters = {}, id = `ai_research_${mode}` } = {}) {
  if (!modes.includes(mode)) throw new Error('未知研究功能');
  const [bundle, style] = await Promise.all([
    readFile(new URL('../dist/jspsych-ai.cloudpsych.min.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/style.css', import.meta.url), 'utf8')
  ]);
  const bytes = gzipSync(JSON.stringify({ bundle, style }), { level: 9 });
  const compressed = encodePackage(bytes);
  const specification = JSON.stringify({ mode, interaction, packageLock: PACKAGE_LOCK }).replace(/</g, '\\u003c');
  const source = `const specification = ${specification};
async function loadPackage() {
  const key = '__jspsych_ai_research_' + specification.packageLock.version.replaceAll('.', '_');
  if (!window[key]) window[key] = (async () => {
    const encoded = ${JSON.stringify(compressed)};
    const alphabet = ${JSON.stringify(alphabet)};
    const bytes = new Uint8Array(${bytes.length});
    for (let offset = 0; offset < encoded.length; offset += 5) {
      let value = 0;
      for (let index = 0; index < 5; index++) value = value * 85 + alphabet.indexOf(encoded[offset + index]);
      const group = new Uint8Array(4);
      for (let index = 3; index >= 0; index--) { group[index] = value % 256; value = Math.floor(value / 256); }
      for (let index = 0; index < 4 && offset / 5 * 4 + index < bytes.length; index++) bytes[offset / 5 * 4 + index] = group[index];
    }
    const contents = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    const api = new Function('window', contents.bundle + ';return JsPsychAI;')(window);
    if (api.PLUGIN_VERSION !== specification.packageLock.version || api.JSPSYCH_VERSION !== specification.packageLock.jspsych) throw new Error('AI插件版本不匹配');
    const styleId = 'jspsych-ai-style-' + specification.packageLock.version.replaceAll('.', '_');
    if (!document.getElementById(styleId)) { const style = document.createElement('style'); style.id = styleId; style.textContent = contents.style; document.head.append(style); }
    return api;
  })();
  return window[key];
}
module.exports.Plugin = class {
  static info = { name: 'ai-research-${mode}', parameters: { configuration: { type: window.jsPsychModule.ParameterType.OBJECT, default: {} } } };
  constructor(psych) { this.psych = psych; }
  async simulate(trial, mode, options, loadCallback) {
    try {
      const api = await loadPackage();
      const inner = new api.PLUGINS[specification.mode](this.psych);
      inner.simulate(trial.configuration, mode, options, loadCallback);
    } catch (error) {
      loadCallback();
      this.psych.finishTrial({ ai_status: 'error', ai_simulated: true, ai_plugin_version: specification.packageLock.version, error: String(error) });
    }
  }
  async trial(display, trial) {
    try {
    const api = await loadPackage();
    const parameters = { ...trial.configuration };
    if ((parameters.delivery?.mode || 'live') === 'live') {
      if (!specification.interaction || !window.CloudPsychAIRuntime) throw new Error('实时生成需要已配置的AI互动协议');
      parameters.client = api.createAIClient({ transport: api.createCloudPsychTransport({ runtime: window.CloudPsychAIRuntime, interaction: specification.interaction, context: () => typeof __IR_V3_STATE === 'undefined' ? {} : __IR_V3_STATE }) });
      parameters.response_schema = specification.interaction.outputSchema || null;
      parameters.max_turns ??= specification.interaction.maxTurns || 3;
      parameters.max_input_characters ??= specification.interaction.maxInputCharacters || 10000;
    }
    const Plugin = api.PLUGINS[specification.mode];
    parameters.start_with_ai ??= Plugin.info.parameters.start_with_ai.default;
    const inner = new Plugin(this.psych);
    inner.trial(display, parameters);
    } catch (error) {
      this.psych.finishTrial({ ai_status: 'error', ai_plugin_version: specification.packageLock.version, error: String(error) });
    }
  }
};`;
  if (source.length > 100000) throw new Error(`AI模块超过当前编辑器的100000字符限制：${source.length}`);
  const module = { schema: 'CodeModule.v1', id, version: PACKAGE_LOCK.version, title: `AI 研究 · ${mode}`,
    inputs: [{ name: 'configuration', type: 'object' }], outputs: [{ name: 'ai_output', type: 'any' }, { name: 'ai_status', type: 'string' }],
    exports: [{ name: 'Plugin', kind: 'plugin' }], plugin: { parameters: { configuration: { type: 'OBJECT' } }, data: { response: { type: 'OBJECT' }, ai_output: { type: 'OBJECT' } } },
    provenance: { package: PACKAGE_LOCK }, source };
  return { module, component: { id: `${id}_component`, type: 'jspsych_plugin', props: {
    pluginModule: { $module: { id, version: PACKAGE_LOCK.version, export: 'Plugin' } }, parameters: { configuration: parameters },
    ...(interaction ? { interactionId: interaction.id } : {})
  } }, packageLock: { ...PACKAGE_LOCK } };
}

export function attachCloudPsychCodeModule(project, artifact, { stageId, routineId } = {}) {
  const result = structuredClone(project);
  const stage = stageId ? result.stages?.find(item => item.id === stageId) : result.stages?.[0];
  const routine = routineId ? stage?.routines?.find(item => item.id === routineId) : stage?.routines?.[0];
  if (!routine) throw new Error('请指定存在的阶段和Routine');
  if (routine.components.some(item => item.type === 'jspsych_plugin')) throw new Error('每个Routine最多包含一个原生插件，请选择独立Routine');
  result.codeModules ??= [];
  const existing = result.codeModules.find(item => item.id === artifact.module.id && item.version === artifact.module.version);
  if (existing && JSON.stringify(existing) !== JSON.stringify(artifact.module)) throw new Error('同名同版本模块已存在且内容不同，请创建新版本');
  if (!existing) result.codeModules.push(structuredClone(artifact.module));
  routine.components.push(structuredClone(artifact.component));
  return result;
}
