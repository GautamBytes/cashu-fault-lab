export type HistoryPhase = 'invoked' | 'observation' | 'completed';
export type HistoryOutcome = 'passed' | 'failed';

export interface HistoryEvent {
  readonly sequence: number;
  readonly at: number;
  readonly phase: HistoryPhase;
  readonly actor: string;
  readonly event: string;
  readonly commandIndex?: number;
  readonly outcome?: HistoryOutcome;
  readonly data?: unknown;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'secret',
  'secrets',
  'proof',
  'proofs',
  'token',
  'tokens',
  'privatekey',
  'nsec',
  'blindingfactor',
  'witness',
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function redactString(value: string): string {
  if (/^(cashu[AB]|nsec1)/i.test(value)) return REDACTED;
  return value;
}

export function containsSensitiveData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return redactString(value) !== value;
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveData(item, seen));
  return Object.entries(value).some(
    ([key, item]) => SENSITIVE_KEYS.has(normalizedKey(key)) || containsSensitiveData(item, seen),
  );
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[REDACTED:CYCLE]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizedKey(key))) output[key] = REDACTED;
    else if (item !== undefined) output[key] = redact(item, seen);
  }
  return output;
}

export class HistoryRecorder {
  readonly #events: HistoryEvent[] = [];
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  record(input: Omit<HistoryEvent, 'sequence' | 'at'>): HistoryEvent {
    const event: HistoryEvent = {
      ...input,
      data: input.data === undefined ? undefined : redact(input.data),
      sequence: this.#events.length,
      at: this.#now(),
    };
    this.#events.push(event);
    return event;
  }

  snapshot(): readonly HistoryEvent[] {
    return this.#events.map((event) => structuredClone(event));
  }
}
