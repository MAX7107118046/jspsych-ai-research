import { adviceMetrics } from '../core/session';
import { AIError, type Question } from '../core/types';
import type { TrialRuntime } from '../runtime';
import { button, element } from '../view';
import type { JudgmentResearch } from './types';
import { action, ask, finishResearch, heading, perform, taskPrompt } from './ui';

export async function judgment(runtime: TrialRuntime, config: JudgmentResearch): Promise<void> {
  const categorical = config.response_type === 'choice';
  const judgmentQuestion = (name: string, prompt: string): Question => ({ name, prompt, type: categorical ? 'choice' : 'number', options: config.choices, required: true });
  const confidence = (name: string): Question => ({ name, prompt: '信心（0—100）', type: 'scale', min: 0, max: 100, required: true });
  const initial = await ask(runtime, 'initial_judgment', '初始判断', [judgmentQuestion('initial', '你的初始判断'), confidence('confidence_initial')], '提交初始判断');
  runtime.result.initial_estimate = initial.initial;
  runtime.result.initial_confidence = initial.confidence_initial;
  runtime.result.advice_condition = { quality: config.quality ?? null, source_label: config.source_label ?? runtime.options.labels?.assistant ?? 'AI', explanation_mode: config.explanation_mode ?? 'brief', help_timing: config.help_timing ?? 'after_initial' };
  if (config.help_timing === 'on_request' || config.help_timing === 'delayed') {
    runtime.beginPhase('awaiting_help', config.help_timing === 'on_request');
    heading(runtime, '获取建议');
    await action(runtime, '获取AI建议', config.help_timing === 'delayed' ? config.help_delay_ms ?? 1000 : 0);
    runtime.emit('help_requested', { timing: config.help_timing });
  }
  runtime.beginPhase('advice_generation');
  let advice = config.advice ?? runtime.options.advice;
  let explanation = config.explanation ?? '';
  if (advice == null) {
    const schema = { type: 'object', additionalProperties: false, required: ['advice', 'explanation'], properties: {
      advice: categorical ? { type: 'string', enum: config.choices } : { type: 'number' }, explanation: { type: 'string' }
    } };
    const result = await perform(runtime, () => runtime.request([{ role: 'user', content: `${taskPrompt(runtime)}\n初始判断：${initial.initial}。提供建议与说明。建议质量条件：${config.quality ?? '研究任务要求'}。解释形式：${config.explanation_mode ?? 'brief'}。${categorical ? `仅从这些选项选择：${JSON.stringify(config.choices)}` : ''}` }], undefined, undefined, schema));
    const data = result.data as { advice: number | string; explanation: string };
    advice = data.advice; explanation = data.explanation;
  }
  if (categorical ? !config.choices!.includes(String(advice)) : !Number.isFinite(advice)) throw new AIError('invalid_output', '建议与判断类型不符');
  runtime.result.advice = advice;
  runtime.result.advice_explanation = explanation;
  runtime.beginPhase('advice_presentation');
  await perform(runtime, () => runtime.showText(`${advice}${config.explanation_mode === 'none' ? '' : `\n${explanation}`}`, config.source_label ?? runtime.options.labels?.assistant ?? 'AI'));
  runtime.emit('advice_presented', { advice, explanation: config.explanation_mode === 'none' ? '' : explanation, source_label: config.source_label ?? 'AI' });
  const evidence = config.evidence ?? [];
  if (evidence.length || config.evidence_questions?.length) {
    const viewed = new Set<string>();
    const operations: unknown[] = [];
    const openEvidence = new Map<string, number>();
    runtime.result.evidence_operations = operations;
    const answers = await ask(runtime, 'evidence_check', '证据核查', config.evidence_questions ?? [], '完成核查', form => {
      const area = element('div', 'ai-evidence');
      for (const item of evidence) {
        const content = element('div', 'ai-evidence-content', item.text); content.hidden = true;
        let openedAt: number | null = null;
        const toggle = button(item.title, () => {
          content.hidden = !content.hidden;
          const time = performance.now() - runtime.started;
          if (!content.hidden) { viewed.add(item.id); openedAt = time; openEvidence.set(item.id, time); }
          const event = { id: item.id, action: content.hidden ? 'close' : 'open', time, visible_ms: content.hidden && openedAt != null ? time - openedAt : null };
          operations.push(event); runtime.emit('evidence_view', event);
          if (content.hidden) openEvidence.delete(item.id);
          form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = Boolean(config.require_evidence && viewed.size < evidence.length);
        }, 'ai-secondary');
        if (item.url) {
          const link = element('a', '', '查看来源'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener';
          link.addEventListener('click', () => { const event = { id: item.id, action: 'source_link', time: performance.now() - runtime.started }; operations.push(event); runtime.emit('evidence_view', event); });
          content.append(link);
        }
        area.append(toggle, content);
      }
      form.prepend(area);
      form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = Boolean(config.require_evidence && evidence.length);
      form.addEventListener('submit', () => {
        if (form.isConnected) return;
        const time = performance.now() - runtime.started;
        for (const [id, opened] of openEvidence) { const event = { id, action: 'phase_end', time, visible_ms: time - opened }; operations.push(event); runtime.emit('evidence_view', event); }
        openEvidence.clear();
      });
    });
    runtime.result.evidence_response = answers;
    runtime.result.evidence_viewed = [...viewed];
  }
  const final = await ask(runtime, 'final_judgment', '最终判断', [judgmentQuestion('final', '你的最终判断'), confidence('confidence_final')], '提交判断');
  const correct = config.correct_answer ?? runtime.options.correct_answer;
  Object.assign(runtime.result, categorical ? {
    final_estimate: final.final, weight_of_advice: null, revision: initial.initial === final.final ? 0 : 1,
    initial_correct: correct == null ? null : initial.initial === correct, final_correct: correct == null ? null : final.final === correct
  } : adviceMetrics(Number(initial.initial), Number(final.final), Number(advice), correct == null ? null : Number(correct)));
  runtime.result.advice_adopted = final.final === advice;
  runtime.result.advice_error = correct == null ? null : categorical ? String(advice) === String(correct) ? 0 : 1 : Math.abs(Number(advice) - Number(correct));
  runtime.result.final_confidence = final.confidence_final;
  runtime.result.response = final.final;
  runtime.result.ai_output = { advice, explanation };
  runtime.userTurns = 2;
  finishResearch(runtime);
}
