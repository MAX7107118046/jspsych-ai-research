import { AIError, type Question } from '../core/types';
import type { TrialRuntime } from '../runtime';
import { button, element, questionForm } from '../view';

export function heading(runtime: TrialRuntime, title: string): void {
  runtime.view.content.querySelector('.ai-phase-title')?.remove();
  runtime.view.content.prepend(element('h3', 'ai-phase-title', title));
}

export function taskPrompt(runtime: TrialRuntime): string {
  const container = element('div'); container.innerHTML = runtime.options.generation_prompt || runtime.options.prompt || '';
  return container.textContent ?? '';
}

export async function perform<Value>(runtime: TrialRuntime, action: () => Promise<Value>): Promise<Value> {
  let result: Value | undefined;
  let failure: unknown;
  await runtime.run(async () => { try { result = await action(); } catch (error) { failure = error; throw error; } });
  if (failure) throw failure;
  if (runtime.done) throw new AIError('cancelled', '试次已结束');
  return result as Value;
}

export function ask(runtime: TrialRuntime, phase: string, title: string, questions: Question[], submitText = '继续', decorate?: (form: HTMLFormElement) => void): Promise<Record<string, unknown>> {
  if (runtime.done) return Promise.reject(new AIError('cancelled', '试次已结束'));
  runtime.beginPhase(phase, true);
  heading(runtime, title);
  runtime.finishBlocked = true;
  runtime.updateControls();
  return new Promise((resolve, reject) => {
    const form = questionForm(questions, submitText, (values, timings) => {
      if (runtime.done) return;
      runtime.result.question_timings ??= {};
      (runtime.result.question_timings as Record<string, unknown>)[phase] = timings;
      runtime.endPhase(values);
      runtime.emit('research_response', { phase, values, timings });
      form.remove();
      resolve(values);
    });
    decorate?.(form);
    runtime.view.content.append(form);
    runtime.speechInput = text => {
      if (!form.isConnected || runtime.done) return;
      const input = form.querySelector<HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement>('textarea,input:not([type=hidden]),select');
      if (!input) return;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (questions.length === 1 && input.value) form.requestSubmit();
    };
    runtime.onCleanup(() => reject(new AIError('cancelled', '试次已结束')));
  });
}

export function action(runtime: TrialRuntime, title: string, delay = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const control = button(title, () => { control.remove(); resolve(); });
    control.disabled = delay > 0;
    runtime.view.content.append(control);
    const timer = setTimeout(() => { if (!runtime.done) control.disabled = false; }, Math.max(0, delay));
    runtime.onCleanup(() => { clearTimeout(timer); reject(new AIError('cancelled', '试次已结束')); });
  });
}

export function finishResearch(runtime: TrialRuntime): void {
  runtime.finishBlocked = false;
  runtime.endPhase();
  runtime.finish('complete');
}
