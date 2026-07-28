import { describe, expect, it } from 'vitest';
import { getDemoSummary } from './demo';

describe('getDemoSummary', () => {
  it('summarizes the reviewed demo artifact without exposing commands', async () => {
    const summary = await getDemoSummary();
    expect(summary).toMatchObject({
      scenarioId: 'http-response-lost',
      seed: 'cashu-fault-lab-v0.1.0-demo',
      status: 'passed',
      commandCount: 3,
      timelineCount: 13,
      invariantCount: 18,
    });
    expect(JSON.stringify(summary)).not.toContain('proofSecret');
  });

  it('counts every invariant state', async () => {
    const summary = await getDemoSummary();
    expect(
      summary.invariantCounts.passed +
        summary.invariantCounts.failed +
        summary.invariantCounts.not_observable +
        summary.invariantCounts.not_applicable,
    ).toBe(18);
  });
});
