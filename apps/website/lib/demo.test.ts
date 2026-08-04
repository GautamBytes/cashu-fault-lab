import { describe, expect, it } from 'vitest';
import { getDemoSummary } from './demo';

describe('getDemoSummary', () => {
  it('summarizes the public v0.2.0 demo artifact without exposing commands', async () => {
    const summary = await getDemoSummary();
    expect(summary).toMatchObject({
      scenarioId: 'http-response-lost',
      seed: 'cashu-fault-lab-v0.1.0-demo',
      status: 'passed',
      commandCount: 3,
      timelineCount: 14,
      invariantCount: 18,
      deliveryAttemptCount: 2,
      redemptionStartCount: 1,
      merchantCreditCount: 1,
      verification: {
        release: 'v0.2.0',
        package: 'cashu-fault-lab@0.2.0',
        command: 'npx --yes cashu-fault-lab@0.2.0 demo',
        publicationRunUrl:
          'https://github.com/GautamBytes/cashu-fault-lab/actions/runs/30937256267',
        evidenceType: 'first-party-reproducible',
        doctor: { checks: 10, failed: 0, warned: 0 },
        cleanup: { containers: 0, networks: 0, volumes: 0 },
      },
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
