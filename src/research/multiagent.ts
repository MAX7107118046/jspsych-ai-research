import { AIError, type Message } from '../core/types';
import type { TrialRuntime } from '../runtime';
import type { MultiAgentResearch } from './types';
import { ask, finishResearch, perform, taskPrompt } from './ui';

export async function multiagentResearch(runtime: TrialRuntime, config: MultiAgentResearch): Promise<void> {
  const agents = runtime.options.agents ?? [];
  if (agents.length < 2 || new Set(agents.map(agent => agent.id)).size !== agents.length) throw new AIError('configuration', '讨论需要至少两个不同 ID 的角色');
  const order = config.order?.length ? config.order.map(id => agents.find(agent => agent.id === id)!) : runtime.options.turn_order === 'random' ? runtime.session.shuffle(agents) : agents;
  if (order.length !== agents.length || order.some(agent => !agent) || new Set(order).size !== agents.length) throw new AIError('configuration', '发言顺序应包含每个角色一次');
  if (config.collect_participant !== false) runtime.result.participant_initial = await ask(runtime, 'participant_initial', '独立立场', [{ name: 'position', prompt: '讨论前，请独立写下你的看法', required: true }]);
  const independent: Array<{ agent_id: string; text: string }> = [];
  const discussion: Message[] = [];
  runtime.result.independent_answers = independent;
  runtime.result.agent_orders = [];
  runtime.beginPhase('agent_independent');
  for (const agent of agents) {
    const result = await perform(runtime, () => runtime.request([{ role: 'user', content: config.independent_prompt || `${taskPrompt(runtime)}\n独立作答。此阶段不参考其他角色或参与者的回答。` }], undefined, agent));
    independent.push({ agent_id: agent.id, text: result.text });
  }
  runtime.beginPhase('independent_presentation');
  for (const answer of independent) {
    await perform(runtime, () => runtime.showText(answer.text, agents.find(agent => agent.id === answer.agent_id)!.label));
    discussion.push({ role: 'assistant', content: answer.text, agentId: answer.agent_id });
  }
  if (runtime.result.participant_initial) discussion.push({ role: 'user', content: `参与者初始立场：${JSON.stringify(runtime.result.participant_initial)}` });
  for (let round = 0; round < (config.discussion_rounds ?? 1); round++) {
    runtime.beginPhase(`discussion_${round + 1}`);
    (runtime.result.agent_orders as string[][]).push(order.map(agent => agent.id));
    for (const agent of order) {
      const result = await perform(runtime, () => runtime.request([...discussion, { role: 'user', content: `请依据自己的角色回应讨论，说明赞同与分歧。第 ${round + 1} 轮。` }], undefined, agent));
      discussion.push({ role: 'assistant', content: result.text, agentId: agent.id });
      await perform(runtime, () => runtime.showText(result.text, agent.label));
      runtime.emit('agent_statement', { round: round + 1, agent_id: agent.id, text: result.text });
    }
  }
  runtime.result.discussion = structuredClone(discussion);
  if (config.consensus !== false) {
    runtime.beginPhase('consensus_proposal');
    const summary = await perform(runtime, () => runtime.request([...discussion, { role: 'user', content: '根据讨论提出一个具体共同方案，并列出仍未解决的分歧。该方案将交给每位角色分别表态。' }], undefined, undefined,
      { type: 'object', additionalProperties: false, required: ['proposal', 'unresolved'], properties: { proposal: { type: 'string' }, unresolved: { type: 'array', items: { type: 'string' } } } }));
    const proposal = summary.data as { proposal: string; unresolved: string[] };
    runtime.result.consensus_proposal = proposal;
    await perform(runtime, () => runtime.showText(proposal.proposal, '共同方案'));
    runtime.beginPhase('agent_final_positions');
    const positions: Array<Record<string, unknown>> = [];
    for (const agent of order) {
      const result = await perform(runtime, () => runtime.request([...discussion, { role: 'user', content: `共同方案：${proposal.proposal}\n未解决分歧：${JSON.stringify(proposal.unresolved)}\n给出讨论后的最终立场、是否赞同此共同方案，以及保留意见。允许继续持不同意见。` }], undefined, agent,
        { type: 'object', additionalProperties: false, required: ['position', 'agrees', 'dissent'], properties: { position: { type: 'string' }, agrees: { type: 'boolean' }, dissent: { type: 'string' } } }));
      const position = { agent_id: agent.id, ...(result.data as { position: string; agrees: boolean; dissent: string }) };
      positions.push(position);
      await perform(runtime, () => runtime.showText(`${position.position}\n${position.agrees ? '赞同共同方案' : '保留不同立场'}\n${position.dissent}`, agent.label));
    }
    runtime.result.final_positions = positions;
    runtime.result.consensus = !proposal.unresolved.length && positions.every(position => position.agrees === true && !String(position.dissent).trim());
  }
  runtime.result.participant_final = await ask(runtime, 'participant_final', '最终立场', [{ name: 'position', prompt: '讨论后，你的最终看法', required: true }], '提交最终立场');
  runtime.result.response = runtime.result.participant_final; runtime.userTurns++;
  runtime.history.push(...discussion);
  finishResearch(runtime);
}
