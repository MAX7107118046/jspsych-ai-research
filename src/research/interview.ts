import { AIError, type Message, type Question } from '../core/types';
import type { TrialRuntime } from '../runtime';
import type { InterviewQuestion, InterviewResearch } from './types';
import { ask, finishResearch, perform, taskPrompt } from './ui';

export async function interviewResearch(runtime: TrialRuntime, config: InterviewResearch): Promise<void> {
  const topics = config.topics ?? [...new Set(config.bank?.map(question => question.topic_id))].map(id => ({ id, title: id, required: true }));
  const required = topics.filter(topic => topic.required !== false).map(topic => topic.id);
  const answered = new Set<string>();
  const used = new Set<string>();
  const responses: Record<string, unknown> = {};
  const followups: Record<string, number> = {};
  const turns: Array<Record<string, unknown>> = [];
  const context: Message[] = [];
  const maximum = config.max_questions ?? 10;
  const minimum = config.min_questions ?? 1;
  let reason = 'max_questions';
  runtime.result.interview_turns = turns;
  const covered = () => required.every(topic => answered.has(topic)) && (config.question_mode === 'generated' || (config.bank ?? []).filter(question => question.required).every(question => used.has(question.id)));
  while (!runtime.done && turns.length < maximum) {
    let question: InterviewQuestion;
    let parent: string | null = null;
    if ((config.question_mode ?? 'bank') === 'bank') {
      const eligible = (config.bank ?? []).filter(item => !used.has(item.id) && (!item.when || String(responses[item.when.question_id]) === String(item.when.equals)))
        .filter(item => !item.when || (config.allowed_followup_topics ?? topics.map(topic => topic.id)).includes(item.topic_id))
        .filter(item => !item.when || (followups[item.topic_id] ?? 0) < (config.max_followups_per_topic ?? 2));
      if (!eligible.length) { reason = 'bank_exhausted'; break; }
      const mandatory = eligible.filter(item => item.required || !answered.has(item.topic_id) && required.includes(item.topic_id));
      const pool = mandatory.length ? mandatory : eligible;
      question = pool[0];
      if (config.selection === 'rules') question = pool.find(item => item.when) ?? pool[0];
      if (config.selection === 'model' && pool.length > 1) {
        runtime.beginPhase('question_selection');
        const completion = await perform(runtime, () => runtime.request([...context, { role: 'user', content: `从题库选择下一题，只返回 question_id。题库：${JSON.stringify(pool)}` }], undefined, undefined,
          { type: 'object', additionalProperties: false, required: ['question_id'], properties: { question_id: { type: 'string', enum: pool.map(item => item.id) } } }));
        question = pool.find(item => item.id === (completion.data as { question_id: string }).question_id)!;
      }
      parent = question.when?.question_id ?? null;
    } else {
      const missing = topics.filter(topic => required.includes(topic.id) && !answered.has(topic.id));
      const pool = missing.length ? missing : topics.filter(topic => (followups[topic.id] ?? 0) < (config.max_followups_per_topic ?? 2) && (config.allowed_followup_topics ?? topics.map(item => item.id)).includes(topic.id));
      if (!pool.length) { reason = covered() ? 'topics_covered' : 'followup_limit'; break; }
      runtime.beginPhase('question_generation');
      const completion = await perform(runtime, () => runtime.request([...context, { role: 'user', content: `${taskPrompt(runtime)}\n生成一个访谈问题。可用主题：${JSON.stringify(pool)}。${missing.length ? '本题覆盖尚未回答的必问主题。' : '围绕已有回答追问，范围仅限可用主题。'}每轮一个问题。` }], undefined, undefined,
        { type: 'object', additionalProperties: false, required: ['topic_id', 'question'], properties: { topic_id: { type: 'string', enum: pool.map(topic => topic.id) }, question: { type: 'string', minLength: 1 } } }));
      const output = completion.data as { topic_id: string; question: string };
      question = { id: `generated-${turns.length + 1}`, topic_id: output.topic_id, prompt: output.question };
      if (answered.has(question.topic_id)) parent = String([...turns].reverse().find(turn => turn.topic_id === question.topic_id)?.id ?? '');
    }
    if (parent) followups[question.topic_id] = (followups[question.topic_id] ?? 0) + 1;
    runtime.beginPhase('question_presentation');
    await perform(runtime, () => runtime.showText(question.prompt, '访谈员'));
    const canStop = Boolean(config.allow_early_finish && turns.length + 1 >= minimum && required.every(topic => answered.has(topic) || topic === question.topic_id));
    const fields: Question[] = [{ name: 'answer', prompt: question.prompt, required: true }];
    if (canStop) fields.push({ name: 'next_action', prompt: '提交本题后', type: 'choice', options: ['继续访谈', '结束访谈'] });
    const response = await ask(runtime, `interview_answer_${turns.length + 1}`, topics.find(topic => topic.id === question.topic_id)?.title ?? question.topic_id, fields, '提交回答');
    used.add(question.id); answered.add(question.topic_id); responses[question.id] = response.answer;
    const turn = { ...question, answer: response.answer, parent_id: parent, kind: parent ? 'followup' : 'outline', order: turns.length + 1 };
    turns.push(turn); runtime.emit('interview_answer', turn); runtime.userTurns++;
    context.push({ role: 'assistant', content: question.prompt }, { role: 'user', content: String(response.answer) });
    if (response.next_action === '结束访谈' && covered()) { reason = 'participant_stop'; break; }
    if ((config.finish_when_topics_covered ?? true) && turns.length >= minimum && covered()) { reason = 'topics_covered'; break; }
  }
  runtime.history.push(...context);
  runtime.result.covered_topics = [...answered];
  runtime.result.missing_required_topics = required.filter(topic => !answered.has(topic));
  runtime.result.unasked_questions = (config.bank ?? []).filter(question => !used.has(question.id)).map(question => ({ id: question.id, reason: question.when && String(responses[question.when.question_id]) !== String(question.when.equals) ? 'condition_not_met' : reason }));
  runtime.result.interview_end_reason = reason;
  runtime.result.response = responses;
  if (!turns.length) throw new AIError('configuration', '没有可提问的题目');
  finishResearch(runtime);
}
