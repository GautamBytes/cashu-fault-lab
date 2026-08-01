import type { LifecycleCapabilities } from '@cashu-fault-lab/wallet-lifecycle-contract';
import { describe, expect, test } from 'vitest';
import { LifecycleCompatibilityMatrix, type LifecycleMatrixParticipant } from '../src/index.js';

function participant(id: string, implementationId: string): LifecycleMatrixParticipant {
  const capabilities: LifecycleCapabilities = {
    schemaVersion: 1,
    implementation: {
      id: implementationId,
      version: '1.0.0',
      language: implementationId === 'cdk' ? 'rust' : 'typescript',
      runtime: implementationId === 'cdk' ? 'rust-1.97' : 'node-24',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      buildDigest: `sha256:${'b'.repeat(64)}`,
    },
    operations: ['mint', 'melt'],
    nuts: [4, 5, 7, 9, 19, 23],
    durability: 'restart_safe',
    recovery: ['quote_state', 'proof_state', 'nut09_restore', 'nut19_replay'],
    mints: [{ id: 'nutshell-local', implementation: 'nutshell' }],
  };
  return { id, capabilities };
}

describe('lifecycle compatibility matrix', () => {
  test('runs supported participants and marks missing operations N/A', async () => {
    const calls: string[] = [];
    const matrix = new LifecycleCompatibilityMatrix(async (entry) => {
      calls.push(entry.id);
      return { ok: true, evidence: { seed: '42' } };
    });
    const supported = participant('cashu-ts', 'cashu-ts');
    const partial = {
      ...participant('cdk', 'cdk'),
      capabilities: { ...participant('cdk', 'cdk').capabilities, operations: ['mint'] as const },
    };

    const results = await matrix.run(['mint', 'melt'], [supported, partial]);

    expect(results).toMatchObject([
      { id: 'cashu-ts', status: 'passed' },
      { id: 'cdk', status: 'not_applicable' },
    ]);
    expect(calls).toEqual(['cashu-ts']);
  });

  test('does not count aliases as independent implementations', () => {
    const matrix = new LifecycleCompatibilityMatrix(async () => ({ ok: true }));
    expect(() =>
      matrix.assertIndependent([
        participant('cashu-ts-a', 'cashu-ts'),
        participant('cashu-ts-b', 'cashu-ts'),
      ]),
    ).toThrow('distinct implementation identities');
    expect(() =>
      matrix.assertIndependent([participant('cashu-ts', 'cashu-ts'), participant('cdk', 'cdk')]),
    ).not.toThrow();
  });
});
