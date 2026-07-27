import { developmentIdentity, type AdapterCapabilities } from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import { CompatibilityMatrix, type MatrixExecutor, type MatrixParticipant } from '../src/index.js';

function participant(
  id: string,
  role: 'sender' | 'receiver',
  status: 'supported' | 'unsupported' = 'supported',
): MatrixParticipant {
  const capabilities: AdapterCapabilities = {
    schemaVersion: 2,
    implementation: developmentIdentity({
      id,
      version: '1.0.0',
      language: 'typescript',
      runtime: 'node-24',
    }),
    roles: {
      [role]: {
        transports: ['http', 'nostr'],
        profiles: status === 'supported' ? ['delivery-v1'] : ['legacy-nut18'],
        durability: status === 'supported' ? 'restart_safe' : 'process',
        evidence: {
          tier: status === 'supported' ? 'T3' : 'T0',
          sources: ['adapter'],
        },
      },
    },
    nuts: [18],
    encodings: ['creqA'],
    mints: [],
  };
  return { id, capabilities };
}

describe('CompatibilityMatrix', () => {
  it('runs every supported sender/receiver pair and preserves evidence', async () => {
    const calls: string[] = [];
    const execute: MatrixExecutor = async (profile, sender, receiver) => {
      calls.push(`${profile}:${sender.id}:${receiver.id}`);
      return { ok: true, evidence: { credits: 1, settlements: 1 } };
    };
    const matrix = new CompatibilityMatrix(execute);

    const result = await matrix.run(
      'delivery-v1',
      [participant('sender-a', 'sender'), participant('sender-b', 'sender')],
      [participant('receiver-a', 'receiver')],
    );

    expect(result.map((entry) => entry.status)).toEqual(['passed', 'passed']);
    const first = result[0];
    expect(first?.status).toBe('passed');
    if (first?.status !== 'passed') throw new Error('Expected passing matrix result');
    expect(first.evidence).toEqual({ credits: 1, settlements: 1 });
    expect(first.senderCapabilities.implementation.id).toBe('sender-a');
    expect(first.receiverCapabilities.implementation.id).toBe('receiver-a');
    expect(first.invariants).toEqual([]);
    expect(first.mints).toEqual([]);
    expect(calls).toEqual(['delivery-v1:sender-a:receiver-a', 'delivery-v1:sender-b:receiver-a']);
  });

  it('reports unsupported capabilities as not applicable without executing them', async () => {
    const execute: MatrixExecutor = async () => {
      throw new Error('must not execute');
    };
    const result = await new CompatibilityMatrix(execute).run(
      'delivery-v1',
      [participant('cashu-ts', 'sender', 'unsupported')],
      [participant('reference', 'receiver')],
    );

    expect(result).toEqual([
      expect.objectContaining({
        status: 'not_applicable',
        reason: 'cashu-ts: delivery-v1 sender capability is not declared',
      }),
    ]);
  });

  it('reports a supported but unwired pair as not applicable instead of passing it', async () => {
    const result = await new CompatibilityMatrix(async () => ({
      ok: null,
      reason: 'No executable adapter pair is configured',
    })).run(
      'delivery-v1',
      [participant('sender-a', 'sender')],
      [participant('receiver-a', 'receiver')],
    );

    expect(result).toEqual([
      expect.objectContaining({
        status: 'not_applicable',
        reason: 'No executable adapter pair is configured',
      }),
    ]);
  });

  it('isolates the documented NUT-26 Nostr mismatch as an expected failure', async () => {
    const capability = (id: string, role: 'sender' | 'receiver'): MatrixParticipant => ({
      id,
      capabilities: {
        schemaVersion: 2,
        implementation: developmentIdentity({
          id,
          version: '1.0.0',
          language: 'typescript',
          runtime: 'node-24',
        }),
        roles: {
          [role]: {
            transports: ['nostr'],
            profiles: ['nut26-nostr'],
            durability: 'process',
            evidence: { tier: 'T0', sources: ['adapter'] },
          },
        },
        nuts: [18, 26],
        encodings: ['creqB'],
        mints: [],
      },
    });
    const result = await new CompatibilityMatrix(async () => ({
      ok: false,
      code: 'NUT26_NIP_MAPPING_MISMATCH',
      reason: 'NUT-26 NIP-04 raw key cannot be treated as NUT-18 NIP-17 delivery',
    })).run('nut26-nostr', [capability('cdk', 'sender')], [capability('cashu-ts', 'receiver')]);

    expect(result[0]).toMatchObject({
      status: 'expected_failure',
      code: 'NUT26_NIP_MAPPING_MISMATCH',
    });
  });
});
