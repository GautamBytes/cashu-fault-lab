import type { ScenarioRunResult } from '@cashu-fault-lab/scenario-runner';
import { validateScenarioResult } from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import { createReport, renderHtml, renderJson, renderJunit } from '../src/index.js';

const result: ScenarioRunResult = {
  status: 'failed',
  error: { name: 'UnsafeError', message: 'Bearer top-secret must-not-leak' },
  artifact: {
    schemaVersion: 1,
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
      implementation: 'reference',
      version: '1.2.3',
      nuts: [3, 7, 9, 19],
      transports: ['http'],
      evidenceTier: 'T3',
      secret: 'secret-a',
      bearer: 'top-secret',
    },
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
      imageDigests: { mint: `sha256:${'c'.repeat(64)}` },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      scenarioId: result.artifact.scenario,
      seed: 'seed-1',
      status: 'failed',
      invariants: [{ name: 'scenario-conformance', passed: false }],
      capabilities: {
        implementation: 'reference',
        version: '1.2.3',
        nuts: [3, 7, 9, 19],
        transports: ['http'],
        evidenceTier: 'T3',
      },
    });
    expect(validateScenarioResult(report)).toEqual({ ok: true });
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
