import type { AIClient } from './client';
import type { AIRequest, Completion, Delivery, Material } from './types';
import { createReplayMaterials } from './session';

export async function pregenerateMaterials(client: Pick<AIClient, 'complete'>, requests: AIRequest[], options: { signal?: AbortSignal; sourceParticipant?: string } = {}): Promise<{ materials: Material[]; completions: Completion[] }> {
  const materials: Material[] = [];
  const completions: Completion[] = [];
  for (const request of requests) {
    options.signal?.throwIfAborted();
    const completion = await client.complete(request, { signal: options.signal });
    completions.push(completion);
    materials.push({ text: completion.text, model: completion.model, data: completion.data,
      agentId: typeof request.metadata?.agentId === 'string' ? request.metadata.agentId : undefined,
      sourceParticipant: options.sourceParticipant });
  }
  return { materials, completions };
}

export function createYokedDelivery(sourceParticipant: string, records: Parameters<typeof createReplayMaterials>[0]): Delivery {
  if (!sourceParticipant) throw new Error('配对回放需要来源参与者编号');
  return { mode: 'yoked', sourceParticipant, materials: createReplayMaterials(records, sourceParticipant) };
}
