export const PLUGIN_VERSION = '0.3.0';
export const DATA_VERSION = 'AIResearchData.v1';
export const JSPSYCH_VERSION = '7.3.4';

export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
export type Provider = 'deepseek' | 'minimax' | 'custom';
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface Thinking { mode?: 'auto' | 'on' | 'off'; effort?: ThinkingEffort }
export type SchemaMode = 'native' | 'json-object' | 'prompt-json';
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; url: string; mimeType?: string } | { type: 'audio'; data: string; mimeType: string };
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
  agentId?: string;
}
export interface Capabilities { stream: boolean; structured: boolean; image: boolean; audio: boolean }
export interface Connection {
  protocol: Protocol;
  baseURL: string;
  model: string;
  provider?: Provider;
  account?: 'm-plan' | 'payg' | 'unknown';
  thinking?: Thinking;
  schemaMode?: SchemaMode;
  apiKey?: string;
  headers?: Record<string, string>;
  capabilities?: Partial<Capabilities>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  extra?: Record<string, unknown>;
}
export interface AIRequest {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  thinking?: Thinking;
  schema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export interface AIResult {
  text: string;
  model: string;
  id?: string;
  usage?: Record<string, unknown>;
  finishReason?: string;
  data?: unknown;
  media?: Array<{ type: 'image' | 'audio'; url: string }>;
  metadata?: Record<string, unknown>;
}
export interface TransportContext { signal: AbortSignal; onDelta: (text: string) => void }
export type Transport = (request: AIRequest, context: TransportContext) => Promise<AIResult>;
export interface Completion extends AIResult {
  requestMs: number;
  firstTokenMs: number | null;
  attempts: number;
  requestedModel: string;
}
export interface ClientOptions {
  connection?: Connection;
  transport?: Transport;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
}
export interface CompleteOptions { signal?: AbortSignal; onDelta?: (text: string) => void }
export type ResearchMode = 'chat' | 'interview' | 'survey' | 'feedback' | 'advice' | 'generate' | 'coedit' | 'learning' | 'multiagent';
export interface Material { text: string; model?: string; agentId?: string; sourceParticipant?: string; data?: unknown }
export interface Delivery {
  mode: 'live' | 'pregenerated' | 'replay' | 'yoked';
  materials?: Material[];
  sourceParticipant?: string;
}
export interface ResearchEvent { type: string; time: number; detail: unknown; phase?: string; phase_id?: number; speech_turn_id?: string | null }
export interface Question {
  name: string;
  prompt: string;
  type?: 'text' | 'number' | 'choice' | 'scale';
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}
export interface Agent {
  id: string;
  label: string;
  system_prompt: string;
  client?: { complete(request: AIRequest, options?: CompleteOptions): Promise<Completion> };
}

export class AIError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AIError';
  }
}
