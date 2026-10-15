import { adviceMetrics } from './core/session';
import { AIError, type Completion, type Question } from './core/types';
import type { TrialRuntime } from './runtime';
import { element, questionForm } from './view';
import { initializeResearch } from './research/index';

const QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { questions: { type: 'array', minItems: 1, maxItems: 30, items: {
    type: 'object', additionalProperties: false, required: ['name', 'prompt', 'type', 'required', 'options', 'min', 'max'],
    properties: { name: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: ['text', 'number', 'choice', 'scale'] }, required: { type: 'boolean' },
      options: { type: 'array', items: { type: 'string' } }, min: { type: ['number', 'null'] }, max: { type: ['number', 'null'] } }
  } } }, required: ['questions']
};

function hideChat(runtime: TrialRuntime): void { runtime.view.controls.hidden = true; }

function startPrompt(runtime: TrialRuntime): string {
  return runtime.options.generation_prompt || runtime.options.prompt || '请根据研究任务开始。';
}

async function chat(runtime: TrialRuntime): Promise<void> {
  if (runtime.options.initial_message) {
    await runtime.showText(runtime.options.initial_message);
    runtime.history.push({ role: 'assistant', content: runtime.options.initial_message });
  }
  runtime.sendAction = async () => { runtime.takeInput(); await runtime.reply(); };
  if (runtime.options.start_with_ai) await runtime.reply(undefined, startPrompt(runtime));
  runtime.updateControls();
}

async function interview(runtime: TrialRuntime): Promise<void> {
  runtime.options.system_prompt = [runtime.options.system_prompt, '你是研究访谈员。每轮提出一个具体问题，结合已有回答追问。保持研究者给定的主题。'].filter(Boolean).join('\n');
  await chat(runtime);
}

async function feedback(runtime: TrialRuntime): Promise<void> {
  hideChat(runtime);
  await runtime.reply(undefined, startPrompt(runtime));
}

async function survey(runtime: TrialRuntime): Promise<void> {
  hideChat(runtime);
  let questions = runtime.options.questions ?? [];
  if (runtime.options.generate_questions) {
    const result = await runtime.request([{ role: 'user', content: `${startPrompt(runtime)}\n生成可填写的研究问题。为每题提供唯一 name。` }], undefined, undefined, QUESTION_SCHEMA);
    questions = (result.data as { questions: Question[] }).questions;
    runtime.result.generated_questions = questions;
  }
  if (!questions.length) throw new AIError('configuration', '问卷需要 questions 或 generate_questions');
  runtime.view.finish.disabled = true;
  runtime.finishBlocked = true;
  const form = questionForm(questions, '提交回答', (values, timings) => {
    runtime.result.response = values;
    runtime.result.question_timings = timings;
    runtime.responseWindows.push(performance.now() - runtime.readyAt);
    runtime.userTurns++;
    runtime.emit('survey_submit', { response: values, question_timings: timings });
    if (runtime.options.survey_feedback) {
      form.remove();
      void runtime.run(async () => {
        await runtime.reply(undefined, `请根据研究任务对以下回答提供反馈：${JSON.stringify(values)}`);
        runtime.finishBlocked = false;
        runtime.finishAction = () => runtime.finish();
        runtime.view.finish.disabled = false;
      });
    } else runtime.finish();
  });
  runtime.view.content.append(form);
  runtime.finishAction = () => { if (runtime.status !== 'complete') runtime.finish(); };
}

async function advice(runtime: TrialRuntime): Promise<void> {
  hideChat(runtime);
  runtime.view.finish.disabled = true;
  runtime.finishBlocked = true;
  const initialForm = questionForm([
    { name: 'initial', prompt: '你的初始判断', type: 'number', required: true },
    { name: 'confidence_initial', prompt: '初始判断的信心（0—100）', type: 'scale', min: 0, max: 100 }
  ], '获取建议', (values, timings) => {
    initialForm.remove();
    runtime.responseWindows.push(performance.now() - runtime.readyAt);
    runtime.userTurns++;
    runtime.result.initial_estimate = values.initial;
    runtime.result.initial_confidence = values.confidence_initial;
    runtime.result.initial_question_timings = timings;
    void runtime.run(async () => {
      let adviceValue = runtime.options.advice;
      let explanation = '';
      if (adviceValue == null) {
        const body = runtime.view.message(runtime.options.labels?.assistant ?? 'AI', '', 'assistant');
        const schema = { type: 'object', additionalProperties: false, required: ['advice', 'explanation'], properties: { advice: { type: 'number' }, explanation: { type: 'string' } } };
        const response = await runtime.request([{ role: 'user', content: `${startPrompt(runtime)}\n参与者初始判断：${values.initial}。提供数值建议及简短说明。` }], undefined, undefined, schema);
        const data = response.data as { advice: number; explanation: string };
        adviceValue = data.advice; explanation = data.explanation;
        body.textContent = `${adviceValue}\n${explanation}`;
      } else runtime.view.message(runtime.options.labels?.assistant ?? 'AI', String(adviceValue), 'assistant');
      if (!Number.isFinite(adviceValue)) throw new AIError('invalid_output', '建议必须为有限数值');
      runtime.result.advice = adviceValue;
      runtime.result.advice_explanation = explanation;
      runtime.emit('advice_presented', { advice: adviceValue });
      const finalForm = questionForm([
        { name: 'final', prompt: '你的最终判断', type: 'number', required: true },
        { name: 'confidence_final', prompt: '最终判断的信心（0—100）', type: 'scale', min: 0, max: 100 }
      ], '提交判断', (final, finalTimings) => {
        Object.assign(runtime.result, adviceMetrics(Number(values.initial), Number(final.final), Number(adviceValue), runtime.options.correct_answer));
        runtime.result.final_confidence = final.confidence_final;
        runtime.result.final_question_timings = finalTimings;
        runtime.result.response = final.final;
        runtime.responseWindows.push(performance.now() - runtime.readyAt);
        runtime.emit('advice_revision', runtime.result);
        runtime.finish();
      });
      runtime.view.content.append(finalForm);
      runtime.view.finish.disabled = true;
    });
  });
  runtime.view.content.append(initialForm);
  runtime.finishAction = () => { if (runtime.status !== 'complete') runtime.finish(); };
}

async function generate(runtime: TrialRuntime): Promise<void> {
  hideChat(runtime);
  const count = runtime.options.candidates ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new AIError('configuration', 'candidates 必须为 1 到 30 的整数');
  const area = element('div', 'ai-candidates');
  runtime.view.content.append(area);
  runtime.result.candidates = [];
  runtime.finishBlocked = runtime.options.response_required ?? false;
  for (let index = 0; index < count; index++) {
    const card = element('label', 'ai-candidate');
    const choice = element('input'); choice.type = 'radio'; choice.name = 'ai-candidate'; choice.value = String(index);
    const body = element('div', 'ai-message-text');
    choice.addEventListener('change', () => {
      runtime.result.selected_candidate = index;
      runtime.result.response = (runtime.result.candidates as Completion[])[index]?.text;
      runtime.responseWindows.push(performance.now() - runtime.readyAt);
      runtime.userTurns = 1;
      runtime.finishBlocked = false;
      runtime.emit('candidate_selected', { index });
      runtime.updateControls();
    });
    card.append(choice, element('strong', '', `方案 ${index + 1}`), body); area.append(card);
    const result = await runtime.request([{ role: 'user', content: `${startPrompt(runtime)}\n请生成方案 ${index + 1}，与已有方案保持差异。已有方案：${JSON.stringify((runtime.result.candidates as Completion[]).map(item => item.text))}` }], body);
    (runtime.result.candidates as Completion[]).push(result);
  }
  runtime.finishAction = () => {
    if (runtime.options.response_required && runtime.result.selected_candidate == null && runtime.status === 'complete') {
      runtime.view.status.textContent = '请选择一个方案'; return;
    }
    runtime.finish();
  };
}

async function coedit(runtime: TrialRuntime): Promise<void> {
  const draft = element('textarea', 'ai-draft'); draft.setAttribute('aria-label', '共同创作稿件');
  runtime.view.content.append(draft);
  runtime.view.input.placeholder = '输入修改要求';
  runtime.result.revisions = [];
  const save = (result: Completion) => {
    draft.value = result.text;
    runtime.result.document = result.text;
    (runtime.result.revisions as unknown[]).push({ author: 'ai', text: result.text, time: performance.now() - runtime.started });
  };
  draft.addEventListener('change', () => {
    runtime.result.document = draft.value;
    (runtime.result.revisions as unknown[]).push({ author: 'participant', text: draft.value, time: performance.now() - runtime.started });
    runtime.emit('document_edit', { characters: draft.value.length });
  });
  runtime.sendAction = async () => {
    const request = runtime.takeInput();
    await runtime.reply(undefined, `当前稿件：\n${draft.value}\n修改要求：${typeof request.content === 'string' ? request.content : JSON.stringify(request.content)}\n返回修改后的完整稿件。`, save);
  };
  runtime.finishAction = () => { runtime.result.document = draft.value; runtime.result.response = draft.value; runtime.finish(); };
  await runtime.reply(undefined, startPrompt(runtime), save);
}

async function learning(runtime: TrialRuntime): Promise<void> {
  runtime.options.system_prompt = [runtime.options.system_prompt, '你是学习辅导员。结合学习者回答提供提示、解释与练习反馈。'].filter(Boolean).join('\n');
  await chat(runtime);
  runtime.finishAction = () => {
    const questions = runtime.options.transfer_questions ?? [];
    if (!questions.length || runtime.status !== 'complete') { runtime.finish(); return; }
    runtime.disableAI();
    runtime.view.finish.hidden = true;
    runtime.emit('transfer_start');
    runtime.readyAt = performance.now();
    const form = questionForm(questions, '提交测验', (values, timings) => {
      runtime.result.transfer_response = values;
      runtime.result.transfer_question_timings = timings;
      runtime.result.transfer_rt = performance.now() - runtime.readyAt;
      runtime.emit('transfer_submit', { response: values });
      runtime.finish();
    });
    runtime.view.content.append(element('h3', '', '独立测验'), form);
  };
}

async function multiagent(runtime: TrialRuntime): Promise<void> {
  const agents = runtime.options.agents ?? [];
  if (!agents.length || new Set(agents.map(agent => agent.id)).size !== agents.length || agents.some(agent => !agent.id)) throw new AIError('configuration', '多代理需要至少一个角色，且角色 ID 唯一');
  runtime.result.agent_orders = [];
  let pendingOrder: typeof agents | null = null;
  let nextAgent = 0;
  const round = async (prompt?: string) => {
    if (!pendingOrder) {
      pendingOrder = runtime.options.turn_order === 'random' ? runtime.session.shuffle(agents) : agents;
      (runtime.result.agent_orders as string[][]).push(pendingOrder.map(agent => agent.id));
      runtime.emit('agent_order', { order: pendingOrder.map(agent => agent.id) });
      nextAgent = 0;
    }
    while (nextAgent < pendingOrder.length) { await runtime.reply(pendingOrder[nextAgent], nextAgent === 0 ? prompt : undefined); nextAgent++; }
    pendingOrder = null;
  };
  runtime.sendAction = async () => { runtime.takeInput(); await round(); };
  if (runtime.options.start_with_ai) await round(startPrompt(runtime));
}

export async function initializeFeature(runtime: TrialRuntime): Promise<void> {
  runtime.validate();
  if (runtime.options.research) { initializeResearch(runtime); return; }
  const initializers = { chat, interview, survey, feedback, advice, generate, coedit, learning, multiagent };
  await initializers[runtime.mode](runtime);
}
