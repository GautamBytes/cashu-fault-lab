import { createHash } from 'node:crypto';

export interface RetryDelayInput {
  readonly attempt: number;
  readonly random: () => number;
  readonly baseMs?: number;
  readonly capMs?: number;
}

export function retryDelay(input: RetryDelayInput): number {
  const baseMs = input.baseMs ?? 250;
  const capMs = input.capMs ?? 30_000;
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    throw new Error('Retry attempt must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(capMs) || capMs < 1) {
    throw new Error('Retry bounds must be positive safe integers');
  }
  const sample = input.random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('Retry random sample must be between zero and one');
  }
  const exponent = Math.min(input.attempt, 30);
  const maximum = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.floor(maximum * sample);
}

export function createSeededRandom(seed: string): () => number {
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('Retry seed is required');
  let counter = 0;
  return () => {
    const digest = createHash('sha256')
      .update('cashu-fault-lab/retry-v1\0', 'utf8')
      .update(seed, 'utf8')
      .update('\0', 'utf8')
      .update(String(counter), 'utf8')
      .digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}
