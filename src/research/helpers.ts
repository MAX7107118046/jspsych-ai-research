import type { ResearchConfiguration, ResearchGroup, TextEdit } from './types';
import { AIError, type ResearchMode } from '../core/types';

export function textEdit(previous: string, next: string): TextEdit | null {
  if (previous === next) return null;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) { previousEnd--; nextEnd--; }
  return { start, removed: previous.slice(start, previousEnd), inserted: next.slice(start, nextEnd) };
}

export function scoreAnswers(response: Record<string, unknown>, key: Record<string, string | number | Array<string | number>> = {}) {
  const items = Object.entries(response).map(([name, answer]) => {
    const expected = key[name];
    const normalized = String(answer ?? '').trim().toLowerCase();
    return { name, answer, correct: expected === undefined ? null : (Array.isArray(expected) ? expected : [expected]).some(value => String(value).trim().toLowerCase() === normalized) };
  });
  return { items, scored: items.filter(item => item.correct !== null).length, correct: items.filter(item => item.correct === true).length };
}

export function validateResearch(mode: ResearchMode, research: ResearchConfiguration): void {
  const modes: Record<ResearchGroup, ResearchMode[]> = {
    judgment: ['advice'], learning: ['learning'], interview: ['interview', 'survey'],
    creation: ['coedit', 'generate'], multiagent: ['multiagent'], multimodal: ['chat', 'feedback', 'survey']
  };
  if (!modes[research.group]?.includes(mode)) throw new AIError('configuration', '研究方向与插件类型不匹配');
  if (research.group === 'judgment' && research.response_type === 'choice' && !research.choices?.length) throw new AIError('configuration', '类别判断需要 choices');
  if (research.group === 'interview') {
    const topics = research.topics ?? [];
    const bank = research.bank ?? [];
    if (new Set(topics.map(topic => topic.id)).size !== topics.length || topics.some(topic => !topic.id)) throw new AIError('configuration', '访谈主题ID必须唯一');
    if (new Set(bank.map(question => question.id)).size !== bank.length || bank.some(question => !question.id)) throw new AIError('configuration', '题库问题ID必须唯一');
    if ((research.question_mode ?? 'bank') === 'bank' && !bank.length) throw new AIError('configuration', '题库模式需要 bank');
    if (research.question_mode === 'generated' && !topics.length) throw new AIError('configuration', '生成访谈需要 topics');
    if (topics.filter(topic => topic.required !== false).length > (research.max_questions ?? 10)) throw new AIError('configuration', '问题上限少于必问主题数');
  }
}

export function groupForMode(mode: ResearchMode): ResearchGroup {
  return ({ advice: 'judgment', learning: 'learning', interview: 'interview', survey: 'interview', coedit: 'creation', generate: 'creation', multiagent: 'multiagent', chat: 'multimodal', feedback: 'multimodal' } as const)[mode];
}
