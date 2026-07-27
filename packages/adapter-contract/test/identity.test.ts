import { describe, expect, it } from 'vitest';
import { developmentIdentity, isDevelopmentIdentity } from '../src/index.js';

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
    expect(isDevelopmentIdentity(first)).toBe(true);
    expect(
      isDevelopmentIdentity({
        ...first,
        buildDigest: `sha256:${'1a'.repeat(32)}`,
      }),
    ).toBe(false);
  });
});
