import type { AIRequest } from '../core/types';

export function mockResearchResponse(request: AIRequest, call = 1): string {
  const properties = request.schema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return `模拟模型回复 ${call}：可以比较证据，再决定采用哪些建议。`;
  if (properties.suggestions) {
    const last = String(request.messages.at(-1)?.content ?? '').split('\n').at(-1) || '把读过的书分享给邻居，让故事继续。';
    return JSON.stringify({ suggestions: [{ id: 'suggestion-1', original: last, replacement: `${last} 欢迎带上一本书，交换一段新故事。`, reason: '补充具体行动邀请。' }] });
  }
  const sample = (schema: Record<string, unknown>): unknown => {
    if (schema.enum) return (schema.enum as unknown[])[0];
    if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 65;
    if (schema.type === 'boolean') return true;
    if (schema.type === 'array') return [];
    if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([name, item]) => [name, sample(item)]));
    return '请描述你的实际经历。';
  };
  if (properties.position) return JSON.stringify({ position: '采用分阶段试点并保留独立完成任务的机会。', agrees: true, dissent: '' });
  return JSON.stringify(sample(request.schema!));
}
