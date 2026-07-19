import type { Event } from 'nostr-tools';

export type NostrFaultAction =
  'duplicate_publish' | 'drop_ok' | 'delay_history' | 'reorder_history' | 'disconnect';

export interface NostrFaultRuleInput {
  readonly action: NostrFaultAction;
  readonly count?: number;
  readonly occurrence?: number;
  readonly kind?: number;
  readonly duplicateCount?: number;
  readonly delayMs?: number;
}

export interface NostrFaultRule extends NostrFaultRuleInput {
  readonly id: string;
  readonly count: number;
}

export interface NostrFaultRuleEvidence {
  readonly id: string;
  readonly action: NostrFaultAction;
  readonly remaining: number;
  readonly applied: number;
}

export interface NostrFaultEvidence {
  readonly publishAttempts: number;
  readonly historyQueries: number;
  readonly rules: readonly NostrFaultRuleEvidence[];
}

interface StoredRule {
  readonly rule: NostrFaultRule;
  remaining: number;
  applied: number;
}

const ACTIONS = new Set<NostrFaultAction>([
  'duplicate_publish',
  'drop_ok',
  'delay_history',
  'reorder_history',
  'disconnect',
]);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = 10_000,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum.toLocaleString('en-US')}`);
  }
  return result;
}

function validateRule(id: string, input: NostrFaultRuleInput): NostrFaultRule {
  if (!ACTIONS.has(input.action)) throw new Error('Nostr fault action is invalid');
  const count = boundedInteger(input.count, 1, 'Fault count');
  if (input.occurrence !== undefined) boundedInteger(input.occurrence, 1, 'Fault occurrence');
  if (
    input.kind !== undefined &&
    (!Number.isSafeInteger(input.kind) || input.kind < 0 || input.kind > 65_535)
  ) {
    throw new Error('Nostr fault kind is invalid');
  }
  if (input.action === 'duplicate_publish') {
    boundedInteger(input.duplicateCount, 1, 'Duplicate count', 100);
  } else if (input.duplicateCount !== undefined) {
    throw new Error('Duplicate count requires duplicate_publish');
  }
  if (input.action === 'delay_history') {
    if (
      input.delayMs === undefined ||
      !Number.isSafeInteger(input.delayMs) ||
      input.delayMs < 0 ||
      input.delayMs > 300_000
    ) {
      throw new Error('History delay must be an integer from 0 to 300,000 milliseconds');
    }
  } else if (input.delayMs !== undefined) {
    throw new Error('Delay requires delay_history');
  }
  return { ...structuredClone(input), id, count };
}

function phase(action: NostrFaultAction): 'publish' | 'history' {
  return action === 'delay_history' || action === 'reorder_history' ? 'history' : 'publish';
}

export class NostrFaultControl {
  readonly #rules: StoredRule[] = [];
  #nextId = 1;
  #publishAttempts = 0;
  #historyQueries = 0;

  setRule(input: NostrFaultRuleInput): string {
    const id = `nostr-rule-${this.#nextId}`;
    this.#nextId += 1;
    const rule = validateRule(id, input);
    this.#rules.push({ rule, remaining: rule.count, applied: 0 });
    return id;
  }

  takePublish(event: Event): readonly NostrFaultRule[] {
    this.#publishAttempts += 1;
    return this.#take('publish', this.#publishAttempts, event.kind);
  }

  takeHistory(): readonly NostrFaultRule[] {
    this.#historyQueries += 1;
    return this.#take('history', this.#historyQueries);
  }

  snapshot(): NostrFaultEvidence {
    return {
      publishAttempts: this.#publishAttempts,
      historyQueries: this.#historyQueries,
      rules: this.#rules.map(({ rule, remaining, applied }) => ({
        id: rule.id,
        action: rule.action,
        remaining,
        applied,
      })),
    };
  }

  #take(
    wantedPhase: 'publish' | 'history',
    ordinal: number,
    kind?: number,
  ): readonly NostrFaultRule[] {
    const matched: NostrFaultRule[] = [];
    for (const stored of this.#rules) {
      const { rule } = stored;
      if (stored.remaining < 1 || phase(rule.action) !== wantedPhase) continue;
      if (rule.occurrence !== undefined && rule.occurrence !== ordinal) continue;
      if (rule.kind !== undefined && rule.kind !== kind) continue;
      stored.remaining -= 1;
      stored.applied += 1;
      matched.push(rule);
    }
    return matched;
  }
}
