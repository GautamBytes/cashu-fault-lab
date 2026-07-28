import {
  currentAdapterContract,
  developmentIdentity,
  type AdapterCapabilities,
} from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import {
  CompatibilityMatrix,
  type MatrixExecutionResult,
  type MatrixExecutor,
  type MatrixParticipant,
} from '../src/index.js';

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
    expect(first.compatibility?.sender).toMatchObject({
      ok: true,
      warnings: [expect.objectContaining({ code: 'ADAPTER_CONTRACT_LEGACY' })],
    });
    expect(first.invariants).toEqual([]);
    expect(first.mints).toEqual([]);
    expect(first.scenarios).toEqual([]);
    expect(calls).toEqual(['delivery-v1:sender-a:receiver-a', 'delivery-v1:sender-b:receiver-a']);
  });

  it('clones per-scenario evidence into the passed matrix case', async () => {
    const scenarios = [
      {
        id: 'retry-response-lost',
        seed: 'pair-seed',
        status: 'passed' as const,
        requiredInvariants: ['retry-convergence' as const],
        invariants: [
          {
            id: 'retry-convergence' as const,
            status: 'passed' as const,
            confidence: 'observed' as const,
            evidence: [{ source: 'timeline' as const, description: 'Retry converged.' }],
          },
        ],
      },
    ];
    const execution = {
      ok: true,
      scenarios,
      releaseSuiteDigest: `sha256:${'ab'.repeat(32)}`,
    } as unknown as MatrixExecutionResult;
    const result = await new CompatibilityMatrix(async () => execution).run(
      'delivery-v1',
      [participant('sender-a', 'sender')],
      [participant('receiver-a', 'receiver')],
    );
    const selected = result[0];
    if (selected?.status !== 'passed') throw new Error('Expected passing matrix result');

    scenarios[0]!.status = 'failed' as 'passed';
    scenarios[0]!.invariants.splice(0);

    expect(selected.scenarios).toEqual([
      {
        id: 'retry-response-lost',
        seed: 'pair-seed',
        status: 'passed',
        requiredInvariants: ['retry-convergence'],
        invariants: [
          {
            id: 'retry-convergence',
            status: 'passed',
            confidence: 'observed',
            evidence: [{ source: 'timeline', description: 'Retry converged.' }],
          },
        ],
      },
    ]);
    expect(selected.releaseSuiteDigest).toBe(`sha256:${'ab'.repeat(32)}`);
  });

  it.each(['failed', 'not_applicable'] as const)(
    'fails a suite-backed matrix pair when a required scenario is %s and retains its diagnostics',
    async (scenarioStatus) => {
      const scenario = {
        id: 'retry-response-lost',
        seed: 'pair-seed',
        status: scenarioStatus,
        requiredInvariants: ['retry-convergence' as const],
        invariants: [],
        code: 'SCENARIO_EXECUTION_FAILED',
        reason: 'Required release scenario did not pass',
      };
      const result = await new CompatibilityMatrix(async () => ({
        ok: true,
        scenarios: [scenario],
        releaseSuiteDigest: `sha256:${'ab'.repeat(32)}`,
      })).run(
        'delivery-v1',
        [participant('sender-a', 'sender')],
        [participant('receiver-a', 'receiver')],
      );

      expect(result).toEqual([
        expect.objectContaining({
          status: 'failed',
          code: 'RELEASE_SUITE_NOT_PASSED',
          reason: expect.stringContaining('retry-response-lost'),
          scenarios: [scenario],
          releaseSuiteDigest: `sha256:${'ab'.repeat(32)}`,
        }),
      ]);
    },
  );

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

  it('rejects contract digest mismatches before executing a matrix pair', async () => {
    const sender = participant('sender-a', 'sender');
    const receiver = participant('receiver-a', 'receiver');
    const badDigest = `sha256:${'12'.repeat(32)}`;
    const result = await new CompatibilityMatrix(async () => {
      throw new Error('must not execute');
    }).run(
      'delivery-v1',
      [{ ...sender, capabilities: { ...sender.capabilities, contract: currentAdapterContract() } }],
      [
        {
          ...receiver,
          capabilities: {
            ...receiver.capabilities,
            contract: { ...currentAdapterContract(), specDigest: badDigest },
          },
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({
        status: 'failed',
        code: 'ADAPTER_CONTRACT_INCOMPATIBLE',
        reason: expect.stringContaining('regeneration'),
      }),
    ]);
  });
});
