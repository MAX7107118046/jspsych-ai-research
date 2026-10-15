import { ParameterType } from 'jspsych';
import type { AIClient } from './core/client';
import type { ResearchSession } from './core/session';
import type { Agent, AIRequest, Completion, Connection, ContentPart, Delivery, Question, ResearchEvent, ResearchMode } from './core/types';
import type { ResearchConfiguration } from './research/types';
import type { MediaReference, SpeechClientLike, SpeechConfiguration } from './speech/types';

export interface AITrialOptions {
  research?: ResearchConfiguration | null;
  speech?: SpeechConfiguration | null;
  speech_client?: SpeechClientLike | null;
  persist_media?: ((blob: Blob, reference: MediaReference) => Promise<Partial<MediaReference>> | Partial<MediaReference>) | null;
  prompt?: string;
  system_prompt?: string;
  generation_prompt?: string;
  initial_message?: string | null;
  start_with_ai?: boolean;
  client?: Pick<AIClient, 'complete'> | null;
  connection?: Connection | null;
  session?: ResearchSession | null;
  memory_key?: string | null;
  history_window?: number;
  max_turns?: number;
  min_turns?: number;
  max_input_characters?: number;
  stream?: boolean;
  generation?: Pick<AIRequest, 'temperature' | 'maxTokens' | 'thinking' | 'extra'>;
  response_schema?: Record<string, unknown> | null;
  delivery?: Delivery;
  condition?: Record<string, unknown>;
  labels?: Partial<{ participant: string; assistant: string; send: string; finish: string }>;
  allow_regenerate?: boolean;
  presentation?: { delay_ms?: number; characters_per_second?: number; max_characters?: number; allow_pause?: boolean };
  questions?: Question[];
  generate_questions?: boolean;
  survey_feedback?: boolean;
  advice?: number | null;
  correct_answer?: number | null;
  candidates?: number;
  agents?: Agent[];
  turn_order?: 'sequential' | 'random';
  transfer_questions?: Question[];
  attachments?: { image?: boolean; audio?: boolean; record_audio?: boolean; max_bytes?: number };
  initial_attachments?: ContentPart[];
  trial_duration?: number | null;
  on_event?: ((event: ResearchEvent) => void) | null;
  persist?: ((data: Record<string, unknown>) => void | Promise<void>) | null;
  error_policy?: 'stop' | 'continue' | 'retry';
  max_retries?: number;
  response_required?: boolean;
}

export type AITrialInput = {
  [Key in keyof AITrialOptions]: Key extends 'on_event' | 'persist' | 'client' | 'session' | 'speech_client' | 'persist_media'
    ? AITrialOptions[Key] : AITrialOptions[Key] | (() => AITrialOptions[Key]);
};

const questionParameters = {
  name: { type: ParameterType.STRING, default: undefined },
  prompt: { type: ParameterType.STRING, default: undefined },
  type: { type: ParameterType.STRING, default: 'text' },
  required: { type: ParameterType.BOOL, default: false },
  options: { type: ParameterType.STRING, array: true, default: [] },
  min: { type: ParameterType.FLOAT, default: null },
  max: { type: ParameterType.FLOAT, default: null }
};

export const parameters = {
  research: { type: ParameterType.OBJECT, default: null },
  speech: { type: ParameterType.OBJECT, default: null },
  speech_client: { type: ParameterType.FUNCTION, default: null },
  persist_media: { type: ParameterType.FUNCTION, default: null },
  prompt: { type: ParameterType.HTML_STRING, default: '' },
  system_prompt: { type: ParameterType.STRING, default: '' },
  generation_prompt: { type: ParameterType.STRING, default: '' },
  initial_message: { type: ParameterType.STRING, default: null },
  start_with_ai: { type: ParameterType.BOOL, default: false },
  client: { type: ParameterType.FUNCTION, default: null },
  connection: { type: ParameterType.OBJECT, default: null },
  session: { type: ParameterType.FUNCTION, default: null },
  memory_key: { type: ParameterType.STRING, default: null },
  history_window: { type: ParameterType.INT, default: 30 },
  max_turns: { type: ParameterType.INT, default: 3 },
  min_turns: { type: ParameterType.INT, default: 0 },
  max_input_characters: { type: ParameterType.INT, default: 10000 },
  stream: { type: ParameterType.BOOL, default: true },
  generation: { type: ParameterType.OBJECT, default: {} },
  response_schema: { type: ParameterType.OBJECT, default: null },
  delivery: { type: ParameterType.OBJECT, default: { mode: 'live' } },
  condition: { type: ParameterType.OBJECT, default: {} },
  labels: { type: ParameterType.OBJECT, default: {} },
  allow_regenerate: { type: ParameterType.BOOL, default: true },
  presentation: { type: ParameterType.OBJECT, default: {} },
  questions: { type: ParameterType.COMPLEX, array: true, nested: questionParameters, default: [] },
  generate_questions: { type: ParameterType.BOOL, default: false },
  survey_feedback: { type: ParameterType.BOOL, default: false },
  advice: { type: ParameterType.FLOAT, default: null },
  correct_answer: { type: ParameterType.FLOAT, default: null },
  candidates: { type: ParameterType.INT, default: 3 },
  agents: { type: ParameterType.COMPLEX, array: true, nested: {
    id: { type: ParameterType.STRING, default: undefined },
    label: { type: ParameterType.STRING, default: 'AI' },
    system_prompt: { type: ParameterType.STRING, default: '' },
    client: { type: ParameterType.FUNCTION, default: null }
  }, default: [] },
  turn_order: { type: ParameterType.STRING, default: 'sequential' },
  transfer_questions: { type: ParameterType.COMPLEX, array: true, nested: questionParameters, default: [] },
  attachments: { type: ParameterType.OBJECT, default: {} },
  initial_attachments: { type: ParameterType.OBJECT, array: true, default: [] },
  trial_duration: { type: ParameterType.INT, default: null },
  on_event: { type: ParameterType.FUNCTION, default: null },
  persist: { type: ParameterType.FUNCTION, default: null },
  error_policy: { type: ParameterType.STRING, default: 'stop' },
  max_retries: { type: ParameterType.INT, default: 1 },
  response_required: { type: ParameterType.BOOL, default: false }
};

export const FEATURE_DEFINITIONS: Array<{ mode: ResearchMode; title: string; description: string }> = [
  { mode: 'chat', title: 'AI 对话', description: '参与者输入与多轮回复' },
  { mode: 'interview', title: '追问访谈', description: 'AI 提问、参与者回答与连续追问' },
  { mode: 'survey', title: '结构化问卷', description: '固定问题或 AI 生成问题与填写反馈' },
  { mode: 'feedback', title: '个性化反馈', description: '根据实验上下文生成并呈现反馈' },
  { mode: 'advice', title: '建议采纳', description: '初始判断、AI 建议与最终判断' },
  { mode: 'generate', title: '多方案生成', description: '多个候选方案及参与者选择' },
  { mode: 'coedit', title: '共同创作', description: 'AI 草稿、参与者编辑与修改请求' },
  { mode: 'learning', title: '学习辅导', description: '对话辅导及独立迁移测验' },
  { mode: 'multiagent', title: '多代理互动', description: '角色配置、讨论顺序与发言记录' }
];

export interface CallRecord {
  id: number;
  agent_id?: string;
  request: AIRequest;
  source: Delivery['mode'];
  status: 'pending' | 'complete' | 'error' | 'cancelled';
  result?: Completion;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  started_ms: number;
  ended_ms?: number;
}
