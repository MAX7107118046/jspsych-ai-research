import type { TrialRuntime } from '../runtime';
import type { MultimodalResearch } from './types';
import { element } from '../view';
import { ask, finishResearch, perform, taskPrompt } from './ui';

export async function multimodalResearch(runtime: TrialRuntime, config: MultimodalResearch): Promise<void> {
  runtime.beginPhase('multimodal_materials');
  runtime.result.presented_materials = structuredClone(config.materials ?? []);
  for (const [index, material] of (config.materials ?? []).entries()) {
    if (material.type === 'image') {
      const image = element('img', 'ai-material-image'); image.alt = `研究图片 ${index + 1}`; image.src = material.url; runtime.view.content.append(image);
      runtime.observeImage(image, { index, source: 'research_material', url: material.url });
    } else if (material.type === 'text') runtime.view.content.append(element('p', 'ai-material-text', material.text));
    else {
      const audio = element('audio'); audio.controls = true; audio.src = `data:${material.mimeType};base64,${material.data}`; runtime.view.content.append(audio);
      audio.addEventListener('play', () => runtime.emit('material_audio_play', { index, position: audio.currentTime }));
      audio.addEventListener('pause', () => runtime.emit('material_audio_pause', { index, position: audio.currentTime }));
    }
  }
  if (config.materials?.length) runtime.history.push({ role: 'user', content: config.materials });
  if (config.questions?.length) {
    runtime.result.response = await ask(runtime, 'multimodal_response', '材料判断', config.questions, '获取反馈');
    runtime.beginPhase('multimodal_feedback');
    await perform(runtime, () => runtime.reply(undefined, `${taskPrompt(runtime)}\n参与者回答：${JSON.stringify(runtime.result.response)}`));
    runtime.finishBlocked = false; runtime.finishAction = () => runtime.finish(); runtime.updateControls();
  } else if (runtime.mode === 'feedback') {
    await perform(runtime, () => runtime.reply(undefined, taskPrompt(runtime)));
    runtime.finishBlocked = false; runtime.finishAction = () => runtime.finish(); runtime.updateControls();
  } else {
    runtime.beginPhase('multimodal_conversation', true);
    runtime.view.controls.hidden = false;
    runtime.sendAction = async () => { runtime.takeInput(); await runtime.reply(); };
    runtime.speechInput = async text => { runtime.view.input.value = text; await runtime.run(runtime.sendAction); };
    runtime.finishBlocked = false; runtime.finishAction = () => finishResearch(runtime); runtime.updateControls();
    if (runtime.options.start_with_ai) await perform(runtime, () => runtime.reply(undefined, taskPrompt(runtime)));
  }
}
