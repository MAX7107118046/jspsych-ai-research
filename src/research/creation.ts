import { AIError } from '../core/types';
import type { TrialRuntime } from '../runtime';
import { button, element } from '../view';
import type { CreationResearch } from './types';
import { textEdit } from './helpers';
import { ask, finishResearch, heading, perform, taskPrompt } from './ui';

interface Suggestion { id: string; original: string; replacement: string; reason: string }

async function compare(runtime: TrialRuntime, config: CreationResearch): Promise<void> {
  runtime.beginPhase('candidate_generation');
  const candidates: string[] = [];
  for (let index = 0; index < (runtime.options.candidates ?? 3); index++) {
    const result = await perform(runtime, () => runtime.request([{ role: 'user', content: `${taskPrompt(runtime)}\n生成第 ${index + 1} 个方案，与这些已有方案保持差异：${JSON.stringify(candidates)}` }]));
    candidates.push(result.text);
  }
  runtime.result.candidates = candidates;
  const mode = config.comparison ?? 'select';
  const questions = [
    ...(mode === 'select' ? [{ name: 'selected', prompt: '选择一个方案', type: 'choice' as const, required: true, options: candidates.map((text, index) => String(index + 1)) }] : []),
    ...candidates.flatMap((text, index) => [
      ...(mode.includes('rank') ? [{ name: `rank_${index + 1}`, prompt: `方案 ${index + 1} 排名（1 最优）`, type: 'number' as const, required: true, min: 1, max: candidates.length }] : []),
      ...(mode.includes('rate') ? [{ name: `rating_${index + 1}`, prompt: `方案 ${index + 1} 评分（0—100）`, type: 'scale' as const, required: true, min: 0, max: 100 }] : [])
    ])
  ];
  const response = await ask(runtime, 'candidate_comparison', '比较方案', questions, '提交比较', form => {
    const previews = element('div', 'ai-candidates');
    candidates.forEach((text, index) => {
      const card = element('details', 'ai-candidate'); card.open = true;
      card.append(element('summary', '', `方案 ${index + 1}`), element('p', '', text));
      card.addEventListener('toggle', () => runtime.emit('candidate_view', { index, open: card.open })); previews.append(card);
      runtime.emit('candidate_presented', { index, text });
    });
    form.prepend(previews);
    form.addEventListener('submit', event => {
      if (mode.includes('rank')) {
        const ranks = candidates.map((text, index) => Number((form.elements.namedItem(`rank_${index + 1}`) as HTMLInputElement).value));
        if (new Set(ranks).size !== candidates.length || ranks.some(rank => !Number.isInteger(rank))) { event.preventDefault(); event.stopImmediatePropagation(); runtime.view.status.textContent = '请为每个方案填写不同的整数排名'; }
      }
    }, { capture: true });
  });
  runtime.result.candidate_comparison = response;
  const selected = response.selected ? Number(response.selected) - 1 : mode.includes('rank') ? candidates.findIndex((text, index) => Number(response[`rank_${index + 1}`]) === 1) : candidates.reduce((best, text, index) => Number(response[`rating_${index + 1}`]) > Number(response[`rating_${best + 1}`]) ? index : best, 0);
  runtime.result.selected_candidate = selected;
  runtime.result.final_draft = candidates[selected];
  runtime.result.response = candidates[selected]; runtime.userTurns++;
  finishResearch(runtime);
}

export async function creationResearch(runtime: TrialRuntime, config: CreationResearch): Promise<void> {
  if (runtime.mode === 'generate') { await compare(runtime, config); return; }
  let draft = config.initial_draft ?? '';
  if (config.start === 'ai') {
    runtime.beginPhase('initial_generation');
    draft = (await perform(runtime, () => runtime.request([{ role: 'user', content: `${taskPrompt(runtime)}\n写出可继续修改的初稿。` }]))).text;
  } else if ((config.start ?? 'participant') === 'participant') {
    const response = await ask(runtime, 'initial_draft', '写下初稿', [{ name: 'draft', prompt: '初稿', required: true }], '开始共同创作');
    draft = String(response.draft);
  }
  runtime.result.initial_draft = draft;
  const revisions: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  runtime.result.revisions = revisions; runtime.result.suggestion_decisions = decisions;
  runtime.beginPhase('coediting', true); heading(runtime, '共同创作');
  const editor = element('textarea', 'ai-draft'); editor.rows = 12; editor.value = draft; editor.setAttribute('aria-label', '共同创作稿件');
  const panel = element('div', 'ai-suggestions');
  let last = draft;
  const snapshot = (source: string) => {
    const current = editor.value;
    if (current !== last) {
      const revision = { source, time: performance.now() - runtime.started, ...textEdit(last, current), draft: current };
      revisions.push(revision); runtime.emit('draft_revision', revision); last = current;
    }
    runtime.result.final_draft = current;
  };
  editor.addEventListener('input', () => snapshot('participant'));
  runtime.speechInput = text => { editor.value += text; snapshot('speech'); };
  runtime.onCleanup(() => snapshot('submit'));
  let pending = 0;
  let revisionRounds = 0;
  let choose: (value: 'ai' | 'finish') => void = () => {};
  const request = button('请求修改建议', () => choose('ai'));
  const submit = button('提交最终稿', () => { snapshot('submit'); if (editor.value.trim()) choose('finish'); else runtime.view.status.textContent = '请填写最终稿'; });
  runtime.view.content.append(editor, panel, request, submit);
  runtime.controlsGuard = () => {
    request.disabled = runtime.busy || (config.turn_order === 'alternating' && pending > 0);
    submit.disabled = runtime.busy || revisionRounds < (config.minimum_revisions ?? 0);
  };
  runtime.updateControls();
  while (!runtime.done) {
    const command = await new Promise<'ai' | 'finish'>((resolve, reject) => { choose = resolve; runtime.onCleanup(() => reject(new AIError('cancelled', '试次已结束'))); });
    snapshot(command);
    if (command === 'finish') break;
    runtime.beginPhase('revision_generation');
    if (config.suggestion_mode === 'replace') {
      const output = await perform(runtime, () => runtime.request([{ role: 'user', content: `${taskPrompt(runtime)}\n修改这篇稿件，返回完整修改稿：\n${editor.value}` }]));
      panel.replaceChildren(); pending = 1;
      const original = editor.value;
      const replacement = output.text;
      panel.append(element('p', '', replacement));
      const decide = (decision: string, value?: string) => {
        if (value != null) { editor.value = value; snapshot(decision); }
        decisions.push({ round: revisionRounds, id: 'replacement', decision, original, replacement, applied: value ?? null, time: performance.now() - runtime.started });
        panel.replaceChildren(); pending = 0; runtime.updateControls();
      };
      panel.append(button('接受修改稿', () => decide('accepted', replacement)), button('保留原稿', () => decide('rejected')));
    } else {
      const output = await perform(runtime, () => runtime.request([{ role: 'user', content: `${taskPrompt(runtime)}\n针对以下稿件提供最多五条局部修改建议。original 必须逐字引用稿件中的连续片段，并且在稿件中仅出现一次。\n${editor.value}` }], undefined, undefined,
        { type: 'object', additionalProperties: false, required: ['suggestions'], properties: { suggestions: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['id', 'original', 'replacement', 'reason'], properties: { id: { type: 'string' }, original: { type: 'string', minLength: 1 }, replacement: { type: 'string' }, reason: { type: 'string' } } } } } }));
      panel.replaceChildren();
      const suggestions = (output.data as { suggestions: Suggestion[] }).suggestions;
      pending = suggestions.length;
      for (const suggestion of suggestions) {
        const card = element('article', 'ai-suggestion');
        const partial = element('textarea'); partial.value = suggestion.replacement; partial.setAttribute('aria-label', `部分采纳 ${suggestion.id}`);
        const decide = (decision: string, replacement?: string) => {
          const found = editor.value.indexOf(suggestion.original);
          if (replacement != null && (found < 0 || editor.value.indexOf(suggestion.original, found + 1) >= 0)) { runtime.view.status.textContent = '原文已修改或存在多处匹配，请在稿件中手动调整，或拒绝本条建议'; return; }
          if (replacement != null) { editor.value = editor.value.slice(0, found) + replacement + editor.value.slice(found + suggestion.original.length); snapshot(decision); }
          const entry = { ...suggestion, round: revisionRounds, decision, applied: replacement ?? null, time: performance.now() - runtime.started };
          decisions.push(entry); runtime.emit('suggestion_decision', entry); card.remove(); pending--; runtime.updateControls();
        };
        card.append(element('p', '', `${suggestion.original} → ${suggestion.replacement}`), element('p', '', suggestion.reason), partial,
          button('接受', () => decide('accepted', suggestion.replacement)), button('拒绝', () => decide('rejected')), button('部分采纳', () => decide('partial', partial.value)));
        panel.append(card);
      }
    }
    revisionRounds++; runtime.result.revision_rounds = revisionRounds;
    runtime.beginPhase('coediting', true); runtime.updateControls();
  }
  snapshot('submit');
  runtime.result.unresolved_suggestions = pending;
  runtime.result.response = editor.value; runtime.userTurns++;
  runtime.controlsGuard = () => {};
  finishResearch(runtime);
}
