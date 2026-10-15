import type { ContentPart, Question } from '../core/types';

export type ResearchGroup = 'judgment' | 'learning' | 'interview' | 'creation' | 'multiagent' | 'multimodal';
export interface EvidenceItem { id: string; title: string; text: string; url?: string }
export interface Topic { id: string; title: string; required?: boolean }
export interface InterviewQuestion { id: string; topic_id: string; prompt: string; required?: boolean; when?: { question_id: string; equals: string } }
export interface JudgmentResearch {
  group: 'judgment'; response_type?: 'number' | 'choice'; choices?: string[];
  advice?: number | string | null; correct_answer?: number | string | null;
  source_label?: string; quality?: string; explanation?: string; explanation_mode?: 'none' | 'brief' | 'detailed';
  help_timing?: 'after_initial' | 'on_request' | 'delayed'; help_delay_ms?: number;
  evidence?: EvidenceItem[]; evidence_questions?: Question[]; require_evidence?: boolean;
}
export interface LearningResearch {
  group: 'learning'; strategy?: 'answer' | 'hints' | 'socratic';
  pretest?: Question[]; practice?: Question[]; posttest?: Question[]; transfer?: Question[];
  hints?: string[]; solution?: string; answer_key?: Record<string, string | number | Array<string | number>>;
  minimum_tutor_turns?: number;
}
export interface InterviewResearch {
  group: 'interview'; question_mode?: 'bank' | 'generated'; selection?: 'sequential' | 'rules' | 'model';
  topics?: Topic[]; bank?: InterviewQuestion[]; allowed_followup_topics?: string[];
  max_questions?: number; min_questions?: number; max_followups_per_topic?: number;
  finish_when_topics_covered?: boolean; allow_early_finish?: boolean;
}
export interface CreationResearch {
  group: 'creation'; start?: 'participant' | 'ai' | 'fixed'; initial_draft?: string;
  turn_order?: 'alternating' | 'free'; suggestion_mode?: 'suggestions' | 'replace';
  comparison?: 'select' | 'rank' | 'rate' | 'rank-rate'; minimum_revisions?: number;
}
export interface MultiAgentResearch {
  group: 'multiagent'; independent_prompt?: string; discussion_rounds?: number;
  order?: string[]; collect_participant?: boolean; consensus?: boolean;
}
export interface MultimodalResearch {
  group: 'multimodal'; materials?: ContentPart[]; questions?: Question[];
}
export type ResearchConfiguration = JudgmentResearch | LearningResearch | InterviewResearch | CreationResearch | MultiAgentResearch | MultimodalResearch;
export interface PhaseRecord {
  id: number; name: string; started_ms: number; ended_ms?: number;
  participant: boolean; response?: unknown;
}
export interface TextEdit { start: number; removed: string; inserted: string }
