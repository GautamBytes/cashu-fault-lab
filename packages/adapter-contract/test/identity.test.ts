import { describe, expect, it } from 'vitest';
import { developmentIdentity } from '../src/index.js';

describe('developmentIdentity', () => {
  it('derives deterministic, domain-separated source and build digests', () => {
    const input = {
      id: 'cashu-ts',
      version: '4.7.2',
      language: 'typescript',
      runtime: 'node-24',
    };

    const first = developmentIdentity(input);
    const second = developmentIdentity(input);

    expect(first).toEqual(second);
    expect(first.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.buildDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.sourceDigest).not.toBe(first.buildDigest);
  });
});
