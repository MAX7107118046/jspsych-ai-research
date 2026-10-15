import type { Question } from './core/types';

export function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text?: string): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const node = element('button', `ai-button ${className}`, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function questionForm(questions: Question[], submitText: string, submit: (values: Record<string, unknown>, timings: Record<string, number>) => void): HTMLFormElement {
  const form = element('form', 'ai-question-form');
  const started = performance.now();
  const focuses = new Map<string, number>();
  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const names = new Set<string>();
  for (const question of questions) {
    if (!question.name || names.has(question.name)) throw new Error('每个问题需要唯一的 name');
    names.add(question.name);
    const label = element('label', 'ai-question');
    label.append(element('span', '', question.prompt));
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (question.type === 'choice') {
      input = element('select');
      input.append(new Option('请选择', ''));
      for (const option of question.options ?? []) input.append(new Option(option, option));
    } else if (question.type === 'number' || question.type === 'scale') {
      input = element('input');
      input.type = 'number';
      input.step = question.type === 'scale' ? '1' : 'any';
      if (question.min != null) input.min = String(question.min);
      if (question.max != null) input.max = String(question.max);
    } else input = element('textarea');
    input.name = question.name;
    input.required = question.required ?? false;
    input.setAttribute('aria-label', question.prompt);
    input.addEventListener('focus', () => { if (!focuses.has(question.name)) focuses.set(question.name, performance.now()); });
    controls.set(question.name, input);
    label.append(input);
    form.append(label);
  }
  const next = element('button', 'ai-button', submitText);
  next.type = 'submit';
  form.append(next);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (next.disabled || !form.reportValidity()) return;
    const values: Record<string, unknown> = {};
    const timings: Record<string, number> = {};
    const now = performance.now();
    for (const question of questions) {
      const input = controls.get(question.name)!;
      values[question.name] = !input.value ? null : ['number', 'scale'].includes(question.type ?? '') ? Number(input.value) : input.value;
      timings[question.name] = now - (focuses.get(question.name) ?? started);
    }
    next.disabled = true;
    submit(values, timings);
  });
  return form;
}

export class TrialView {
  root = element('section', 'ai-research');
  content = element('div', 'ai-content');
  transcript = element('div', 'ai-transcript');
  status = element('p', 'ai-status');
  controls = element('div', 'ai-controls');
  footer = element('div', 'ai-footer');
  input = element('textarea', 'ai-input');
  send: HTMLButtonElement;
  finish: HTMLButtonElement;
  cancel: HTMLButtonElement;

  constructor(display: HTMLElement, options: { prompt: string; send: string; finish: string }, actions: { send: () => void; finish: () => void; cancel: () => void }) {
    this.root.dataset.aiResearch = 'true';
    const stimulus = element('div', 'ai-prompt');
    stimulus.innerHTML = options.prompt;
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.transcript.setAttribute('aria-label', '对话记录');
    this.input.rows = 3;
    this.input.placeholder = '输入你的回答';
    this.input.setAttribute('aria-label', '你的回答');
    this.send = button(options.send, actions.send);
    this.finish = button(options.finish, actions.finish);
    this.cancel = button('取消请求', actions.cancel, 'ai-secondary');
    this.cancel.hidden = true;
    this.controls.append(this.input, this.send);
    this.footer.append(this.cancel, this.finish);
    this.root.append(stimulus, this.content, this.transcript, this.status, this.controls, this.footer);
    display.replaceChildren(this.root);
  }

  message(label: string, text: string, role: string): HTMLDivElement {
    const card = element('article', `ai-message ai-message-${role}`);
    card.dataset.role = role;
    const body = element('div', 'ai-message-text', text);
    card.append(element('strong', 'ai-speaker', label), body);
    this.transcript.append(card);
    return body;
  }

  busy(value: boolean): void {
    this.root.setAttribute('aria-busy', String(value));
    this.input.disabled = value;
    this.send.disabled = value;
    this.finish.disabled = value;
    this.cancel.hidden = !value;
    if (value) this.status.textContent = '正在生成…';
    else this.status.textContent = '';
  }
}
