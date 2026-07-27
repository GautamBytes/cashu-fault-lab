import {
  INVARIANT_REGISTRY,
  type MatrixCaseResult,
  type ScenarioRunResult,
} from '@cashu-fault-lab/scenario-runner';
import {
  developmentIdentity,
  validateScenarioResult,
  type AdapterCapabilities,
} from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import {
  createMatrixReport,
  createReport,
  renderHtml,
  renderJson,
  renderJunit,
  renderMatrixHtml,
  renderMatrixJson,
  renderMatrixJunit,
} from '../src/index.js';

const result: ScenarioRunResult = {
  status: 'failed',
  error: { name: 'UnsafeError', message: 'Bearer top-secret must-not-leak' },
  artifact: {
    schemaVersion: 2,
    seed: 'seed-1',
    scenario: 'response-loss <script>alert(1)</script>',
    commands: [
      {
        type: 'configure_fault',
        target: 'http',
        rule: { kind: 'drop_response', occurrence: 1 },
      },
      { type: 'send', sender: 'reference', requestId: 'request-1' },
    ],
    capabilities: {
      schemaVersion: 2,
      implementation: {
        id: 'reference',
        version: '1.2.3',
        language: 'typescript',
        runtime: 'node-24',
        sourceDigest: `sha256:${'de'.repeat(32)}`,
        buildDigest: `sha256:${'ef'.repeat(32)}`,
      },
      roles: {
        sender: {
          transports: ['http'],
          profiles: ['delivery-v1'],
          durability: 'persistent',
          evidence: { tier: 'T1', sources: ['runner', 'transport'] },
        },
        receiver: {
          transports: ['http'],
          profiles: ['delivery-v1'],
          durability: 'restart_safe',
          evidence: { tier: 'T3', sources: ['durable_ledger', 'durable_state'] },
        },
      },
      nuts: [3, 7, 9, 19],
      encodings: ['creqA'],
      mints: [{ id: 'nutshell-local', implementation: 'nutshell', version: '0.17.0' }],
      secret: 'secret-a',
      bearer: 'top-secret',
    },
    invariants: INVARIANT_REGISTRY.map((definition, index) => ({
      id: definition.id,
      status: index === 2 ? ('failed' as const) : ('not_applicable' as const),
      confidence: index === 2 ? ('observed' as const) : ('derived' as const),
      evidence:
        index === 2
          ? [
              {
                source: 'ledger' as const,
                index: 2,
                field: 'creditId',
                description: 'Durable ledger contains duplicate credit evidence.',
              },
            ]
          : [],
      ...(index === 2 ? { reason: 'A delivery produced duplicate merchant credits.' } : {}),
    })),
    history: [
      {
        sequence: 0,
        at: 0,
        phase: 'invoked',
        actor: 'http',
        event: 'configure_fault',
        commandIndex: 0,
        data: { secret: 'secret-a', proof: '02deadbeef' },
      },
      {
        sequence: 1,
        at: 10,
        phase: 'observation',
        actor: 'oracle',
        event: 'delivery_attempted',
        commandIndex: 1,
        data: {
          type: 'delivery_attempted',
          requestId: 'request-1',
          deliveryId: 'delivery-1',
          payloadHash: 'a'.repeat(64),
          proofSetHash: 'b'.repeat(64),
          transport: 'http',
          proofs: [{ secret: 'secret-a', C: '02deadbeef' }],
        },
      },
      {
        sequence: 2,
        at: 11,
        phase: 'observation',
        actor: 'oracle',
        event: 'redemption_started',
        commandIndex: 1,
        data: {
          type: 'redemption_started',
          deliveryId: 'delivery-1',
          proofSetHash: 'b'.repeat(64),
          secret: 'secret-a',
        },
      },
    ],
  },
};

function expectSecretFree(output: string): void {
  expect(output).not.toContain('secret-a');
  expect(output).not.toContain('02deadbeef');
  expect(output).not.toContain('top-secret');
  expect(output).not.toContain('must-not-leak');
  expect(output).toContain('a'.repeat(64));
  expect(output).toContain('b'.repeat(64));
}

describe('allowlist report rendering', () => {
  it('builds a deterministic report containing only safe evidence', () => {
    const report = createReport({
      result,
      componentVersions: { receiver: '1.2.3' },
      imageDigests: { mint: `sha256:${'cd'.repeat(32)}` },
    });

    expect(report).toMatchObject({
      schemaVersion: 2,
      scenarioId: result.artifact.scenario,
      seed: 'seed-1',
      status: 'failed',
      invariants: result.artifact.invariants,
      capabilities: {
        schemaVersion: 2,
        implementation: {
          id: 'reference',
          version: '1.2.3',
          language: 'typescript',
          runtime: 'node-24',
        },
        roles: {
          sender: { evidence: { tier: 'T1' } },
          receiver: { evidence: { tier: 'T3' } },
        },
        nuts: [3, 7, 9, 19],
      },
    });
    expect(validateScenarioResult(report)).toEqual({ ok: true });
    expect(report.timeline[2]?.data).toEqual({
      deliveryId: 'delivery-1',
      proofSetHash: 'b'.repeat(64),
    });
    expectSecretFree(JSON.stringify(report));
  });

  it('renders secret-free JSON and JUnit', () => {
    const input = { result };
    expectSecretFree(renderJson(input));
    const junit = renderJunit(input);
    expectSecretFree(junit);
    expect(junit).toContain('<testsuite');
    expect(junit).toContain('<failure');
  });

  it('uses artifact-level component versions and image digests by default', () => {
    const resultWithMetadata: ScenarioRunResult = {
      ...result,
      artifact: {
        ...result.artifact,
        componentVersions: { receiver: '1.2.3' },
        imageDigests: { mint: `sha256:${'de'.repeat(32)}` },
      },
    };

    expect(createReport({ result: resultWithMetadata })).toMatchObject({
      componentVersions: { receiver: '1.2.3' },
      imageDigests: { mint: `sha256:${'de'.repeat(32)}` },
    });
  });

  it('renders self-contained HTML without executable scenario markup', () => {
    const html = renderHtml({ result });
    expectSecretFree(html);
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('rejects malformed component versions and image digests', () => {
    expect(() =>
      createReport({ result, componentVersions: { receiver: 'Bearer secret' } }),
    ).toThrowError(/version/i);
    expect(() => createReport({ result, imageDigests: { mint: 'latest' } })).toThrowError(
      /digest/i,
    );
  });
});

const matrixCapability: AdapterCapabilities = {
  schemaVersion: 2,
  implementation: developmentIdentity({
    id: 'ref',
    version: '0.0.0',
    language: 'typescript',
    runtime: 'node-24',
  }),
  roles: {
    sender: {
      transports: ['http'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T0', sources: ['adapter'] },
    },
    receiver: {
      transports: ['http'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T0', sources: ['adapter'] },
    },
  },
  nuts: [18],
  encodings: ['creqA'],
  mints: [],
};

const matrixResults: readonly MatrixCaseResult[] = [
  {
    profile: 'delivery-v1',
    sender: 'ref',
    receiver: 'ref',
    status: 'passed',
    senderCapabilities: matrixCapability,
    receiverCapabilities: matrixCapability,
    invariants: [],
    mints: [],
  },
  {
    profile: 'delivery-v1',
    sender: 'cashu-ts',
    receiver: 'ref',
    status: 'failed',
    code: 'ADAPTER_UNSUPPORTED',
    reason: 'cashu-ts does not implement receipts',
  },
  {
    profile: 'delivery-v1',
    sender: 'cdk',
    receiver: 'ref',
    status: 'not_applicable',
    reason: 'cdk receiver is not registered',
  },
  {
    profile: 'nut26-nostr',
    sender: 'cdk',
    receiver: 'cashu-ts',
    status: 'expected_failure',
    code: 'NUT26_NIP_MAPPING_MISMATCH',
    reason: 'NIP-04 raw key mismatch',
  },
];

describe('matrix report rendering', () => {
  const releaseGate = {
    passed: false,
    qualifyingPairs: [],
    reasons: [
      {
        code: 'MINIMUM_QUALIFYING_PAIRS' as const,
        message: 'Release requires two qualifying pairs.',
      },
      {
        code: 'MINIMUM_DISTINCT_MINTS' as const,
        message: 'Release requires two distinct mints.',
      },
    ],
  };

  it('summarizes pass/fail/N/A/expected counts across cases', () => {
    const report = createMatrixReport({
      profile: 'delivery-v1',
      seed: 'matrix-seed',
      results: matrixResults,
    });

    expect(report.summary).toEqual({
      passed: 1,
      failed: 1,
      notApplicable: 1,
      expectedFailure: 1,
      total: 4,
    });
    expect(report.profile).toBe('delivery-v1');
    expect(report.cases).toHaveLength(4);
  });

  it('renders deterministic JSON containing every case', () => {
    const json = renderMatrixJson({
      profile: 'delivery-v1',
      seed: 'matrix-seed',
      results: matrixResults,
    });

    expect(json).toContain('"passed": 1');
    expect(json).toContain('"total": 4');
    expect(json).toContain('NUT26_NIP_MAPPING_MISMATCH');
    expect(json).toContain('cashu-ts does not implement receipts');
  });

  it('includes release-gate failures in JSON, JUnit, and HTML', () => {
    const input = {
      profile: 'delivery-v1',
      seed: 'matrix-seed',
      results: matrixResults,
      releaseGate,
    };

    const json = renderMatrixJson(input);
    expect(json).toContain('"schemaVersion": 2');
    expect(json).toContain('"releaseGate"');
    expect(json).toContain('MINIMUM_QUALIFYING_PAIRS');
    expect(renderMatrixJunit(input)).toContain('<failure type="RELEASE_GATE_FAILED"');
    const html = renderMatrixHtml(input);
    expect(html).toContain('Release gate failed');
    expect(html).toContain('MINIMUM_DISTINCT_MINTS');
  });

  it('renders JUnit with one testcase per pair and correct skip/failure counts', () => {
    const junit = renderMatrixJunit({
      profile: 'delivery-v1',
      seed: 'matrix-seed',
      results: matrixResults,
    });

    expect(junit).toContain('<testsuite');
    expect(junit).toContain('tests="4"');
    expect(junit).toContain('failures="1"');
    expect(junit).toContain('skipped="2"');
    expect(junit).toContain('<failure type="ADAPTER_UNSUPPORTED"');
    expect(junit).toContain('<skipped type="NUT26_NIP_MAPPING_MISMATCH"');
    expect(junit).toContain('<skipped message="cdk receiver is not registered"');
    expect(junit.match(/<testcase/g)?.length).toBe(4);
  });

  it('renders self-contained HTML without leaking secrets or script tags', () => {
    const html = renderMatrixHtml({
      profile: 'delivery-v1',
      seed: 'matrix-seed',
      results: matrixResults,
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Compatibility matrix');
    expect(html).toContain('ref</td><td>→</td><td>ref');
    expect(html).toContain('NUT26_NIP_MAPPING_MISMATCH');
    expect(html).not.toContain('<script>');
  });
});
