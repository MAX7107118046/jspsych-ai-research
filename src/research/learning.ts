import type { TrialRuntime } from '../runtime';
import type { LearningResearch } from './types';
import { scoreAnswers } from './helpers';
import { ask, finishResearch, heading, taskPrompt } from './ui';
import { button, element } from '../view';

export async function learningResearch(runtime: TrialRuntime, config: LearningResearch): Promise<void> {
  const assessment = async (name: string, title: string, questions: typeof config.pretest) => {
    if (!questions?.length) return;
    const response = await ask(runtime, name, title, questions, '提交回答');
    runtime.result[`${name}_response`] = response;
    runtime.result[`${name}_score`] = scoreAnswers(response, config.answer_key);
  };
  await assessment('pretest', '前测', config.pretest);
  await assessment('practice', '练习', config.practice);
  runtime.beginPhase('tutoring', true);
  heading(runtime, '学习辅导');
  runtime.view.controls.hidden = false;
  const minimum = config.minimum_tutor_turns ?? 1;
  const strategy = config.strategy ?? 'hints';
  const instructions = { answer: '直接给出答案并解释。', hints: '提供逐步提示，根据学习者已掌握的内容逐步深入。', socratic: '通过具体问题引导学习者推理，每轮只提出一个问题。' };
  runtime.options.system_prompt = [runtime.options.system_prompt, instructions[strategy]].filter(Boolean).join('\n');
  runtime.result.tutoring_strategy = strategy;
  runtime.result.help_events = [];
  const tools = element('div', 'ai-learning-tools');
  runtime.view.content.append(tools);
  let turns = 0;
  let level = 0;
  let proceed: () => void;
  const finished = new Promise<void>((resolve, reject) => { proceed = resolve; runtime.onCleanup(() => reject(new Error('试次已结束'))); });
  const next = button('开始独立测验', () => { if (turns >= minimum) proceed(); });
  next.disabled = turns < minimum;
  runtime.controlsGuard = () => { next.disabled = runtime.busy || turns < minimum; };
  tools.append(next);
  const recordHelp = (kind: string) => {
    const event = { kind, level, time: performance.now() - runtime.started, strategy };
    (runtime.result.help_events as unknown[]).push(event); runtime.emit('learning_help', event);
    turns++; next.disabled = turns < minimum;
  };
  runtime.sendAction = async () => {
    runtime.takeInput();
    runtime.beginPhase('tutor_generation');
    if (strategy === 'hints') level++;
    await runtime.reply(undefined, `${taskPrompt(runtime)}\n按照${strategy}策略回复当前学习者。${strategy === 'hints' ? `当前提示层级：${level}。` : ''}`);
    if (strategy === 'answer') runtime.result.answer_revealed = true;
    recordHelp('conversation');
    runtime.beginPhase('tutoring', true);
  };
  runtime.speechInput = async text => { runtime.view.input.value = text; await runtime.run(runtime.sendAction); };
  if (config.hints?.length) {
    const hint = button('下一条提示', () => { void runtime.run(async () => {
      if (level >= config.hints!.length) return;
      runtime.beginPhase('hint_presentation');
      await runtime.showText(config.hints![level]); level++; recordHelp('hint'); runtime.beginPhase('tutoring', true);
    }); }, 'ai-secondary');
    tools.prepend(hint);
    runtime.controlsGuard = () => { hint.disabled = runtime.busy || level >= config.hints!.length; next.disabled = runtime.busy || turns < minimum; };
  }
  if (config.solution) tools.prepend(button('查看答案', () => { void runtime.run(async () => {
    runtime.beginPhase('answer_presentation');
    await runtime.showText(config.solution!); runtime.result.answer_revealed = true; recordHelp('answer_reveal'); runtime.beginPhase('tutoring', true);
  }); }, 'ai-secondary'));
  runtime.finishBlocked = true;
  runtime.finishAction = () => { if (runtime.status !== 'complete') runtime.finish(); };
  runtime.updateControls();
  await finished;
  runtime.endPhase({ tutor_turns: turns });
  runtime.controlsGuard = () => {};
  tools.remove();
  runtime.view.controls.hidden = true;
  runtime.disableAI();
  runtime.result.ai_calls_at_withdrawal = runtime.calls.length;
  await assessment('posttest', '独立测验', config.posttest);
  const transferStarted = performance.now();
  await assessment('transfer', '迁移测验', config.transfer ?? runtime.options.transfer_questions);
  runtime.result.transfer_rt = performance.now() - transferStarted;
  runtime.result.independent_ai_calls = runtime.calls.length - Number(runtime.result.ai_calls_at_withdrawal);
  runtime.result.response = runtime.result.transfer_response ?? runtime.result.posttest_response ?? null;
  finishResearch(runtime);
}
