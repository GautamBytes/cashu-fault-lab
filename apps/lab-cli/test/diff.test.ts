import type { FailureArtifact, ScenarioRunResult } from '@cashu-fault-lab/scenario-runner';
import { describe, expect, it } from 'vitest';
import { diffScenarios, renderDiffText } from '../src/diff.js';

function result(overrides: {
  readonly status?: 'passed' | 'failed';
  readonly scenario?: string;
  readonly seed?: string;
  readonly commands?: readonly unknown[];
  readonly history?: readonly { readonly phase: string; readonly event: string }[];
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly name: string; readonly message: string };
}): ScenarioRunResult {
  const artifact: FailureArtifact = {
    schemaVersion: 1,
    seed: overrides.seed ?? 'seed-1',
    scenario: overrides.scenario ?? 'request-loss',
    commands: (overrides.commands ?? [{ type: 'assert_quiescent' }]) as FailureArtifact['commands'],
    history: (overrides.history ?? []) as FailureArtifact['history'],
    capabilities: overrides.capabilities ?? { implementation: 'fake', version: '1.0.0' },
  };
  if (overrides.status === 'failed') {
    return {
      status: 'failed',
      artifact,
      error: overrides.error ?? { name: 'Error', message: 'failed' },
    };
  }
  return { status: overrides.status ?? 'passed', artifact };
}

describe('diffScenarios', () => {
  it('reports sameOutcome for identical results', () => {
    const a = result({});
    const diff = diffScenarios(a, a);
    expect(diff.sameOutcome).toBe(true);
    expect(diff.statusChanged).toBe(false);
    expect(diff.commandChanges).toEqual([]);
  });

  it('detects a status change from passed to failed', () => {
    const left = result({ status: 'passed' });
    const right = result({
      status: 'failed',
      error: { name: 'Error', message: 'boom' },
    });
    const diff = diffScenarios(left, right);
    expect(diff.statusChanged).toBe(true);
    expect(diff.errorChanged).toBe(false);
    expect(diff.sameOutcome).toBe(false);
  });

  it('detects an error message change between two failures', () => {
    const left = result({
      status: 'failed',
      error: { name: 'Error', message: 'old failure' },
    });
    const right = result({
      status: 'failed',
      error: { name: 'Error', message: 'new failure' },
    });
    const diff = diffScenarios(left, right);
    expect(diff.errorChanged).toBe(true);
    expect(diff.sameOutcome).toBe(false);
  });

  it('detects added, removed, and changed commands', () => {
    const left = result({
      commands: [
        { type: 'configure_fault', target: 'http', rule: { kind: 'drop_response', occurrence: 1 } },
        { type: 'send', sender: 'reference', requestId: 'r1' },
      ],
    });
    const right = result({
      commands: [
        { type: 'configure_fault', target: 'http', rule: { kind: 'drop_response', occurrence: 2 } },
        { type: 'send', sender: 'reference', requestId: 'r1' },
        { type: 'assert_quiescent' },
      ],
    });
    const diff = diffScenarios(left, right);
    expect(diff.commandCountChanged).toBe(true);
    expect(diff.commandChanges).toContainEqual({
      index: 0,
      kind: 'changed',
      left: left.artifact.commands[0],
      right: right.artifact.commands[0],
    });
    expect(diff.commandChanges).toContainEqual({
      index: 2,
      kind: 'added',
      right: right.artifact.commands[2],
    });
  });

  it('detects a removed command', () => {
    const left = result({
      commands: [{ type: 'assert_quiescent' }, { type: 'assert_quiescent' }],
    });
    const right = result({ commands: [{ type: 'assert_quiescent' }] });
    const diff = diffScenarios(left, right);
    expect(diff.commandChanges).toContainEqual({
      index: 1,
      kind: 'removed',
      left: left.artifact.commands[1],
    });
  });

  it('sums observation counts by event type and flags count changes', () => {
    const left = result({
      history: [
        { phase: 'observation', event: 'merchant_credited' },
        { phase: 'observation', event: 'delivery_attempted' },
      ],
    });
    const right = result({
      history: [
        { phase: 'observation', event: 'merchant_credited' },
        { phase: 'observation', event: 'merchant_credited' },
        { phase: 'observation', event: 'delivery_attempted' },
      ],
    });
    const diff = diffScenarios(left, right);
    expect(diff.observationCounts.left).toEqual({
      merchant_credited: 1,
      delivery_attempted: 1,
    });
    expect(diff.observationCounts.right).toEqual({
      merchant_credited: 2,
      delivery_attempted: 1,
    });
    expect(diff.historyLengthChanged).toBe(true);
  });

  it('detects capability changes', () => {
    const left = result({ capabilities: { implementation: 'a', version: '1.0.0' } });
    const right = result({ capabilities: { implementation: 'a', version: '1.1.0' } });
    const diff = diffScenarios(left, right);
    expect(diff.capabilitiesChanged).toBe(true);
  });

  it('renderDiffText produces a readable text summary', () => {
    const left = result({ status: 'passed', seed: 's1' });
    const right = result({
      status: 'failed',
      seed: 's2',
      error: { name: 'Error', message: 'boom' },
    });
    const diff = diffScenarios(left, right);
    const text = renderDiffText('a.json', 'b.json', left, right, diff);
    expect(text).toContain('diff a.json -> b.json');
    expect(text).toContain('status: passed -> failed');
    expect(text).toContain('seed: s1 (changed)');
    expect(text).toContain('outcome: different');
  });

  it('renderDiffText reports same outcome without diffs', () => {
    const a = result({});
    const text = renderDiffText('a.json', 'b.json', a, a, diffScenarios(a, a));
    expect(text).toContain('outcome: same');
    expect(text).toContain('observations: (same counts)');
  });
});
