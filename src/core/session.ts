import type { Message, Material } from './types';

export class ResearchSession {
  readonly id: string;
  readonly seed: number;
  private randomState: number;
  private histories = new Map<string, Message[]>();

  constructor(options: { id?: string; seed?: number } = {}) {
    this.id = options.id ?? globalThis.crypto.randomUUID();
    this.seed = options.seed ?? 1;
    if (!Number.isSafeInteger(this.seed)) throw new Error('seed 必须为整数');
    this.randomState = this.seed >>> 0 || 1;
    this.history = this.history.bind(this);
    this.append = this.append.bind(this);
    this.clear = this.clear.bind(this);
    this.shuffle = this.shuffle.bind(this);
    this.snapshot = this.snapshot.bind(this);
  }

  history(key: string): Message[] { return structuredClone(this.histories.get(key) ?? []); }

  append(key: string, messages: Message[]): void {
    this.histories.set(key, [...this.history(key), ...structuredClone(messages)]);
  }

  clear(key?: string): void { if (key === undefined) this.histories.clear(); else this.histories.delete(key); }

  shuffle<Value>(values: readonly Value[]): Value[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
      this.randomState ^= this.randomState << 13;
      this.randomState ^= this.randomState >>> 17;
      this.randomState ^= this.randomState << 5;
      const target = Math.floor((this.randomState >>> 0) / 4294967296 * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  snapshot(): { id: string; seed: number; randomState: number; histories: Record<string, Message[]> } {
    return { id: this.id, seed: this.seed, randomState: this.randomState, histories: Object.fromEntries(this.histories) };
  }

  static restore(snapshot: ReturnType<ResearchSession['snapshot']>): ResearchSession {
    const session = new ResearchSession({ id: snapshot.id, seed: snapshot.seed });
    session.randomState = snapshot.randomState;
    session.histories = new Map(Object.entries(structuredClone(snapshot.histories)));
    return session;
  }
}

export function createResearchSession(options?: ConstructorParameters<typeof ResearchSession>[0]): ResearchSession {
  return new ResearchSession(options);
}

export function adviceMetrics(initial: number, final: number, advice: number, correct?: number | null) {
  const denominator = advice - initial;
  return {
    initial_estimate: initial, final_estimate: final, advice,
    weight_of_advice: denominator === 0 ? null : (final - initial) / denominator,
    advice_distance: Math.abs(advice - initial), revision: final - initial,
    initial_error: correct == null ? null : Math.abs(initial - correct),
    final_error: correct == null ? null : Math.abs(final - correct)
  };
}

export function createReplayMaterials(records: Array<{ ai_calls?: Array<{ result?: { text: string; model?: string; data?: unknown }; agent_id?: string }> }>, sourceParticipant?: string): Material[] {
  return records.flatMap(record => (record.ai_calls ?? []).filter(call => call.result).map(call => ({
    text: call.result!.text, model: call.result!.model, data: call.result!.data,
    agentId: call.agent_id, sourceParticipant
  })));
}

export function assignCondition<Value>(participantIndex: number, conditions: readonly Value[]): Value {
  if (!Number.isSafeInteger(participantIndex) || participantIndex < 0 || !conditions.length) throw new Error('条件分配需要非负参与者序号和至少一个条件');
  return conditions[participantIndex % conditions.length];
}
