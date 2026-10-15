import type { ResearchMode } from '../core/types';
export { mockResearchResponse } from './mock';
import type { AITrialOptions } from '../parameters';
import type { ResearchGroup } from './types';

export interface ResearchField { name: string; label: string; kind: 'text' | 'number' | 'boolean' | 'choice' | 'json'; options?: string[] }
export const RESEARCH_DEFINITIONS: Array<{ group: ResearchGroup; title: string; modes: ResearchMode[]; fields: ResearchField[] }> = [
  { group: 'judgment', title: '判断与建议采纳', modes: ['advice'], fields: [
    { name: 'response_type', label: '判断类型', kind: 'choice', options: ['number', 'choice'] }, { name: 'choices', label: '类别选项', kind: 'json' },
    { name: 'advice', label: '固定建议（留空时请求模型，类别建议填写 JSON 字符串）', kind: 'json' }, { name: 'correct_answer', label: '正确答案', kind: 'json' },
    { name: 'quality', label: '建议质量条件', kind: 'text' }, { name: 'source_label', label: '来源身份', kind: 'text' },
    { name: 'explanation_mode', label: '解释方式', kind: 'choice', options: ['none', 'brief', 'detailed'] }, { name: 'explanation', label: '固定建议解释', kind: 'text' },
    { name: 'help_timing', label: '帮助时机', kind: 'choice', options: ['after_initial', 'on_request', 'delayed'] }, { name: 'help_delay_ms', label: '帮助等待（毫秒）', kind: 'number' },
    { name: 'evidence', label: '证据材料（id、title、text、url）', kind: 'json' }, { name: 'evidence_questions', label: '核查题目', kind: 'json' }, { name: 'require_evidence', label: '要求逐条查看证据', kind: 'boolean' }
  ] },
  { group: 'learning', title: '学习与认知卸载', modes: ['learning'], fields: [
    { name: 'strategy', label: '辅导策略', kind: 'choice', options: ['answer', 'hints', 'socratic'] },
    ...['pretest', 'practice', 'posttest', 'transfer'].map((name, index) => ({ name, label: ['前测题目', '练习题目', '独立测验', '迁移测验'][index], kind: 'json' as const })),
    { name: 'hints', label: '固定提示阶梯', kind: 'json' }, { name: 'solution', label: '答案揭示材料', kind: 'text' }, { name: 'answer_key', label: '评分答案（题目 name 对应答案）', kind: 'json' }, { name: 'minimum_tutor_turns', label: '最少辅导次数', kind: 'number' }
  ] },
  { group: 'interview', title: '访谈与自适应提问', modes: ['interview', 'survey'], fields: [
    { name: 'question_mode', label: '题目来源', kind: 'choice', options: ['bank', 'generated'] }, { name: 'selection', label: '题库选题方式', kind: 'choice', options: ['sequential', 'rules', 'model'] },
    { name: 'topics', label: '提纲主题（id、title、required）', kind: 'json' }, { name: 'bank', label: '题库（id、topic_id、prompt、required、when）', kind: 'json' }, { name: 'allowed_followup_topics', label: '允许追问的主题 ID', kind: 'json' },
    { name: 'min_questions', label: '最少问题数', kind: 'number' }, { name: 'max_questions', label: '最多问题数', kind: 'number' }, { name: 'max_followups_per_topic', label: '每个主题最多追问', kind: 'number' },
    { name: 'finish_when_topics_covered', label: '满足必问主题后自动结束', kind: 'boolean' }, { name: 'allow_early_finish', label: '允许参与者在满足必问要求后结束', kind: 'boolean' }
  ] },
  { group: 'creation', title: '创造与共同创作', modes: ['coedit', 'generate'], fields: [
    { name: 'start', label: '起稿方式', kind: 'choice', options: ['participant', 'ai', 'fixed'] }, { name: 'initial_draft', label: '固定初稿', kind: 'text' },
    { name: 'turn_order', label: '修改顺序', kind: 'choice', options: ['alternating', 'free'] }, { name: 'suggestion_mode', label: '建议形式', kind: 'choice', options: ['suggestions', 'replace'] },
    { name: 'minimum_revisions', label: '最少 AI 修改轮数', kind: 'number' }, { name: 'comparison', label: '多方案比较', kind: 'choice', options: ['select', 'rank', 'rate', 'rank-rate'] }
  ] },
  { group: 'multiagent', title: '角色与多代理互动', modes: ['multiagent'], fields: [
    { name: 'independent_prompt', label: '共同独立作答任务', kind: 'text' }, { name: 'discussion_rounds', label: '讨论轮数', kind: 'number' }, { name: 'order', label: '发言角色 ID 顺序（空数组使用原生顺序）', kind: 'json' },
    { name: 'collect_participant', label: '收集参与者独立立场', kind: 'boolean' }, { name: 'consensus', label: '收集代理共识与保留意见', kind: 'boolean' }
  ] },
  { group: 'multimodal', title: '多模态互动', modes: ['chat', 'feedback', 'survey'], fields: [
    { name: 'materials', label: '文字、图片、音频材料', kind: 'json' }, { name: 'questions', label: '材料回答题目（留空使用对话）', kind: 'json' }
  ] }
];

export function researchDefaults(group: ResearchGroup, full = false): AITrialOptions {
  const question = (name: string, prompt: string) => ({ name, prompt, required: true });
  const defaults: Record<ResearchGroup, AITrialOptions> = {
    judgment: { prompt: '估计这次任务的成功概率（0—100）。', research: { group: 'judgment', response_type: 'number', advice: null, correct_answer: 70, source_label: 'AI 顾问', quality: '根据证据作答', explanation_mode: 'brief', help_timing: 'after_initial', evidence: full ? [{ id: 'sample', title: '历史记录', text: '相同条件下，100 次任务中有 70 次成功。' }] : [], evidence_questions: [], require_evidence: full } },
    learning: { prompt: '学习区分相关关系与因果关系。', research: { group: 'learning', strategy: 'hints', pretest: full ? [question('pre', '冰淇淋销量与溺水人数相关，能证明因果吗？')] : [], practice: [], posttest: [question('post', '请说明相关关系为何不足以证明因果。')], transfer: [question('transfer', '咖啡摄入与工作时长相关，如何解释？')], hints: full ? ['考虑是否存在共同影响两者的变量。', '气温可能同时影响冰淇淋销量和游泳人数。'] : [], solution: full ? '相关关系还可能来自混淆因素或反向因果，需要额外研究设计判断。' : '', minimum_tutor_turns: 1 } },
    interview: { prompt: '访谈主题：人们如何在日常决策中使用 AI。', research: { group: 'interview', question_mode: full ? 'generated' : 'bank', selection: 'sequential', topics: [{ id: 'experience', title: '使用经历', required: true }, ...(full ? [{ id: 'judgment', title: '信任与核查', required: true }] : [])], bank: [{ id: 'first', topic_id: 'experience', prompt: '请描述最近一次使用 AI 帮助决策的经历。', required: true }], allowed_followup_topics: ['experience', 'judgment'], min_questions: 1, max_questions: full ? 4 : 2, max_followups_per_topic: 1, finish_when_topics_covered: true, allow_early_finish: true } },
    creation: { prompt: '为社区图书馆设计一段鼓励读者参与旧书交换的文案。', research: { group: 'creation', start: full ? 'participant' : 'fixed', initial_draft: '把读过的书分享给邻居，让故事继续。', turn_order: 'alternating', suggestion_mode: 'suggestions', comparison: 'select', minimum_revisions: full ? 1 : 0 }, candidates: 3 },
    multiagent: { prompt: '讨论是否应在校园自习室引入 AI 学习助手。每次发言不超过80字。', agents: [{ id: 'benefit', label: '学习支持者', system_prompt: '重视便利与个性化学习，提供具体收益。' }, { id: 'skeptic', label: '独立思考倡导者', system_prompt: '重视独立思考与认知依赖，审慎看待全面使用。' }], research: { group: 'multiagent', discussion_rounds: 1, collect_participant: full, consensus: true } },
    multimodal: { prompt: '请根据材料讨论不同解释，每轮回复不超过80字。', research: { group: 'multimodal', materials: [{ type: 'image', url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="%23dfe8f2"/><circle cx="60" cy="50" r="25" fill="%23466c91"/><rect x="105" y="25" width="45" height="50" fill="%238b677d"/></svg>' }], questions: [] }, speech: full ? { enabled: true, input_mode: 'automatic', output: true, review_transcript: true, save_audio: false, language: 'zh', voice_id: 'male-qn-qingse' } : null, max_turns: 5 }
  };
  return structuredClone(defaults[group]);
}

