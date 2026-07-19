import { describe, expect, it } from 'vitest';
import { createSeededRandom, retryDelay } from '../src/index.js';

describe('sender retry policy', () => {
  it('uses capped exponential full jitter', () => {
    expect(retryDelay({ attempt: 0, random: () => 1 })).toBe(250);
    expect(retryDelay({ attempt: 1, random: () => 1 })).toBe(500);
    expect(retryDelay({ attempt: 20, random: () => 1 })).toBe(30_000);
    expect(retryDelay({ attempt: 4, random: () => 0.5 })).toBe(2_000);
  });

  it('rejects invalid attempts and random samples', () => {
    expect(() => retryDelay({ attempt: -1, random: () => 0 })).toThrowError(/attempt/i);
    expect(() => retryDelay({ attempt: 1, random: () => -0.1 })).toThrowError(/random/i);
    expect(() => retryDelay({ attempt: 1, random: () => 1.1 })).toThrowError(/random/i);
  });

  it('derives reproducible pseudorandom sequences from a seed', () => {
    const first = createSeededRandom('retry-seed');
    const second = createSeededRandom('retry-seed');
    const different = createSeededRandom('other-seed');
    const sequence = Array.from({ length: 10 }, () => first());
    expect(Array.from({ length: 10 }, () => second())).toEqual(sequence);
    expect(Array.from({ length: 10 }, () => different())).not.toEqual(sequence);
    expect(sequence.every((sample) => sample >= 0 && sample < 1)).toBe(true);
  });
});
